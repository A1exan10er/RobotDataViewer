import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root=new URL('../../',import.meta.url);
const text=path=>readFile(new URL(path,root),'utf8');
const b64=async path=>(await readFile(new URL(path,root))).toString('base64');
const manifest=JSON.parse(await text('vendor/force/model.json'));
const model=await readFile(new URL('vendor/force/force.onnx',root));
if(createHash('sha256').update(model).digest('hex')!==manifest.onnxSha256)throw new Error('Force model checksum mismatch');
const worker=(await Promise.all(['vendor/libav.js','vendor/libav-factory.js','vendor/force/deepflow.js','node_modules/onnxruntime-web/dist/ort.all.min.js','tools/force/worker.js'].map(text))).join('\n');
const assets={manifest,worker,model:model.toString('base64'),deepflowWasm:await b64('vendor/force/deepflow.wasm'),
  ortModule:await text('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs'),ortWasm:await b64('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm')};
await mkdir(new URL('public/',root),{recursive:true});
await writeFile(new URL('public/force-runtime.js',root),'globalThis.RDV_FORCE_ASSETS='+JSON.stringify(assets)+';\n');
console.log('Built optional, local force-runtime.js');
