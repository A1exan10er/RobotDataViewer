export type CameraRole = 'unassigned' | 'scene' | 'tactile';
export type CameraStatus = 'stopped' | 'starting' | 'streaming' | 'disconnected' | 'error';
export type CameraError = 'permission' | 'busy' | 'missing' | 'profile' | 'unsupported' | 'capture';
export type CameraProfile = { width: number; height: number; frameRate: number };
export type CameraPreferences = { name: string; role: CameraRole; customProfile?: CameraProfile };
export const CAMERA_PROFILES: Record<Exclude<CameraRole, 'unassigned'>, CameraProfile> = {
  scene: { width: 640, height: 480, frameRate: 30 },
  tactile: { width: 640, height: 360, frameRate: 30 },
};
export type LiveCamera = CameraPreferences & {
  id: string; label: string; present: boolean; status: CameraStatus;
  stream?: MediaStream; settings?: MediaTrackSettings; error?: CameraError; mismatch: boolean; generation: number;
};
export interface CaptureAdapter {
  enumerate(): Promise<Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>[]>;
  open(constraints: MediaStreamConstraints): Promise<MediaStream>;
  resizeMode: boolean;
  subscribe(changed: () => void): () => void;
}
export interface RoleStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const ROLE_KEY = 'rdv.live-camera-roles.v1';
const PREFERENCES_KEY = 'rdv.live-camera-preferences.v2';
const roles: CameraRole[] = ['unassigned', 'scene', 'tactile'];
export function validCameraProfile(profile: unknown): profile is CameraProfile {
  if (!profile || typeof profile !== 'object') return false;
  const { width, height, frameRate } = profile as CameraProfile;
  return Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0
    && Number.isFinite(frameRate) && frameRate >= 1;
}
export function requestedProfile(camera: Pick<CameraPreferences, 'role' | 'customProfile'>): CameraProfile | undefined {
  return camera.customProfile || (camera.role === 'unassigned' ? undefined : CAMERA_PROFILES[camera.role]);
}
export function configuredFrameRate(camera: LiveCamera): number {
  const rate = camera.settings?.frameRate;
  return rate && Number.isFinite(rate) && rate >= 1 ? rate : requestedProfile(camera)?.frameRate || 30;
}
function savedObject(storage: RoleStorage | undefined, key: string): Record<string, unknown> | undefined {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(key) || 'null');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) return saved as Record<string, unknown>;
  } catch { /* Device memory is optional, including in private mode. */ }
}
export function cameraError(error: unknown): CameraError {
  const name = (error as { name?: string })?.name;
  return name === 'NotAllowedError' || name === 'SecurityError' ? 'permission'
    : name === 'NotFoundError' ? 'missing'
    : name === 'NotReadableError' || name === 'AbortError' ? 'busy'
    : name === 'OverconstrainedError' ? 'profile' : 'capture';
}
export function browserCapture(): CaptureAdapter | undefined {
  const media = navigator.mediaDevices;
  if (!window.isSecureContext || !media?.getUserMedia || !media.enumerateDevices) return;
  return {
    enumerate: () => media.enumerateDevices(), open: constraints => media.getUserMedia(constraints),
    resizeMode: !!(media.getSupportedConstraints() as MediaTrackSupportedConstraints & { resizeMode?: boolean }).resizeMode,
    subscribe: changed => { media.addEventListener('devicechange', changed); return () => media.removeEventListener('devicechange', changed); },
  };
}
function stopStream(stream?: MediaStream) { stream?.getTracks().forEach(track => track.stop()); }

