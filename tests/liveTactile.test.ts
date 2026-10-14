import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveTactile, LiveCalibrationPool, type LiveRenderer } from '../src/liveTactile.ts';
import type { TactileBaseline } from '../src/tactileFilter.ts';
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const source={} as ImageBitmapSource;
function rig(pool=new LiveCalibrationPool(),region='ready') {
  let sampled=0,disposed=0,paints=0,closed=0,rendered=0;
  const renderer:LiveRenderer<{close():void}>={sample:async()=>{sampled++;},calibrated:async()=>({roiStatus:region}) as TactileBaseline,render:async()=>{rendered++;return {close:()=>closed++};},dispose:()=>disposed++};
  const live=new LiveTactile(()=>renderer,()=>{},()=>paints++,pool);
  return {live,renderer,get sampled(){return sampled;},get disposed(){return disposed;},get paints(){return paints;},get closed(){return closed;},get rendered(){return rendered;}};
}
async function collect(r:ReturnType<typeof rig>,start=0){for(let n=start;n<start+60;n++){r.live.frame(source,n,n*33);await tick();}}
test('manual calibration uses 60 unique observations, keeps reference, and closes painted frames',async()=>{
  const r=rig();r.live.frame(source,0,0);await tick();assert.equal(r.sampled,0);
  const calibrating=r.live.calibrate();await tick();r.live.frame(source,0,0);await tick();r.live.frame(source,0,0);await tick();assert.equal(r.sampled,1);
  for(let n=1;n<60;n++){r.live.frame(source,n,n*33);await tick();}await calibrating;assert.equal(r.live.state,'ready');
  r.live.frame(source,60,2000);await tick();assert.equal(r.paints,1);assert.equal(r.closed,1);assert.equal(r.sampled,60);assert.equal(r.live.lastPaint,2000);
  const again=r.live.calibrate();await tick();assert.equal(r.live.samples,0);await collect(r,100);await again;assert.equal(r.live.state,'ready');r.live.reset();
});
test('only two calibrations run, queued cancellation does not consume a slot',async()=>{
  const pool=new LiveCalibrationPool(),a=rig(pool),b=rig(pool),c=rig(pool),d=rig(pool);
  const jobs=[a.live.calibrate(),b.live.calibrate(),c.live.calibrate(),d.live.calibrate()];await tick();
  assert.equal(a.live.state,'calibrating');assert.equal(b.live.state,'calibrating');assert.equal(c.live.state,'queued');assert.equal(d.live.state,'queued');
  c.live.reset();a.live.reset();await tick();assert.equal(d.live.state,'calibrating');b.live.reset();d.live.reset();await Promise.all(jobs);
});
test('calibration timeout releases resources and permits retry',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const r=rig();const job=r.live.calibrate();await tick();t.mock.timers.tick(10001);await job;assert.equal(r.live.state,'timeout');assert.equal(r.disposed,1);r.live.reset();t.mock.timers.reset();
});
test('slow capture extends collection time while keeping all 60 distinct samples',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const r=rig();const job=r.live.calibrate(5);await tick();
  for(let n=0;n<60;n++){r.live.frame(source,n,n*200);await tick();t.mock.timers.tick(200);}
  await job;assert.equal(r.live.state,'ready');assert.equal(r.sampled,60);r.live.reset();
  const stalled=rig();const timeout=stalled.live.calibrate(5);await tick();t.mock.timers.tick(23999);assert.equal(stalled.live.state,'calibrating');t.mock.timers.tick(1);await timeout;assert.equal(stalled.live.state,'timeout');stalled.live.reset();t.mock.timers.reset();
});
test('missing sensing region hides the heatmap without rendering',async()=>{
  const r=rig(undefined,'not-found');const job=r.live.calibrate();await tick();await collect(r);await job;assert.equal(r.live.state,'region');r.live.frame(source,100,4000);await tick();assert.equal(r.rendered,0);r.live.reset();
});
test('render overload never queues old frames and reset rejects late replies',async()=>{
  const r=rig();const job=r.live.calibrate();await tick();await collect(r);await job;
  let complete!:(image:{close():void})=>void,calls=0,closed=0;r.renderer.render=()=>{calls++;return new Promise(resolve=>complete=resolve);};
  for(let n=60;n<100;n++)r.live.frame(source,n,n*33);assert.equal(calls,1);
  r.live.reset();complete({close:()=>closed++});await tick();assert.equal(r.paints,0);assert.equal(closed,1);assert.equal(r.live.state,'idle');
});
test('processing errors are isolated and do not retain a worker',async()=>{
  const r=rig();const job=r.live.calibrate();await tick();await collect(r);await job;r.renderer.render=async()=>{throw new Error('worker failed');};r.live.frame(source,61,2013);await tick();assert.equal(r.live.state,'failed');assert.equal(r.disposed,1);r.live.reset();
});
