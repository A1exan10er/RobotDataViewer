import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';
const root=new URL('../',import.meta.url);
const frontend=await readFile(new URL('vendor/libav.js',root),'utf8');
const factory=await readFile(new URL('vendor/libav-factory.js',root),'utf8');
const worker=await readFile(new URL('tools/decoder-worker.js',root),'utf8');
// Both workers and the compatibility renderer use these same sources. The worker
// bundle is a classic script, so resolve this explicit local dependency at build time.
let filter='';
for(const path of ['src/tactileRoi.ts','src/tactileFilter.ts'])
  filter+=ts.transpileModule(await readFile(new URL(path,root),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^import .*;\s*$/gm,'').replace(/^export /gm,'')+'\n';
filter=filter.trimEnd()+'\n';
await writeFile(new URL('vendor/tactile-filter.js',root),filter);
await writeFile(new URL('vendor/decoder-worker.js',root),frontend+'\n'+factory+'\n'+filter+'\n'+worker);
await writeFile(new URL('vendor/decoder.wasm.b64',root),(await readFile(new URL('vendor/decoder.wasm',root))).toString('base64'));
