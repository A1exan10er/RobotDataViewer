import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TactileFilter, TactileCalibration, tactileGray, tactileBaselineCount } from '../src/tactileFilter.ts';

function frame(w:number,h:number,value=100){const a=new Uint8ClampedArray(w*h*4);for(let i=0;i<a.length;i+=4){a[i]=a[i+1]=a[i+2]=value;a[i+3]=255;}return a;}
// Filter-only numerical goldens use an explicit all-valid region; runtime
// calibration never substitutes this for a failed detection.
function allowAll(m:ReturnType<TactileCalibration['finish']>){m.roiMask.fill(1);m.roiStatus='ready';return m;}
function model(w=41,h=25){const c=new TactileCalibration(w,h);for(const n of [96,104,99,101,100,102,98,100])c.add(frame(w,h,n));return allowAll(c.finish());}
function isBlack(out:Uint8ClampedArray){return out.every((v,i)=>v===(i%4===3?255:0));}
const bytes=(s:string)=>new Uint8ClampedArray(Buffer.from(s,'base64'));

test('NumPy/OpenCV goldens match grayscale, median, percentile, Gaussian borders and Inferno',()=>{
  const fixture=JSON.parse(readFileSync(new URL('fixtures/tactile-reference.json',import.meta.url),'utf8'));
  for(const f of fixture.cases){
    const calibration=new TactileCalibration(f.width,f.height);
    for(const encoded of f.frames)calibration.add(bytes(encoded));
    const baseline=calibration.finish();
    assert.deepEqual([...baseline.baseline],[...bytes(f.baseline)]);
    const expectedNoise=bytes(f.noiseFloor),view=new DataView(expectedNoise.buffer);
    for(let p=0;p<baseline.noiseFloor.length;p++)assert.equal(baseline.noiseFloor[p],view.getFloat32(p*4,true));
    const current=bytes(f.current),copy=current.slice();
    assert.deepEqual([...tactileGray(current)],[...bytes(f.gray)]);
    const filter=new TactileFilter(allowAll(baseline)),output=new Uint8ClampedArray(current.length);
    for(const r of f.renders){
      filter.render(current,output,r.gain,r.cleanup);
      const expected=bytes(r.output);
      // Float32 SIMD accumulation may move a value across one 8-bit quantization bin.
      const max=Math.max(...output.map((v,i)=>Math.abs(v-expected[i])));
      assert.ok(max<=3,`OpenCV parity ${f.width}x${f.height}, gain ${r.gain}, cleanup ${r.cleanup}: ${max}`);
      for(let p=3;p<output.length;p+=4)assert.equal(output[p],255);
    }
    assert.deepEqual(current,copy);
  }
});
test('baseline length follows the reference, including ties-to-even and short clips',()=>{
  assert.equal(tactileBaselineCount(30,100),60);assert.equal(tactileBaselineCount(29.97,100),60);
  assert.equal(tactileBaselineCount(30.25,100),60);assert.equal(tactileBaselineCount(30.75,100),62);
  assert.equal(tactileBaselineCount(1,20),8);assert.equal(tactileBaselineCount(30,3),3);
  assert.equal(tactileBaselineCount(NaN,100),60);assert.equal(tactileBaselineCount(30,0),0);
});
test('calibrated background is opaque black at all gains; Show all changes exposes noise',()=>{
  const baseline=model(),filter=new TactileFilter(baseline),current=frame(41,25,104),out=current.slice();
  for(const gain of [1,10,16]){filter.render(current,out,gain);assert.ok(isBlack(out));}
  filter.render(current,out,10,false);assert.ok(!isBlack(out));
  filter.render(frame(41,25),out,10,false);assert.ok(isBlack(out));
});
test('weak, strong and held responses remain deterministic through settings and seek order',()=>{
  const baseline=model(),original=baseline.baseline.slice(),noise=baseline.noiseFloor.slice();
  const filter=new TactileFilter(baseline),out=frame(41,25),contact=frame(41,25,108);
  filter.render(contact,out);assert.ok(!isBlack(out));const weak=out.slice();
  for(let i=0;i<4;i++){filter.render(frame(41,25),out);assert.ok(isBlack(out));filter.render(frame(41,25,130),out,16);filter.render(contact,out);assert.deepEqual(out,weak);}
  filter.render(contact,out,1);assert.notDeepEqual(out,weak);filter.render(contact,out);assert.deepEqual(out,weak);
  assert.deepEqual(baseline.baseline,original);assert.deepEqual(baseline.noiseFloor,noise);
});
test('calibration copies inputs, releases frames, handles one-frame clips and rejects bad dimensions',()=>{
  const c=new TactileCalibration(1,1),a=frame(1,1,42);c.add(a);a[0]=255;
  const baseline=c.finish();assert.equal(baseline.baseline[0],42);assert.equal(baseline.noiseFloor[0],0);
  assert.throws(()=>c.finish());assert.throws(()=>new TactileCalibration(0,1));
  assert.throws(()=>c.add(frame(2,1)));assert.throws(()=>new TactileFilter({...baseline,width:2}));
  assert.throws(()=>new TactileFilter(baseline).render(frame(2,1),frame(2,1)));
});
test('portrait orientation, tiny images and saturation follow the recorded pixels',()=>{
  for(const [w,h] of [[9,17],[1,1],[1,9],[7,3]]){
    const baseline=model(w,h),current=frame(w,h),out=current.slice();
    for(let y=0;y<Math.ceil(h/2);y++)for(let x=0;x<w;x++)for(let c=0;c<3;c++)current[(y*w+x)*4+c]=255;
    new TactileFilter(baseline).render(current,out,16,false);
    assert.deepEqual([...out.slice(0,4)],[252,255,164,255]);
    if(h>1)assert.deepEqual([...out.slice(-4)],[0,0,0,255]);
  }
});
test('the post-gamma cutoff suppresses values below 10 without suppressing the next bin',()=>{
  const baseline=model(1,1),out=frame(1,1),current=frame(1,1,112);
  baseline.noiseFloor[0]=9.79;new TactileFilter(baseline).render(current,out);assert.ok(isBlack(out));
  baseline.noiseFloor[0]=9.69;new TactileFilter(baseline).render(current,out);assert.ok(!isBlack(out));
  new TactileFilter(baseline).render(frame(1,1,101),out,1,false);assert.ok(!isBlack(out));
});

test('grayscale calibration and rendering match RGBA exactly without changing input',()=>{
  const w=41,h=23,frames=Array.from({length:8},(_,f)=>Uint8ClampedArray.from({length:w*h*4},(_,i)=>i%4===3?255:(i*17+f*3)%256));
  const rgbaCalibration=new TactileCalibration(w,h),grayCalibration=new TactileCalibration(w,h);
  for(const rgba of frames){rgbaCalibration.add(rgba);const gray=tactileGray(rgba);grayCalibration.addGray(gray);gray.fill(255);}
  const a=allowAll(rgbaCalibration.finish()),b=allowAll(grayCalibration.finish());assert.deepEqual(a,b);
  const filter=new TactileFilter(a),out=new Uint8ClampedArray(w*h*4),expected=new Uint8ClampedArray(out.length);
  const rgba=frames[3],gray=tactileGray(rgba),original=gray.slice();
  for(const gain of [1,10,16])for(const cleanup of [true,false]){filter.render(rgba,expected,gain,cleanup);filter.renderGray(gray,out,gain,cleanup);assert.deepEqual(out,expected);assert.deepEqual(gray,original);}
});
