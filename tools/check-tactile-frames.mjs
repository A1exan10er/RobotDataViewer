// Internal regression driver: RGBA fixtures are extracted locally, never shipped.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import assert from 'node:assert/strict';
import {TactileFilter} from '../src/tactileFilter.ts';
const manifestPath=resolve(process.argv[2]),manifest=JSON.parse(readFileSync(manifestPath));
const report=[];
for(const f of manifest){
 const reference=new Uint8ClampedArray(readFileSync(resolve(dirname(manifestPath),f.reference)));
 const current=new Uint8ClampedArray(readFileSync(resolve(dirname(manifestPath),f.current)));
 const filter=new TactileFilter(f.width,f.height,reference),out=new Uint8ClampedArray(current.length);
 filter.render(current,out);const first=out.slice();filter.render(reference,out);assert.ok(out.every(v=>v===255));filter.render(current,out);assert.deepEqual(out,first);
 let changed=0;for(let i=0;i<out.length;i+=4)if(out[i+2]<225)changed++;
 if(f.expected==='white')assert.equal(changed,0,JSON.stringify({...f,changed}));
 if(f.expected==='response')assert.ok(changed>500,JSON.stringify({...f,changed}));
 report.push({...f,changed});
}
writeFileSync(resolve(dirname(manifestPath),'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({frames:report.length,white:report.filter(x=>x.expected==='white').length,response:report.filter(x=>x.expected==='response').length,report:resolve(dirname(manifestPath),'results.json')},null,2));
