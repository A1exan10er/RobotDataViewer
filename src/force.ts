import { onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue';
import manifest from '../vendor/force/model.json';
import { forceDecoderResources } from './transport';
import { ForceCache, parseForceTracks, serializeForceTracks, videoHash, type ForceTrack, type ForceProgress } from './forceTracks';
import type { RecordingSource } from './source';
import type { Episode, EpisodeData, Media, Timing } from './types';
import type { Playback } from './playback';
import { nativeForce, type NativeItem, type StorageUsage } from './nativeForce';
import { playbackMark } from './playbackMetrics';

type Assets={worker:string;[key:string]:unknown};
let pendingAssets:Promise<Assets>|null=null;
function loadAssets():Promise<Assets>{
  if(pendingAssets)return pendingAssets;
  pendingAssets=new Promise<Assets>((resolve,reject)=>{
    const script=document.createElement('script');script.src=new URL('./force-runtime.js',location.href).href;
    script.onload=()=>{const g=globalThis as any,assets=g.RDV_FORCE_ASSETS;delete g.RDV_FORCE_ASSETS;script.remove();assets?resolve(assets):reject(new Error('forceRuntimeMissing'));};
    script.onerror=()=>{script.remove();reject(new Error('forceRuntimeMissing'));};
    document.head.append(script);
  }).finally(()=>{pendingAssets=null;});
  return pendingAssets;
}
class ForceWorker {
  private worker:Worker;private id=0;private pending?:{id:number;resolve:(v:any)=>void;reject:(e:unknown)=>void;timer:ReturnType<typeof setTimeout>};
  private dead=false;
  constructor(code:string,private signal:AbortSignal,private progress:(p:ForceProgress)=>void){
    const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
    try{this.worker=new Worker(url);}finally{URL.revokeObjectURL(url);}
    this.worker.onmessage=({data})=>{
      if(this.signal.aborted)return;
      if(data.progress){this.progress(data.progress);this.deadline();return;}
      if(data.id!==this.pending?.id)return;
      const pending=this.pending!;clearTimeout(pending.timer);this.pending=undefined;
      data.error?pending.reject(new Error(data.error)):pending.resolve(data.result);
    };
    this.worker.onerror=event=>{this.fail(new Error(event.message||'forceCalculationFailed'));this.dispose();};
    this.signal.addEventListener('abort',this.dispose,{once:true});
  }
  private fail(error:unknown){if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(error);this.pending=undefined;}}
  private deadline(){if(this.pending){clearTimeout(this.pending.timer);this.pending.timer=setTimeout(()=>{this.fail(new Error('forceCalculationFailed'));this.dispose();},90000);}}
  request(type:string,payload:object):Promise<any>{
    this.signal.throwIfAborted();
    if(this.dead)return Promise.reject(new Error('forceCalculationFailed'));
    return new Promise((resolve,reject)=>{
      this.pending={id:++this.id,resolve,reject,timer:setTimeout(()=>{},0)};this.deadline();
      try{this.worker.postMessage({id:this.id,type,...payload});}catch(error){this.fail(error);}
    });
  }
  dispose=()=>{if(this.dead)return;this.dead=true;this.signal.removeEventListener('abort',this.dispose);this.fail(new DOMException('Cancelled','AbortError'));this.worker.terminate();};
}
export function compatibleTrack(track:ForceTrack,media:Media,timing:Timing,blob:Blob){
  return track.model.weightsSha256===manifest.weightsSha256&&track.sensor===media.id&&track.video.bytes===blob.size&&
    track.video.frames===timing.media.length&&(!media.width||track.video.width===media.width)&&(!media.height||track.video.height===media.height)&&
    timing.media.every((t,i)=>Math.abs(t-track.time[i])<.002);
}
export function useForce(source:Ref<RecordingSource|null>,episode:Ref<Episode|null>,data:Ref<EpisodeData|null>,playback:Playback){
  const storage=shallowRef<StorageUsage|null>(null),diagnostics=shallowRef<unknown>(null);
  if(nativeForce)void nativeForce.usage().then(v=>storage.value=v).catch(()=>{});
  let browserFallback=false;
  const enabled=ref(false),preparing=ref(false),progress=shallowRef<ForceProgress|null>(null);
  const tracks=shallowRef<Record<string,ForceTrack>>({}),errors=shallowRef<Record<string,string>>({}),notice=ref('');
  const cache=new ForceCache(),externalFiles=new Set<Blob>();let hashes=new WeakMap<Blob,string>(),abort=new AbortController(),serial=0;
  let runner:ForceWorker|undefined;
  async function importBlob(blob:Blob,wanted?:(track:ForceTrack)=>boolean){
    const current=serial;
    if(blob.size>64*1024*1024)throw new Error('forceInvalidFile');
    const parsed=parseForceTracks(JSON.parse(await blob.text()));
    if(current!==serial)throw new DOMException('Cancelled','AbortError');
    if(parsed.some(t=>t.model.weightsSha256!==manifest.weightsSha256))throw new Error('forceInvalidFile');
    parsed.filter(t=>!wanted||wanted(t)).forEach(t=>cache.put(t));
  }
  function cancel(){++serial;abort.abort();runner?.dispose();runner=undefined;preparing.value=false;progress.value=null;playback.setExternalHold(false);}
  async function prepare(){
    cancel();tracks.value={};errors.value={};notice.value='';diagnostics.value=null;
    if(!enabled.value||!source.value||!episode.value||!data.value)return;
    const current=serial,selected=episode.value,recording=source.value,timings=data.value.timings;
    abort=new AbortController();const signal=abort.signal;
    const sensors=selected.media.filter(m=>m.kind==='tactile');
    preparing.value=true;playback.setExternalHold(true);
    const result:Record<string,ForceTrack>={},failures:Record<string,string>={};
    playbackMark('force-preparation-start',selected.id);
    try{
      const missing:NativeItem[]=[];
      for(const media of sensors){
        signal.throwIfAborted();progress.value={sensor:media.id,frame:0,frames:timings[media.id].media.length,stage:'checking'};
        const blob=recording.file(media.path);if(media.failed||!blob){failures[media.id]='forceCalculationFailed';continue;}
        let sha=hashes.get(blob);if(!sha){sha=await videoHash(blob,signal);hashes.set(blob,sha);}
        const cached=cache.get(sha,media.id,manifest.weightsSha256);
        if(cached&&compatibleTrack(cached,media,timings[media.id],blob)){result[media.id]=cached;playbackMark('force-cache-hit',media.id);}
        else missing.push({media,blob,sha,timing:timings[media.id]});
      }
      if(missing.length)for(const blob of [...externalFiles,...recording.forceFiles?.()||[]]){
        signal.throwIfAborted();
        try{await importBlob(blob,t=>missing.some(m=>m.sha===t.video.sha256&&m.media.id===t.sensor));}catch{signal.throwIfAborted();notice.value='forceInvalidFile';}
        for(let i=missing.length-1;i>=0;i--){const m=missing[i],cached=cache.get(m.sha,m.media.id,manifest.weightsSha256);
          if(cached&&compatibleTrack(cached,m.media,timings[m.media.id],m.blob)){result[m.media.id]=cached;missing.splice(i,1);}}
        if(!missing.length)break;
      }
      if(missing.length&&nativeForce){
        try{
          for(const track of await nativeForce.lookup(missing,signal)){
            const index=missing.findIndex(m=>m.sha===track.video.sha256&&compatibleTrack(track,m.media,m.timing,m.blob));
            if(index>=0){cache.put(track);result[track.sensor]=track;missing.splice(index,1);playbackMark('force-disk-cache-hit',track.sensor);}
          }
        }catch{signal.throwIfAborted();}
      }
      if(missing.length){
        // Finish the normal two-job tactile calibration before adding inference memory.
        if(playback.preparing.value)await new Promise<void>((resolve,reject)=>{
          const stop=watch(playback.preparing,v=>{if(!v){stop();signal.removeEventListener('abort',cancelWait);resolve();}});
          const cancelWait=()=>{stop();reject(signal.reason);};signal.addEventListener('abort',cancelWait,{once:true});
        });
        signal.throwIfAborted();progress.value={sensor:missing[0].media.id,frame:0,frames:0,stage:'loading'};
        if(nativeForce&&!browserFallback){
          const response=await nativeForce.calculate(missing,signal,p=>{if(current===serial)progress.value=p;});
          signal.throwIfAborted();diagnostics.value=response.diagnostics;
          for(const track of response.tracks){
            const item=missing.find(m=>m.media.id===track.sensor&&m.sha===track.video.sha256);
            if(!item||!compatibleTrack(track,item.media,item.timing,item.blob))throw new Error('forceInvalidFile');
            cache.put(track);result[track.sensor]=track;playbackMark('force-track-complete',track.sensor,{frames:track.time.length,backend:'native'});
          }
          for(const item of missing)if(!result[item.media.id])failures[item.media.id]='forceCalculationFailed';
          storage.value=await nativeForce.usage().catch(()=>storage.value);
        }else{
        const assets=await loadAssets();signal.throwIfAborted();
        const {worker:_,...payload}=assets;
        let backend='wasm';
        const initialize=async(forceWasm:boolean)=>{
          signal.throwIfAborted();runner?.dispose();
          const worker=new ForceWorker(assets.worker,signal,p=>{if(current===serial)progress.value=p;});runner=worker;
          const info=await worker.request('init',{assets:payload,decoder:await forceDecoderResources(),forceWasm});backend=info.backend;return worker;
        };
        const forceWasm=new URLSearchParams(location.search).has('forceWasm');
        let worker:ForceWorker;
        try{worker=await initialize(forceWasm);}catch(error){signal.throwIfAborted();if(forceWasm)throw error;worker=await initialize(true);}
        for(const {media,blob,sha} of missing){
          signal.throwIfAborted();
          try{
            const request={blob,sensor:media.id,sha,expectedFrames:timings[media.id].media.length};
            let response;
            try{response=await worker.request('calculate',request);}catch(error){
              signal.throwIfAborted();if(backend!=='webgpu')throw error;
              worker=await initialize(true);response=await worker.request('calculate',request);
            }
            signal.throwIfAborted();const track=response.track as ForceTrack;
            if(!compatibleTrack(track,media,timings[media.id],blob))throw new Error('forceInvalidFile');
            cache.put(track);result[media.id]=track;
            playbackMark('force-track-complete',media.id,{frames:track.time.length,seconds:response.seconds,backend:response.backend});
          }catch(error){signal.throwIfAborted();failures[media.id]='forceCalculationFailed';console.warn('Force preparation:',media.id,error);}
        }
        }
      }
      signal.throwIfAborted();tracks.value=result;errors.value=failures;
      playbackMark('force-preparation-complete',selected.id,{tracks:Object.keys(result).length,failures:Object.keys(failures).length});
    }catch(error){
      if(!signal.aborted&&current===serial){
        console.warn('Force initialization:',error);
        notice.value=error instanceof Error&&error.message==='forceRuntimeMissing'?'forceRuntimeMissing':'forceCalculationFailed';
        sensors.forEach(m=>{if(!result[m.id])failures[m.id]=notice.value;});tracks.value=result;errors.value=failures;
      }
    }finally{if(current===serial){runner?.dispose();runner=undefined;preparing.value=false;progress.value=null;playback.setExternalHold(false);}}
  }
  watch(source,()=>{cancel();cache.clear();externalFiles.clear();hashes=new WeakMap();enabled.value=false;tracks.value={};errors.value={};browserFallback=false;},{flush:'sync'});
  watch([enabled,episode],()=>{void prepare();},{flush:'post'});
  onBeforeUnmount(cancel);
  async function removeSaved(all=false){
    const selected=episode.value,recording=source.value,timings=data.value?.timings;
    cancel();enabled.value=false;tracks.value={};errors.value={};externalFiles.clear();
    try{
      const items:NativeItem[]=[];
      if(!all&&selected&&recording&&timings)for(const media of selected.media.filter(m=>m.kind==='tactile'&&!m.failed)){
        const blob=recording.file(media.path);if(!blob)continue;
        const sha=hashes.get(blob)||await videoHash(blob);items.push({media,blob,sha,timing:timings[media.id]});
      }

      if(all)cache.clear();else items.forEach(m=>cache.remove(m.sha,m.media.id));
      if(nativeForce)storage.value=await nativeForce.remove(all?undefined:items);
      notice.value='forceRemoved';
    }catch{notice.value='forceRemoveFailed';}
  }
  return {enabled,preparing,progress,tracks,errors,notice,storage,diagnostics,removeSaved,native:!!nativeForce,
    retryBrowser:()=>{browserFallback=true;void prepare();},
    exportDiagnostics(){
      const url=URL.createObjectURL(new Blob([JSON.stringify({version:1,preparation:diagnostics.value,storage:storage.value},null,2)],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download='force-diagnostics.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    },
    cancel:()=>{enabled.value=false;cancel();},retry:prepare,
    async importFile(blob:Blob){const current=serial;try{await importBlob(blob);externalFiles.add(blob);notice.value='forceImported';if(enabled.value)await prepare();}catch{if(current===serial)notice.value='forceInvalidFile';}},
    exportFile(){const values=Object.values(tracks.value);if(!values.length)return;
      const url=URL.createObjectURL(new Blob([serializeForceTracks(values)],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download='force-estimates.rdv-force.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);},
  };
}
