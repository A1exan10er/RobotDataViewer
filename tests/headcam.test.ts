import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openRecording } from '../src/source.ts';
import { mediaTimeAt } from '../src/math.ts';

const head=new Uint8Array(await readFile(new URL('./fixtures/timing-60fps.mp4',import.meta.url)));
const wrist=new Uint8Array(await readFile(new URL('./fixtures/timing-30fps.mp4',import.meta.url)));
const json=(v:unknown)=>JSON.stringify(v);
const pose=(x:number)=>({'tcp.x':x,'tcp.y':0,'tcp.z':0,'tcp.qw':1,'tcp.qx':0,'tcp.qy':0,'tcp.qz':0});
function fixture(root='task/T1E1/',umi='umi'){
 const entries=new Map<string,string|Uint8Array>([
  [root+'metadata.json',json({format:'ego-headcam-companion-1',umi_episode:umi,episode_id:'sample',duration_seconds:.1})],
  [root+umi+'/metadata.json',json({task_title:'Head + UMI / 头戴相机',robot:'umi',coordinate_reference:{type:'umi_episode_start_relative_pose',sides:{left:{pose:pose(10)},right:{pose:pose(12)}}}})],
  [root+umi+'/observation.state.eef_pose/data.csv','timestamp_ms,left_x,left_y,left_z,right_x,right_y,right_z\n0,1,2,3,4,5,6\n60,2,3,4,5,6,7'],
  [root+umi+'/observation.state.gripper/data.csv','timestamp_ms,left_gripper,right_gripper\n0,.02,.03\n60,.01,.01'],
  // These are audit/provenance records, never instructions to shift or swap video.
  [root+'alignment.json',json({offset_ms:9999,effective_stereo_order:'right-left',source_episode:'/unavailable/elsewhere'})],
  [root+'frame_mappings/observation.image.left_wrist_view.csv','umi_frame_index,head_video_frame_index\n0,2\n1,1\n2,0'],
 ]);
 for(const eye of ['left','right']){
  const p=root+'observation.image.ego_'+eye+'/';
  entries.set(p+'video.mp4',head);
  entries.set(p+'timestamps.csv','timestamp_ms,is_new,source_raw_index,source_sequence\n7.648807,1,580,4404\n23.635805,1,581,4405\n43.707802,1,582,4406');
  entries.set(p+'timestamps_raw.csv','timestamp_ms\n1000\n1016\n1033');
 }
 for(const name of ['left_wrist_view','right_wrist_view','left_wrist_left_tactile','left_wrist_right_tactile','right_wrist_left_tactile','right_wrist_right_tactile']){
  const p=root+umi+'/observation.image.'+name+'/';entries.set(p+'video.mp4',wrist);
  entries.set(p+'timestamps_raw.csv','timestamp_ms,is_new\n0,1\n20,1\n60,1');
  entries.set(p+'timestamps.csv','timestamp_ms,is_new\n0,1\n20,1');
 }
 return entries;
}
function files(entries:Map<string,string|Uint8Array>){
 return [...entries].map(([path,body])=>{const f=new File([body],path.split('/').at(-1)!);Object.defineProperty(f,'webkitRelativePath',{value:path});return f;});
}
function archive(entries:Map<string,string|Uint8Array>){
 const enc=new TextEncoder(),parts:Uint8Array[]=[];
 for(const [path,body] of entries){
  const bytes=typeof body==='string'?enc.encode(body):body,header=new Uint8Array(512);
  const put=(offset:number,s:string)=>header.set(enc.encode(s),offset);
  put(0,path);put(100,'0000644\0');put(124,bytes.length.toString(8).padStart(11,'0')+'\0');put(148,'        ');put(156,'0');put(257,'ustar\0');
  put(148,header.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ');parts.push(header,bytes,new Uint8Array((512-bytes.length%512)%512));
 }
 return new File([...parts,new Uint8Array(1024)],'synthetic-headcam.tar');
}
for(const tar of [false,true])test(`head companion ${tar?'TAR':'folder'} combines eight channels and exact individual timelines`,async()=>{
 const entries=fixture(),source=await openRecording(tar?[archive(entries)]:files(entries),tar);
 assert.equal(source.manifest.episodes.length,1);const ep=source.manifest.episodes[0];
 assert.equal(ep.title,'Head + UMI / 头戴相机');assert.equal(ep.robot,'umi');assert.equal(ep.stateRoot,'task/T1E1/umi/');
 assert.deepEqual(ep.media.map(m=>m.id),['ego_left','ego_right','l_wrist','r_wrist','l_tact_l','l_tact_r','r_tact_l','r_tact_r']);
 const data=await source.data(ep.data);
 assert.ok(ep.media.every(m=>!m.failed&&m.frames===3));assert.ok(Math.abs(ep.media[0].fps-60)<1e-8);assert.ok(Math.abs(ep.media[2].fps-30)<1e-8);
 assert.deepEqual(data.timings.ego_left.episode,[7.648807,23.635805,43.707802]);
 assert.deepEqual(data.timings.ego_left,data.timings.ego_right);
 assert.deepEqual(data.timings.l_wrist.episode,[0,20,60]);assert.ok(Object.values(data.timings).every(t=>!t.estimated));
 assert.ok(Math.abs(mediaTimeAt(data.timings.ego_left,23.635805)-1/60)<1e-8);
 assert.ok(Math.abs(mediaTimeAt(data.timings.l_wrist,20)-1/30)<1e-8);
 const t=data.timings.ego_left.episode;assert.ok(Math.abs(mediaTimeAt(data.timings.ego_left,(t[1]+t[2])/2)-.025)<1e-8);
 assert.deepEqual(data.trajectories.map(t=>t.frame),['shared','shared']);assert.deepEqual(data.trajectories[1].points[0].p,[6,5,6]);
 assert.deepEqual(data.signals.find(s=>s.id==='gripper.left_gripper')!.values,[.02,.01]);
 assert.deepEqual(await source.data(ep.data),data);assert.deepEqual(ep.issues,[]);
});
test('parent folders keep separate companion exports and independent legacy episodes',async()=>{
 const entries=new Map([...fixture('task/a/'),...fixture('task/b/','recording/umi')]);
 entries.set('task/legacy/metadata.json','{}');entries.set('task/legacy/observation.state.gripper/data.csv','timestamp_ms,gripper\n0,.03');
 const source=await openRecording(files(entries));assert.equal(source.manifest.episodes.length,3);
 assert.deepEqual(source.manifest.episodes.map(e=>e.sourceName),['task/a','task/b','task/legacy']);
 // Selecting umi by itself continues to open a normal six-camera episode.
 const standalone=files(new Map([...fixture()].filter(([p])=>p.includes('/umi/')).map(([p,b])=>[p.slice('task/T1E1/'.length),b])));
 const umi=await openRecording(standalone);assert.equal(umi.manifest.episodes.length,1);assert.equal(umi.manifest.episodes[0].media.length,6);
});
test('untrusted companion paths and unknown format cannot absorb unrelated episodes',async()=>{
 for(const path of ['../other','/other','umi/../other','umi\\other','https://other','',null]){
  const entries=fixture();entries.set('task/T1E1/metadata.json',json({format:'ego-headcam-companion-1',umi_episode:path}));
  const s=await openRecording(files(entries));assert.equal(s.manifest.episodes.length,2);assert.equal(s.manifest.episodes[0].media.length,2);assert.equal(s.manifest.episodes[0].stateRoot,undefined);
 }
 for(const metadata of ['null',json({format:'unknown',umi_episode:'umi'})]){
  const entries=fixture();entries.set('task/T1E1/metadata.json',metadata);assert.equal((await openRecording(files(entries))).manifest.episodes.length,2);
 }
});
test('partial companion, corrupt video, and absent head timestamps retain usable channels',async()=>{
 const entries=fixture();entries.delete('task/T1E1/observation.image.ego_right/video.mp4');
 entries.set('task/T1E1/umi/observation.image.right_wrist_view/video.mp4','not a movie');
 entries.delete('task/T1E1/observation.image.ego_left/timestamps_raw.csv');
 entries.set('task/T1E1/observation.image.ego_left/timestamps.csv','timestamp_ms\n7.648807\n23.635805');
 const source=await openRecording(files(entries)),ep=source.manifest.episodes[0],data=await source.data(ep.data);
 assert.equal(ep.media.length,7);assert.equal(data.timings.ego_left.estimated,true);
 assert.equal(data.timings.ego_left.episode[0],7.648807);assert.equal(data.timings.l_wrist.estimated,false);
 assert.ok(ep.issues.some(i=>i.code==='invalid_video'&&i.channel==='r_wrist'));assert.equal(data.trajectories.length,2);
 const headOnly=new Map([...fixture()].filter(([p])=>!p.includes('/umi/')));
 const solo=await openRecording(files(headOnly));assert.equal(solo.manifest.episodes.length,1);assert.equal(solo.manifest.episodes[0].media.length,2);
 assert.deepEqual((await solo.data(solo.manifest.episodes[0].data)).trajectories,[]);
});
test('nested camera directory convention works for both head and UMI timestamps',async()=>{
 const entries=new Map([...fixture()].map(([p,b])=>[p.replace('observation.image.','observation/image/'),b]));
 const source=await openRecording(files(entries)),data=await source.data(source.manifest.episodes[0].data);
 assert.equal(Object.keys(data.timings).length,8);assert.ok(Object.values(data.timings).every(t=>!t.estimated));
});
