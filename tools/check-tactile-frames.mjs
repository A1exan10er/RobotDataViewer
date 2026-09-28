// Independent OpenCV goldens for local sample frames, never shipped.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import assert from 'node:assert/strict';
import {TactileFilter} from '../src/tactileFilter.ts';
import {detectTactileRegion} from '../src/tactileRoi.ts';
const manifestPath=resolve(process.argv[2]),manifest=JSON.parse(readFileSync(manifestPath));
const load=path=>new Uint8Array(readFileSync(resolve(dirname(manifestPath),path)));
const palette=load('inferno.rgb'),gamma=Uint8Array.from({length:256},(_,i)=>Math.floor(Math.pow(i/255,.7)*255));
const report=[],regions=new Map();
for(const f of manifest){
 const baseline=load(f.baseline);
 if(!regions.has(f.baseline)){
  const started=performance.now(),roi=detectTactileRegion(baseline,f.width,f.height),ms=performance.now()-started;
  const expectedMask=load(f.roiMask),expectedCurve=new Float32Array(load(f.roiCurve).buffer);
  assert.equal(roi.status,f.roiStatus);assert.ok(Math.abs(roi.confidence-f.roiConfidence)<.01);
  const maxCurveError=Math.max(...roi.curve.map((x,y)=>Math.abs(x-expectedCurve[y])));
  assert.ok(maxCurveError<=1,`${f.baseline}: boundary error ${maxCurveError}`);
  let maskDifferences=0;for(let p=0;p<expectedMask.length;p++)if(expectedMask[p]!==roi.mask[p]){
   maskDifferences++;assert.ok([p-1,p+1,p-f.width,p+f.width].some(q=>q>=0&&q<expectedMask.length&&expectedMask[q]!==expectedMask[p]));
  }
  assert.ok(maskDifferences<=f.height*2);
  writeFileSync(resolve(dirname(manifestPath),f.roiMask+'.js'),roi.mask);
  regions.set(f.baseline,{...roi,ms,maxCurveError,maskDifferences});
 }
 const roi=regions.get(f.baseline);
 // Color parity uses the identical oracle mask. Arc parity is checked separately
 // above so a boundary quantization difference cannot be mistaken for blur error.
 const model={width:f.width,height:f.height,sampleCount:f.sampleCount,baseline,noiseFloor:new Float32Array(load(f.noiseFloor).buffer),roiMask:load(f.roiMask),roiStatus:roi.status,roiConfidence:roi.confidence};
 const amplified=load(f.amplified);
 const current=new Uint8ClampedArray(load(f.current)),expected=load(f.expected);
 const filter=new TactileFilter(model),out=new Uint8ClampedArray(current.length);
 filter.render(current,out);const first=out.slice();filter.render(new Uint8ClampedArray(current.length),out);filter.render(current,out);assert.deepEqual(out,first);
 let changed=0,maxError=0,mismatches=0;
 for(let i=0;i<out.length;i++){const error=Math.abs(out[i]-expected[i]);maxError=Math.max(maxError,error);if(error)mismatches++;if(i%4===0&&Math.max(out[i],out[i+1],out[i+2])>0)changed++;}
 // OpenCV's SIMD float32 summation and JS can straddle one quantization bin.
 // Require every differing pixel to be exactly the corresponding neighboring
 // gain bin's gamma/Inferno color, including the explicit black cutoff.
 for(let p=0;p<amplified.length;p++){
  if(!model.roiMask[p])assert.deepEqual([...out.subarray(p*4,p*4+4)],[0,0,0,255]);
  const i=p*4;if(out.slice(i,i+4).every((v,c)=>v===expected[i+c]))continue;
  assert.equal(out[i+3],255);
  assert.ok([-1,0,1].some(offset=>{let value=gamma[Math.max(0,Math.min(255,amplified[p]+offset))];if(value<10)value=0;return [0,1,2].every(c=>out[i+c]===(value?palette[value*3+c]:0));}),JSON.stringify({...f,p,maxError}));
 }
 assert.ok(mismatches/out.length<.001,JSON.stringify({...f,maxError,mismatches}));
 report.push({task:f.task,channel:f.channel,time:f.time,changed,maxError,mismatches});
}
const masks=[...regions].map(([sample,r])=>({sample,status:r.status,confidence:r.confidence,ms:r.ms,maxCurveError:r.maxCurveError,maskDifferences:r.maskDifferences,area:r.mask.reduce((a,b)=>a+b,0)/r.mask.length}));
writeFileSync(resolve(dirname(manifestPath),'roi-results.json'),JSON.stringify(masks,null,2));
writeFileSync(resolve(dirname(manifestPath),'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({frames:report.length,black:report.filter(x=>x.changed===0).length,maxError:Math.max(...report.map(x=>x.maxError)),mismatches:report.reduce((n,x)=>n+x.mismatches,0),masks,report:resolve(dirname(manifestPath),'results.json')},null,2));
