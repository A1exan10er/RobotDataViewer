import type { Pose, Timing } from './types.ts';

export function nearestIndex(values: number[], target: number): number {
  if (!values.length) return -1;
  let lo = 0, hi = values.length - 1;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid] < target) lo = mid + 1; else hi = mid; }
  return lo > 0 && target - values[lo - 1] <= values[lo] - target ? lo - 1 : lo;
}
export function poseAt(points: Pose[], time: number): Pose | null {
  if (!points.length || time < points[0].t || time > points[points.length - 1].t + 100) return null;
  let lo = 0, hi = points.length - 1;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid].t < time) lo = mid + 1; else hi = mid; }
  return points[lo > 0 && time - points[lo - 1].t <= points[lo].t - time ? lo - 1 : lo];
}
export function mediaTimeAt(timing: Timing, episodeMs: number): number {
  const { episode: e, media: m } = timing;
  if (!e.length) return 0;
  if (episodeMs <= e[0]) return m[0];
  if (episodeMs >= e[e.length - 1]) return m[m.length - 1] + (episodeMs - e[e.length - 1]) / 1000;
  const next = nearestIndex(e, episodeMs);
  const i = e[next] > episodeMs ? Math.max(0, next - 1) : next;
  const j = Math.min(i + 1, e.length - 1);
  return m[i] + (m[j] - m[i]) * ((episodeMs - e[i]) / Math.max(1e-6, e[j] - e[i]));
}
export function localRateAt(timing: Timing, episodeMs: number): number {
  const i = Math.min(Math.max(0, nearestIndex(timing.episode, episodeMs)), timing.episode.length - 2);
  if (i < 0) return 1;
  // Average a short window to avoid capture jitter changing the playback rate every frame.
  const a = Math.max(0, i - 5), b = Math.min(timing.episode.length - 1, i + 5);
  return Math.max(.25, Math.min(4, (timing.media[b] - timing.media[a]) * 1000 / Math.max(1, timing.episode[b] - timing.episode[a])));
}
/** Ported from QualityCheck's corrected tactileDifference.ts. No threshold, decay, or force inference. */
export function differenceRgb(current: Uint8ClampedArray, reference: Uint8ClampedArray, output: Uint8ClampedArray, gain = 1): void {
  if (current.length !== reference.length || current.length !== output.length || current.length % 4) throw new Error('Frame dimensions differ');
  for (let i = 0; i < current.length; i += 4) {
    for (let c = 0; c < 3; c++) output[i + c] = 255 - Math.min(255, Math.abs(current[i + c] - reference[i + c]) * gain);
    output[i + 3] = 255;
  }
}
export function timeText(ms: number): string {
  const total = Math.max(0, ms / 1000);
  return `${Math.floor(total / 60).toString().padStart(2, '0')}:${Math.floor(total % 60).toString().padStart(2, '0')}.${Math.floor(total % 1 * 10)}`;
}
export function safeRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes('\0') && !value.includes(':') && value.split('/').every(p => p && p !== '.' && p !== '..');
}
