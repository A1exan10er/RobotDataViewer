/** Optional authenticated loopback API. Importing this module never loads inference. */
import manifest from '../vendor/force/model.json';
import { parseForceTracks, serializeForceTracks, type ForceProgress, type ForceTrack } from './forceTracks';
import type { ForceStorageUsage } from './forceStore';
import type { Media, Timing } from './types';
export type NativeItem={media:Media;blob:Blob;sha:string;timing:Timing};
export type StorageUsage=ForceStorageUsage;
export type ForceBackend='auto'|'cpu'|'gpu';
const local=location.protocol==='http:'&&location.hostname==='127.0.0.1';
const fragment=new URLSearchParams(location.hash.slice(1));
let token=local?fragment.get('native'):null;
if(local){
  try{
    if(token)sessionStorage.setItem('rdv-native-token',token);
    else token=sessionStorage.getItem('rdv-native-token');
  }catch{/* A private browser may disable storage; the launch token still works in memory. */}
  if(fragment.has('native'))history.replaceState(null,'',location.pathname+location.search);
}
export function nativeIdentity(item:NativeItem){
  return {sensor:item.media.id,video:{sha256:item.sha,bytes:item.blob.size,frames:item.timing.media.length,width:item.media.width,height:item.media.height},
    model:{id:manifest.model,weightsSha256:manifest.weightsSha256,pipeline:manifest.pipeline},reference:{frame:0 as const,time:item.timing.media[0]},time:Array.from(item.timing.media)};
}
async function request(path:string,method='GET',body?:unknown,signal?:AbortSignal,headers:Record<string,string>={}){
  signal?.throwIfAborted();
  const deadline=new AbortController(),forward=()=>deadline.abort(signal?.reason);
  signal?.addEventListener('abort',forward,{once:true});
  const timer=setTimeout(()=>deadline.abort(new Error('Native force request timed out')),30000);
  try{
  const response=await fetch('/api/v1/'+path,{method,signal:deadline.signal,headers:{Authorization:'Bearer '+token,...headers,...(body&&!(body instanceof Blob)?{'Content-Type':'application/json'}:{})},
    body:body instanceof Blob?body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:'omit'});
  if(!response.ok)throw new Error(`Native force service: ${response.status}`);
  return await response.json();
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',forward);}
}
let previousJob:Promise<void>=Promise.resolve();
export const nativeForce=token?{
  async usage():Promise<StorageUsage>{return (await request('capabilities')).storage;},
  async save(track:ForceTrack):Promise<StorageUsage>{return request('cache','PUT',JSON.parse(serializeForceTracks([track])));},
  async lookup(items:NativeItem[],signal:AbortSignal){return parseForceTracks(await request('cache','POST',{items:items.map(nativeIdentity)},signal));},
  async remove(items?:NativeItem[]):Promise<StorageUsage>{return request('cache','DELETE',items?{items:items.map(nativeIdentity)}:{});},
  async calculate(items:NativeItem[],signal:AbortSignal,progress:(p:ForceProgress)=>void,provider:ForceBackend='auto'):Promise<{tracks:ForceTrack[];errors:Record<string,string>;diagnostics:unknown;savedSensors?:string[];storageErrors?:Record<string,string>}>{
    const predecessor=previousJob;let release!:()=>void;previousJob=new Promise<void>(resolve=>release=resolve);
    let id:string|undefined;
    const abort=()=>{if(id)void request('jobs/'+id,'DELETE').catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
    const started=performance.now();
    try{
      await predecessor;signal.throwIfAborted();
      // Read the job id even if cancellation arrives during creation, so cleanup
      // can always address the server-owned job. Later transfers are abortable.
      const job=await request('jobs','POST',{items:items.map(nativeIdentity),provider});id=job.id;
      signal.throwIfAborted();
      for(let i=0;i<items.length;i++){
        const item=items[i];
        for(let offset=0;offset<item.blob.size;offset+=4*1024*1024){
          progress({sensor:item.media.id,frame:0,frames:item.timing.media.length,stage:'transferring',elapsed:(performance.now()-started)/1000});
          await request(`jobs/${id}/video/${i}`,'PUT',item.blob.slice(offset,offset+4*1024*1024),signal,{'X-Upload-Offset':String(offset)});
        }
      }
      await request(`jobs/${id}/start`,'POST',{},signal);
      while(true){
        signal.throwIfAborted();const state=await request('jobs/'+id,'GET',undefined,signal);
        if(state.progress)progress({...state.progress,elapsed:(performance.now()-started)/1000});
        else progress({sensor:items[0].media.id,frame:0,frames:0,stage:'loading',elapsed:(performance.now()-started)/1000});
        if(state.state==='failed'&&!state.tracks?.length)throw new Error('Native engine failed');
        if(state.state==='cancelled')throw new DOMException('Cancelled','AbortError');
        if(state.state==='complete'||state.state==='failed')return {tracks:parseForceTracks({format:'robot-data-viewer-force',version:1,tracks:state.tracks}),errors:state.errors,savedSensors:state.savedSensors,storageErrors:state.storageErrors,diagnostics:{sensors:state.diagnostics,transfer:state.transfer}};
        await new Promise<void>((resolve,reject)=>{
          const cancel=()=>{clearTimeout(timer);reject(signal.reason);};
          const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},200);
          signal.addEventListener('abort',cancel,{once:true});
        });
      }
    }finally{signal.removeEventListener('abort',abort);try{if(id)await request('jobs/'+id,'DELETE').catch(()=>{});}finally{release();}}
  }
}:null;
