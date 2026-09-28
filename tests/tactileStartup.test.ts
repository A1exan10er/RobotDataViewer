import test from 'node:test';
import assert from 'node:assert/strict';
import { TactileCache, calibrationKey } from '../src/tactileCache.ts';
import { CalibrationQueue } from '../src/calibrationQueue.ts';
import { SynchronizedChannel, allChannelsReady } from '../src/synchronizedChannel.ts';
import type { Media } from '../src/types.ts';
import { mediaTimeAt, localRateAt } from '../src/math.ts';
import type { TactileBaseline } from '../src/tactileFilter.ts';
const settle=()=>new Promise<void>(r=>setImmediate(r));
function deferred(){let resolve!:()=>void,reject!:(error:Error)=>void;const promise=new Promise<void>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const model=():TactileBaseline=>({width:2,height:1,sampleCount:8,baseline:new Uint8Array([90,100]),noiseFloor:new Float32Array([1.4,2]),roiMask:new Uint8Array([0,1]),roiStatus:'ready',roiConfidence:.9});
test('32 MiB cache defaults; Blob identity, decoder paths, parameters and detached copies remain separate',()=>{
  const cache=new TactileCache(),blob=new Blob(['same']),other=new Blob(['same']);assert.equal(cache.limit,32*1024*1024);
  const key=calibrationKey('native-bitmap',30,60),original=model();cache.put(blob,key,original);original.baseline[0]=0;
  assert.equal(cache.get(blob,key)!.baseline[0],90);assert.equal(cache.get(other,key),undefined);
  assert.equal(cache.get(blob,calibrationKey('libav-rgba',30,60)),undefined);assert.equal(cache.get(blob,calibrationKey('native-bitmap',24,60)),undefined);
  const copy=cache.get(blob,key)!;structuredClone(copy,{transfer:[copy.baseline.buffer,copy.noiseFloor.buffer,copy.roiMask.buffer]});
  assert.equal(cache.get(blob,key)!.baseline.length,2);assert.equal(cache.sizeBytes,12);
  cache.clear();assert.equal(cache.sizeBytes,0);assert.equal(cache.get(blob,key),undefined);
});
test('cache evicts least recently used models and excludes oversized entries',()=>{
  const cache=new TactileCache(24),blob=new Blob();for(const key of ['a','b'])cache.put(blob,key,model());
  cache.get(blob,'a');cache.put(blob,'c',model());assert.equal(cache.get(blob,'b'),undefined);assert.ok(cache.get(blob,'a'));assert.equal(cache.sizeBytes,24);
  const tooSmall=new TactileCache(11);tooSmall.put(blob,'a',model());assert.equal(tooSmall.sizeBytes,0);
});
test('camera-prioritized queue limits work to two jobs and removes cancelled queued jobs',async()=>{
  const queue=new CalibrationQueue(),jobs=Array.from({length:4},()=>deferred()),aborts=jobs.map(()=>new AbortController()),started:number[]=[];
  const results=jobs.map((job,i)=>queue.run(async()=>{started.push(i);await job.promise;return i;},aborts[i].signal).catch(()=>-1));
  await settle();assert.deepEqual(started,[]);queue.pump();await settle();assert.deepEqual(started,[0,1]);
  aborts[2].abort();jobs[0].resolve();await settle();queue.pump();await settle();assert.deepEqual(started,[0,1,3]);
  jobs[1].resolve();jobs[3].resolve();assert.deepEqual(await Promise.all(results),[0,1,-1,3]);
});
class Player {
  ready=true;error=false;currentTime=-1;seeks:{time:number,present?:boolean,done:ReturnType<typeof deferred>}[]=[];paints:number[]=[];coverage=false;disposed=0;reserves:number[]=[];
  prepare(time:number,ahead=0){this.reserves.push(ahead);return this.ready&&this.coverage&&this.seeks.at(-1)!.time<=time;}
  seek(time:number,present?:boolean){const done=deferred();this.seeks.push({time,present,done});return done.promise;}
  present(time:number,_rate:number,playing:boolean){assert.equal(playing,false,'staging must never play');this.currentTime=time;this.paints.push(time);}pause(){}dispose(){this.disposed++;}
}
const media:Media={id:'touch',kind:'tactile',path:'',original:'',width:2,height:1,fps:30,frames:240,duration:8};
const timing={episode:Array.from({length:240},(_,i)=>i*1000/30),media:Array.from({length:240},(_,i)=>i/30),estimated:false};
function channel(player:Player,render:(generation:number,time:number)=>void=()=>{},failed=()=>assert.fail('unexpected failure'),now=()=>performance.now()){
  const value=new SynchronizedChannel(media,timing,now);value.bind(()=>{},failed,render);value.attach(player);return value;
}
test('expected unmounted and queued channels prevent premature and empty readiness',async()=>{
  const player=new Player(),first=channel(player),queued=new SynchronizedChannel(media,timing);
  assert.equal(allChannelsReady([]),false);assert.equal(allChannelsReady([first,queued]),false);
  first.prepared();first.pulse(0,.65,1);player.coverage=true;player.seeks[0].done.resolve();await settle();first.pulse(0,.65,1);
  first.acknowledge(0,0);first.pulse(0,.65,1);assert.equal(first.state,'ready');
  assert.equal(allChannelsReady([first,queued]),false);queued.fail();assert.equal(allChannelsReady([first,queued]),true);
});
test('preparation seeks the held target, reserves ahead, and requires an actual painted frame',async()=>{
  const player=new Player(),renders:number[]=[],value=channel(player,(_generation,time)=>renders.push(time));
  value.pulse(3,.65,1);assert.equal(player.seeks.length,0);value.prepared();value.pulse(3,.65,1);
  assert.equal(player.seeks[0].time,3);assert.equal(player.seeks[0].present,false);
  for(let i=0;i<20;i++)value.pulse(3,.65,1);assert.equal(player.seeks.length,1);
  player.seeks[0].done.resolve();await settle();value.pulse(3,.65,1);assert.deepEqual(renders,[],'reserve must be filled');
  player.coverage=true;value.pulse(3,.65,1);assert.deepEqual(player.paints,[3]);assert.deepEqual(renders,[3]);assert.equal(value.state,'frame');
  value.acknowledge(0,3.65);value.pulse(3,.65,1);assert.equal(value.state,'frame','future frame cannot satisfy readiness');
  value.acknowledge(0,2);value.pulse(3,.65,1);assert.equal(value.state,'frame','old frame cannot satisfy readiness');
  value.acknowledge(0,3);value.pulse(3,.65,1);assert.equal(value.state,'ready');assert.equal(player.reserves.at(-1),.65);
});
test('rapid seeks and rate changes coalesce and reject stale renders and failures',async()=>{
  const player=new Player(),value=channel(player);value.prepared();value.pulse(2,.65,1);
  value.invalidate(1);value.pulse(4,1.3,2);value.invalidate(2);value.pulse(5,1.3,2);assert.equal(player.seeks.length,1);
  player.seeks[0].done.reject(new Error('obsolete'));await settle();value.pulse(5,1.3,2);assert.equal(player.seeks[1].time,5);
  player.coverage=true;player.seeks[1].done.resolve();await settle();value.pulse(5,1.3,2);assert.deepEqual(player.paints,[5]);
  value.acknowledge(1,5);value.pulse(5,1.3,2);assert.equal(value.state,'frame');
  value.acknowledge(2,5);value.pulse(5,1.3,2);assert.equal(value.state,'ready');assert.equal(player.reserves.at(-1),1.3);
});
test('paused short-clip end is a valid target, and disposal suppresses delayed completion',async()=>{
  const player=new Player(),value=channel(player);value.prepared();value.pulse(.099,.65,1);
  player.coverage=true;player.seeks[0].done.resolve();await settle();value.pulse(.099,.65,1);value.acknowledge(0,2/30);value.pulse(.099,.65,1);
  assert.equal(value.state,'ready');assert.deepEqual(player.paints,[.099]);
  value.invalidate(1);value.pulse(2,.65,1);value.dispose();player.seeks[1].done.resolve();await settle();value.pulse(2,.65,1);assert.deepEqual(player.paints,[.099]);
});
test('offset and capture-rate mapping seek the current media timestamp, not a future lead',async()=>{
  const timing={episode:[1000,2000,3000],media:[0,1.1,2.2],estimated:false},time=mediaTimeAt(timing,1500),rate=2*localRateAt(timing,1500);
  const player=new Player(),value=channel(player);value.prepared();value.pulse(time,.65*rate,rate);
  assert.ok(Math.abs(player.seeks[0].time-.55)<1e-9);
});
test('failed preparation is terminal, idempotent, and stops work',()=>{
  const player=new Player();let failures=0;const value=channel(player,()=>{},()=>failures++);
  value.fail();value.fail();value.prepared();value.pulse(2,.65,1);assert.equal(value.state,'failure');assert.equal(failures,1);assert.equal(player.disposed,1);assert.deepEqual(player.seeks,[]);
});
test('fallback keeps the expected channel pending and requires new decoder frames',async()=>{
  const player=new Player(),value=channel(player);value.prepared();value.pulse(0,.65,1);value.detach();
  const replacement=new Player();value.bind(()=>{},()=>assert.fail(),()=>{});value.attach(replacement);value.invalidate(1);
  player.seeks[0].done.resolve();await settle();value.pulse(0,.65,1);assert.deepEqual(replacement.seeks,[]);assert.equal(allChannelsReady([value]),false);
  value.prepared();value.pulse(0,.65,1);replacement.coverage=true;replacement.seeks[0].done.resolve();await settle();value.pulse(0,.65,1);
  value.acknowledge(0,0);assert.equal(value.state,'frame');value.acknowledge(1,0);value.pulse(0,.65,1);assert.equal(value.state,'ready');
});
test('frame preparation bounds hung requests and missing paint acknowledgements',async()=>{
  for(const hangSeek of [false,true]){
    const player=new Player();let now=0,failures=0;const value=channel(player,()=>{},()=>failures++,()=>now);
    value.prepared();value.pulse(0,.65,1);
    if(!hangSeek){player.coverage=true;player.seeks[0].done.resolve();await settle();value.pulse(0,.65,1);}
    now=30001;value.pulse(0,.65,1);value.fail();assert.equal(value.state,'failure');assert.equal(failures,1);assert.equal(player.disposed,1);
    player.seeks[0].done.resolve();await settle();value.pulse(0,.65,1);assert.equal(player.paints.length,hangSeek?0:1);
  }
});

test('a full catch-up queue releases elapsed frames without painting or losing the current frame',async()=>{
  const {discardPastFrames}=await import('../src/frameQueue.ts');
  const closed:number[]=[],queue=Array.from({length:36},(_,i)=>({time:3+i/30}));
  discardPastFrames(queue,3.55,f=>closed.push(f.time));
  assert.equal(closed.length,16);assert.ok(queue[0].time<=3.55&&queue[1].time>3.55);
  assert.equal(queue.length,20);assert.equal(queue.at(-1)!.time,3+35/30);
  while(queue.length<36)queue.push({time:queue.at(-1)!.time+1/30});
  assert.ok(queue.at(-1)!.time>=3.55+.65);
  discardPastFrames(queue,2,f=>closed.push(f.time));assert.equal(closed.length,16,'future frames must remain private');
  discardPastFrames(queue,20,f=>closed.push(f.time));assert.equal(queue.length,1,'retain the last frame at EOF');
});
test('cancelled running calibration retains its slot until resources have actually released',async()=>{
  const queue=new CalibrationQueue(1),abort=new AbortController(),job=deferred();let started=0;
  const first=queue.run(()=>job.promise,abort.signal).catch(()=>{});
  const second=queue.run(async()=>{started++;},new AbortController().signal);
  queue.pump();await settle();abort.abort();queue.pump();assert.equal(started,0);
  job.resolve();await first;await settle();queue.pump();await second;assert.equal(started,1);
});
test('render results survive advancing time but never overwrite a newer paint or an explicit seek',async()=>{
  const {RenderOrder}=await import('../src/renderOrder.ts');const order=new RenderOrder();
  const slow=order.capture();assert.ok(order.accepts(slow),'elapsed playback alone is not an invalidation');
  order.didPaint();assert.equal(order.accepts(slow),false,'newer prefiltered frame must survive a delayed settings redraw');
  const sought=order.capture();order.invalidate();assert.equal(order.accepts(sought),false);
  const current=order.capture();assert.ok(order.accepts(current));order.invalidate();assert.equal(order.accepts(current),false,'disposal rejects replies');
});

test('synchronous seek, reserve, presentation and render errors fail only their channel',async()=>{
  for(const stage of ['seek','prepare','present','render'] as const){
    const player=new Player();let failures=0;
    const value=channel(player,()=>{if(stage==='render')throw new Error('canvas');},()=>failures++);
    if(stage==='seek')player.seek=()=>{throw new Error('seek');};
    if(stage==='prepare')player.prepare=()=>{throw new Error('reserve');};
    if(stage==='present')player.present=()=>{throw new Error('bitmap');};
    value.prepared();assert.doesNotThrow(()=>value.pulse(0,.65,1));
    if(stage!=='seek'){player.coverage=true;player.seeks[0].done.resolve();await settle();assert.doesNotThrow(()=>value.pulse(0,.65,1));}
    assert.equal(value.state,'failure',stage);assert.equal(failures,1);assert.equal(player.disposed,1);
    value.pulse(0,.65,1);value.fail();assert.equal(failures,1);
    const healthy=new Player(),other=channel(healthy);other.prepared();other.pulse(0,.65,1);healthy.coverage=true;healthy.seeks[0].done.resolve();await settle();other.pulse(0,.65,1);other.acknowledge(0,0);other.pulse(0,.65,1);
    assert.equal(allChannelsReady([value,other]),true,'other channels still reach joint readiness');
  }
});
test('steady-state errors and throwing cleanup cannot break the shared clock or skip notices',async()=>{
  const player=new Player();let notices=0;const value=channel(player,()=>{},()=>notices++);
  value.prepared();value.pulse(0,.65,1);player.coverage=true;player.seeks[0].done.resolve();await settle();value.pulse(0,.65,1);value.acknowledge(0,0);value.pulse(0,.65,1);
  player.present=()=>{throw new Error('draw');};player.dispose=()=>{player.disposed++;throw new Error('cleanup');};
  assert.doesNotThrow(()=>value.present(1,1,true));assert.equal(value.state,'failure');assert.equal(notices,1);assert.equal(player.disposed,1);
  value.present(2,1,true);value.pause();value.fail();assert.equal(notices,1);
});
test('failure before transport construction is visible and late attachment is disposed',()=>{
  const value=new SynchronizedChannel(media,timing),states:string[]=[];let failures=0;
  value.bind(state=>states.push(state),()=>failures++,()=>assert.fail());
  value.fail();value.fail();assert.deepEqual(states,['preparing','failure']);assert.equal(failures,1);assert.equal(allChannelsReady([value]),true);
  const late=new Player();value.attach(late);assert.equal(late.disposed,1);assert.equal(value.transport,null);
});
