import type { TactileBaseline } from './tactileFilter';

export const cloneBaseline=(model:TactileBaseline):TactileBaseline=>({...model,baseline:model.baseline.slice(),noiseFloor:model.noiseFloor.slice(),roiMask:model.roiMask.slice()});
// Bump the revision when baseline statistics, arc detection or capture conventions change.
export const calibrationKey=(path:string,fps:number,frames:number)=>`median-p99-roi-v1:${path}:${fps}:${frames}`;
/** Owns only completed models, never source Blobs or calibration frames. */
export class TactileCache {
  private identities=new WeakMap<Blob,number>();private serial=0;
  private entries=new Map<string,TactileBaseline>();private bytes=0;
  readonly limit:number;
  constructor(limit=32*1024*1024){this.limit=limit;}
  get sizeBytes(){return this.bytes;}
  private key(blob:Blob,path:string){let id=this.identities.get(blob);if(id===undefined){id=++this.serial;this.identities.set(blob,id);}return `${id}:${path}`;}
  private size(model:TactileBaseline){return model.baseline.byteLength+model.noiseFloor.byteLength+model.roiMask.byteLength;}
  get(blob:Blob,path:string){const key=this.key(blob,path),model=this.entries.get(key);if(!model)return;this.entries.delete(key);this.entries.set(key,model);return cloneBaseline(model);}
  put(blob:Blob,path:string,model:TactileBaseline){
    const key=this.key(blob,path),old=this.entries.get(key);if(old){this.bytes-=this.size(old);this.entries.delete(key);}
    const bytes=this.size(model);if(bytes>this.limit)return;
    while(this.bytes+bytes>this.limit){const [key,old]=this.entries.entries().next().value!;this.entries.delete(key);this.bytes-=this.size(old);}
    this.entries.set(key,cloneBaseline(model));this.bytes+=bytes;
  }
  clear(){this.entries.clear();this.identities=new WeakMap();this.bytes=0;}
}
export const tactileCache=new TactileCache();
