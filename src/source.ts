import type { Episode, EpisodeData, Manifest } from './types';
import { openPackage, SamplePackage } from './package.ts';
import { readTar, recordingPath } from './archive.ts';
import { captureContext } from './tactileRecovery.ts';
import { cameras, findChannel, loadRaw, readJson } from './raw.ts';
import { safeRelativePath } from './math.ts';
export interface RecordingSource {
  kind:'original'|'prepared'; manifest:Manifest;
  file(path:string):Blob|undefined;
  data(path:string,signal?:AbortSignal):Promise<EpisodeData>;
  dispose():void;
  forceFiles?():Blob[];
}
class OriginalSource implements RecordingSource {
  kind='original' as const;
  readonly manifest:Manifest;private files:Map<string,Blob>;
  constructor(manifest:Manifest,files:Map<string,Blob>){this.manifest=manifest;this.files=files;}
  file(path:string){return this.files.get(path);}
  forceFiles(){return [...this.files].filter(([path])=>path.endsWith('.rdv-force.json')).map(([,blob])=>blob);}
  data(path:string,signal?:AbortSignal){return loadRaw(this.files,this.manifest.episodes.find(e=>e.data===path)!,signal);}
  dispose(){this.files.clear();}
}
async function discover(files:Map<string,Blob>,signal?:AbortSignal):Promise<RecordingSource>{
  const episodes:Episode[]=[];
  const metadataByRoot=new Map<string,any>(),companions=new Map<string,string>();
  for(const [path,blob] of files){
    if(path!=='metadata.json'&&!path.endsWith('/metadata.json'))continue;
    signal?.throwIfAborted();
    const root=path.slice(0,-'metadata.json'.length);
    let metadata:any={};try{metadata=await readJson(blob);}catch{/* Available channels can still be inspected. */}
    metadataByRoot.set(root,metadata);
    // Only an explicit export relationship joins episodes. Paths must remain
    // inside the selected export; source_capture/alignment provenance is not a link.
    if(metadata.format==='ego-headcam-companion-1'&&safeRelativePath(metadata.umi_episode)){
      companions.set(root,root+metadata.umi_episode+'/');
    }
  }
  const includedRoots=new Set(companions.values());
  for(const [root,metadata] of metadataByRoot){
    signal?.throwIfAborted();
    if(includedRoots.has(root))continue;
    const stateRoot=companions.get(root)??root;
    const media=Object.entries(cameras).flatMap(([id,name])=>{
      const cameraRoot=id.startsWith('ego_')?root:stateRoot;
      const path=findChannel(files,cameraRoot,'observation.image.'+name,'video.mp4');
      return path?[{id,kind:id.includes('tact')?'tactile' as const:'rgb' as const,path,original:path,width:0,height:0,fps:30,frames:0,duration:1}]:[];
    });
    if(!media.length&&!findChannel(files,stateRoot,'observation.state.eef_pose')&&!findChannel(files,stateRoot,'observation.state.gripper'))continue;
    const stateMetadata=metadataByRoot.get(stateRoot)??{};
    const name=root.split('/').filter(Boolean).at(-1)||'episode';
    episodes.push({capture:captureContext(stateMetadata),id:root||name,title:String(metadata.task_title||metadata.task_name||stateMetadata.task_title||stateMetadata.task_name||name),robot:String(metadata.robot_type||metadata.robot||stateMetadata.robot_type||stateMetadata.robot||'robot'),durationMs:Number(metadata.duration_seconds)*1000||1,data:root,...(stateRoot!==root?{stateRoot}:{}),sourceName:root.replace(/\/$/,'')||name,media,issues:[]});
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
      for(const ep of pkg.manifest.episodes){
        ep.capture=undefined;
        const tactile=ep.media.find(m=>m.kind==='tactile'),path=tactile?.original;
        const marker=path?.indexOf('observation.image');
        const metadata=path&&marker!==undefined&&marker>=0?pkg.file(path.slice(0,marker)+'metadata.json'):undefined;
        if(metadata){try{ep.capture=captureContext(await readJson(metadata));}catch{}}
      }
      return {kind:'prepared',manifest:pkg.manifest,file:p=>pkg.file(p),data:p=>pkg.data(p),forceFiles:()=>files.filter(f=>f.name.endsWith('.rdv-force.json')),dispose:()=>{}};
    }catch{/* This may be an original recording with an unrelated manifest. */}
  }
  return discover(map,signal);
}
