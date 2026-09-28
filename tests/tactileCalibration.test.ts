import test from 'node:test';
import assert from 'node:assert/strict';
import { collectNativeBaseline } from '../src/tactileCalibration.ts';

class Video extends EventTarget {
  muted=false;preload='';playsInline=false;time=0;removed=false;paused=false;seeks:number[]=[];
  set src(_url:string){queueMicrotask(()=>this.dispatchEvent(new Event('loadeddata')));}
  get currentTime(){return this.time;}
  set currentTime(time:number){this.time=time;this.seeks.push(time);queueMicrotask(()=>this.dispatchEvent(new Event('seeked')));}
  pause(){this.paused=true;}
  removeAttribute(){this.removed=true;}
  load(){}
}
function setup(){const videos:Video[]=[];const original=globalThis.document;Object.assign(globalThis,{document:{createElement(){const v=new Video();videos.push(v);return v;}}});return {videos,restore:()=>{Object.assign(globalThis,{document:original});}};}

test('native calibration samples frame midpoints on a private decoder, including irregular PTS',async()=>{
  const {videos,restore}=setup(),samples:number[]=[];
  try{
    await collectNativeBaseline('blob:test',[0,.03,.09],.13,30,async(v,index,total)=>{samples.push(v.currentTime);assert.equal(total,3);assert.equal(index,samples.length-1);},new AbortController().signal);
    assert.equal(videos.length,1);assert.deepEqual(samples,[.015,.06,.11]);assert.ok(videos[0].paused&&videos[0].removed);
  }finally{restore();}
});
test('episode disposal cancels calibration and releases its private decoder',async()=>{
  const {videos,restore}=setup(),abort=new AbortController();let samples=0;
  try{
    await assert.rejects(collectNativeBaseline('blob:test',[0,.03,.06],.1,30,async()=>{samples++;abort.abort();},abort.signal),{name:'AbortError'});
    assert.equal(samples,1);assert.ok(videos[0].removed);
  }finally{restore();}
});
test('already cancelled calibration does not capture frames',async()=>{
  const {videos,restore}=setup(),abort=new AbortController();abort.abort();
  try{await assert.rejects(collectNativeBaseline('blob:test',[0],.03,30,async()=>{assert.fail('captured disposed frame');},abort.signal),{name:'AbortError'});assert.ok(videos[0].removed);}finally{restore();}
});
