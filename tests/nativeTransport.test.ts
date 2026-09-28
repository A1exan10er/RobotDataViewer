import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeTransport } from '../src/nativeTransport.ts';

class Video extends EventTarget {
  readyState=4;seeking=false;error=null;paused=true;playbackRate=1;time=0;seeks=0;plays=0;pauses=0;
  get currentTime(){return this.time;}
  set currentTime(time:number){this.time=time;this.seeks++;this.seeking=true;}
  async play(){this.paused=false;this.plays++;}
  pause(){this.paused=true;this.pauses++;}
  removeAttribute(){}load(){}
  finishSeek(){this.seeking=false;this.dispatchEvent(new Event('seeked'));}
}
const transport=(video:Video)=>new NativeTransport(video as unknown as HTMLVideoElement);

test('normal native clock drift does not flush the decoder or restart playback',()=>{
  const v=new Video(),player=transport(v);
  for(let i=1;i<=300;i++){v.time=i/60;player.present(v.time+.08,1,true);assert.equal(player.prepare(),true);}
  assert.equal(v.seeks,0);assert.equal(v.plays,1);assert.equal(v.pauses,0);
  assert.ok(v.playbackRate>=1&&v.playbackRate<=1.08);
});
test('large drift recovery is bounded and paused presentation does not seek',()=>{
  const v=new Video(),player=transport(v);player.present(2,1,true);assert.equal(v.seeks,1);v.finishSeek();
  player.present(4,1,true);assert.equal(v.seeks,1);
  player.present(7,1,false);assert.equal(v.seeks,1);assert.equal(v.paused,true);
});
test('explicit user seeks remain exact and decoder failures reject',async()=>{
  const v=new Video(),player=transport(v);const sought=player.seek(3.25);
  assert.equal(v.time,3.25);v.finishSeek();await sought;
  const failed=player.seek(1);v.dispatchEvent(new Event('error'));await assert.rejects(failed,/video/);
  const disposed=player.seek(2);player.dispose();await assert.rejects(disposed,/video/);
});
test('native readiness concerns decoded video only',async()=>{
  const v=new Video(),player=transport(v);
  assert.equal(player.ready,true);assert.equal(player.prepare(),true);
  const sought=player.seek(1.5);assert.equal(player.prepare(),false);
  v.finishSeek();await sought;assert.equal(player.prepare(),true);
});
