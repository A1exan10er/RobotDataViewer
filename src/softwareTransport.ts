import type { RegionGeometry } from './tactileRoi';
import type { TactileBaseline } from './tactileFilter';
import { discardPastFrames } from './frameQueue.ts';
export interface Transport {
  error:boolean; ready:boolean; currentTime:number;
  prepare(time:number,ahead?:number):boolean;
  prepareCatchUp?(time:number,ahead:number):boolean;
  present(time:number,rate:number,playing:boolean):void;
  seek(time:number,present?:boolean):Promise<void>;
  pause():void;
  dispose():void;
}
export type DecoderResources={wasmBinary:Uint8Array;wasmModule?:WebAssembly.Module};
export type DecodedFrame={time:number;width:number;height:number;pixels?:ArrayBuffer;gray?:ArrayBuffer;image?:ImageBitmap;differenceImage?:ImageBitmap;difference?:ArrayBuffer;reference?:TactileBaseline;gain:number;cleanup:boolean};
export function closeFrame(frame:DecodedFrame){frame.image?.close();frame.differenceImage?.close();}
export class DecoderTransport implements Transport {
  error=false;ready=false;currentTime=-1;private gain=10;private cleanup=true;
  private worker:Worker;private queue:DecodedFrame[]=[];private serial=0;private version=0;private eof=false;private pending=false;private dead=false;
  private calls=new Map<number,{resolve:(value:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  readonly initialized:Promise<void>;
  reference?:TactileBaseline;
  private bufferSize:number;private readonly fps:number;private reserveTarget=0;private playing=false;private seedBytes=0;
  private pts:number[];private draw:(frame:DecodedFrame)=>void;private failed:(error:unknown)=>void;
  private diagnostics:(metrics:Record<string,number>)=>void;private readonly isTactile:boolean;
  constructor(worker:Worker,resources:Uint8Array|Promise<DecoderResources>,blob:Blob,pts:number[],fps:number,draw:(frame:DecodedFrame)=>void,failed:(error:unknown)=>void,isTactile=false,reference?:TactileBaseline,diagnostics=(metrics:Record<string,number>)=>{void metrics;},probeOnly=false){
    this.isTactile=isTactile;this.pts=pts;this.draw=draw;this.failed=failed;this.diagnostics=diagnostics;
    this.fps=Math.max(1,fps);this.bufferSize=Math.max(8,Math.min(40,Math.ceil(this.fps*1.2)));
    this.worker=worker;
    this.worker.onmessage=e=>{const p=this.calls.get(e.data.id);if(!p){e.data.result?.frames?.forEach(closeFrame);return;}this.calls.delete(e.data.id);clearTimeout(p.timer);e.data.error?p.reject(new Error(e.data.error)):p.resolve(e.data.result);};
    this.worker.onerror=()=>{if(this.dead)return;this.error=true;const error=new Error('decoder');for(const p of this.calls.values()){clearTimeout(p.timer);p.reject(error);}this.calls.clear();this.failed(error);};
    const initialize=async({wasmBinary,wasmModule}:DecoderResources)=>{
      const args={blob,frameRate:fps,frameCount:pts.length,isTactile,reference,probeOnly,pixelMode:typeof createImageBitmap!=='function'};
      try{return await this.rpc('init',{...args,...(wasmModule?{wasmModule}:{wasmBinary})});}
      catch(error){if(wasmModule&&error instanceof Error&&error.name==='DataCloneError')return this.rpc('init',{...args,wasmBinary});throw error;}
    };
    this.initialized=(resources instanceof Uint8Array?initialize({wasmBinary:resources}):resources.then(initialize)).then(result=>{
      this.reference=result?.reference;this.metrics(result?.metrics);
      if(!isTactile)return this.fill(0,false);
    }).then(()=>{
      if(isTactile||this.dead)return;
      if(!this.queue.length)throw new Error('No decoded frames');
      this.resize();this.ready=true;this.present(0,1,false);
    });
    void this.initialized.catch(error=>{if(!this.dead&&!this.error){this.error=true;this.failed(error);}});
  }
  async probeRegion(blob:Blob,width:number,height:number):Promise<RegionGeometry|undefined>{
    await this.initialized;const result=await this.rpc('probeRegion',{blob,width,height});this.metrics(result.metrics);return result.geometry;
  }
  async geometry(episodeId:string):Promise<RegionGeometry|undefined>{return (await this.rpc('geometry',{episodeId})).geometry;}
  async adoptRegion(donor:RegionGeometry):Promise<TactileBaseline|undefined>{
    if(this.ready||this.pending||this.queue.length)throw new Error('Region must be resolved before staging');
    const model=(await this.rpc('adoptRegion',{donor})).reference;
    if(model)this.reference=model;return model;
  }
  private metrics(metrics?:Record<string,number>){if(metrics){this.seedBytes=metrics.seedBytes||0;this.diagnostics(metrics);}}
  private resize(){
    const first=this.queue[0];if(!first)return;
    const bytes=first.width*first.height*(first.gray?5:4);
    this.bufferSize=Math.min(40,Math.max(8,Math.ceil(this.fps*1.2)),Math.max(1,Math.floor((64*1024*1024-this.seedBytes)/bytes)));
  }
  private rpc(method:string,args:unknown,transfer:Transferable[]=[]):Promise<any>{
    if(this.dead)return Promise.reject(new Error('disposed'));
    return new Promise((resolve,reject)=>{
      const id=++this.serial,timer=setTimeout(()=>{this.calls.delete(id);reject(new Error('decoder timeout'));},30000);
      this.calls.set(id,{resolve,reject,timer});
      try{this.worker.postMessage({id,method,args},transfer);}catch(error){clearTimeout(timer);this.calls.delete(id);reject(error);}
    });
  }
  private target(time:number){let lo=0,hi=this.pts.length;while(lo<hi){const m=(lo+hi)>>>1;if(this.pts[m]<=time+.000001)lo=m+1;else hi=m;}return this.pts[Math.max(0,lo-1)]||0;}
  private async fill(time:number,seek:boolean,limit=4){
    const version=this.version;this.pending=true;
    try{
      const result=await this.rpc('batch',{time:this.target(time),seek,gain:this.gain,cleanup:this.cleanup,limit});
      if(version!==this.version||this.dead){result.frames.forEach(closeFrame);return;}
      this.queue.push(...result.frames);this.eof=result.eof;this.metrics(result.metrics);this.resize();
    }catch(error){if(version===this.version&&!this.dead)throw error;}
    finally{if(version===this.version)this.pending=false;}
  }
  private refill(){
    if(this.dead||this.pending||this.eof||!this.ready||this.queue.length>=this.bufferSize||this.queue.at(-1)!.time>=this.reserveTarget-.002)return;
    void this.fill(this.queue.at(-1)?.time||0,false,Math.min(4,this.bufferSize-this.queue.length)).then(()=>this.refill()).catch(error=>{if(!this.dead&&!this.error){this.error=true;this.failed(error);}});
  }
  prepare(time:number,ahead=0){
    if(!this.ready||this.error)return false;
    const target=this.target(time+Math.min(ahead,Math.max(0,this.bufferSize-2)/this.fps));
    // Stage only the requested reserve. Further decode-ahead begins on joint Play.
    this.reserveTarget=this.playing?this.target(time+Math.max(0,this.bufferSize-2)/this.fps):target;
    this.refill();
    return !!this.queue.length&&this.queue[0].time<=this.target(time)+.002&&(this.queue.at(-1)!.time>=target-.002||this.eof);
  }
  prepareCatchUp(time:number,ahead:number){discardPastFrames(this.queue,this.target(time),closeFrame);return this.prepare(time,ahead);}
  present(time:number,_rate:number,playing:boolean){
    this.playing=playing;
    const target=this.target(time);discardPastFrames(this.queue,target,closeFrame);
    const frame=this.queue[0];if(frame&&frame.time<=target+.002&&(this.currentTime!==frame.time||!this.ready)){this.currentTime=frame.time;this.draw(frame);}
  }
  setGain(gain:number){this.gain=gain;}
  setCleanup(cleanup:boolean){this.cleanup=cleanup;}
  async redraw(frame:DecodedFrame,gain:number,cleanup:boolean):Promise<DecodedFrame>{
    if(!frame.gray)throw new Error('No grayscale frame');
    // Keep the displayed sample for subsequent settings changes; only this copy
    // moves to the existing decoder worker. No additional renderer is allocated.
    const gray=frame.gray.slice(0);
    const result=await this.rpc('redraw',{gray,time:frame.time,gain,cleanup},[gray]);
    return result.frames[0];
  }
  async seek(time:number,present=true){
    await this.initialized;if(this.dead)return;
    const target=this.target(time);this.playing=false;this.reserveTarget=target;
    if(this.ready&&this.queue.length&&this.queue[0].time<=target+.002&&this.queue.at(-1)!.time>=target-.002){
      // Reuse valid decoded pixels (including an in-flight contiguous refill).
      discardPastFrames(this.queue,target,closeFrame);
      // RGB bitmaprenderer consumes the bitmap on first presentation. If that
      // exact frame is still on its canvas, acknowledge it without transferring
      // the consumed bitmap again. Tactile staging needs its grayscale callback.
      if(this.isTactile)this.currentTime=-1;
      if(present)this.present(time,1,false);return;
    }
    const version=++this.version;this.queue.forEach(closeFrame);this.queue=[];this.pending=false;this.eof=false;this.ready=false;
    await this.fill(time,true);if(this.dead||version!==this.version)return;
    if(!this.queue.length)throw new Error('No frame at seek target');
    this.ready=true;this.currentTime=-1;if(present)this.present(time,1,false);
  }
  pause(){this.playing=false;}
  dispose(){if(this.dead)return;this.dead=true;this.ready=false;++this.version;this.worker.terminate();this.queue.forEach(closeFrame);this.queue=[];this.reference=undefined;for(const p of this.calls.values()){clearTimeout(p.timer);p.reject(new Error('disposed'));}this.calls.clear();}
}
