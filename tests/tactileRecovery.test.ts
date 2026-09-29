import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { captureContext, matchingNeighbors, TactileRecovery, type RegionOperations } from '../src/tactileRecovery.ts';
import { detectTactileRegion, regionGeometry, borrowTactileRegion, detectRegionSamples } from '../src/tactileRoi.ts';
import { adoptBaselineRegion, TactileCalibration, TactileFilter, type TactileBaseline } from '../src/tactileFilter.ts';
import { TactileCache } from '../src/tactileCache.ts';
import type { Episode } from '../src/types.ts';
import type { RecordingSource } from '../src/source.ts';
const fixture=JSON.parse(readFileSync(new URL('fixtures/tactile-roi.json',import.meta.url),'utf8')).cases.find((f:any)=>f.name==='curved-rim');
const gray=new Uint8Array(inflateSync(Buffer.from(fixture.baseline,'base64'))),width=640,height=360;
const detected=detectTactileRegion(gray,width,height),geometry=regionGeometry(gray,width,height,detected.curve,detected.confidence,'donor');
function episode(id:string,time:number,extra:any={}):Episode{return {id,title:'task',robot:'arx5',durationMs:1000,data:id,sourceName:id,issues:[],media:[{id:'r_tact_l',kind:'tactile',path:id,original:id,width,height,fps:30,frames:60,duration:2}],capture:{task:'plug',operator:'person',device:'device',session:'session',time,...extra}};}
const model=():TactileBaseline=>({width,height,sampleCount:60,baseline:gray.slice(),noiseFloor:new Float32Array(gray.length).fill(3.5),roiMask:new Uint8Array(gray.length),roiStatus:'not-found',roiConfidence:0});
function setup(episodes:Episode[]){const blobs=new Map(episodes.map(e=>[e.id,new Blob([e.id])]));const source={manifest:{format:'robot-data-viewer',version:1,episodes},file:(id:string)=>blobs.get(id),dispose(){},kind:'original'} as RecordingSource;const cache=new TactileCache();return {blobs,cache,recovery:new TactileRecovery(source,cache)};}
test('capture context and deterministic donor selection reject conflicting identities',()=>{
  assert.equal(captureContext({task_key:'x'}),undefined);
  assert.deepEqual(captureContext({task_key:'x',username:'p',collector_device_id:'d',recording_session_id:'s',start_time:'bad'}),{task:'x',operator:'p',device:'d',session:'s',time:undefined});
  const current=episode('current',100),near=episode('a',90),next=episode('b',110),otherSession=episode('c',99,{session:'other'});
  const bad=[episode('device',101,{device:'wrong'}),episode('task',101,{task:'wrong'}),episode('operator',101,{operator:'wrong'}),{...episode('robot',101),robot:'umi'},{...episode('channel',101),media:[]}];
  assert.deepEqual(matchingNeighbors([current,...bad,otherSession,next,near],current,'r_tact_l').map(e=>e.id),['a','b','c']);
  assert.equal(matchingNeighbors([episode('unknown',99,{device:undefined,session:'other'})],current,'r_tact_l').length,0);
  assert.equal(matchingNeighbors([episode('unknown',99,{device:undefined})],current,'r_tact_l').length,1);
  assert.equal(matchingNeighbors(Array.from({length:10},(_,i)=>episode('n'+i,90-i)),current,'r_tact_l').length,4);
  const wrongDimensions=Array.from({length:4},(_,i)=>{const e=episode('wrong'+i,99-i);e.media[0].width=320;return e;});
  assert.deepEqual(matchingNeighbors([...wrongDimensions,near],current,'r_tact_l',{width,height}).map(e=>e.id),['a'],'Known mismatched dimensions do not consume the four candidate slots');
});
test('borrowed geometry tolerates brightness changes and partial occlusion, rejects shifted or blank images',()=>{
  for(const image of [gray,Uint8Array.from(gray,v=>Math.min(255,Math.round(v*.8+12))),Uint8Array.from(gray,(v,p)=>Math.floor(p/width)>=130&&Math.floor(p/width)<210?0:v)])assert.equal(borrowTactileRegion(image,width,height,geometry)?.status,'ready');
  for(const image of [new Uint8Array(gray.length),new Uint8Array(gray.length).fill(255),Uint8Array.from(gray,(_,p)=>gray[Math.floor(p/width)*width+Math.max(0,p%width-20)])])assert.equal(borrowTactileRegion(image,width,height,geometry),undefined);
  assert.equal(borrowTactileRegion(gray,width,height,{...geometry,width:320}),undefined);
  assert.equal(borrowTactileRegion(gray,width,height,{...geometry,confidence:.74}),undefined);
});
test('borrowing changes only geometry and masks outside response before and after smoothing',()=>{
  const original=model(),baseline=original.baseline.slice(),noise=original.noiseFloor.slice(),resolved=adoptBaselineRegion(original,geometry)!;
  assert.equal(resolved.roiMethod,'neighbor');assert.equal(resolved.roiDonor,'donor');assert.equal(resolved.sampleCount,60);
  assert.deepEqual(resolved.baseline,baseline);assert.deepEqual(resolved.noiseFloor,noise);assert.ok(original.roiMask.every(v=>!v));
  const current=Uint8Array.from(gray,(v,p)=>resolved.roiMask[p]?v:255-v),out=new Uint8ClampedArray(gray.length*4),filter=new TactileFilter(resolved);
  for(const cleanup of [true,false]){filter.renderGray(current,out,16,cleanup);assert.ok(out.every((v,i)=>v===(i%4===3?255:0)));}
});
test('bright moving rim is entirely black while strong interior contact stays unchanged',()=>{
  const resolved=adoptBaselineRegion(model(),geometry)!,rim=gray.slice();
  // Independently draw a 50-pixel disk around every observed arc point, including
  // the steep upper/lower sections. This mimics rim displacement/illumination.
  for(let y=0;y<height;y++)for(let dy=-50;dy<=50;dy++){
    const row=y+dy;if(row<0||row>=height)continue;
    const reach=Math.floor(Math.sqrt(2500-dy*dy)),cx=Math.round(geometry.curve[y]);
    for(let x=Math.max(0,cx-reach);x<=Math.min(width-1,cx+reach);x++)rim[row*width+x]=gray[row*width+x]>128?0:255;
  }
  const out=new Uint8ClampedArray(gray.length*4),expected=new Uint8ClampedArray(out.length),filter=new TactileFilter(resolved);
  for(const cleanup of [true,false]){filter.renderGray(rim,out,16,cleanup);assert.ok(out.every((v,i)=>v===(i%4===3?255:0)),'The rim must not leak or glow, including Show all changes');}
  const contact=gray.slice();for(let y=150;y<210;y++)for(let x=270;x<350;x++)contact[y*width+x]=255;
  const unmasked=new TactileFilter({...resolved,roiMask:new Uint8Array(gray.length).fill(1)});
  for(const cleanup of [true,false]){
    filter.renderGray(contact,out,16,cleanup);unmasked.renderGray(contact,expected,16,cleanup);
    const p=(180*width+310)*4;assert.deepEqual(out.slice(p,p+4),expected.slice(p,p+4));assert.equal(Math.max(...out.slice(p,p+3)),255,'Saturated contact is retained');
  }
});
test('unopened donors are probed in deterministic order; corrupt donors are skipped and geometry is reused',async()=>{
  const current=episode('current',100),bad=episode('bad',99),donor=episode('donor',102),{blobs,cache,recovery}=setup([current,bad,donor]);
  let probes=0,adoptions=0;const ops:RegionOperations={geometry:async()=>undefined,probe:async blob=>{probes++;if(blob===blobs.get('bad'))throw new Error('corrupt');return structuredClone(geometry);},adopt:async g=>{adoptions++;return adoptBaselineRegion(model(),g);}};
  const result=await recovery.resolve(current,'r_tact_l',model(),ops,new AbortController().signal,()=>{});
  assert.equal(result.roiDonor,'donor');assert.equal(probes,2);assert.equal(adoptions,1);
  await recovery.resolve(current,'r_tact_l',model(),ops,new AbortController().signal,()=>{});assert.equal(probes,3,'only corrupt donor retried');
  assert.equal(cache.getGeometry(blobs.get('current')!),undefined,'borrowed results are not independent donors');
  await recovery.resolve(current,'r_tact_l',result,{...ops,geometry:async()=>{assert.fail('Borrowed geometry must not become an independent donor');}},new AbortController().signal,()=>{});
  cache.clear();assert.equal(cache.sizeBytes,0);
});
test('cancellation rejects a delayed donor before cache insertion or adoption',async()=>{
  const current=episode('current',100),donor=episode('donor',99),{recovery,cache}=setup([current,donor]);const abort=new AbortController();let resolve!:(g:typeof geometry)=>void;
  const pending=recovery.resolve(current,'r_tact_l',model(),{geometry:async()=>undefined,probe:()=>new Promise(r=>{resolve=r;}),adopt:async()=>{assert.fail('stale adoption');}},abort.signal,()=>{});
  abort.abort();resolve(geometry);await assert.rejects(pending,{name:'AbortError'});assert.equal(cache.sizeBytes,0);
});
test('no neighbors, wrong dimensions, failed alignment and four failed candidates remain bounded',async()=>{
  const current=episode('current',100),donors=Array.from({length:8},(_,i)=>episode('n'+i,90-i)),{recovery}=setup([current,...donors]);let probes=0;
  const ops:RegionOperations={geometry:async()=>undefined,probe:async()=>{probes++;return geometry;},adopt:async()=>undefined};
  assert.equal((await recovery.resolve(current,'r_tact_l',model(),ops,new AbortController().signal,()=>{})).roiStatus,'not-found');assert.equal(probes,4);
  const alone=setup([current]);await alone.recovery.resolve(current,'r_tact_l',model(),ops,new AbortController().signal,()=>{});assert.equal(probes,4);
});
test('geometry and baseline models share one LRU and failure results are not retained',()=>{
  const cache=new TactileCache(20000),a=new Blob(),b=new Blob();cache.putGeometry(a,geometry);assert.ok(cache.getGeometry(a));
  const copy=cache.getGeometry(a)!;copy.curve.fill(0);assert.ok(cache.getGeometry(a)!.curve.some(Boolean));
  cache.putGeometry(b,geometry);assert.equal(cache.getGeometry(a),undefined);assert.ok(cache.sizeBytes<=cache.limit);
  cache.put(a,'failed',model());assert.equal(cache.get(a,'failed'),undefined);
});
test('eight or fewer grayscale donor samples produce geometry without changing input',()=>{
  const samples=[gray.slice(),gray.slice(),gray.slice()],before=samples.map(s=>s.slice());
  assert.ok(detectRegionSamples(samples,width,height));samples.forEach((s,i)=>assert.deepEqual(s,before[i]));
  assert.equal(detectRegionSamples([],width,height),undefined);
});

test('borrowed masks match independent NumPy correlation/morphology goldens exactly',()=>{
  const f=JSON.parse(readFileSync(new URL('fixtures/tactile-neighbor.json',import.meta.url),'utf8'));
  const decode=(s:string)=>new Uint8Array(inflateSync(Buffer.from(s,'base64'))),bytes=decode(f.curve),curve=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.length/4);
  const geometry=regionGeometry(decode(f.baseline),f.width,f.height,curve,f.confidence,'oracle');
  for(const c of f.cases){const region=borrowTactileRegion(decode(c.current),f.width,f.height,geometry);if(c.mask===null)assert.equal(region,undefined,c.name);else{assert.ok(region,c.name);assert.deepEqual(region.mask,decode(c.mask),c.name);}}
});
