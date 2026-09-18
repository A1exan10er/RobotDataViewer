import type { Transport } from './transport';

/** Let the browser's media clock run; minor drift is corrected without seeking. */
export class NativeTransport implements Transport {
  readonly video:HTMLVideoElement;
  private lastSeek=-Infinity;
  private lastRate=-Infinity;
  private cancelSeek:(()=>void)|null=null;
  constructor(video:HTMLVideoElement){this.video=video;}
  get error(){return !!this.video.error;}
  get ready(){return this.video.readyState>=2;}
  get currentTime(){return this.video.currentTime;}
  prepare(){return this.ready&&!this.video.seeking;}
  present(time:number,rate:number,playing:boolean){
    const v=this.video;
    if(!playing){this.pause();return;}
    if(v.seeking)return;
    const now=performance.now(),drift=time-v.currentTime;
    // A frame-sized difference is normal: currentTime and the UI clock update separately.
    // Repeated seeks here flush the native decoder and stall every synchronized stream.
    if(Math.abs(drift)>.5&&now-this.lastSeek>2000){v.currentTime=time;this.lastSeek=now;}
    if(now-this.lastRate>=200){
      const correction=Math.abs(drift)>.04?Math.max(-.08,Math.min(.08,drift*.4)):0;
      const desired=Math.max(.0625,Math.min(8,rate*(1+correction)));
      if(Math.abs(v.playbackRate-desired)>.005)v.playbackRate=desired;
      this.lastRate=now;
    }
    if(v.paused)void v.play().catch(()=>{});
  }
  seek(time:number):Promise<void>{
    this.cancelSeek?.();
    const v=this.video;
    return new Promise((resolve,reject)=>{
      let timer:ReturnType<typeof setTimeout>;
      const cleanup=()=>{clearTimeout(timer);v.removeEventListener('seeked',finish);v.removeEventListener('error',fail);v.removeEventListener('loadeddata',start);this.cancelSeek=null;};
      const finish=()=>{cleanup();resolve();};
      const fail=()=>{cleanup();reject(new Error('video'));};
      const start=()=>{if(Math.abs(v.currentTime-time)<.00001&&!v.seeking){finish();return;}v.currentTime=time;this.lastSeek=performance.now();};
      this.cancelSeek=fail;
      v.addEventListener('seeked',finish);v.addEventListener('error',fail);
      timer=setTimeout(fail,15000);
      if(this.ready)start();else v.addEventListener('loadeddata',start,{once:true});
    });
  }
  pause(){if(!this.video.paused)this.video.pause();}
  dispose(){this.cancelSeek?.();this.pause();this.video.removeAttribute('src');this.video.load();}
}
