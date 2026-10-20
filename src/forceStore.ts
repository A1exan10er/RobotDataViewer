import { sha256 } from '@noble/hashes/sha2.js';
import { parseForceTracks, serializeForceTracks, type ForceTrack } from './forceTracks.ts';

export type ForceIdentity = Pick<ForceTrack, 'sensor'|'video'|'model'|'reference'> & {time: ArrayLike<number>};
export type ForceStorageUsage = {bytes:number;tracks:number;limit:number|null;retention?:'persistent'|'lru'|'browser'};
export function savedForceKey(track:ForceIdentity):string {
  // Include the entire identity, not just the filename, weights or sensor.
  const {sensor,video:v,model:m,reference:r}=track;
  const value=JSON.stringify([sensor,v.sha256,v.bytes,v.width,v.height,v.frames,m.id,m.weightsSha256,m.pipeline,r.frame,r.time,Array.from(track.time)]);
  return Array.from(sha256(new TextEncoder().encode(value)),n=>n.toString(16).padStart(2,'0')).join('');
}

/** No model/runtime import. Browser-managed storage is best effort, never an archive. */
export class BrowserForceStore {
  private factory:IDBFactory|undefined;
  constructor(factory?:IDBFactory){
    try{this.factory=factory??globalThis.indexedDB;}catch{/* Storage can be disabled for this origin. */}
  }
  private open():Promise<IDBDatabase>{
    return new Promise((resolve,reject)=>{
      if(!this.factory){reject(new Error('Force storage unavailable'));return;}
      let request:IDBOpenDBRequest,expired=false;
      const timer=setTimeout(()=>{expired=true;reject(new Error('Force storage blocked'));},5000);
      try{request=this.factory.open('robot-data-viewer-force',1);}catch(error){clearTimeout(timer);reject(error);return;}
      request.onupgradeneeded=()=>{
        const store=request.result.createObjectStore('tracks',{keyPath:'key'});
        store.createIndex('bytes','bytes');
      };
      request.onerror=()=>{clearTimeout(timer);reject(request.error);};
      request.onblocked=()=>{expired=true;clearTimeout(timer);reject(new Error('Force storage blocked'));};
      request.onsuccess=()=>{
        if(expired){request.result.close();return;}
        clearTimeout(timer);request.result.onversionchange=()=>request.result.close();resolve(request.result);
      };
    });
  }
  private async transaction<T>(mode:IDBTransactionMode,work:(store:IDBObjectStore,done:(value:T)=>void)=>void):Promise<T>{
    const database=await this.open();
    try{return await new Promise<T>((resolve,reject)=>{
      const tx=database.transaction('tracks',mode);let value:T;
      const timer=setTimeout(()=>{tx.abort();reject(new Error('Force storage timed out'));},10000);
      tx.oncomplete=()=>{clearTimeout(timer);resolve(value);};
      tx.onabort=tx.onerror=()=>{clearTimeout(timer);reject(tx.error||new Error('Force storage failed'));};
      try{work(tx.objectStore('tracks'),result=>{value=result;});}catch(error){tx.abort();reject(error);}
    });}finally{database.close();}
  }
  async get(identity:ForceIdentity):Promise<ForceTrack|undefined>{
    const key=savedForceKey(identity);
    const entry=await this.transaction<any>('readonly',(store,done)=>{const request=store.get(key);request.onsuccess=()=>done(request.result);});
    if(!entry)return;
    try{
      if(typeof entry.body!=='string'||entry.body.length>64*1024*1024)throw new Error('Invalid saved track');
      const tracks=parseForceTracks(JSON.parse(entry.body)),track=tracks[0];
      if(tracks.length!==1||!track.valid.every(v=>v===1)||savedForceKey(track)!==key)throw new Error('Saved identity mismatch');
      return track;
    }catch{
      await this.transaction('readwrite',(store,done)=>{store.delete(key);done(undefined);});
      return;
    }
  }
  async put(track:ForceTrack):Promise<void>{
    if(!track.valid.every(v=>v===1))throw new Error('Cannot save incomplete force results');
    const body=serializeForceTracks([track]);
    if(body.length>64*1024*1024)throw new Error('Force result too large');
    parseForceTracks(JSON.parse(body));
    await this.transaction('readwrite',(store,done)=>{store.put({key:savedForceKey(track),body,bytes:new TextEncoder().encode(body).byteLength});done(undefined);});
  }
  async remove(identities?:ForceIdentity[]):Promise<void>{
    await this.transaction('readwrite',(store,done)=>{
      if(identities)identities.forEach(value=>store.delete(savedForceKey(value)));else store.clear();
      done(undefined);
    });
  }
  async usage():Promise<ForceStorageUsage>{
    return this.transaction('readonly',(store,done)=>{
      let bytes=0,tracks=0;
      // Key-only cursor avoids cloning all stored force arrays for a usage label.
      const request=store.index('bytes').openKeyCursor();
      request.onsuccess=()=>{const cursor=request.result;if(cursor){bytes+=Number(cursor.key);tracks++;cursor.continue();}
        else done({bytes,tracks,limit:null,retention:'browser'});};
    });
  }
}
