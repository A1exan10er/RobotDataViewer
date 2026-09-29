/** Optional authenticated loopback API. Importing this module never loads inference. */
import manifest from '../vendor/force/model.json';
import { parseForceTracks, type ForceProgress, type ForceTrack } from './forceTracks';
import type { Media, Timing } from './types';
export type NativeItem={media:Media;blob:Blob;sha:string;timing:Timing};
export type StorageUsage={bytes:number;limit:number;tracks:number};
const local=location.protocol==='http:'&&location.hostname==='127.0.0.1';
const fragment=new URLSearchParams(location.hash.slice(1));
let token=local?fragment.get('native'):null;
if(local){
  if(token){sessionStorage.setItem('rdv-native-token',token);history.replaceState(null,'',location.pathname+location.search);}
  else token=sessionStorage.getItem('rdv-native-token');
}
export function nativeIdentity(item:NativeItem){
  return {sensor:item.media.id,video:{sha256:item.sha,bytes:item.blob.size,frames:item.timing.media.length,width:item.media.width,height:item.media.height},
    model:{id:manifest.model,weightsSha256:manifest.weightsSha256,pipeline:manifest.pipeline},reference:{frame:0,time:item.timing.media[0]},time:Array.from(item.timing.media)};
}
async function request(path:string,method='GET',body?:unknown,signal?:AbortSignal,headers:Record<string,string>={}){
  const response=await fetch('/api/v1/'+path,{method,signal,headers:{Authorization:'Bearer '+token,...headers,...(body&&!(body instanceof Blob)?{'Content-Type':'application/json'}:{})},
    body:body instanceof Blob?body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:'omit'});
  if(!response.ok)throw new Error(`Native force service: ${response.status}`);
  return response.json();
}
let previousJob:Promise<void>=Promise.resolve();
export const nativeForce=token?{
  async usage():Promise<StorageUsage>{return (await request('capabilities')).storage;},
  async lookup(items:NativeItem[],signal:AbortSignal){return parseForceTracks(await request('cache','POST',{items:items.map(nativeIdentity)},signal));},
  async remove(items?:NativeItem[]):Promise<StorageUsage>{return request('cache','DELETE',items?{items:items.map(nativeIdentity)}:{});},
  async calculate(items:NativeItem[],signal:AbortSignal,progress:(p:ForceProgress)=>void):Promise<{tracks:ForceTrack[];errors:Record<string,string>;diagnostics:unknown}>{
    const predecessor=previousJob;let release!:()=>void;previousJob=new Promise<void>(resolve=>release=resolve);
    let id:string|undefined;
    const abort=()=>{if(id)void request('jobs/'+id,'DELETE').catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
    const started=performance.now();
    try{
      await predecessor;signal.throwIfAborted();
      // Read the job id even if cancellation arrives during creation, so cleanup
      // can always address the server-owned job. Later transfers are abortable.
      const job=await request('jobs','POST',{items:items.map(nativeIdentity)});id=job.id;
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
        if(state.state==='failed')throw new Error('Native engine failed');
        if(state.state==='cancelled')throw new DOMException('Cancelled','AbortError');
        if(state.state==='complete')return {tracks:parseForceTracks({format:'robot-data-viewer-force',version:1,tracks:state.tracks}),errors:state.errors,diagnostics:{sensors:state.diagnostics,transfer:state.transfer}};
        await new Promise<void>((resolve,reject)=>{
          const cancel=()=>{clearTimeout(timer);reject(signal.reason);};
          const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},200);
          signal.addEventListener('abort',cancel,{once:true});
        });
      }
    }finally{signal.removeEventListener('abort',abort);try{if(id)await request('jobs/'+id,'DELETE').catch(()=>{});}finally{release();}}
  }
}:null;
