import { tactileBaselineCount } from './tactileFilter.ts';

/** Seek a private decoder, never the synchronized playback video. */
export async function collectNativeBaseline(
  url:string, pts:number[], duration:number, fps:number,
  sample:(video:HTMLVideoElement,index:number,total:number)=>Promise<void>, signal:AbortSignal,
):Promise<void>{
  const video=document.createElement('video');video.muted=true;video.preload='auto';video.playsInline=true;
  const wait=(event:'loadeddata'|'seeked',start:()=>void)=>new Promise<void>((resolve,reject)=>{
    const cleanup=()=>{video.removeEventListener(event,done);video.removeEventListener('error',fail);signal.removeEventListener('abort',abort);clearTimeout(timer);};
    const done=()=>{cleanup();resolve();};
    const fail=()=>{cleanup();reject(new Error('Could not decode tactile baseline'));};
    const abort=()=>{cleanup();reject(signal.reason??new Error('Calibration cancelled'));};
    const timer=setTimeout(fail,10000);
    video.addEventListener(event,done,{once:true});video.addEventListener('error',fail,{once:true});signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted){abort();return;}try{start();}catch(error){cleanup();reject(error);}
  });
  try{
    await wait('loadeddata',()=>{video.src=url;});
    const total=tactileBaselineCount(fps,pts.length);
    if(!total)throw new Error('No baseline frames');
    for(let index=0;index<total;index++){
      signal.throwIfAborted();
      const end=pts[index+1]??duration;
      const time=pts[index]+Math.max(0,end-pts[index])/2;
      if(Math.abs(video.currentTime-time)>.000001)await wait('seeked',()=>{video.currentTime=time;});
      signal.throwIfAborted();await sample(video,index,total);signal.throwIfAborted();
    }
  }finally{video.pause();video.removeAttribute('src');video.load();}
}
