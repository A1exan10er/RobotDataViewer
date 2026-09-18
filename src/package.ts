import type { EpisodeData, Manifest } from './types';
import { safeRelativePath } from './math.ts';

export class SamplePackage {
  readonly manifest:Manifest; private files:Map<string,File>;
  constructor(manifest:Manifest,files:Map<string,File>){this.manifest=manifest;this.files=files;}
  file(path: string): File | undefined { return this.files.get(path); }
  async data(path: string): Promise<EpisodeData> {
    const file = this.file(path);
    if (!file || file.size > 128 * 1024 * 1024) throw new Error('invalidPackage');
    const data = JSON.parse(await file.text()) as EpisodeData;
    if (!data || !Array.isArray(data.trajectories) || !Array.isArray(data.signals) || !data.timings) throw new Error('invalidPackage');
    const finiteArray = (v: unknown): v is number[] => Array.isArray(v) && v.every(x => typeof x === 'number' && Number.isFinite(x));
    const ascending = (v: number[]) => v.every((x, i) => i === 0 || x >= v[i - 1]);
    for (const timing of Object.values(data.timings)) {
      if (!finiteArray(timing.media) || !finiteArray(timing.episode) || !timing.media.length || timing.media.length !== timing.episode.length || !ascending(timing.media) || !ascending(timing.episode)) throw new Error('invalidPackage');
    }
    for (const tr of data.trajectories) {
      if (!['left', 'right', 'single'].includes(tr.side) || !['shared','recorded'].includes(tr.frame) || !Array.isArray(tr.points)) throw new Error('invalidPackage');
      for (const p of tr.points) if (!Number.isFinite(p.t) || !finiteArray(p.p) || p.p.length !== 3 || (p.axes !== null && (!Array.isArray(p.axes) || p.axes.length !== 3 || !p.axes.every(a => finiteArray(a) && a.length === 3))) || (p.g !== null && !Number.isFinite(p.g))) throw new Error('invalidPackage');
      if (!ascending(tr.points.map(p => p.t))) throw new Error('invalidPackage');
    }
    for (const s of data.signals) if (typeof s.id !== 'string' || typeof s.name !== 'string' || !finiteArray(s.t) || !finiteArray(s.values) || s.t.length !== s.values.length || !ascending(s.t)) throw new Error('invalidPackage');
    return data;
  }
}
export async function openPackage(files: File[]): Promise<SamplePackage> {
  const manifests = files.filter(f => f.name === 'manifest.json');
  for (const candidate of manifests.sort((a, b) => a.webkitRelativePath.length - b.webkitRelativePath.length)) {
    if (candidate.size > 8 * 1024 * 1024) continue;
    let m: Manifest;
    try { m = JSON.parse(await candidate.text()); } catch { continue; }
    if (m.format !== 'robot-data-viewer') continue;
    if (m.version !== 1 || !Array.isArray(m.episodes) || !m.episodes.length) throw new Error('invalidPackage');
    const base = candidate.webkitRelativePath.slice(0, -'manifest.json'.length);
    const map = new Map(files.filter(f => f.webkitRelativePath.startsWith(base)).map(f => [f.webkitRelativePath.slice(base.length), f]));
    const ids = new Set<string>();
    for (const ep of m.episodes) {
      if (typeof ep.id !== 'string' || ids.has(ep.id) || typeof ep.title !== 'string' || typeof ep.robot !== 'string' || !safeRelativePath(ep.data) || !map.has(ep.data) || !Number.isFinite(ep.durationMs) || ep.durationMs <= 0 || !Array.isArray(ep.media) || !Array.isArray(ep.issues)) throw new Error('invalidPackage');
      ids.add(ep.id);
      const channels = new Set<string>();
      for (const media of ep.media) {
        if (!['third','second_third','l_wrist','r_wrist','l_tact_l','l_tact_r','r_tact_l','r_tact_r'].includes(media.id) || channels.has(media.id) || !['rgb','tactile'].includes(media.kind) || !safeRelativePath(media.path) || !safeRelativePath(media.original) || !Number.isFinite(media.duration) || media.duration <= 0 || !Number.isFinite(media.fps) || media.fps <= 0) throw new Error('invalidPackage');
        channels.add(media.id);
      }
    }
    return new SamplePackage(m, map);
  }
  throw new Error('missingPackage');
}
