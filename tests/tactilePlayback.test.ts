import test from 'node:test';
import assert from 'node:assert/strict';
import { TactilePlayback } from '../src/tactilePlayback.ts';

class Video extends EventTarget {
  currentTime=0; readyState=2; seeking=false;
  seek(time:number) { this.seeking=true;this.currentTime=time;this.dispatchEvent(new Event('seeking')); }
  finishSeek() { this.seeking=false;this.dispatchEvent(new Event('seeked')); }
}
class Frame { closed=0; readonly id:number; constructor(id:number){this.id=id;} close(){this.closed++;} }
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function setup() {
  const video=new Video(),painted:number[]=[],jobs:{time:number;gain:number;cleanup:boolean;resolve:(frame:Frame)=>void;reject:(error:Error)=>void}[]=[];
  let failures=0;
  const playback=new TactilePlayback(video,(gain,cleanup)=>new Promise<Frame>((resolve,reject)=>jobs.push({time:video.currentTime,gain,cleanup,resolve,reject})),frame=>painted.push(frame.id),()=>failures++);
  return {video,painted,jobs,playback,failures:()=>failures};
}

test('continuous playback displays completed tactile frames even beyond the old 100 ms cutoff',async()=>{
  const {video,painted,jobs,playback}=setup();playback.update(8,true);
  for(let i=1;i<=10;i++){video.currentTime=i*.02;playback.update(8,true);}
  assert.equal(jobs.length,1); // Incoming updates cannot create a backlog.
  const first=new Frame(1);jobs[0].resolve(first);await flush();
  assert.deepEqual(painted,[1]);assert.equal(first.closed,1);
  assert.equal(jobs.length,2);assert.equal(jobs[1].time,.2);
  video.currentTime=.45;playback.update(8,true);jobs[1].resolve(new Frame(2));await flush();
  assert.deepEqual(painted,[1,2]);assert.equal(jobs[2].time,.45);
  playback.dispose();jobs[2].resolve(new Frame(3));await flush();assert.deepEqual(painted,[1,2]);
});
test('seeking away and back rejects the old render even when its timestamp matches again',async()=>{
  const {video,painted,jobs,playback}=setup();playback.update(8,true);
  video.seek(10);video.finishSeek();video.seek(0);video.finishSeek();
  const old=new Frame(1);jobs[0].resolve(old);await flush();
  assert.deepEqual(painted,[]);assert.equal(old.closed,1);assert.equal(jobs.length,2);
  jobs[1].resolve(new Frame(2));await flush();assert.deepEqual(painted,[2]);playback.dispose();
});
test('a seek in progress blocks rendering until the destination frame is ready',async()=>{
  const {video,painted,jobs,playback}=setup();playback.update(8,true);video.seek(10);
  jobs[0].resolve(new Frame(1));await flush();assert.equal(jobs.length,1);assert.deepEqual(painted,[]);
  video.finishSeek();assert.equal(jobs.length,2);assert.equal(jobs[1].time,10);
  jobs[1].resolve(new Frame(2));await flush();assert.deepEqual(painted,[2]);playback.dispose();
});
test('settings changes invalidate in-flight images and render the latest requested settings',async()=>{
  const {painted,jobs,playback}=setup();playback.update(8,true);playback.update(16,false);playback.update(8,true);
  jobs[0].resolve(new Frame(1));await flush();assert.deepEqual(painted,[]);
  assert.equal(jobs[1].gain,8);assert.equal(jobs[1].cleanup,true);
  jobs[1].resolve(new Frame(2));await flush();assert.deepEqual(painted,[2]);
  playback.update(8,true);assert.equal(jobs.length,2);playback.dispose();
});
test('pausing schedules the stopped frame without repeatedly rendering the same image',async()=>{
  const {video,painted,jobs,playback}=setup();playback.update(8,true);
  video.currentTime=.25;video.dispatchEvent(new Event('pause'));
  jobs[0].resolve(new Frame(1));await flush();assert.equal(jobs[1].time,.25);
  jobs[1].resolve(new Frame(2));await flush();video.dispatchEvent(new Event('pause'));
  assert.equal(jobs.length,2);assert.deepEqual(painted,[1,2]);playback.dispose();
});
test('obsolete failures and disposed results cannot paint or report a false rendering failure',async()=>{
  const {video,painted,jobs,playback,failures}=setup();playback.update(8,true);video.seek(5);video.finishSeek();
  jobs[0].reject(new Error('obsolete capture'));await flush();assert.equal(failures(),0);
  playback.dispose();const late=new Frame(1);jobs[1].resolve(late);await flush();
  assert.deepEqual(painted,[]);assert.equal(late.closed,1);assert.equal(failures(),0);
  video.seek(10);video.finishSeek();assert.equal(jobs.length,2);
});
