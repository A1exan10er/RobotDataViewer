import type { CaptureContext, Episode } from './types.ts';
import type { RecordingSource } from './source';
import type { TactileBaseline } from './tactileFilter';
import type { RegionGeometry } from './tactileRoi';
import { tactileCache, type TactileCache } from './tactileCache.ts';

const text=(value:unknown)=>typeof value==='string'?value.trim():'';
export function captureContext(metadata:any):CaptureContext|undefined {
  const task=text(metadata?.task_key)||text(metadata?.task_title)||text(metadata?.task_name),operator=text(metadata?.username);
  if(!task||!operator)return;
  const time=Date.parse(metadata.start_time);
  return {task,operator,device:text(metadata.collector_device_id)||undefined,session:text(metadata.recording_session_id)||undefined,time:Number.isFinite(time)?time:undefined};
}
export function matchingNeighbors(episodes:Episode[],current:Episode,channel:string,dimensions?:{width:number;height:number}):Episode[]{
  const c=current.capture;if(!c)return [];
  return episodes.filter(ep=>{
    const d=ep.capture,media=ep.media.find(m=>m.id===channel&&m.kind==='tactile');
    if(ep.id===current.id||!d||d.task!==c.task||d.operator!==c.operator||ep.robot!==current.robot||!media)return false;
    if(dimensions&&((media.width&&media.width!==dimensions.width)||(media.height&&media.height!==dimensions.height)))return false;
    if(c.device&&d.device)return c.device===d.device;
    // A missing identity is not a match by itself. A shared capture session is required.
    return !!c.session&&c.session===d.session;
  }).sort((a,b)=>{
    const same=(e:Episode)=>c.session&&e.capture?.session===c.session?0:1;
    const distance=(e:Episode)=>c.time!==undefined&&e.capture?.time!==undefined?Math.abs(e.capture.time-c.time):Infinity;
    return same(a)-same(b)||(distance(a)-distance(b)||0)||a.id.localeCompare(b.id);
  }).slice(0,4);
}
export interface RegionOperations {
  probe(blob:Blob,width:number,height:number):Promise<RegionGeometry|undefined>;
  adopt(donor:RegionGeometry):Promise<TactileBaseline|undefined>;
  geometry(episodeId:string):Promise<RegionGeometry|undefined>;
}
/** Source-scoped coordinator. Calls run inside the panel's existing calibration job. */
export class TactileRecovery {
  private source:RecordingSource;private cache:TactileCache;
  constructor(source:RecordingSource,cache:TactileCache=tactileCache){this.source=source;this.cache=cache;}
  async resolve(ep:Episode,channel:string,model:TactileBaseline,ops:RegionOperations,signal:AbortSignal,progress:(episodeId:string)=>void):Promise<TactileBaseline>{
    signal.throwIfAborted();
    const media=ep.media.find(m=>m.id===channel),own=media&&this.source.file(media.path);
    if(model.roiStatus==='ready'){
      if(own&&model.roiMethod!=='neighbor'&&model.roiCurve?.length){
        const geometry=await ops.geometry(ep.id);signal.throwIfAborted();if(geometry)this.cache.putGeometry(own,geometry);
      }
      return model;
    }
    for(const donor of matchingNeighbors(this.source.manifest.episodes,ep,channel,model)){
      signal.throwIfAborted();const media=donor.media.find(m=>m.id===channel)!,blob=this.source.file(media.path);if(!blob)continue;
      if(media.width&&media.height&&(media.width!==model.width||media.height!==model.height))continue;
      progress(donor.id);
      try{
        let geometry=this.cache.getGeometry(blob);
        if(!geometry){geometry=await ops.probe(blob,model.width,model.height);signal.throwIfAborted();if(geometry){geometry.episodeId=donor.id;this.cache.putGeometry(blob,geometry);}}
        if(!geometry||geometry.width!==model.width||geometry.height!==model.height)continue;
        const resolved=await ops.adopt(geometry);signal.throwIfAborted();if(resolved?.roiStatus==='ready')return resolved;
      }catch{signal.throwIfAborted();/* A corrupt donor does not fail the current sensor. */}
    }
    return model;
  }
}
