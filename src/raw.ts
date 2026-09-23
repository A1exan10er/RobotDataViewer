import { finite, parseCsv, type Csv } from './csv.ts';
import { probeMovie } from './mp4.ts';
import type { Episode, EpisodeData, Issue, Timing, Trajectory, Vec3 } from './types';

export const cameras: Record<string,string> = {ego_left:'ego_left',ego_right:'ego_right',third:'third_view',second_third:'second_third_view',l_wrist:'left_wrist_view',r_wrist:'right_wrist_view',l_tact_l:'left_wrist_left_tactile',l_tact_r:'left_wrist_right_tactile',r_tact_l:'right_wrist_left_tactile',r_tact_r:'right_wrist_right_tactile'};
type Matrix = number[][];
function axes6(v: number[]): Vec3[] | null {
  const norm = (v:number[]) => {const d=Math.hypot(...v);return d>1e-8?v.map(x=>x/d) as Vec3:null;};
  const a=norm(v.slice(0,3));if(!a)return null;
  const dot=a.reduce((s,x,i)=>s+x*v[i+3],0),b=norm(v.slice(3).map((x,i)=>x-dot*a[i]));if(!b)return null;
  return [a,b,[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]];
}
function matrix(p: Record<string,unknown>): Matrix {
  const q='wxyz'.split('').map(k=>finite(p['tcp.q'+k])), pos='xyz'.split('').map(k=>finite(p['tcp.'+k]));
  if(q.includes(null)||pos.includes(null))throw new Error('pose');
  const d=Math.hypot(...q as number[]);if(d<1e-8)throw new Error('pose');
  const [w,x,y,z]=(q as number[]).map(n=>n/d);
  return [[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w),pos[0]!],[2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w),pos[1]!],[2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y),pos[2]!],[0,0,0,1]];
}
export function transforms(metadata: any): Record<string,Matrix> {
  try {
    const reference=metadata.coordinate_reference;if(reference?.type!=='umi_episode_start_relative_pose')return {};
    const left=matrix(reference.sides.left.reference_pose || reference.sides.left.pose),right=matrix(reference.sides.right.reference_pose || reference.sides.right.pose);
    const inv=[...Array(3)].map((_,i)=>[left[0][i],left[1][i],left[2][i],-left.slice(0,3).reduce((s,r)=>s+r[i]*r[3],0)]);inv.push([0,0,0,1]);
    const mul=(b:Matrix)=>inv.map(r=>b[0].map((_,j)=>r.reduce((s,x,k)=>s+x*b[k][j],0)));
    return {left:mul(left),right:mul(right)};
  }catch{return {};}
}
export function parseTrajectories(csv:Csv, metadata:unknown, issues:Issue[]): Trajectory[] {
  const refs=transforms(metadata),out:Trajectory[]=[];
  for(const side of ['left','right','single'] as const){
    const prefix=side==='single'?'':side+'_';if(!'xyz'.split('').every(k=>csv.columns.includes(prefix+k)))continue;
    const points:Trajectory['points']=[];let invalid=0;
    for(const row of csv.rows){
      const t=finite(row.timestamp_ms),p='xyz'.split('').map(k=>finite(row[prefix+k]));
      if(t===null||t<0||p.includes(null)){invalid++;continue;}
      const rotation=Array.from({length:6},(_,i)=>finite(row[prefix+'r'+(i+1)]));
      let axes=rotation.includes(null)?null:axes6(rotation as number[]),position=p as Vec3;
      if(refs[side]){const m=refs[side];position=m.slice(0,3).map(r=>r.slice(0,3).reduce((s,x,j)=>s+x*position[j],r[3])) as Vec3;
        if(axes)axes=axes.map(a=>m.slice(0,3).map(r=>r.slice(0,3).reduce((s,x,j)=>s+x*a[j],0)) as Vec3);}
      points.push({t,p:position,axes,g:finite(row[prefix+'gripper'])});
    }
    if(invalid)issues.push({code:'invalid_samples',channel:side,count:invalid});
    if(points.length)out.push({side,frame:refs[side]?'shared':'recorded',points:points.sort((a,b)=>a.t-b.t)});
  }
  if(!out.length)issues.push({code:'missing_trajectory'});return out;
}
export function makeTiming(pts:number[], rows:Csv['rows'], rawRows:Csv['rows']=[], preference:'raw'|'processed'='raw'): Timing {
  // Raw capture times describe all video frames. Training observations may omit
  // the final row when paired with the following action (e.g. hand-guided ARX5).
  const raw=rawRows.map(r=>finite(r.timestamp_ms)),processed=rows.map(r=>finite(r.timestamp_ms));
  const captured=(preference==='processed'?[processed,raw]:[raw,processed]).find(times=>times.length===pts.length &&
    times.every((t,i)=>t!==null&&t>=0&&(i===0||t>=times[i-1]!)) &&
    (times.length===1||times.at(-1)!>times[0]!));
  const offset=processed.find(t=>t!==null&&t>=0)??raw.find(t=>t!==null&&t>=0)??0;
  return {media:pts,episode:captured?captured as number[]:pts.map(t=>offset+t*1000),estimated:!captured};
}
export function findChannel(files:Map<string,Blob>, root:string, modality:string, name='data.csv'): string | undefined {
  return [modality,modality.replaceAll('.','/')].map(m=>root+m+'/'+name).find(p=>files.has(p));
}
export async function readJson(blob:Blob): Promise<any> {
  if(blob.size>8*1024*1024)throw new Error('invalidRecording');
  const data=JSON.parse((await blob.text()).replace(/^\uFEFF/,''));
  if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('invalidRecording');return data;
}
export async function loadRaw(files:Map<string,Blob>, ep:Episode, signal?:AbortSignal): Promise<EpisodeData> {
  const root=ep.stateRoot??ep.data;let metadata:any={};try{metadata=await readJson(files.get(root+'metadata.json')!);}catch{}signal?.throwIfAborted();
  ep.issues=[];const issues=ep.issues;
  const readCsv=async(path:string|undefined,channel:string):Promise<Csv>=>{
    if(!path||!files.has(path))return {columns:[],rows:[]};
    const blob=files.get(path)!;signal?.throwIfAborted();
    try{if(blob.size>128*1024*1024)throw new Error('large CSV');return parseCsv(await blob.text());}
    catch{issues.push({code:'invalid_samples',channel});return {columns:[],rows:[]};}
  };
  const csv=(modality:string,name='data.csv')=>readCsv(findChannel(files,root,modality,name),modality);
  const state=await csv('observation.state.eef_pose');
  const data:EpisodeData={trajectories:parseTrajectories(state,metadata,issues),signals:[],timings:{}};
  for(const name of ['eef_pose','gripper','joint_position','joint_velocity',...Object.values(cameras).filter(n=>n.includes('tactile'))]){
    const {columns,rows}=name==='eef_pose'?state:await csv('observation.state.'+name);
    if(columns.length&&!rows.length)issues.push({code:'empty_signal',channel:name});
    for(const column of columns){
      if(column==='timestamp_ms'||(name==='eef_pose'&&!/(^|_)[xyz]$/.test(column)))continue;
      const samples=rows.map(r=>[finite(r.timestamp_ms),finite(r[column])]).filter((p):p is number[]=>p[0]!==null&&p[0]>=0&&p[1]!==null).sort((a,b)=>a[0]-b[0]);
      if(!samples.length)continue;
      data.signals.push({id:name+'.'+column,name:column,unit:name.includes('tactile')?null:name==='eef_pose'||name==='gripper'||column.includes('gripper')?'m':name==='joint_velocity'?'rad/s':'rad',t:samples.map(p=>p[0]),values:samples.map(p=>p[1])});
    }
  }
  let end=Math.max(0,...data.trajectories.map(t=>t.points.at(-1)!.t),...data.signals.map(s=>s.t.at(-1)!));
  await Promise.all(ep.media.map(async media=>{
    signal?.throwIfAborted();
    try {
      const info=await probeMovie(files.get(media.path)!,signal);
      Object.assign(media,{width:info.width,height:info.height,duration:info.duration,fps:info.fps,frames:info.pts.length,codec:info.codec});
      // Timing belongs to this MP4, including cameras outside the UMI folder.
      const directory=media.path.slice(0,media.path.lastIndexOf('/')+1);
      const [processed,raw]=await Promise.all(['timestamps.csv','timestamps_raw.csv'].map(name=>readCsv(directory+name,media.id)));
      // Head exports already express capture times on the shared episode clock.
      // Source sequence/raw indexes are provenance, not indexes into this MP4.
      const timing=makeTiming(info.pts,processed.rows,raw.rows,media.id.startsWith('ego_')?'processed':'raw');
      data.timings[media.id]=timing;if(timing.estimated)issues.push({code:'estimated_alignment',channel:media.id});
      end=Math.max(end,timing.episode.at(-1)!+(info.duration-info.pts.at(-1)!)*1000);
    } catch(e) {
      signal?.throwIfAborted();
      media.failed=true;issues.push({code:'invalid_video',channel:media.id});
      data.timings[media.id]={media:[0],episode:[0],estimated:true};
    }
  }));
  signal?.throwIfAborted();ep.durationMs=end||ep.durationMs;return data;
}
