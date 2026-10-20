import type { TactileBaseline } from './tactileFilter';
import type { RegionGeometry } from './tactileRoi';

export const cloneBaseline=(model:TactileBaseline):TactileBaseline=>({...model,baseline:model.baseline.slice(),noiseFloor:model.noiseFloor.slice(),roiMask:model.roiMask.slice(),roiCurve:model.roiCurve?.slice()});
const cloneGeometry=(g:RegionGeometry):RegionGeometry=>({...g,curve:g.curve.slice(),rim:g.rim.slice()});
// Includes broader detection, checked donor geometry and per-episode provenance.
export const calibrationKey=(path:string,fps:number,frames:number)=>`quiet-prefix-median-p99-roi-v4:${path}:${fps}:${frames}`;
type Entry={model?:TactileBaseline;geometry?:RegionGeometry;bytes:number};
/** Completed models and compact donor geometry share one bounded LRU. No media retained. */
export class TactileCache {
  private identities=new WeakMap<Blob,number>();private serial=0;
  private entries=new Map<string,Entry>();private bytes=0;
  readonly limit:number;
  constructor(limit=32*1024*1024){this.limit=limit;}
  get sizeBytes(){return this.bytes;}
  private key(blob:Blob,path:string){let id=this.identities.get(blob);if(id===undefined){id=++this.serial;this.identities.set(blob,id);}return `${id}:${path}`;}
  private read(key:string){const entry=this.entries.get(key);if(entry){this.entries.delete(key);this.entries.set(key,entry);}return entry;}
  private write(key:string,entry:Entry){
    const old=this.entries.get(key);if(old){this.bytes-=old.bytes;this.entries.delete(key);}
    if(entry.bytes>this.limit)return;
    while(this.bytes+entry.bytes>this.limit){const [key,old]=this.entries.entries().next().value!;this.entries.delete(key);this.bytes-=old.bytes;}
    this.entries.set(key,entry);this.bytes+=entry.bytes;
  }
  get(blob:Blob,path:string){const model=this.read(this.key(blob,path))?.model;return model&&cloneBaseline(model);}
  put(blob:Blob,path:string,model:TactileBaseline){
    if(model.roiStatus!=='ready')return;
    this.write(this.key(blob,path),{model:cloneBaseline(model),bytes:model.baseline.byteLength+model.noiseFloor.byteLength+model.roiMask.byteLength+(model.roiCurve?.byteLength||0)+(model.roiDonor?.length||0)*2});
  }
  getGeometry(blob:Blob){const g=this.read(this.key(blob,'geometry-v2'))?.geometry;return g&&cloneGeometry(g);}
  putGeometry(blob:Blob,g:RegionGeometry){this.write(this.key(blob,'geometry-v2'),{geometry:cloneGeometry(g),bytes:g.curve.byteLength+g.rim.byteLength+g.episodeId.length*2});}
  clear(){this.entries.clear();this.identities=new WeakMap();this.bytes=0;}
}
export const tactileCache=new TactileCache();