/** Owns capture independently of recorded transports and of heatmap processing. */
export class LiveCameraSession {
  readonly cameras = new Map<string, LiveCamera>();
  automatic = false;
  requesting = false;
  error?: CameraError;
  private disposed = false;
  private epoch = 0;
  private enumeration = 0;
  private stopped = new Set<string>();
  private preferences: Record<string, CameraPreferences> = Object.create(null);
  private listeners = new Map<string, () => void>();
  private opening = new Map<string, Promise<void>>();
  private unsubscribe: () => void;
  private adapter: CaptureAdapter;
  private changed: () => void;
  private storage?: RoleStorage;
  constructor(adapter: CaptureAdapter, changed: () => void, storage?: RoleStorage) {
    this.adapter = adapter; this.changed = changed; this.storage = storage;
    const saved = savedObject(storage, PREFERENCES_KEY);
    if (saved) {
      for (const [id, entry] of Object.entries(saved)) {
        if (!entry || typeof entry !== 'object') continue;
        const value = entry as Partial<CameraPreferences>;
        if (!roles.includes(value.role as CameraRole)) continue;
        this.preferences[id] = { name: typeof value.name === 'string' ? value.name.trim() : '', role: value.role!,
          ...(validCameraProfile(value.customProfile) ? { customProfile: { ...value.customProfile } } : {}) };
      }
    } else {
      for (const [id, role] of Object.entries(savedObject(storage, ROLE_KEY) || {})) {
        if (roles.includes(role as CameraRole)) this.preferences[id] = { name: '', role: role as CameraRole };
      }
      this.savePreferences();
    }
    this.unsubscribe = adapter.subscribe(() => { void this.refresh(); });
  }
  private emit() { if (!this.disposed) this.changed(); }
  private savePreferences(camera?: LiveCamera) {
    if (camera) this.preferences[camera.id] = { name: camera.name, role: camera.role,
      ...(camera.customProfile ? { customProfile: { ...camera.customProfile } } : {}) };
    try { this.storage?.setItem(PREFERENCES_KEY, JSON.stringify(this.preferences)); } catch { /* Optional persistence. */ }
  }
  private release(camera: LiveCamera) {
    ++camera.generation;
    this.listeners.get(camera.id)?.(); this.listeners.delete(camera.id);
    stopStream(camera.stream); camera.stream = undefined; camera.settings = undefined; camera.mismatch = false;
  }
  async refresh() {
    const version = ++this.enumeration;
    try {
      const devices = await this.adapter.enumerate();
      if (this.disposed || version !== this.enumeration) return;
      const ids = new Set<string>(), start: string[] = [];
      for (const device of devices) {
        if (device.kind !== 'videoinput' || !device.deviceId || ids.has(device.deviceId)) continue;
        ids.add(device.deviceId);
        let camera = this.cameras.get(device.deviceId);
        const arrived = !camera?.present;
        if (!camera) {
          camera = { id: device.deviceId, label: device.label, ...(this.preferences[device.deviceId] || { name: '', role: 'unassigned' as const }), present: true, status: 'stopped', mismatch: false, generation: 0 };
          this.cameras.set(camera.id, camera);
        } else { camera.present = true; camera.label = device.label || camera.label; if (arrived) camera.status = 'stopped'; }
        if (arrived && this.automatic && !this.requesting && !this.stopped.has(camera.id)) start.push(camera.id);
      }
      for (const camera of this.cameras.values()) if (!ids.has(camera.id) && camera.present) {
        this.release(camera); camera.present = false; camera.status = 'disconnected';
      }
      this.error = undefined; this.emit();
      for (const id of start) void this.start(id, false);
    } catch (error) { if (!this.disposed && version === this.enumeration) { this.error = cameraError(error); this.emit(); } }
  }
  async startAll() {
    if (this.disposed || this.requesting) return;
    this.automatic = true; this.error = undefined;
    const epoch = ++this.epoch;
    // Keep the permission probe alive until enumeration has exposed all devices.
    if (![...this.cameras.values()].some(camera => camera.stream)) {
      this.requesting = true; this.emit();
      let probe: MediaStream | undefined;
      try {
        probe = await this.adapter.open({ video: true, audio: false });
        if (this.disposed || epoch !== this.epoch) return;
        await this.refresh();
      } catch (error) {
        if (this.disposed || epoch !== this.epoch) return;
        this.error = cameraError(error);
        if (this.error === 'permission') { this.automatic = false; return; }
        // A busy default camera must not prevent other exact devices opening.
        // With no devices yet, keep hot-plug discovery enabled.
        const probeError = this.error;
        await this.refresh();
        this.error = probeError;
      } finally {
        stopStream(probe);
        if (!this.disposed && epoch === this.epoch) { this.requesting = false; this.emit(); }
      }
    } else await this.refresh();
    if (this.disposed || epoch !== this.epoch) return;
    // Individual stops are deliberate; the per-camera Start button clears them.
    await Promise.all([...this.cameras.values()].filter(camera => camera.present && !this.stopped.has(camera.id)).map(camera => this.start(camera.id, false)));
  }
  async start(id: string, explicit = true) {
    const camera = this.cameras.get(id);
    if (this.disposed || !camera?.present || camera.status === 'starting' || camera.stream) return;
    if (explicit) this.stopped.delete(id);
    this.release(camera); const generation = camera.generation;
    camera.status = 'starting'; camera.error = undefined; this.emit();
    const profile = requestedProfile(camera);
    const video: MediaTrackConstraints & { resizeMode?: { exact: string } } = { deviceId: { exact: id } };
    if (profile) {
      video.width = { exact: profile.width }; video.height = { exact: profile.height }; video.frameRate = { exact: profile.frameRate };
      if (this.adapter.resizeMode) video.resizeMode = { exact: 'none' };
    }
    let stream: MediaStream | undefined;
    // A cancelled getUserMedia cannot itself be aborted. Wait for its stream to
    // arrive and be stopped before asking the same physical source for a new
    // profile, otherwise Chrome may negotiate against the still-opening source.
    const previous = this.opening.get(id);
    let finished!: () => void;
    const opening = new Promise<void>(resolve => { finished = resolve; });
    this.opening.set(id, opening);
    try {
      if (previous) await previous;
      if (this.disposed || generation !== camera.generation || !camera.present) return;
      stream = await this.adapter.open({ video, audio: false });
      if (this.disposed || generation !== camera.generation || !camera.present) { stopStream(stream); return; }
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState === 'ended') throw new Error('No active video track');
      const settings = track.getSettings();
      if (settings.deviceId && settings.deviceId !== id) throw new Error('Wrong capture device');
      camera.stream = stream; camera.settings = settings; camera.status = 'streaming';
      const resizeMode = (settings as MediaTrackSettings & { resizeMode?: string }).resizeMode;
      camera.mismatch = !!profile && (settings.width !== profile.width || settings.height !== profile.height || !settings.frameRate || Math.abs(settings.frameRate - profile.frameRate) > .5 || (this.adapter.resizeMode && resizeMode !== undefined && resizeMode !== 'none'));
      const ended = () => {
        if (generation !== camera.generation) return;
        this.release(camera); camera.status = 'disconnected'; this.emit(); void this.refresh();
      };
      track.addEventListener('ended', ended);
      this.listeners.set(id, () => track.removeEventListener('ended', ended));
      this.emit(); void this.refresh();
    } catch (error) {
      stopStream(stream);
      if (!this.disposed && generation === camera.generation) { camera.status = 'error'; camera.error = cameraError(error); this.emit(); }
    } finally {
      finished(); if (this.opening.get(id) === opening) this.opening.delete(id);
    }
  }
  stop(id: string) {
    const camera = this.cameras.get(id); if (!camera) return;
    this.stopped.add(id); this.release(camera); camera.status = camera.present ? 'stopped' : 'disconnected'; camera.error = undefined; this.emit();
  }
  stopAll() {
    ++this.epoch; this.automatic = false; this.requesting = false;
    for (const camera of this.cameras.values()) { this.release(camera); camera.status = camera.present ? 'stopped' : 'disconnected'; camera.error = undefined; }
    this.emit();
  }
  setRole(id: string, role: CameraRole) {
    const camera = this.cameras.get(id);
    if (!camera || !roles.includes(role) || (camera.role === role && !camera.customProfile)) return;
    this.configure(camera, role);
  }
  setName(id: string, name: string) {
    const camera = this.cameras.get(id); if (this.disposed || !camera) return;
    camera.name = name.trim(); this.savePreferences(camera); this.emit();
  }
  setProfile(id: string, profile?: CameraProfile): boolean {
    const camera = this.cameras.get(id);
    if (this.disposed || !camera || (profile !== undefined && !validCameraProfile(profile))) return false;
    const previous = camera.customProfile;
    if (previous?.width === profile?.width && previous?.height === profile?.height && previous?.frameRate === profile?.frameRate) return true;
    this.configure(camera, camera.role, profile); return true;
  }
  private configure(camera: LiveCamera, role: CameraRole, profile?: CameraProfile) {
    if (this.disposed) return;
    const restart = camera.status === 'starting' || !!camera.stream;
    this.release(camera); camera.role = role; camera.status = camera.present ? 'stopped' : 'disconnected'; camera.error = undefined;
    camera.customProfile = profile ? { ...profile } : undefined;
    this.savePreferences(camera);
    this.emit(); if (restart) void this.start(camera.id, false);
  }
  dispose() { this.stopAll(); this.disposed = true; ++this.enumeration; this.unsubscribe(); }
}

