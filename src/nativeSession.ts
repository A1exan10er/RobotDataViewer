/** Shared launch credentials; consume the URL fragment only once. */
const local = location.protocol === 'http:' && location.hostname === '127.0.0.1';
const fragment = new URLSearchParams(location.hash.slice(1));
let token = local ? fragment.get('native') : null;
if (local) {
  try {
    if (token) sessionStorage.setItem('rdv-native-token', token);
    else token = sessionStorage.getItem('rdv-native-token');
  } catch { /* The in-memory launch token still works with storage disabled. */ }
  if (fragment.has('native')) history.replaceState(null, '', location.pathname + location.search);
}
export const nativeToken = token;
export const localServiceCandidate = local;

export async function serviceRequest(path: string, body?: unknown, method = 'POST', keepalive = false) {
  const response = await fetch('/api/v1/service' + path, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'omit', cache: 'no-store', keepalive, signal: AbortSignal.timeout(5000),
  });
  return response;
}
