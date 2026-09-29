import { sha256 } from '@noble/hashes/sha2.js';

export const FORCE_MODEL = 'PSP_deep_flow_diff_shear_valloss_0.6344';
export const FORCE_PIPELINE = 'deepflow-035-clahe-relative-diff-2dp-first-frame-v1';
export type ForceTrack = {
  sensor: string;
  video: { sha256: string; bytes: number; frames: number; width: number; height: number };
  model: { id: string; weightsSha256: string; pipeline: string };
  reference: { frame: 0; time: number }; unit: 'N';
  time: Float64Array; shear: Float32Array; fz: Float32Array; valid: Uint8Array;
};
export type ForceProgress = { sensor: string; frame: number; frames: number; stage: 'checking'|'loading'|'calculating' };
const hash = /^[0-9a-f]{64}$/;
const positiveInt = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n)>0;

export function parseForceTracks(value: unknown): ForceTrack[] {
  const pack = value as any;
  if (pack?.format !== 'robot-data-viewer-force' || pack.version !== 1 || !Array.isArray(pack.tracks) || pack.tracks.length>4096) throw new Error('forceInvalidFile');
  let total=0;
  return pack.tracks.map((t:any) => {
    const count=t?.video?.frames;
    if (!positiveInt(count) || count>2_000_000 || (total+=count)>4_000_000 || typeof t.sensor!=='string' || !t.sensor || t.sensor.length>128 ||
      !hash.test(t.video.sha256) || !positiveInt(t.video.bytes) || !positiveInt(t.video.width) || !positiveInt(t.video.height) ||
      t.model?.id!==FORCE_MODEL || t.model.pipeline!==FORCE_PIPELINE || !hash.test(t.model.weightsSha256) || t.unit!=='N' ||
      t.reference?.frame!==0 || !Number.isFinite(t.reference.time) ||
      !['time','shear','fz','valid'].every(k=>Array.isArray(t[k])&&t[k].length===count)) throw new Error('forceInvalidFile');
    for(let i=0;i<count;i++) {
      if(!Number.isFinite(t.time[i]) || t.time[i]<0 || (i>0&&t.time[i]<=t.time[i-1]) ||
        ![0,1].includes(t.valid[i]) || ![t.shear[i],t.fz[i]].every(v=>Number.isFinite(v)&&v>=0&&v<=1e6)) throw new Error('forceInvalidFile');
    }
    if(t.reference.time!==t.time[0])throw new Error('forceInvalidFile');
    return {sensor:t.sensor,video:{...t.video},model:{...t.model},reference:{...t.reference},unit:'N',
      time:Float64Array.from(t.time),shear:Float32Array.from(t.shear),fz:Float32Array.from(t.fz),valid:Uint8Array.from(t.valid)};
  });
}
export function serializeForceTracks(tracks:ForceTrack[]) {
  return JSON.stringify({format:'robot-data-viewer-force',version:1,tracks:tracks.map(t=>({...t,
    time:Array.from(t.time),shear:Array.from(t.shear),fz:Array.from(t.fz),valid:Array.from(t.valid)}))});
}
/** A displayed frame owns its value until the following source frame. Never look ahead. */
export function forceAt(track:ForceTrack|undefined,time:number) {
  if(!track||!Number.isFinite(time)||time<track.time[0]-1e-6)return null;
  let lo=0,hi=track.time.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(track.time[mid]<=time+1e-6)lo=mid+1;else hi=mid;}
  const i=lo-1;
  return i>=0&&track.valid[i] ? {frame:i,shear:track.shear[i],fz:track.fz[i],time:track.time[i]} : null;
}
export async function videoHash(blob:Blob,signal?:AbortSignal):Promise<string> {
  const digest=sha256.create();
  // Blob slices make cancellation bounded even on browsers without Blob.stream().
  for(let offset=0;offset<blob.size;offset+=1024*1024){
    signal?.throwIfAborted();digest.update(new Uint8Array(await blob.slice(offset,offset+1024*1024).arrayBuffer()));
  }
  signal?.throwIfAborted();return Array.from(digest.digest(),b=>b.toString(16).padStart(2,'0')).join('');
}
export function forceTrackKey(t:ForceTrack) {return `${t.video.sha256}:${t.sensor}:${t.model.id}:${t.model.weightsSha256}:${t.model.pipeline}`;}
export class ForceCache {
  private entries=new Map<string,{track:ForceTrack;bytes:number}>();
  bytes=0;
  readonly limit:number;
  constructor(limit=32*1024*1024){this.limit=limit;}
  put(track:ForceTrack){
    const key=forceTrackKey(track),old=this.entries.get(key);
    if(old){this.bytes-=old.bytes;this.entries.delete(key);}
    const bytes=track.time.byteLength+track.shear.byteLength+track.fz.byteLength+track.valid.byteLength+1024;
    if(bytes>this.limit)return;
    while(this.bytes+bytes>this.limit){const first=this.entries.keys().next().value!;this.bytes-=this.entries.get(first)!.bytes;this.entries.delete(first);}
    this.entries.set(key,{track,bytes});this.bytes+=bytes;
  }
  get(sha:string,sensor:string,weightsSha:string):ForceTrack|undefined {
    const key=`${sha}:${sensor}:${FORCE_MODEL}:${weightsSha}:${FORCE_PIPELINE}`,entry=this.entries.get(key);
    if(entry){this.entries.delete(key);this.entries.set(key,entry);return entry.track;}
  }
  clear(){this.entries.clear();this.bytes=0;}
}
