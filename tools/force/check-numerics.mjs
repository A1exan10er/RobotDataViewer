import { readFile,writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const root=new URL('../../',import.meta.url),require=createRequire(import.meta.url);
const factory=new Function('require','__dirname',(await readFile(new URL('vendor/force/deepflow.js',root),'utf8'))+';return DeepFlowFactory;')(require,new URL('vendor/force/',root).pathname);
const cv=await factory({wasmBinary:await readFile(new URL('vendor/force/deepflow.wasm',root))});
const cases=JSON.parse(await readFile(new URL('artifacts/force-reference/manifest.json',root),'utf8')),results=[];
for(const c of cases){
  const ref=await readFile(new URL(`artifacts/force-reference/${c.name}-reference.rgba`,root)),cur=await readFile(new URL(`artifacts/force-reference/${c.name}-current.rgba`,root));
  const p=cv._malloc(ref.length);cv.HEAPU8.set(ref,p);assert.equal(cv._force_reset(p,c.width,c.height),1);
  cv.HEAPU8.set(cur,p);const started=performance.now(),ptr=cv._force_input(p,c.width,c.height);assert.ok(ptr,cv.UTF8ToString(cv._force_error()));
  const actual=cv.HEAPF32.slice(ptr/4,ptr/4+3*640*360),raw=await readFile(new URL(`artifacts/force-reference/${c.name}-input.f32`,root));
  const expected=new Float32Array(raw.buffer,raw.byteOffset,raw.byteLength/4);let flowMax=0,flowMean=0,diffMax=0;
  for(let i=0;i<actual.length;i++){const error=Math.abs(actual[i]-expected[i]);if(i<2*640*360){flowMax=Math.max(flowMax,error);flowMean+=error;}else diffMax=Math.max(diffMax,error);}
  await writeFile(new URL(`artifacts/force-reference/${c.name}-wasm.f32`,root),Buffer.from(actual.buffer));
  results.push({name:c.name,flowMax,flowMean:flowMean/(2*640*360),diffMax,milliseconds:performance.now()-started});cv._free(p);
}
await writeFile(new URL('artifacts/force-reference/preprocess-results.json',root),JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
assert.ok(results.every(r=>r.diffMax===0),'Relative diff must match NumPy exactly');
// Native SIMD and WASM iterative solvers have different floating-point kernels.
// The acceptance gate is the resulting force error in check-force-values.py.
