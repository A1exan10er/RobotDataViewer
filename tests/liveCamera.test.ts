import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveCameraSession, LiveFrameHealth, type CaptureAdapter } from '../src/liveCamera.ts';
const tick = async () => { for(let i=0;i<10;i++) await Promise.resolve(); };
class Track extends EventTarget {
  readyState = 'live'; stopped = false;
  settings: Record<string,unknown>;
  constructor(settings: Record<string,unknown>) { super(); this.settings=settings; }
  getSettings() { return this.settings; }
  stop() { this.stopped=true; this.readyState='ended'; }
}
function stream(id:string,settings={width:640,height:480,frameRate:30}) {
  const track=new Track({deviceId:id,...settings}); return {track,stream:{getTracks:()=>[track],getVideoTracks:()=>[track]} as unknown as MediaStream};
}
function fixture(ids=['a','b']) {
  const devices=ids.map(deviceId=>({deviceId,kind:'videoinput' as const,label:'Identical USB camera'}));
  const opened:ReturnType<typeof stream>[]=[]; const constraints:MediaStreamConstraints[]=[];
  let changed=()=>{},unsubscribed=false;
  const adapter:CaptureAdapter={resizeMode:true,enumerate:async()=>devices,open:async c=>{constraints.push(c);const id=typeof c.video==='object'?(c.video.deviceId as {exact:string}).exact:devices[0]?.deviceId;if(!id)throw Object.assign(new Error(),{name:'NotFoundError'});const s=stream(id);opened.push(s);return s.stream;},subscribe:fn=>{changed=fn;return()=>{unsubscribed=true;};}};
  const session=new LiveCameraSession(adapter,()=>{});
  return {devices,opened,constraints,adapter,session,changed:()=>changed(),get unsubscribed(){return unsubscribed;}};
}
test('permission probe closes; eight identical names remain independent; dispose releases all',async()=>{
  const f=fixture(Array.from({length:8},(_,i)=>String(i))); await f.session.startAll(); await tick();
  assert.equal(f.session.cameras.size,8);assert.equal([...f.session.cameras.values()].filter(c=>c.stream).length,8);
  assert.equal(f.opened[0].track.stopped,true); assert(f.constraints.every(c=>c.audio===false));
  f.session.dispose();assert(f.opened.every(s=>s.track.stopped));assert(f.unsubscribed);
});
test('hot plug and reconnect auto-start, explicit stop is retained, global stop disables auto-start',async()=>{
  const f=fixture();await f.session.startAll();await tick();f.session.stop('a');
  f.devices.splice(0,1);await f.session.refresh();f.devices.push({deviceId:'a',kind:'videoinput',label:'Identical USB camera'},{deviceId:'c',kind:'videoinput',label:'New'});await f.session.refresh();await tick();
  assert.equal(f.session.cameras.get('a')?.status,'stopped');assert.equal(f.session.cameras.get('c')?.status,'streaming');
  f.devices.splice(f.devices.findIndex(d=>d.deviceId==='b'),1);await f.session.refresh();assert.equal(f.session.cameras.get('b')?.status,'disconnected');
  f.devices.push({deviceId:'b',kind:'videoinput',label:'Returned'});await f.session.refresh();await tick();assert.equal(f.session.cameras.get('b')?.status,'streaming');
  f.session.stopAll();f.devices.push({deviceId:'d',kind:'videoinput',label:'New'});await f.session.refresh();assert.equal(f.session.cameras.get('d')?.status,'stopped');f.session.dispose();
});
test('late captures after Stop all/disposal are released and never resurrect',async()=>{
  const f=fixture(['a']);await f.session.refresh();let resolve!:(s:MediaStream)=>void;
  f.adapter.open=()=>new Promise(r=>resolve=r);const opening=f.session.start('a');f.session.stopAll();const late=stream('a');resolve(late.stream);await opening;assert(late.track.stopped);assert.equal(f.session.cameras.get('a')?.status,'stopped');
  const enabling=f.session.startAll();f.session.dispose();const probe=stream('a');resolve(probe.stream);await enabling;assert(probe.track.stopped);
});
test('profile changes restart exact device, remember roles by ID, and reveal negotiated mismatches',async()=>{
  const f=fixture(['a']);let saved='';const storage={getItem:()=>saved||null,setItem:(_key:string,value:string)=>saved=value};f.session.dispose();
  const session=new LiveCameraSession(f.adapter,()=>{},storage);await session.startAll();await tick();session.setRole('a','tactile');await tick();
  const c=f.constraints.at(-1)!;assert.deepEqual(c.video,{deviceId:{exact:'a'},width:{exact:640},height:{exact:360},frameRate:{exact:30},resizeMode:{exact:'none'}});
  assert.equal(session.cameras.get('a')?.mismatch,true);assert.equal(JSON.parse(saved).a,'tactile');session.dispose();
  const again=new LiveCameraSession(f.adapter,()=>{},storage);await again.refresh();assert.equal(again.cameras.get('a')?.role,'tactile');again.dispose();
});
test('denied permission, unavailable profile and a busy device fail locally',async()=>{
  const f=fixture();const open=f.adapter.open;f.adapter.open=async c=>{if(typeof c.video==='object'&&(c.video.deviceId as {exact:string}).exact==='b')throw Object.assign(new Error(),{name:'NotReadableError'});return open(c);};
  await f.session.startAll();assert.equal(f.session.cameras.get('a')?.status,'streaming');assert.equal(f.session.cameras.get('b')?.error,'busy');
  f.adapter.open=async()=>{throw Object.assign(new Error(),{name:'OverconstrainedError'});};f.session.setRole('a','tactile');await tick();assert.equal(f.session.cameras.get('a')?.error,'profile');f.session.dispose();
  const denied=fixture();denied.adapter.open=async()=>{throw Object.assign(new Error(),{name:'NotAllowedError'});};await denied.session.startAll();assert.equal(denied.session.error,'permission');assert.equal(denied.session.automatic,false);denied.session.dispose();
});
test('overlapping discovery ignores obsolete enumeration',async()=>{
  const f=fixture();let resolve!:(d:any[])=>void;f.adapter.enumerate=()=>new Promise(r=>resolve=r);const old=f.session.refresh();const oldResolve=resolve;const current=f.session.refresh();resolve([{kind:'videoinput',deviceId:'new',label:'New'}]);await current;oldResolve([{kind:'videoinput',deviceId:'old',label:'Old'}]);await old;assert.deepEqual([...f.session.cameras.keys()],['new']);f.session.dispose();
});
test('frame health distinguishes normal, low presentation, stalls and hidden time',()=>{
  const health=new LiveFrameHealth();health.reset(0);for(let t=0;t<=3000;t+=1000/30)health.frame(t);assert(Math.abs(health.read(3000,true).fps!-30)<1);assert.equal(health.read(5100,true).warning,'stale');
  health.reset(0);for(let t=0;t<=9000;t+=100){health.frame(t);health.read(t,true);}assert.equal(health.read(9000,true).warning,'slow');
  assert.equal(health.read(10000,false).warning,'hidden');health.frame(10100);assert.equal(health.read(10100,true).warning,undefined);
});
test('busy default camera does not block other cameras; empty start enables future hot plug',async()=>{
  const f=fixture();const open=f.adapter.open;f.adapter.open=async c=>{if(c.video===true||(c.video as MediaTrackConstraints).deviceId?.['exact']==='a')throw Object.assign(new Error(),{name:'NotReadableError'});return open(c);};
  await f.session.startAll();await tick();assert.equal(f.session.cameras.get('a')?.error,'busy');assert.equal(f.session.cameras.get('b')?.status,'streaming');f.session.dispose();
  const empty=fixture([]);await empty.session.startAll();assert.equal(empty.session.automatic,true);empty.devices.push({deviceId:'new',kind:'videoinput',label:'New'});await empty.session.refresh();await tick();assert.equal(empty.session.cameras.get('new')?.status,'streaming');empty.session.dispose();
});
test('missed frame callbacks still count presented frames',()=>{
  const health=new LiveFrameHealth();health.reset(0);
  for(let frame=1;frame<=90;frame+=3)health.frame(frame*1000/30,frame);
  assert.ok(Math.abs(health.read(3000,true).fps!-30)<2);
});
