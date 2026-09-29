import test from 'node:test';
import assert from 'node:assert/strict';
import { ForceCache, FORCE_MODEL, FORCE_PIPELINE, forceAt, parseForceTracks, serializeForceTracks, videoHash } from '../src/forceTracks.ts';
const weights='a'.repeat(64),sha='b'.repeat(64);
function fixture(){return {format:'robot-data-viewer-force',version:1,tracks:[{
  sensor:'l_tact_l',video:{sha256:sha,bytes:123,frames:3,width:641,height:359},model:{id:FORCE_MODEL,weightsSha256:weights,pipeline:FORCE_PIPELINE},
  reference:{frame:0,time:0},unit:'N',time:[0,.033,.1],shear:[0,1,2],fz:[0,2,3],valid:[1,0,1],
}]};}
test('force tracks round trip and never select a future source frame',()=>{
  const tracks=parseForceTracks(fixture()),t=tracks[0];
  assert.deepEqual(parseForceTracks(JSON.parse(serializeForceTracks(tracks))),tracks);
  assert.equal(forceAt(t,-1),null);assert.equal(forceAt(t,NaN),null);
  assert.equal(forceAt(t,.032)!.frame,0);assert.equal(forceAt(t,.034),null);
  assert.equal(forceAt(t,.1)!.fz,3);assert.equal(forceAt(t,.105)!.frame,2);
  for(let repeat=0;repeat<10;repeat++){assert.equal(forceAt(t,.11)!.frame,2);assert.equal(forceAt(t,0)!.frame,0);}
});
test('rejects mismatched lengths, nonfinite values, different algorithms and invalid timestamps',()=>{
  for(const mutate of [t=>t.time.pop(),t=>t.fz[1]=Infinity,t=>t.shear[0]=-1,t=>t.valid[1]=2,t=>t.time[2]=.02,
    t=>t.video.sha256='wrong',t=>t.video.frames=0,t=>t.model.pipeline='DIS',t=>t.reference.frame=1,t=>t.unit='Pa']){
    const pack=fixture();mutate(pack.tracks[0] as any);assert.throws(()=>parseForceTracks(pack));
  }
});
test('cache bounds include arrays, identity separates sensors and model versions, source clear releases tracks',()=>{
  const t=parseForceTracks(fixture())[0],cache=new ForceCache(2200);
  cache.put(t);const other={...t,sensor:'r_tact_r'};cache.put(other);
  assert.equal(cache.get(sha,'l_tact_l',weights),t);
  assert.equal(cache.get(sha,'l_tact_l','c'.repeat(64)),undefined);
  cache.put({...t,sensor:'l_tact_r'});
  assert.equal(cache.get(sha,'r_tact_r',weights),undefined);
  assert.ok(cache.bytes<=cache.limit);cache.clear();assert.equal(cache.bytes,0);
});
test('streaming content hashes distinguish same-name files and honor cancellation',async()=>{
  assert.equal(await videoHash(new Blob(['abc'])),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.notEqual(await videoHash(new Blob(['abcd'])),await videoHash(new Blob(['abce'])));
  const abort=new AbortController();abort.abort();await assert.rejects(videoHash(new Blob(['abc']),abort.signal));
});
