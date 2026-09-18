import workerCode from '../vendor/decoder-worker.js?raw';
import wasmBase64 from '../vendor/decoder.wasm.b64?raw';
export interface Transport {
  error:boolean; ready:boolean; currentTime:number;
  prepare(time:number,ahead?:number):boolean;
  present(time:number,rate:number,playing:boolean):void;
  seek(time:number):Promise<void>;
  pause():void;
  dispose():void;
}
export { NativeTransport } from './nativeTransport';
export type DecodedFrame={time:number;width:number;height:number;pixels?:ArrayBuffer;image?:ImageBitmap;differenceImage?:ImageBitmap;difference?:ArrayBuffer;reference?:ArrayBuffer;gain:number;cleanup:boolean};
export function closeFrame(frame:DecodedFrame){frame.image?.close();frame.differenceImage?.close();}
let workerUrl='';let wasmBinary:Uint8Array;
function resources(){
  if(!workerUrl){workerUrl=URL.createObjectURL(new Blob([workerCode],{type:'text/javascript'}));
    wasmBinary=Uint8Array.from(atob(wasmBase64.trim()),c=>c.charCodeAt(0));}
  return {workerUrl,wasmBinary};
}
export class SoftwareTransport implements Transport {
  error=false;ready=false;currentTime=-1;private gain=1;private cleanup=true;
  private worker:Worker;private queue:DecodedFrame[]=[];private serial=0;private version=0;private eof=false;private pending=false;private dead=false;
  private calls=new Map<number,{resolve:(value:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private initialized:Promise<void>;
  private bufferSize:number;private readonly fps:number;
  constructor(blob:Blob,private pts:number[],fps:number,private draw:(frame:DecodedFrame)=>void,private failed:(error:unknown)=>void,isTactile=false){
    this.fps=Math.max(1,fps);this.bufferSize=Math.max(8,Math.min(40,Math.ceil(this.fps*1.2)));
    const urls=resources();this.worker=new Worker(urls.workerUrl);
    this.worker.onmessage=e=>{const p=this.calls.get(e.data.id);if(!p){e.data.result?.frames?.forEach(closeFrame);return;}this.calls.delete(e.data.id);clearTimeout(p.timer);e.data.error?p.reject(new Error(e.data.error)):p.resolve(e.data.result);};
    this.worker.onerror=()=>{this.error=true;for(const p of this.calls.values()){clearTimeout(p.timer);p.reject(new Error('decoder'));}this.calls.clear();};
    this.initialized=this.rpc('init',{blob,wasmBinary:urls.wasmBinary,frameRate:fps,isTactile}).then(()=>this.fill(0,false)).then(()=>{if(!this.queue.length)throw new Error('No decoded frames');const first=this.queue[0];this.bufferSize=Math.min(this.bufferSize,Math.max(4,Math.floor(64*1024*1024/(first.width*first.height*(isTactile?8:4)))));this.ready=true;this.present(0,1,false);this.refill();});
    void this.initialized.catch(error=>{if(!this.dead){this.error=true;this.failed(error);}});
  }
  private rpc(method:string,args:unknown):Promise<any>{
    return new Promise((resolve,reject)=>{const id=++this.serial;const timer=setTimeout(()=>{this.calls.delete(id);reject(new Error('decoder timeout'));},30000);this.calls.set(id,{resolve,reject,timer});this.worker.postMessage({id,method,args});});
  }
  private target(time:number){let lo=0,hi=this.pts.length;while(lo<hi){const m=(lo+hi)>>>1;if(this.pts[m]<=time+.000001)lo=m+1;else hi=m;}return this.pts[Math.max(0,lo-1)]||0;}
  private async fill(time:number,seek:boolean){
    const version=this.version;this.pending=true;
    try{const result=await this.rpc('batch',{time:this.target(time),seek,gain:this.gain,cleanup:this.cleanup});if(version!==this.version||this.dead){result.frames.forEach(closeFrame);return;}this.queue.push(...result.frames);this.eof=result.eof;}
    finally{if(version===this.version)this.pending=false;}
  }
  private refill(){
    if(this.dead||this.pending||this.eof||!this.ready||this.queue.length>=this.bufferSize)return;
    void this.fill(this.queue.at(-1)?.time||0,false).then(()=>this.refill()).catch(error=>{if(!this.dead){this.error=true;this.failed(error);}});
  }
  prepare(time:number,ahead=0){
    if(!this.ready||this.error)return false;
    // Keep a bounded reserve, including while paused. Resume only once it is replenished.
    this.refill();
    const target=this.target(time+Math.min(ahead,(this.bufferSize-2)/this.fps));
    return !!this.queue.length&&(this.queue.at(-1)!.time>=target-.002||this.eof);
  }
  present(time:number,_rate:number,_playing:boolean){
    const target=this.target(time);let index=0;
    while(index+1<this.queue.length&&this.queue[index+1].time<=target+.002)index++;
    if(index)this.queue.splice(0,index).forEach(closeFrame);
    const frame=this.queue[0];if(frame&&(this.currentTime!==frame.time||!this.ready)){this.currentTime=frame.time;this.draw(frame);}

  }
  setGain(gain:number){this.gain=gain;}
  setCleanup(cleanup:boolean){this.cleanup=cleanup;}
  async seek(time:number){
    await this.initialized;if(this.dead)return;
    ++this.version;this.queue.forEach(closeFrame);this.queue=[];this.pending=false;this.eof=false;this.ready=false;
    await this.fill(time,true);if(this.dead)return;
    if(!this.queue.length)throw new Error('No frame at seek target');
    this.ready=true;this.currentTime=-1;this.present(time,1,false);this.refill();
  }
  pause(){}
  dispose(){this.dead=true;++this.version;this.worker.terminate();this.queue.forEach(closeFrame);this.queue=[];for(const p of this.calls.values()){clearTimeout(p.timer);p.reject(new Error('disposed'));}this.calls.clear();}
}
