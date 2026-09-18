import test from 'node:test';
import assert from 'node:assert/strict';
import { differenceRgb, mediaTimeAt, nearestIndex, poseAt, safeRelativePath, timeText } from '../src/math.ts';

test('capture offsets and irregular frame times are preserved',()=>{
  const timing={media:[0,.033,.1],episode:[17,50,140],estimated:false};
  assert.equal(mediaTimeAt(timing,17),0);
  assert.equal(mediaTimeAt(timing,50),.033);
  assert.ok(Math.abs(mediaTimeAt(timing,95)-.0665)<1e-9);
  assert.equal(mediaTimeAt(timing,0),0);
  assert.equal(mediaTimeAt(timing,240),.2);
});
test('duplicate and one-frame recordings yield finite mappings',()=>{
  assert.ok(Math.abs(mediaTimeAt({media:[0,.033,.066],episode:[0,0,33],estimated:false},10)-.043)<1e-12);
  assert.equal(mediaTimeAt({media:[0],episode:[25],estimated:false},30),.005);
});
test('nearest recorded samples, endpoints and empty channels',()=>{
  assert.equal(nearestIndex([],0),-1);assert.equal(nearestIndex([5,10,30],21),2);assert.equal(nearestIndex([5,10,30],20),1);
  assert.equal(poseAt([],0),null);
  assert.equal(poseAt([{t:20,p:[1,2,3],axes:null,g:null}],0),null);
});
test('tactile comparison preserves subtle and equal-mean color changes without mutating sources',()=>{
  const reference=new Uint8ClampedArray([100,100,100,255,10,20,30,255]);
  const current=new Uint8ClampedArray([130,70,100,255,11,20,30,255]);const copy=current.slice();const out=new Uint8ClampedArray(8);
  differenceRgb(current,reference,out);
  assert.deepEqual([...out],[225,225,255,255,254,255,255,255]);assert.deepEqual(current,copy);
  differenceRgb(current,reference,out);assert.equal(out[0],225); // held contact does not rebase
  differenceRgb(reference,reference,out);assert.deepEqual([...out],[255,255,255,255,255,255,255,255]);
  differenceRgb(current,reference,out,16);assert.equal(out[0],0);assert.equal(out[4],239);
  assert.throws(()=>differenceRgb(new Uint8ClampedArray(4),reference,out));
});
test('package paths cannot resolve outside the selected folder',()=>{
  for(const p of ['../secret','/etc/passwd','x/../y','http://example.com','x\\y','x//y','C:/x','x/./y'])assert.equal(safeRelativePath(p),false,p);
  assert.equal(safeRelativePath('samples/样本 1/data.json'),true);
});
test('time readout includes minutes and subsecond position',()=>{
  assert.equal(timeText(61250),'01:01.2');assert.equal(timeText(-5),'00:00.0');
});
