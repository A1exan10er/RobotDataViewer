import { onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue';
import manifest from '../vendor/force/model.json';
import { forceDecoderResources } from './transport';
import { ForceCache, parseForceTracks, serializeForceTracks, videoHash, type ForceTrack, type ForceProgress } from './forceTracks';
import type { RecordingSource } from './source';
import type { Episode, EpisodeData, Media, Timing } from './types';
import type { Playback } from './playback';
import { nativeForce, nativeIdentity, type NativeItem, type StorageUsage, type ForceBackend } from './nativeForce';
import { reportPreparation } from './serviceLifecycle';
import { BrowserForceStore, savedForceKey } from './forceStore';
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
    track.model.id===manifest.model&&track.model.pipeline===manifest.pipeline&&
    track.video.frames===timing.media.length&&(!media.width||track.video.width===media.width)&&(!media.height||track.video.height===media.height)&&
    track.valid.length===timing.media.length&&track.valid.every(v=>v===1)&&
    timing.media.every((t,i)=>Math.abs(t-track.time[i])<.002);
}
function alignTrack(track:ForceTrack,timing:Timing):ForceTrack {
  // Decoders round equivalent MP4 timestamps differently. After compatibility
  // validation, store the viewer's canonical frame times for exact future lookup.
  return {...track,time:Float64Array.from(timing.media),reference:{frame:0,time:timing.media[0]}};
}
export function useForce(source:Ref<RecordingSource|null>,episode:Ref<Episode|null>,data:Ref<EpisodeData|null>,playback:Playback){
  const storage=shallowRef<StorageUsage|null>(null),diagnostics=shallowRef<unknown>(null);
  const browserStore=new BrowserForceStore(),provider=ref<ForceBackend>('auto'),reused=ref(0),saved=ref(0),storageWarning=ref('');
  const backend=ref(''),backendReason=ref('');
  const retained=new Set<string>();
  async function refreshStorage(){try{storage.value=await (nativeForce?nativeForce.usage():browserStore.usage());}catch{/* Saving reports actionable failures separately. */}}
  void refreshStorage();
  async function persist(track:ForceTrack){
    try{
      if(nativeForce)await nativeForce.save(track);else await browserStore.put(track);
      retained.add(savedForceKey(track));return true;
    }catch{return false;}
  }
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
  function cancel(){++serial;abort.abort();runner?.dispose();runner=undefined;if(preparing.value)void reportPreparation(false).catch(()=>{});preparing.value=false;progress.value=null;playback.setExternalHold(false);}
  async function prepare(){
    cancel();tracks.value={};errors.value={};notice.value='';diagnostics.value=null;reused.value=0;saved.value=0;storageWarning.value='';backend.value='';backendReason.value='';
    if(!enabled.value||!source.value||!episode.value||!data.value)return;
    const preparationStarted=performance.now();
    const current=serial,selected=episode.value,recording=source.value,timings=data.value.timings;
    abort=new AbortController();const signal=abort.signal;
    const sensors=selected.media.filter(m=>m.kind==='tactile');
    preparing.value=true;playback.setExternalHold(true);
    const result:Record<string,ForceTrack>={},failures:Record<string,string>={},saveAttempts=new Set<string>();
    playbackMark('force-preparation-start',selected.id);
    try{
      await reportPreparation(true);signal.throwIfAborted();
      const missing:NativeItem[]=[];
      for(const media of sensors){
        signal.throwIfAborted();progress.value={sensor:media.id,frame:0,frames:timings[media.id].media.length,stage:'checking'};
        const blob=recording.file(media.path);if(media.failed||!blob){failures[media.id]='forceCalculationFailed';continue;}
        let sha=hashes.get(blob);if(!sha){sha=await videoHash(blob,signal);hashes.set(blob,sha);}
        const cached=cache.get(sha,media.id,manifest.weightsSha256);
        if(cached&&compatibleTrack(cached,media,timings[media.id],blob)){result[media.id]=alignTrack(cached,timings[media.id]);reused.value++;playbackMark('force-cache-hit',media.id);}
        else missing.push({media,blob,sha,timing:timings[media.id]});
      }
      if(missing.length)for(const blob of [...externalFiles,...recording.forceFiles?.()||[]]){
        signal.throwIfAborted();
        try{await importBlob(blob,t=>missing.some(m=>m.sha===t.video.sha256&&m.media.id===t.sensor));}catch{signal.throwIfAborted();notice.value='forceInvalidFile';}
        for(let i=missing.length-1;i>=0;i--){const m=missing[i],cached=cache.get(m.sha,m.media.id,manifest.weightsSha256);
          if(cached&&compatibleTrack(cached,m.media,timings[m.media.id],m.blob)){result[m.media.id]=alignTrack(cached,m.timing);reused.value++;missing.splice(i,1);}}
        if(!missing.length)break;
      }
      if(missing.length&&nativeForce){
        try{
          for(const track of await nativeForce.lookup(missing,signal)){
            const index=missing.findIndex(m=>m.sha===track.video.sha256&&compatibleTrack(track,m.media,m.timing,m.blob));
            if(index>=0){cache.put(track);retained.add(savedForceKey(track));result[track.sensor]=track;reused.value++;missing.splice(index,1);playbackMark('force-disk-cache-hit',track.sensor);}
          }
        }catch{signal.throwIfAborted();storageWarning.value='forceStorageUnavailable';}
      }else if(missing.length){
        for(let i=missing.length-1;i>=0;i--){
          signal.throwIfAborted();const item=missing[i];let track:ForceTrack|undefined;
          try{track=await browserStore.get(nativeIdentity(item));}
          catch{signal.throwIfAborted();storageWarning.value='forceStorageUnavailable';break;}
          signal.throwIfAborted();
          if(track&&compatibleTrack(track,item.media,item.timing,item.blob)){
            cache.put(track);retained.add(savedForceKey(track));result[track.sensor]=track;reused.value++;missing.splice(i,1);
            playbackMark('force-disk-cache-hit',track.sensor,{backend:'indexeddb'});
          }
        }
      }
      if(missing.length){
        // Finish the normal two-job tactile calibration before adding inference memory.
        if(playback.preparing.value)await new Promise<void>((resolve,reject)=>{
          const stop=watch(playback.preparing,v=>{if(!v){stop();signal.removeEventListener('abort',cancelWait);resolve();}});
          const cancelWait=()=>{stop();reject(signal.reason);};signal.addEventListener('abort',cancelWait,{once:true});
        });
        signal.throwIfAborted();progress.value={sensor:missing[0].media.id,frame:0,frames:0,stage:'loading'};
        if(nativeForce&&!browserFallback){
          const response=await nativeForce.calculate(missing,signal,p=>{if(current===serial)progress.value=p;},provider.value);
          signal.throwIfAborted();diagnostics.value=response.diagnostics;
          const sensors=(response.diagnostics as {sensors?:{backend?:string;fallback?:string[]}[]}).sensors||[];
          backend.value=[...new Set(sensors.map(s=>s.backend).filter(Boolean))].join(', ');
          backendReason.value=[...new Set(sensors.flatMap(s=>s.fallback||[]))].join('; ');
          for(const track of response.tracks){
            const item=missing.find(m=>m.media.id===track.sensor&&m.sha===track.video.sha256);
            if(!item||!compatibleTrack(track,item.media,item.timing,item.blob))throw new Error('forceInvalidFile');
            cache.put(track);result[track.sensor]=track;playbackMark('force-track-complete',track.sensor,{frames:track.time.length,backend:'native'});
            if(response.savedSensors?.includes(track.sensor))retained.add(savedForceKey(track));
            else if(response.storageErrors?.[track.sensor]){saveAttempts.add(savedForceKey(track));storageWarning.value='forceSaveFailed';}
            // Older launchers have no save endpoint: lookup proves whether they kept it.
            else if(!response.savedSensors){
              try{const stored=await nativeForce.lookup([item],signal);if(stored.length)retained.add(savedForceKey(track));}
              catch{signal.throwIfAborted();storageWarning.value='forceSaveFailed';}
            }
          }
          for(const item of missing)if(!result[item.media.id])failures[item.media.id]='forceCalculationFailed';
          storage.value=await nativeForce.usage().catch(()=>storage.value);
        }else{
        const assets=await loadAssets();signal.throwIfAborted();
        const {worker:_,...payload}=assets;
        let workerBackend='wasm',completedFrames=0,processingStarted=performance.now();
        const overallFrames=missing.reduce((sum,m)=>sum+m.timing.media.length,0);
        const initialize=async(forceWasm:boolean)=>{
          signal.throwIfAborted();runner?.dispose();
          const worker=new ForceWorker(assets.worker,signal,p=>{
            if(current!==serial)return;
            const overallFrame=completedFrames+p.frame,elapsed=(performance.now()-preparationStarted)/1000;
            progress.value={...p,overallFrame,overallFrames,elapsed,backend:workerBackend,
              ...(p.stage==='calculating'&&overallFrame>0?{remaining:(performance.now()-processingStarted)/1000*(overallFrames-overallFrame)/overallFrame}:{})};
          });runner=worker;
          const info=await worker.request('init',{assets:payload,decoder:await forceDecoderResources(),forceWasm});workerBackend=info.backend;backend.value=workerBackend;
          if(provider.value==='gpu'&&workerBackend!=='webgpu')backendReason.value='WebGPU unavailable or numerical validation failed; using WASM.';
          return worker;
        };
        const forceWasm=provider.value==='cpu'||new URLSearchParams(location.search).has('forceWasm');
        let worker:ForceWorker;
        try{worker=await initialize(forceWasm);}catch(error){signal.throwIfAborted();if(forceWasm)throw error;worker=await initialize(true);}
        processingStarted=performance.now();
        for(const {media,blob,sha} of missing){
          signal.throwIfAborted();
          try{
            const request={blob,sensor:media.id,sha,expectedFrames:timings[media.id].media.length};
            let response;
            try{response=await worker.request('calculate',request);}catch(error){
              signal.throwIfAborted();if(workerBackend!=='webgpu')throw error;
              worker=await initialize(true);response=await worker.request('calculate',request);
            }
            signal.throwIfAborted();
            if(!compatibleTrack(response.track,media,timings[media.id],blob))throw new Error('forceInvalidFile');
            const track=alignTrack(response.track,timings[media.id]);
            cache.put(track);result[media.id]=track;
            saveAttempts.add(savedForceKey(track));
            if(!await persist(track)){signal.throwIfAborted();storageWarning.value='forceSaveFailed';}
            signal.throwIfAborted();
            playbackMark('force-track-complete',media.id,{frames:track.time.length,seconds:response.seconds,backend:response.backend});
          }catch(error){signal.throwIfAborted();failures[media.id]='forceCalculationFailed';console.warn('Force preparation:',media.id,error);}
          completedFrames+=timings[media.id].media.length;
        }
        }
      }
      // Imported/sidecar and previously unsaved memory results also become reusable.
      for(const track of Object.values(result)){
        signal.throwIfAborted();
        if(!retained.has(savedForceKey(track))&&!saveAttempts.has(savedForceKey(track))&&track.valid.every(v=>v===1)){
          if(!await persist(track)){signal.throwIfAborted();storageWarning.value='forceSaveFailed';}
        }
      }
      signal.throwIfAborted();tracks.value=result;errors.value=failures;
      await refreshStorage();
      playbackMark('force-preparation-complete',selected.id,{tracks:Object.keys(result).length,failures:Object.keys(failures).length});
    }catch(error){
      if(!signal.aborted&&current===serial){
        console.warn('Force initialization:',error);
        notice.value=error instanceof Error&&error.message==='forceRuntimeMissing'?'forceRuntimeMissing':'forceCalculationFailed';
        sensors.forEach(m=>{if(!result[m.id])failures[m.id]=notice.value;});tracks.value=result;errors.value=failures;
      }
    }finally{if(current===serial){saved.value=Object.values(result).filter(track=>retained.has(savedForceKey(track))).length;runner?.dispose();runner=undefined;preparing.value=false;void reportPreparation(false).catch(()=>{});progress.value=null;playback.setExternalHold(false);}}
  }
  watch(source,()=>{cancel();cache.clear();externalFiles.clear();retained.clear();hashes=new WeakMap();enabled.value=false;tracks.value={};errors.value={};reused.value=saved.value=0;storageWarning.value='';backend.value='';backendReason.value='';browserFallback=false;},{flush:'sync'});
  watch([enabled,episode],()=>{void prepare();},{flush:'post'});
  onBeforeUnmount(cancel);
  async function removeSaved(all=false){
    const selected=episode.value,recording=source.value,timings=data.value?.timings;
    cancel();enabled.value=false;tracks.value={};errors.value={};externalFiles.clear();reused.value=saved.value=0;storageWarning.value='';
    try{
      const items:NativeItem[]=[];
      if(!all&&selected&&recording&&timings)for(const media of selected.media.filter(m=>m.kind==='tactile'&&!m.failed)){
        const blob=recording.file(media.path);if(!blob)continue;
        const sha=hashes.get(blob)||await videoHash(blob);items.push({media,blob,sha,timing:timings[media.id]});
      }

      if(all){cache.clear();retained.clear();}else items.forEach(m=>{cache.remove(m.sha,m.media.id);retained.delete(savedForceKey(nativeIdentity(m)));});
      if(nativeForce)storage.value=await nativeForce.remove(all?undefined:items);
      else{await browserStore.remove(all?undefined:items.map(nativeIdentity));await refreshStorage();}
      notice.value='forceRemoved';
    }catch{notice.value='forceRemoveFailed';}
  }
  return {enabled,preparing,progress,tracks,errors,notice,storage,diagnostics,removeSaved,provider,reused,saved,storageWarning,backend,backendReason,native:!!nativeForce,
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
