// Offline diagnostics for existing ignored baseline samples; no recordings are shipped.
import fs from 'node:fs';
import path from 'node:path';
import {detectTactileRegion} from '../src/tactileRoi.ts';
const root=path.resolve(import.meta.dirname,'..'),output=path.join(root,'artifacts/region-validation');fs.mkdirSync(output,{recursive:true});
const reports=[];
for(const [folder,pattern] of [['arc-investigation',/^\d{4}-.*tactile-baseline\.npy$/],['response-roi',/-baseline\.gray$/]]){
 for(const name of fs.readdirSync(path.join(root,'artifacts',folder)).filter(n=>pattern.test(n)).sort()){
  const bytes=fs.readFileSync(path.join(root,'artifacts',folder,name));
  const gray=new Uint8Array(name.endsWith('.npy')?bytes.subarray(10+bytes.readUInt16LE(8)):bytes);
  const started=performance.now(),region=detectTactileRegion(gray,640,360);
  fs.writeFileSync(path.join(output,name+'.mask'),region.mask);fs.writeFileSync(path.join(output,name+'.curve'),new Uint8Array(region.curve.buffer));
  reports.push({name,folder,status:region.status,method:region.method,confidence:region.confidence,ms:performance.now()-started,area:region.mask.reduce((a,b)=>a+b,0)});
 }
}
fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(reports,null,2));
console.log(JSON.stringify({count:reports.length,failed:reports.filter(r=>r.status!=='ready'),recovered:reports.filter(r=>r.method==='broader'),maxMs:Math.max(...reports.map(r=>r.ms))},null,2));
if(reports.length!==52||reports.some(r=>r.status!=='ready'))process.exitCode=1;
