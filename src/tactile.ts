import workerCode from '../tools/tactile-worker.js?raw';
import filterCode from '../vendor/tactile-filter.js?raw';
import { TactilePlayback } from './tactilePlayback';
import { cloneBaseline } from './tactileCache';
import type { TactileBaseline } from './tactileFilter';
let workerUrl='';
export type TactileImage=ImageBitmap|(ImageData & {close():void});
type Reply={image?:TactileImage;reference?:TactileBaseline;pixels?:ArrayBuffer;width?:number;height?:number};
export class TactileRenderer {
  private capture:HTMLCanvasElement|null=null;
  private worker:Worker;private serial=0;private disposed=false;private initialized=false;
  private playback:TactilePlayback<TactileImage>|null=null;private video:HTMLVideoElement|null=null;
  private calls=new Map<number,{resolve:(reply:Reply)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  constructor(private paint:(image:TactileImage,sourceTime?:number)=>void,private failed:()=>void,private pixelMode=false){
    workerUrl ||= URL.createObjectURL(new Blob([filterCode,workerCode],{type:'text/javascript'}));this.worker=new Worker(workerUrl);
    this.worker.onmessage=({data})=>{
      const call=this.calls.get(data.id);if(!call){data.image?.close();return;}
      this.calls.delete(data.id);clearTimeout(call.timer);data.error?call.reject(new Error(data.error)):call.resolve(data);
    };
    this.worker.onerror=()=>{if(!this.disposed)this.failed();this.dispose();};
  }
  private rpc(data:Record<string,unknown>,transfer:Transferable[]=[]):Promise<Reply>{
    if(this.disposed)return Promise.reject(new Error('disposed'));
    return new Promise((resolve,reject)=>{
      const id=++this.serial,timer=setTimeout(()=>{this.calls.delete(id);reject(new Error('Tactile rendering timed out'));},30000);
      this.calls.set(id,{resolve,reject,timer});
      try{this.worker.postMessage({id,...data},transfer);}catch(error){clearTimeout(timer);this.calls.delete(id);reject(error);}
    });
  }
  private async send(kind:string,source:ImageBitmapSource,gain=10,cleanup=true):Promise<Reply>{
    if(this.pixelMode){
      // One frame per turn; statistics, fitting and filtering still run in the worker.
      this.capture??=document.createElement('canvas');const input=source as HTMLVideoElement|HTMLCanvasElement;
      const width=input instanceof HTMLVideoElement?input.videoWidth:input.width,height=input instanceof HTMLVideoElement?input.videoHeight:input.height;
      if(this.capture.width!==width||this.capture.height!==height){this.capture.width=width;this.capture.height=height;}
      const context=this.capture.getContext('2d',{willReadFrequently:true})!;context.drawImage(input,0,0);
      const pixels=context.getImageData(0,0,width,height).data;
      const reply=await this.rpc({kind,pixels:pixels.buffer,width,height,gain,cleanup},[pixels.buffer]);
      if(reply.pixels)reply.image=Object.assign(new ImageData(new Uint8ClampedArray(reply.pixels),reply.width!,reply.height!),{close(){}}) as TactileImage;
      return reply;
    }
    const bitmap=await createImageBitmap(source);
    if(this.disposed){bitmap.close();throw new Error('disposed');}
    try{return await this.rpc({kind,bitmap,gain,cleanup},[bitmap]);}
    catch(error){bitmap.close();throw error;}
  }
  async sample(source:ImageBitmapSource){await this.send('sample',source);}
  async calibrated(){const reply=await this.rpc({kind:'calibrated'});this.initialized=true;return reply.reference!;}
  async reference(reference:TactileBaseline){await this.rpc({kind:'reference',reference:cloneBaseline(reference),pixelMode:this.pixelMode});this.initialized=true;}
  async render(source:ImageBitmapSource,gain:number,cleanup:boolean){return (await this.send('frame',source,gain,cleanup)).image;}
  update(video:HTMLVideoElement,gain:number,cleanup=true){
    if(this.disposed||!this.initialized)return;
    if(video!==this.video){
      this.playback?.dispose();this.video=video;
      this.playback=new TactilePlayback(video,async(gain,cleanup)=>(await this.send('frame',video,gain,cleanup)).image,this.paint,this.failed);
    }
    this.playback!.update(gain,cleanup);
  }
  // A staged render owns presentation until the shared barrier releases. Detach
  // seek/pause listeners as well as invalidating any old automatic render.
  suspend(){this.playback?.dispose();this.playback=null;this.video=null;}
  invalidate(){this.playback?.invalidate();}
  dispose(){if(this.disposed)return;this.disposed=true;this.playback?.dispose();this.worker.terminate();for(const call of this.calls.values()){clearTimeout(call.timer);call.reject(new Error('disposed'));}this.calls.clear();this.capture=null;}
}
