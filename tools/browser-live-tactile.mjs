// Isolated Chrome/CDP test. No existing browser session or user profile is read.
// Live tactile regression: RDV_ARCHIVE overrides the ARX5 task folder/TAR. Images are sampled while playback continues.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname,'..');
const output=join(root,'artifacts','live-tactile');await mkdir(output,{recursive:true});
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
const source=process.env.RDV_ARCHIVE || '/home/tianyu/Downloads/task-e7244f5d-part-01-of-01';
const seconds=Number(process.env.RDV_SECONDS||24);
try{
 const browser=(await cdp('Browser.getVersion',{},true)).product;
 const target=await cdp('Target.createTarget',{url:'about:blank'},true);session=(await cdp('Target.attachToTarget',{targetId:target.targetId,flatten:true},true)).sessionId;
 await cdp('Page.enable');await cdp('Runtime.enable');await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['http://*','https://*','ws://*','wss://*']});
 await viewport(1920,1080);await cdp('Page.navigate',{url:pathToFileURL(join(root,'dist/viewer.html')).href});await wait("!!document.querySelector('.open-main')");
 const doc=await cdp('DOM.getDocument');const node=await cdp('DOM.querySelector',{nodeId:doc.root.nodeId,selector:(await stat(source)).isDirectory()?'input[webkitdirectory]':'input[accept]'});await cdp('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[source]});
 await wait("document.querySelectorAll('.media-card').length===7 && !document.querySelector('.media-message')",45000);
 await evaluate(`{
 window.__live=[];window.__paints={};const draw=CanvasRenderingContext2D.prototype.drawImage;
 CanvasRenderingContext2D.prototype.drawImage=function(...args){const result=draw.apply(this,args);if(this.canvas.closest?.('.difference-cell')){const id=this.canvas.closest('.media-card').dataset.channel;window.__paints[id]=(window.__paints[id]||0)+1;}return result;};
 window.__timer=setInterval(()=>{const channels=[...document.querySelectorAll('.tactile-card')].map(c=>{const canvas=c.querySelector('.difference-cell canvas'),pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let changed=0;for(let i=0;i<pixels.length;i+=32)if(Math.min(pixels[i],pixels[i+1],pixels[i+2])<225)changed++;return {id:c.dataset.channel,mode:c.dataset.mode,changed,paints:window.__paints[c.dataset.channel]||0};});window.__live.push({at:performance.now(),timeline:Number(document.querySelector('.timeline').value),busy:document.querySelector('.playback-status').textContent.includes('Synchronizing'),channels});},200);
 document.querySelector('.play-button').click();
 }`);
 for(let i=0;i<seconds;i++){await delay(1000);if((i+1)%5===0)console.log(JSON.stringify(await evaluate('window.__live.at(-1)')));}
 const samples=await evaluate('clearInterval(window.__timer);window.__live');
 const contacts=samples.filter(s=>s.timeline>=9500&&s.timeline<=11000||s.timeline>=19500&&s.timeline<=21000);
 const report={browser,source,errors,requests,wallMs:samples.at(-1).at-samples[0].at,advancedMs:samples.at(-1).timeline-samples[0].timeline,busySamples:samples.filter(s=>s.busy).length,last:samples.at(-1),contact:Object.fromEntries(['l_tact_l','l_tact_r'].map(id=>[id,{samples:contacts.length,visible:contacts.filter(s=>s.channels.find(c=>c.id===id).changed>50).length}]))};
 await writeFile(join(output,'chrome.json'),JSON.stringify(report,null,2));await writeFile(join(output,'chrome-raw.json'),JSON.stringify(samples));await screenshot('chrome-live');
 assert.ok(contacts.length>0);assert.ok(Object.values(report.contact).every(c=>c.visible>=c.samples*.7),JSON.stringify(report.contact));
 assert.ok(!samples.some(s=>s.busy&&s.at>samples[0].at+1000));assert.ok(report.advancedMs>=report.wallMs*.98);
 assert.ok(samples.at(-1).channels.every(c=>c.paints>20));assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
 console.log(JSON.stringify(report,null,2));
}finally{for(const {timeout} of pending.values())clearTimeout(timeout);chrome.kill('SIGTERM');await delay(300);await rm(profile,{recursive:true,force:true}).catch(()=>{});}
