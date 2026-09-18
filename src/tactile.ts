import workerCode from '../tools/tactile-worker.js?raw';
import filterCode from '../vendor/tactile-filter.js?raw';
import { TactilePlayback } from './tactilePlayback';
let workerUrl='';
type Reply={image?:ImageBitmap;width?:number;height?:number};
export class TactileRenderer {
  private worker:Worker;private serial=0;private disposed=false;private initialized=false;
  private playback:TactilePlayback<ImageBitmap>|null=null;private video:HTMLVideoElement|null=null;
  private calls=new Map<number,{resolve:(reply:Reply)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  constructor(private paint:(image:ImageBitmap)=>void,private failed:()=>void){
    workerUrl ||= URL.createObjectURL(new Blob([filterCode,workerCode],{type:'text/javascript'}));this.worker=new Worker(workerUrl);
    this.worker.onmessage=({data})=>{
      const call=this.calls.get(data.id);if(!call){data.image?.close();return;}
      this.calls.delete(data.id);clearTimeout(call.timer);data.error?call.reject(new Error(data.error)):call.resolve(data);
    };
    this.worker.onerror=()=>{if(!this.disposed)this.failed();this.dispose();};
  }
  private async send(kind:string,video:ImageBitmapSource,gain=1,cleanup=true):Promise<Reply>{
    const bitmap=await createImageBitmap(video);
    if(this.disposed){bitmap.close();throw new Error('disposed');}
    return new Promise((resolve,reject)=>{
      const id=++this.serial,timer=setTimeout(()=>{this.calls.delete(id);reject(new Error('Tactile rendering timed out'));},10000);
      this.calls.set(id,{resolve,reject,timer});this.worker.postMessage({id,kind,bitmap,gain,cleanup},[bitmap]);
    });
  }
  async reference(source:ImageBitmapSource){const size=await this.send('reference',source);this.initialized=true;return size;}
  async render(source:ImageBitmapSource,gain:number,cleanup:boolean){return (await this.send('frame',source,gain,cleanup)).image;}
  update(video:HTMLVideoElement,gain:number,cleanup=true){
    if(this.disposed||!this.initialized)return;
    if(video!==this.video){
      this.playback?.dispose();this.video=video;
      this.playback=new TactilePlayback(video,async(gain,cleanup)=>(await this.send('frame',video,gain,cleanup)).image,this.paint,this.failed);
    }
    this.playback!.update(gain,cleanup);
  }
  dispose(){this.disposed=true;this.playback?.dispose();this.worker.terminate();for(const call of this.calls.values()){clearTimeout(call.timer);call.reject(new Error('disposed'));}this.calls.clear();}
}
