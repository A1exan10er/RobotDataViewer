import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserCapture, LiveCameraSession, LiveFrameHealth, requestedProfile, validCameraProfile, type CaptureAdapter } from '../src/liveCamera.ts';
test('browser capability failures explain disabled capture without requesting permission',async()=>{
  let opens=0;
  const events=new EventTarget();
  const media=Object.assign(events,{getUserMedia:async()=>{opens++;return stream('a').stream;},enumerateDevices:async()=>[],getSupportedConstraints:()=>({resizeMode:true})}) as unknown as MediaDevices;
  assert.equal(browserCapture({secureContext:false,mediaDevices:media}).reason,'insecureContext');
  assert.equal(browserCapture({secureContext:true}).reason,'missingCameraApi');
  assert.equal(browserCapture({secureContext:true,mediaDevices:{enumerateDevices:media.enumerateDevices} as MediaDevices}).reason,'missingCameraApi');
  assert.equal(browserCapture({secureContext:true,mediaDevices:{getUserMedia:media.getUserMedia} as MediaDevices}).reason,'missingCameraApi');
  const capture=browserCapture({secureContext:true,mediaDevices:media});
  assert.equal(capture.reason,undefined);assert.equal(opens,0);
  assert.equal(capture.adapter?.resizeMode,true);
  await capture.adapter!.open({video:true,audio:false});assert.equal(opens,1);
  let changed=0;const unsubscribe=capture.adapter!.subscribe(()=>changed++);
  events.dispatchEvent(new Event('devicechange'));assert.equal(changed,1);
  unsubscribe();events.dispatchEvent(new Event('devicechange'));assert.equal(changed,1);
  const minimal=browserCapture({secureContext:true,mediaDevices:Object.assign(events,{getSupportedConstraints:undefined}) as unknown as MediaDevices});
  assert.equal(minimal.adapter?.resizeMode,false);
});
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
  const f=fixture(['a']);const saved=new Map<string,string>();const storage={getItem:(key:string)=>saved.get(key)||null,setItem:(key:string,value:string)=>{saved.set(key,value);}};f.session.dispose();
  const session=new LiveCameraSession(f.adapter,()=>{},storage);await session.startAll();await tick();session.setRole('a','tactile');await tick();
  const c=f.constraints.at(-1)!;assert.deepEqual(c.video,{deviceId:{exact:'a'},width:{exact:640},height:{exact:360},frameRate:{exact:30},resizeMode:{exact:'none'}});
  assert.equal(session.cameras.get('a')?.mismatch,true);assert.equal(JSON.parse(saved.get('rdv.live-camera-preferences.v2')!).a.role,'tactile');session.dispose();
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
test('names and custom settings survive migration, reordered discovery and reconnect by exact identity',async()=>{
  const f=fixture();f.session.dispose();
  const saved=new Map([['rdv.live-camera-roles.v1',JSON.stringify({a:'tactile',b:'scene',bad:'invalid'})]]);
  const storage={getItem:(key:string)=>saved.get(key)||null,setItem:(key:string,value:string)=>{saved.set(key,value);}};
  const session=new LiveCameraSession(f.adapter,()=>{},storage);await session.startAll();
  assert.equal(session.cameras.get('a')!.role,'tactile');const track=session.cameras.get('a')!.stream,generation=session.cameras.get('a')!.generation;
  session.setName('a','  Left fingertip 左指  ');assert.equal(session.cameras.get('a')!.stream,track);assert.equal(session.cameras.get('a')!.generation,generation);
  const other=session.cameras.get('b')!.stream;
  assert(session.setProfile('a',{width:320,height:240,frameRate:15}));await tick();
  assert.deepEqual(f.constraints.at(-1)!.video,{deviceId:{exact:'a'},width:{exact:320},height:{exact:240},frameRate:{exact:15},resizeMode:{exact:'none'}});
  assert.equal(session.cameras.get('b')!.stream,other);assert.equal(session.cameras.get('a')!.name,'Left fingertip 左指');session.dispose();
  f.devices.reverse();const restored=new LiveCameraSession(f.adapter,()=>{},storage);await restored.refresh();
  assert.equal(restored.cameras.get('a')!.name,'Left fingertip 左指');assert.equal(restored.cameras.get('b')!.name,'');
  assert.deepEqual(requestedProfile(restored.cameras.get('a')!),{width:320,height:240,frameRate:15});
  f.devices.splice(f.devices.findIndex(d=>d.deviceId==='a'),1);await restored.refresh();f.devices.push({deviceId:'a',kind:'videoinput',label:'New driver label'});await restored.refresh();
  assert.equal(restored.cameras.get('a')!.name,'Left fingertip 左指');assert.equal(restored.cameras.get('a')!.label,'New driver label');
  restored.setRole('a','scene');assert.equal(restored.cameras.get('a')!.customProfile,undefined);assert.equal(restored.cameras.get('a')!.status,'stopped');restored.dispose();
});
test('invalid settings leave capture unchanged; custom reset and individual stop remain isolated',async()=>{
  const f=fixture();await f.session.startAll();const camera=f.session.cameras.get('a')!,active=camera.stream;
  for(const profile of [{width:0,height:360,frameRate:30},{width:640.5,height:360,frameRate:30},{width:640,height:360,frameRate:NaN},{width:640,height:360,frameRate:.5}]) {
    assert.equal(validCameraProfile(profile),false);assert.equal(f.session.setProfile('a',profile),false);assert.equal(camera.stream,active);
  }
  f.session.stop('a');const count=f.opened.length;
  f.session.setProfile('a',{width:320,height:240,frameRate:15});assert.equal(camera.status,'stopped');assert.equal(f.opened.length,count);
  f.session.setProfile('a');assert.equal(requestedProfile(camera),undefined);await f.session.startAll();assert.equal(camera.status,'stopped');
  f.session.dispose();
});
test('storage failures and malformed preferences do not block capture',async()=>{
  for(const storage of [{getItem:()=>{throw new Error('storage denied');},setItem:()=>{throw new Error('full');}}, {getItem:()=>'{invalid',setItem:()=>{}}, {getItem:()=>JSON.stringify({a:{role:'tactile',name:8,customProfile:{width:0,height:360,frameRate:30}},b:{role:'bogus'}}),setItem:()=>{}}]) {
    const f=fixture();f.session.dispose();const session=new LiveCameraSession(f.adapter,()=>{},storage);await session.startAll();
    session.setName('a','Right sensor');assert.equal(session.cameras.get('a')!.name,'Right sensor');assert.equal(session.cameras.get('a')!.customProfile,undefined);assert.equal(session.cameras.get('b')!.role,'unassigned');session.dispose();
  }
});
test('settings changes invalidate in-flight captures and stop late streams',async()=>{
  const f=fixture(['a']);await f.session.refresh();const pending:Array<(s:MediaStream)=>void>=[];
  f.adapter.open=()=>new Promise(resolve=>pending.push(resolve));const first=f.session.start('a');
  f.session.setProfile('a',{width:320,height:240,frameRate:15});assert.equal(pending.length,1,'one physical open in flight per device');
  const late=stream('a'),current=stream('a',{width:320,height:240,frameRate:15});pending[0](late.stream);await first;await tick();assert(late.track.stopped);assert.equal(pending.length,2);
  pending[1](current.stream);await tick();
  assert(late.track.stopped);assert.equal(f.session.cameras.get('a')!.stream,current.stream);f.session.dispose();
});
test('rapid profile changes skip obsolete queued opens and keep other devices independent',async()=>{
  const f=fixture();await f.session.refresh();const original=f.adapter.open,pending:Array<(s:MediaStream)=>void>=[];
  f.adapter.open=c=>(c.video as MediaTrackConstraints).deviceId?.['exact']==='a'?new Promise(resolve=>pending.push(resolve)):original(c);
  const opening=f.session.start('a');f.session.setRole('a','scene');f.session.setRole('a','tactile');
  await f.session.start('b');assert.equal(f.session.cameras.get('b')!.status,'streaming');assert.equal(pending.length,1);
  const late=stream('a');pending[0](late.stream);await opening;await tick();assert.equal(pending.length,2);
  const current=stream('a',{width:640,height:360,frameRate:30});pending[1](current.stream);await tick();assert.equal(f.session.cameras.get('a')!.role,'tactile');assert.equal(f.session.cameras.get('a')!.stream,current.stream);assert(late.track.stopped);f.session.dispose();
});
test('display health uses configured FPS including intentionally slow capture',()=>{
  for(const rate of [1,5,15,30,60]) {
    const health=new LiveFrameHealth();health.reset(0);
    for(let frame=1;frame<=rate*10;frame++){const now=frame*1000/rate;health.frame(now,frame);assert.equal(health.read(now,true,rate).warning,undefined);}
  }
  const health=new LiveFrameHealth();health.reset(0);
  for(let t=0;t<=9000;t+=100){health.frame(t);health.read(t,true,15);}assert.equal(health.read(9000,true,15).warning,'slow');
});