/** Display/compositor statistics, never a claim about sensor acquisition FPS. */
export class LiveFrameHealth {
  lastFrame?: number;
  fps?: number;
  private started = 0;
  private frames: { at: number; count: number }[] = [];
  private presented?: number;
  private lowSince?: number;
  reset(now: number) { this.started = now; this.lastFrame = undefined; this.fps = undefined; this.frames = []; this.presented = undefined; this.lowSince = undefined; }
  frame(now: number, presented?: number) {
    const count = presented !== undefined && this.presented !== undefined ? Math.max(1, presented - this.presented) : 1;
    this.presented = presented; this.lastFrame = now; this.frames.push({ at: now, count }); this.trim(now);
  }
  private trim(now: number) { while (this.frames.length && this.frames[0].at < now - 2000) this.frames.shift(); }
  read(now: number, visible: boolean, frameRate = 30): { fps: number | undefined; age: number | undefined; warning: 'hidden' | 'stale' | 'slow' | undefined } {
    if (!visible) { this.reset(now); return { warning: 'hidden' as const, fps: undefined, age: undefined }; }
    this.trim(now);
    const elapsed = Math.min(2000, now - this.started);
    this.fps = elapsed >= 1000 ? this.frames.reduce((total, frame) => total + frame.count, 0) * 1000 / elapsed : undefined;
    const age = this.lastFrame === undefined ? now - this.started : now - this.lastFrame;
    const target = Number.isFinite(frameRate) && frameRate >= 1 ? frameRate : 30;
    if (now - this.started >= 3000 && this.fps !== undefined && this.fps < .8 * target) this.lowSince ??= now;
    else this.lowSince = undefined;
    return { fps: this.fps, age, warning: age >= 2000 ? 'stale' as const : this.lowSince !== undefined && now - this.lowSince >= 5000 ? 'slow' as const : undefined };
  }
}
