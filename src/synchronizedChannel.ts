import type { Transport } from './softwareTransport';
import type { Media, Timing } from './types';

export type ChannelState = 'preparing' | 'frame' | 'ready' | 'failure';

/** An expected channel exists before its decoder or scheduled calibration job does. */
export class SynchronizedChannel {
  state: ChannelState = 'preparing';
  transport: Transport | null = null;
  generation = 0;
  private calibrated = false;
  private dead = false;
  private version = 0;
  private pending = false;
  private sought = false;
  private rendered = false;
  private painted = false;
  private target = 0;
  private startedAt: number | null = null;
  private changed: (state: ChannelState) => void = () => {};
  private failed: () => void = () => {};
  private render: (generation: number, time: number) => void = () => {};
  readonly media: Media;
  readonly timing: Timing;
  private now: () => number;

  constructor(media: Media, timing: Timing, now = () => performance.now()) {
    this.media = media; this.timing = timing; this.now = now;
  }
  private set(state: ChannelState) { this.state = state; this.changed(state); }
  private attempt<T>(run: () => T): T | undefined {
    try { return run(); } catch { this.fail(); }
  }
  /** Bind panel notices before constructing workers, videos or other fallible resources. */
  bind(changed: (state: ChannelState) => void, failed: () => void, render: (generation: number, time: number) => void) {
    if (this.dead) return;
    this.changed = changed; this.failed = failed; this.render = render;
    this.attempt(() => this.changed(this.state));
  }
  attach(transport: Transport) {
    if (this.dead || this.state === 'failure') { try { transport.dispose(); } catch {} return; }
    this.transport = transport;
  }
  prepared() {
    if (this.dead || this.state === 'failure' || this.calibrated) return;
    this.calibrated = true; this.attempt(() => this.set('frame'));
  }
  invalidate(generation: number) {
    if (this.dead || this.state === 'failure') return;
    this.generation = generation; this.version++;
    this.sought = this.rendered = this.painted = false; this.startedAt = null;
    this.attempt(() => { this.transport?.pause(); this.set(this.calibrated ? 'frame' : 'preparing'); });
  }
  /** A fallback retains its expected slot, so it cannot disappear from readiness. */
  detach() {
    this.pause(); this.transport = null; this.calibrated = false;
    this.invalidate(this.generation);
  }
  acknowledge(generation: number, sourceTime: number) {
    if (this.dead || this.state !== 'frame' || !this.rendered || generation !== this.generation || !Number.isFinite(sourceTime)) return;
    const pts = this.timing.media;
    let lo = 0, hi = pts.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (pts[mid] <= this.target + .000001) lo = mid + 1; else hi = mid; }
    const frame = pts[Math.max(0, lo - 1)] ?? this.target;
    // Decoders report a frame PTS; a paused native video reports the seek time.
    if (sourceTime < frame - .002 || sourceTime > this.target + .002) return;
    this.painted = true;
  }
  pulse(time: number, ahead: number, rate: number) {
    this.attempt(() => this.prepareFrame(time, ahead, rate));
  }
  private prepareFrame(time: number, ahead: number, rate: number) {
    if (this.dead || this.state === 'failure') return;
    const transport = this.transport;
    if (transport?.error) { this.fail(); return; }
    if (!transport || !this.calibrated || this.state === 'ready') return;
    this.startedAt ??= this.now();
    if (this.now() - this.startedAt >= 30000) { this.fail(); return; }
    if (this.pending) return;
    if (!this.sought) {
      this.target = time; this.pending = true;
      const version = this.version;
      void transport.seek(time, false).then(() => {
        if (!this.dead && version === this.version) this.sought = true;
      }).catch(() => { if (!this.dead && version === this.version) this.fail(); })
        .finally(() => { this.pending = false; });
      return;
    }
    if (!transport.prepare(time, ahead)) return;
    if (!this.rendered) {
      this.rendered = true;
      transport.present(time, rate, false);
      this.render(this.generation, time);
    }
    if (this.painted) this.set('ready');
  }
  fail() {
    if (this.dead || this.state === 'failure') return;
    this.version++; this.state = 'failure';
    // A broken decoder or canvas must not prevent the notice or other cleanup.
    for (const cleanup of [() => this.changed('failure'), () => this.transport?.dispose(), () => this.failed()]) {
      try { cleanup(); } catch {}
    }
  }
  pause() { if (!this.dead && this.state !== 'failure') this.attempt(() => this.transport?.pause()); }
  prepare(time: number, ahead = 0) {
    if (this.dead || this.state === 'failure') return false;
    return this.attempt(() => {
      if (this.transport?.error) { this.fail(); return false; }
      return this.transport?.prepare(time, ahead) ?? false;
    }) ?? false;
  }
  present(time: number, rate: number, playing: boolean) {
    if (!this.dead && this.state === 'ready') this.attempt(() => this.transport?.present(time, rate, playing));
  }
  dispose() {
    this.dead = true; this.version++;
    try { this.transport?.pause(); } catch {}
  }
}

export function allChannelsReady(channels: Iterable<SynchronizedChannel>) {
  const expected = [...channels];
  return expected.length > 0 && expected.every(channel => channel.state === 'ready' || channel.state === 'failure');
}
