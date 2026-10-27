/** Resource lifecycle for browser tabs served by the native launcher. */
import { ref } from 'vue';
import { localServiceCandidate, nativeToken, serviceRequest } from './nativeSession';

export type ServiceState = 'checking' | 'standalone' | 'running' | 'stopping' | 'stopped' | 'disconnected';
export const serviceState = ref<ServiceState>(localServiceCandidate ? 'checking' : 'standalone');
export const serviceError = ref(false);
export const servicePreparing = ref(false);
const sessionId = crypto.randomUUID();
let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
let activityQueue = Promise.resolve();

export function reportPreparation(preparing: boolean): Promise<void> {
  servicePreparing.value = preparing;
  if (!nativeToken) return Promise.resolve();
  // Preserve start/end ordering, including rapid cancellation and episode changes.
  activityQueue = activityQueue.catch(() => {}).then(async () => {
    const response = await serviceRequest('/session', { id: sessionId, preparing });
    if (response.status === 404) return; // Older native packages have no lifecycle API.
    if (!response.ok) throw new Error('Viewer service is unavailable');
  });
  return activityQueue;
}

async function poll() {
  try {
    const response = await fetch('/api/v1/service', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(5000) });
    if (response.status === 404 && serviceState.value === 'checking') { serviceState.value = 'standalone'; return; }
    if (!response.ok) throw new Error('Service unavailable');
    const value = await response.json();
    if (value.application !== 'RobotDataViewer' || value.protocol !== 1) throw new Error('Not a viewer service');
    if (stopped || ['stopping', 'stopped', 'disconnected'].includes(serviceState.value)) return;
    if (value.state === 'stopping') { serviceState.value = 'stopped'; return; }
    serviceState.value = 'running';
  } catch {
    if (stopped || ['stopping', 'stopped', 'disconnected'].includes(serviceState.value)) return;
    if (serviceState.value === 'checking') {
      // Vite, other HTTP hosts, and old launchers remain usable without controls.
      serviceState.value = nativeToken ? 'disconnected' : 'standalone';
    } else if (serviceState.value === 'running') serviceState.value = 'disconnected';
    return;
  }
  if (!stopped) timer = setTimeout(poll, 2000);
}

export function startServiceWatch() {
  if (localServiceCandidate) void poll();
  window.addEventListener('pagehide', leave);
  window.addEventListener('pageshow', resume);
}
function leave() {
  if (timer) clearTimeout(timer);
  if (nativeToken) void serviceRequest('/session', { id: sessionId }, 'DELETE', true).catch(() => {});
}
function resume(event: PageTransitionEvent) {
  if (event.persisted && localServiceCandidate && !stopped) {
    if (nativeToken) void reportPreparation(servicePreparing.value).catch(() => {});
    void poll();
  }
}
export function stopServiceWatch() {
  stopped = true;
  leave();
  window.removeEventListener('pagehide', leave);
  window.removeEventListener('pageshow', resume);
}

export async function stopService(confirm: () => boolean) {
  if (!nativeToken || serviceState.value !== 'running') return;
  serviceError.value = false;
  try {
    await activityQueue.catch(() => {});
    let response = await serviceRequest('/shutdown', {});
    if (response.status === 409) {
      if (!confirm()) return;
      response = await serviceRequest('/shutdown', { cancelActive: true });
    }
    if (!response.ok) throw new Error('Shutdown failed');
    serviceState.value = 'stopped';
    if (timer) clearTimeout(timer);
  } catch {
    // A failed request is not proof of shutdown. Keep a retry visible until health polling resolves it.
    serviceError.value = true;
  }
}
