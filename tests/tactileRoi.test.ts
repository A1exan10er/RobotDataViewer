import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { detectTactileRegion } from '../src/tactileRoi.ts';
import { TactileCalibration, TactileFilter } from '../src/tactileFilter.ts';

const fixture = JSON.parse(readFileSync(new URL('fixtures/tactile-roi.json', import.meta.url), 'utf8'));
const decode = (s:string) => new Uint8Array(inflateSync(Buffer.from(s, 'base64')));
const rgba = (gray:Uint8Array) => Uint8ClampedArray.from({length:gray.length*4}, (_, i) => i%4===3 ? 255 : gray[Math.floor(i/4)]);
const black = (output:Uint8ClampedArray) => output.every((v,i) => v===(i%4===3 ? 255 : 0));

for (const f of fixture.cases) test(`arc oracle: ${f.name}`, () => {
  const gray=decode(f.baseline), original=gray.slice(), start=performance.now();
  const actual=detectTactileRegion(gray,f.width,f.height), mask=decode(f.mask), bytes=decode(f.curve);
  const curve=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.length/4);
  assert.equal(actual.status,f.status);assert.deepEqual(gray,original);
  assert.ok(Math.abs(actual.confidence-f.confidence)<.01,`${actual.confidence} vs ${f.confidence}`);
  assert.equal(actual.curve.length,curve.length);
  for(let y=0;y<curve.length;y++)assert.ok(Math.abs(actual.curve[y]-curve[y])<=1,`row ${y}: ${actual.curve[y]} vs ${curve[y]}`);
  // Any rounding difference must be at the fitted boundary, never elsewhere.
  let differences=0;
  for(let p=0;p<mask.length;p++)if(actual.mask[p]!==mask[p]){
    differences++;const x=p%f.width,y=Math.floor(p/f.width);
    const neighbors=[p-1,p+1,p-f.width,p+f.width].filter(q=>q>=0&&q<mask.length);
    assert.ok(neighbors.some(q=>mask[q]!==mask[p]),`mask differs away from boundary at ${x},${y}`);
  }
  assert.ok(differences<=f.height*2,`mask differences: ${differences}`);
  if(f.status==='not-found')assert.ok(actual.mask.every(v=>v===0));
  console.log(`${f.name}: ${Math.round(performance.now()-start)} ms, confidence ${actual.confidence.toFixed(4)}, mask differences ${differences}`);
});

test('mask excludes outside changes before blur and after color, including Show all changes', () => {
  const f=fixture.cases.find((f:{name:string})=>f.name==='odd-dimensions'), gray=decode(f.baseline), current=rgba(gray);
  const calibration=new TactileCalibration(f.width,f.height);calibration.add(current);
  const model=calibration.finish(), mask=model.roiMask.slice(), baseline=model.baseline.slice();
  assert.equal(model.roiStatus,'ready');assert.equal(model.sampleCount,1);
  const filter=new TactileFilter(model), output=new Uint8ClampedArray(current.length);
  for(let p=0;p<gray.length;p++)if(!mask[p])for(let k=0;k<3;k++)current[p*4+k]=255-gray[p];
  for(const cleanup of [true,false])for(const gain of [1,10,16]){filter.render(current,output,gain,cleanup);assert.ok(black(output));}
  const outsideOnly=current.slice();
  // A sustained change immediately inside the mask must remain visible without
  // leaking outside it. Mutating the caller's model must not mutate the filter.
  for(let p=0;p<gray.length;p++)if(mask[p])for(let k=0;k<3;k++)current[p*4+k]=255;
  model.roiMask.fill(0);
  for(const cleanup of [true,false]){
    filter.render(current,output,10,cleanup);assert.ok(!black(output));const expected=output.slice();
    for(let p=0;p<gray.length;p++)if(!mask[p])assert.deepEqual([...output.subarray(p*4,p*4+4)],[0,0,0,255]);
    filter.render(outsideOnly,output,16,cleanup);assert.ok(black(output));
    filter.render(current,output,10,cleanup);assert.deepEqual(output,expected);
    filter.render(rgba(baseline),output,10,cleanup);assert.ok(black(output));
  }
  assert.deepEqual(model.baseline,baseline);
});

test('failed detection stays black, even if a malformed caller supplies nonzero mask values', () => {
  const calibration=new TactileCalibration(9,7);calibration.add(rgba(new Uint8Array(63).fill(255)));
  const model=calibration.finish();assert.equal(model.roiStatus,'not-found');model.roiMask.fill(1);
  const out=new Uint8ClampedArray(63*4), filter=new TactileFilter(model);
  for(const cleanup of [true,false]){filter.render(rgba(new Uint8Array(63)),out,16,cleanup);assert.ok(black(out));}
  assert.throws(()=>detectTactileRegion(new Uint8Array(0),0,1));
  assert.throws(()=>new TactileFilter({...model,roiMask:new Uint8Array(1)}));
});
