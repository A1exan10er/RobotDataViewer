import test from 'node:test';
import assert from 'node:assert/strict';
import { readTar,recordingPath } from '../src/archive.ts';
import { parseCsv } from '../src/csv.ts';
import { makeTiming,parseTrajectories } from '../src/raw.ts';
import { openRecording } from '../src/source.ts';
function member(name:string,body:string,type='0'){
 const header=new Uint8Array(512),enc=new TextEncoder(),bytes=enc.encode(body);
 const put=(offset:number,value:string)=>header.set(enc.encode(value),offset);
 put(0,name);put(100,'0000644\0');put(124,bytes.length.toString(8).padStart(11,'0')+'\0');put(148,'        ');put(156,type);put(257,'ustar\0');
 put(148,header.reduce((s,b)=>s+b,0).toString(8).padStart(6,'0')+'\0 ');
 return [header,bytes,new Uint8Array((512-bytes.length%512)%512)];
}
function tar(parts:(string|Uint8Array)[]){return new Blob([...parts,new Uint8Array(1024)]);}
function file(path:string,text:string){const f=new File([text],path.split('/').at(-1)!);Object.defineProperty(f,'webkitRelativePath',{value:path});return f;}
test('TAR reads original members as slices and rejects damaged/truncated content',async()=>{
 const blob=tar(member('episode/data.csv','timestamp_ms,x\n0,1\n'));
 const files=await readTar(blob);assert.equal(await files.get('episode/data.csv')!.text(),'timestamp_ms,x\n0,1\n');
 await assert.rejects(readTar(blob.slice(0,520)));
 const bytes=new Uint8Array(await blob.arrayBuffer());bytes[1]^=1;await assert.rejects(readTar(new Blob([bytes])));
 await assert.rejects(readTar(tar(member('../outside','x'))));
 await assert.rejects(readTar(tar([...member('same','x'),...member('same','y')])));
});
test('TAR supports Unicode PAX paths, GNU long names, and ignores symlinks',async()=>{
 const name='episode/'+ '中文'.repeat(55)+'/data.csv';const value='path='+name+'\n';let length=new TextEncoder().encode(value).length+3;
 while(length!==String(length).length+1+new TextEncoder().encode(value).length)length=String(length).length+1+new TextEncoder().encode(value).length;
 const files=await readTar(tar([...member('pax',length+' '+value,'x'),...member('placeholder','pax-data'),...member('long',name+'2\0','L'),...member('short','long-data'),...member('link','','2')]));
 assert.equal(await files.get(name)!.text(),'pax-data');assert.equal(await files.get(name+'2')!.text(),'long-data');assert.equal(files.size,2);
 for(const p of ['/etc/a','C:/a','a/../b','a\\b','a//b'])assert.throws(()=>recordingPath(p));
});
test('CSV handles BOM, quoted commas/newlines and rejects unterminated values',()=>{
 const csv=parseCsv('\uFEFFtimestamp_ms,name,x\r\n0,"a,b\nline",1\r\n');assert.equal(csv.rows[0].name,'a,b\nline');assert.throws(()=>parseCsv('a\n"b'));
});
test('timing uses exact capture times or explicit estimates with capture offset',()=>{
 assert.deepEqual(makeTiming([0,.033,.1],parseCsv('timestamp_ms\n100\n133\n208').rows),{media:[0,.033,.1],episode:[100,133,208],estimated:false});
 assert.deepEqual(makeTiming([0,.033,.1],parseCsv('timestamp_ms\n100\n133').rows),{media:[0,.033,.1],episode:[100,133,200],estimated:true});
 assert.equal(makeTiming([0,.1],parseCsv('timestamp_ms\n\n5\n2').rows).estimated,true);
});
test('full raw capture timestamps align videos with intentionally shortened training observations',()=>{
 const pts=[0,.033,.066],raw=parseCsv('timestamp_ms,is_new\n2,true\n32,true\n70,true').rows;
 const training=raw.slice(0,-1);
 assert.deepEqual(makeTiming(pts,training,raw),{media:pts,episode:[2,32,70],estimated:false});
 // Prefer capture timing even if a processed file also has a complete but shifted timeline.
 assert.deepEqual(makeTiming(pts,parseCsv('timestamp_ms\n0\n33\n66').rows,raw).episode,[2,32,70]);
 assert.deepEqual(makeTiming(pts,[],raw).episode,[2,32,70]);
 assert.equal(training.length,2);assert.equal(raw.length,3);
});
test('incomplete or invalid raw timestamps fall back to a valid processed timeline',()=>{
 const pts=[0,.033,.066],processed=parseCsv('timestamp_ms\n10\n43\n76').rows;
 for(const values of ['', '2\n32', '2\n70\n32', '2\nnan\n70', '-1\n32\n70', '2\n2\n2']){
   const raw=parseCsv('timestamp_ms\n'+values).rows;
   assert.deepEqual(makeTiming(pts,processed,raw),{media:pts,episode:[10,43,76],estimated:false});
 }
});
test('a one-entry difference alone never invents exact alignment',()=>{
 const pts=[0,.04,.1],short=parseCsv('timestamp_ms\n7\n47').rows;
 assert.deepEqual(makeTiming(pts,short,short),{media:pts,episode:[7,47,107],estimated:true});
 assert.deepEqual(makeTiming(pts,[],short),{media:pts,episode:[7,47,107],estimated:true});
});
test('UMI reference transforms apply to position/orientation without inventing alignment',()=>{
 const pose=(x:number)=>({'tcp.x':x,'tcp.y':0,'tcp.z':0,'tcp.qw':1,'tcp.qx':0,'tcp.qy':0,'tcp.qz':0});
 const csv=parseCsv('timestamp_ms,right_x,right_y,right_z,right_r1,right_r2,right_r3,right_r4,right_r5,right_r6,right_gripper\n0,1,2,3,1,0,0,0,1,0,.03\n1,,2,3,1,0,0,0,1,0,.03');
 const metadata={coordinate_reference:{type:'umi_episode_start_relative_pose',sides:{left:{reference_pose:pose(10)},right:{reference_pose:pose(12)}}}};
 const issues:any[]=[];const aligned=parseTrajectories(csv,metadata,issues)[0];assert.equal(aligned.frame,'shared');assert.deepEqual(aligned.points[0].p,[3,2,3]);assert.deepEqual(aligned.points[0].axes,[[1,0,0],[0,1,0],[0,0,1]]);assert.equal(issues[0].count,1);
 const raw=parseTrajectories(csv,{},[])[0];assert.equal(raw.frame,'recorded');assert.deepEqual(raw.points[0].p,[1,2,3]);
});
test('original folders discover nested episodes without manifests; empty tactile signals stay empty',async()=>{
 const files=[file('local/task/episode1/metadata.json','{"robot":"umi","task_title":"Sample"}'),file('local/task/episode1/observation.state.eef_pose/data.csv','timestamp_ms,x,y,z,r1,r2,r3,r4,r5,r6\n0,1,2,3,1,0,0,0,1,0\n1000,2,3,4,1,0,0,0,1,0'),file('local/task/episode1/observation.state.left_wrist_left_tactile/data.csv','timestamp_ms,x,y,z\n'),file('local/task/episode2/metadata.json','{}'),file('local/task/episode2/observation/state/gripper/data.csv','timestamp_ms,gripper\n0,.02\n1000,.03')];
 const source=await openRecording(files);assert.equal(source.kind,'original');assert.equal(source.manifest.episodes.length,2);
 const data=await source.data(source.manifest.episodes[0].data);assert.equal(data.trajectories[0].points.length,2);assert.equal(data.signals.length,3);assert.ok(source.manifest.episodes[0].issues.some(i=>i.code==='empty_signal'));
 const second=await source.data(source.manifest.episodes[1].data);assert.equal(second.signals[0].values[1],.03);source.dispose();assert.equal(source.file(files[0].webkitRelativePath),undefined);
});

test('a malformed numeric channel does not hide the other recorded signals',async()=>{
 const source=await openRecording([file('episode/metadata.json','null'),file('episode/observation.state.eef_pose/data.csv','timestamp_ms,x\n"unfinished'),file('episode/observation.state.gripper/data.csv','timestamp_ms,gripper\n0,.02\n1000,.03')]);
 const data=await source.data(source.manifest.episodes[0].data);assert.equal(data.signals[0].values[1],.03);assert.ok(source.manifest.episodes[0].issues.some(i=>i.code==='invalid_samples'));
});
