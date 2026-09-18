import { onBeforeUnmount, ref } from 'vue';
import { localRateAt, mediaTimeAt } from './math';
import type { Media, Timing } from './types';
import type { Transport } from './transport';
type Binding={transport:Transport;timing:Timing;media:Media;failed:()=>void;stalledSince:number};
export function usePlayback(){
  const time=ref(0),duration=ref(0),rate=ref(1),playing=ref(false),busy=ref(false);
  const bindings=new Map<string,Binding>();let raf=0,last=performance.now(),seekVersion=0,buffering=false;
  const target=(b:Binding,ms:number)=>Math.min(Math.max(0,b.media.duration-.0001),mediaTimeAt(b.timing,ms));
  const end=(b:Binding)=>b.timing.episode.at(-1)!+(b.media.duration-b.timing.media.at(-1)!)*1000;
  const active=(b:Binding,ms:number)=>ms>=b.timing.episode[0]&&ms<end(b);
  function register(media:Media,timing:Timing,transport:Transport,failed:()=>void){bindings.set(media.id,{media,timing,transport,failed,stalledSince:0});}
  function fail(b:Binding){b.transport.pause();b.failed();bindings.delete(b.media.id);}
  function pause(){playing.value=false;busy.value=false;buffering=false;bindings.forEach(b=>b.transport.pause());}
  function play(){if(!duration.value)return;if(time.value>=duration.value-1){void seek(0,true);return;}last=performance.now();buffering=true;busy.value=true;playing.value=true;}
  async function seek(ms:number,resume=playing.value){
    const version=++seekVersion;pause();busy.value=true;time.value=Math.max(0,Math.min(duration.value,ms));
    await Promise.all([...bindings.values()].map(async b=>{try{await b.transport.seek(target(b,time.value));}catch{if(version===seekVersion&&bindings.get(b.media.id)===b)fail(b);}}));
    if(version!==seekVersion)return;busy.value=false;if(resume&&time.value<duration.value)play();
  }
  function step(direction:number){
    const first=[...bindings.values()].find(b=>active(b,time.value));
    if(first){const frames=first.timing.episode;
      if(direction>0)void seek(frames.find(t=>t>time.value+.1)??duration.value,false);
      else{let previous=0;for(const t of frames){if(t>=time.value-.1)break;previous=t;}void seek(previous,false);}
    }else void seek(time.value+direction*1000/30,false);
  }
  function reset(ms=0){++seekVersion;pause();bindings.clear();time.value=0;duration.value=ms;}
  function tick(now:number){
    const elapsed=now-last;last=now;
    if(playing.value){
      const next=buffering?time.value:Math.min(duration.value,time.value+elapsed*rate.value);let waiting=false;
      for(const b of bindings.values()){
        if(b.transport.error){fail(b);continue;}
        if(!active(b,next)){b.transport.pause();continue;}
        if(!b.transport.prepare(target(b,next),buffering ? .65*rate.value*localRateAt(b.timing,next) : 0)){waiting=true;if(!b.stalledSince)b.stalledSince=now;else if(now-b.stalledSince>30000)fail(b);}
        else b.stalledSince=0;
      }
      buffering=waiting;busy.value=waiting;if(!waiting)time.value=next;
      for(const b of bindings.values())if(active(b,time.value))b.transport.present(target(b,time.value),rate.value*localRateAt(b.timing,time.value),!waiting);
      if(time.value>=duration.value)pause();
    }
    raf=requestAnimationFrame(tick);
  }
  raf=requestAnimationFrame(tick);const visibility=()=>{if(document.hidden)pause();};document.addEventListener('visibilitychange',visibility);
  onBeforeUnmount(()=>{reset();cancelAnimationFrame(raf);document.removeEventListener('visibilitychange',visibility);});
  return {time,duration,rate,playing,busy,register,pause,play,seek,step,reset,unregister:(id:string)=>bindings.delete(id),toggle:()=>playing.value?pause():play()};
}
export type Playback=ReturnType<typeof usePlayback>;
