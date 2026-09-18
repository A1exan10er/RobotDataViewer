import type { Episode, EpisodeData, Manifest } from './types';
import { openPackage, SamplePackage } from './package.ts';
import { readTar, recordingPath } from './archive.ts';
import { cameras, findChannel, loadRaw, readJson } from './raw.ts';
export interface RecordingSource {
  kind:'original'|'prepared'; manifest:Manifest;
  file(path:string):Blob|undefined;
  data(path:string,signal?:AbortSignal):Promise<EpisodeData>;
  dispose():void;
}
class OriginalSource implements RecordingSource {
  kind='original' as const;
  readonly manifest:Manifest;private files:Map<string,Blob>;
  constructor(manifest:Manifest,files:Map<string,Blob>){this.manifest=manifest;this.files=files;}
  file(path:string){return this.files.get(path);}
  data(path:string,signal?:AbortSignal){return loadRaw(this.files,this.manifest.episodes.find(e=>e.data===path)!,signal);}
  dispose(){this.files.clear();}
}
async function discover(files:Map<string,Blob>,signal?:AbortSignal):Promise<RecordingSource>{
  const episodes:Episode[]=[];
  for(const [path,blob] of files){
    if(path!=='metadata.json'&&!path.endsWith('/metadata.json'))continue;
    signal?.throwIfAborted();
    const root=path.slice(0,-'metadata.json'.length);
    const media=Object.entries(cameras).flatMap(([id,name])=>{
      const path=findChannel(files,root,'observation.image.'+name,'video.mp4');
      return path?[{id,kind:id.includes('tact')?'tactile' as const:'rgb' as const,path,original:path,width:0,height:0,fps:30,frames:0,duration:1}]:[];
    });
    if(!media.length&&!findChannel(files,root,'observation.state.eef_pose')&&!findChannel(files,root,'observation.state.gripper'))continue;
    let metadata:any={};try{metadata=await readJson(blob);}catch{/* Available channels can still be inspected. */}
    const name=root.split('/').filter(Boolean).at(-1)||'episode';
    episodes.push({id:root||name,title:String(metadata.task_title||metadata.task_name||name),robot:String(metadata.robot_type||metadata.robot||'robot'),durationMs:Number(metadata.duration_seconds)*1000||1,data:root,sourceName:root.replace(/\/$/,'')||name,media,issues:[]});
  }
  episodes.sort((a,b)=>a.sourceName.localeCompare(b.sourceName));
  if(!episodes.length)throw new Error('missingRecording');
  return new OriginalSource({format:'robot-data-viewer',version:1,episodes},files);
}
export async function openRecording(files:File[], archive=false,signal?:AbortSignal):Promise<RecordingSource>{
  if(archive)return discover(await readTar(files[0],signal),signal);
  const map=new Map(files.map(f=>[recordingPath(f.webkitRelativePath||f.name),f as Blob]));
  // Generated packages remain supported, but are no longer required.
  if(files.some(f=>f.name==='manifest.json')){
    try{
      const pkg:SamplePackage=await openPackage(files);
      return {kind:'prepared',manifest:pkg.manifest,file:p=>pkg.file(p),data:p=>pkg.data(p),dispose:()=>{}};
    }catch{/* This may be an original recording with an unrelated manifest. */}
  }
  return discover(map,signal);
}
