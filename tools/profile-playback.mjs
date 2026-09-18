// Isolated Chrome/CDP test. No existing browser session or user profile is read.
// Usage: node tools/profile-playback.mjs [run-name] [CPU-throttle-rate]; RDV_ARCHIVE overrides the local sample.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname,'..');
const output=join(root,'artifacts','playback-profile');await mkdir(output,{recursive:true});
const profile=await mkdtemp(join(tmpdir(),'robot-viewer-chrome-'));
const chrome=spawn(process.env.ROBOT_VIEWER_CHROME || '/opt/google/chrome/chrome',[
  '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
  '--disable-background-networking','--disable-component-update','--no-first-run',
  '--disable-default-apps','--disable-sync','--metrics-recording-only',
  '--remote-debugging-pipe',`--user-data-dir=${profile}`,'about:blank',
],{stdio:['ignore','ignore','pipe','pipe','pipe']});
let counter=0,buffer='',stderr='',session;
const pending=new Map(),errors=[],requests=[];
chrome.stderr.on('data',b=>stderr+=b.toString());
chrome.stdio[4].on('data',chunk=>{
  buffer+=chunk.toString();let end;
  while((end=buffer.indexOf('\0'))>=0){const raw=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!raw)continue;const message=JSON.parse(raw);
    if(message.id){const promise=pending.get(message.id);if(promise){clearTimeout(promise.timeout);pending.delete(message.id);message.error?promise.reject(new Error(JSON.stringify(message.error))):promise.resolve(message.result);}}
    else if(message.method==='Runtime.consoleAPICalled'&&message.params.type==='warning') console.log('PAGE WARNING',JSON.stringify(message.params.args));
    else if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails);
    else if(message.method==='Network.requestWillBeSent' && /^https?:/.test(message.params.request.url))requests.push(message.params.request.url);
  }
});
const cdp=(method,params={},browser=false)=>new Promise((resolve,reject)=>{
  const id=++counter;const timeout=setTimeout(()=>{pending.delete(id);reject(new Error(`Timed out: ${method}; ${stderr.slice(-1000)}`));},20000);
  pending.set(id,{resolve,reject,timeout});chrome.stdio[3].write(JSON.stringify({id,method,params,...(!browser&&session?{sessionId:session}:{})})+'\0');
});
const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async(expression,timeout=18000)=>{const start=Date.now();while(Date.now()-start<timeout){if(await evaluate(expression))return;await delay(100);}throw new Error('Condition timed out: '+expression);};
const screenshot=async name=>{const result=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(output,name+'.png'),Buffer.from(result.data,'base64'));};
const viewport=async(width,height)=>{await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await delay(100);};
const click=async selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const archive=process.env.RDV_ARCHIVE || '/home/tianyu/Downloads/task-e7244f5d-part-01-of-01.tar';
const runName=process.argv[2]||'baseline',throttle=Number(process.argv[3]||1),seconds=Number(process.env.RDV_SECONDS||12);
const folder=(await stat(archive)).isDirectory();
try{
 const target=await cdp('Target.createTarget',{url:'about:blank'},true);session=(await cdp('Target.attachToTarget',{targetId:target.targetId,flatten:true},true)).sessionId;
 await cdp('Page.enable');await cdp('Runtime.enable');await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['http://*','https://*','ws://*','wss://*']});
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`{
 window.__cost={};window.__batches=[];window.__long=[];window.__liveWorkers=new Set();
 for(const name of ['putImageData','getImageData','drawImage']){const orig=CanvasRenderingContext2D.prototype[name];CanvasRenderingContext2D.prototype[name]=function(...args){const start=performance.now();const result=orig.apply(this,args);const key=name+':'+this.canvas.className;const cost=window.__cost[key]||{calls:0,ms:0,max:0};const dt=performance.now()-start;cost.calls++;cost.ms+=dt;cost.max=Math.max(cost.max,dt);window.__cost[key]=cost;return result;};}
 new PerformanceObserver(list=>window.__long.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({entryTypes:['longtask']});
 const Base=Worker;window.Worker=class extends Base{constructor(...args){super(...args);window.__liveWorkers.add(this);this.sent=new Map();this.addEventListener('message',e=>{const sent=this.sent.get(e.data.id);if(sent&&sent.method==='batch'){window.__batches.push({at:performance.now(),ms:performance.now()-sent.at,frames:e.data.result?.frames?.length||0});}this.sent.delete(e.data.id);});}postMessage(data,...args){this.sent.set(data.id,{at:performance.now(),method:data.method});return super.postMessage(data,...args);}terminate(){window.__liveWorkers.delete(this);return super.terminate();}};
 }`});
 await viewport(1366,900);await cdp('Page.navigate',{url:pathToFileURL(join(root,'dist/viewer.html')).href});await wait("!!document.querySelector('.open-main')");
 const doc=await cdp('DOM.getDocument');const node=await cdp('DOM.querySelector',{nodeId:doc.root.nodeId,selector:folder?'input[webkitdirectory]':'input[accept]'});await cdp('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[archive]});
 await wait("document.querySelectorAll('.media-card').length===7 && !document.querySelector('.media-message')",45000);
 await cdp('Emulation.setCPUThrottlingRate',{rate:throttle});
 await evaluate(`{
 window.__cost={};window.__batches=[];window.__long=[];window.__frames=[];window.__running=true;
 const tick=now=>{const timeline=Number(document.querySelector('.timeline').value);const views=[...document.querySelectorAll('.media-card')].map(c=>({id:c.dataset.channel,t:Number(c.querySelector('.software-video')?.dataset.presentedTime||c.querySelector('video')?.currentTime||0)}));window.__frames.push({at:performance.now(),timeline,busy:document.querySelector('.playback-status').textContent.includes('Synchronizing'),views});if(window.__running)requestAnimationFrame(tick);};requestAnimationFrame(tick);
 }`);
 await cdp('Profiler.enable');await cdp('Profiler.start');await click('.play-button');await delay(seconds*1000);await click('.play-button');
 const {profile:cpu}=await cdp('Profiler.stop');await evaluate('window.__running=false');
 const raw=await evaluate('({frames:window.__frames,cost:window.__cost,batches:window.__batches,long:window.__long,workers:window.__liveWorkers.size})');
 const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))]:0;
 const channels={};for(const sample of raw.frames){for(const v of sample.views){const c=channels[v.id]??={times:[],gaps:[],steps:[],last:null};if(c.last===null||Math.abs(v.t-c.last.t)>.001){if(c.last){c.gaps.push(sample.at-c.last.at);c.steps.push(v.t-c.last.t);}c.times.push(v.t);c.last={t:v.t,at:sample.at};}}}
 const report={name:runName,archive,throttle,episodes:await evaluate("document.querySelectorAll('.episode-button').length"),wallMs:raw.frames.at(-1).at-raw.frames[0].at,advancedMs:raw.frames.at(-1).timeline-raw.frames[0].timeline,busyFrames:raw.frames.filter(f=>f.busy).length,totalRafs:raw.frames.length,longTasks:raw.long,canvas:raw.cost,batch:{count:raw.batches.length,p50:percentile(raw.batches.map(b=>b.ms),.5),p95:percentile(raw.batches.map(b=>b.ms),.95),max:Math.max(...raw.batches.map(b=>b.ms))},channels:Object.fromEntries(Object.entries(channels).map(([id,c])=>[id,{displayed:c.times.length,p50Gap:percentile(c.gaps,.5),p95Gap:percentile(c.gaps,.95),maxGap:Math.max(...c.gaps),gapsOver80ms:c.gaps.filter(g=>g>80).length,skipped:c.steps.reduce((s,d)=>s+Math.max(0,Math.round(d*30)-1),0)}])),hotspots:cpu.nodes.filter(n=>n.hitCount).sort((a,b)=>b.hitCount-a.hitCount).slice(0,20).map(n=>({name:n.callFrame.functionName,url:n.callFrame.url.slice(-60),line:n.callFrame.lineNumber,hits:n.hitCount})),errors,requests};
 await writeFile(join(output,runName+'.json'),JSON.stringify(report,null,2));await writeFile(join(output,runName+'-raw.json'),JSON.stringify(raw));await writeFile(join(output,runName+'.cpuprofile'),JSON.stringify(cpu));await screenshot(runName);console.log(JSON.stringify({...report,longTasks:{count:report.longTasks.length,max:Math.max(0,...report.longTasks.map(x=>x.duration))},hotspots:report.hotspots.slice(0,8)},null,2));
}finally{for(const {timeout} of pending.values())clearTimeout(timeout);chrome.kill('SIGTERM');await delay(300);await rm(profile,{recursive:true,force:true}).catch(()=>{});}
