// Isolated Chrome/CDP test. No existing browser session or user profile is read.
// Usage: RDV_ARCHIVE=/path/to/five-episode-task.tar node tools/browser-alignment.mjs
// RDV_FOLDER and RDV_UMI_ARCHIVE optionally override the named original samples.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname,'..');
const output=join(root,'artifacts','alignment-browser');await mkdir(output,{recursive:true});
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
const paths=[
  [process.env.RDV_FOLDER || '/home/tianyu/Downloads/task-e7244f5d-part-01-of-01',false,5,7],
  [process.env.RDV_ARCHIVE || '/home/tianyu/Downloads/task-e7244f5d-part-01-of-01.tar',true,5,7],
  [process.env.RDV_UMI_ARCHIVE || '/home/tianyu/Downloads/episode_0012_20260807-131606_yanqiang_umi_none.tar',true,1,6]
];
const report={checks:[],errors,requests};
try{
 report.browser=(await cdp('Browser.getVersion',{},true)).product;
 const target=await cdp('Target.createTarget',{url:'about:blank'},true);session=(await cdp('Target.attachToTarget',{targetId:target.targetId,flatten:true},true)).sessionId;
 await cdp('Page.enable');await cdp('Runtime.enable');await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['http://*','https://*','ws://*','wss://*']});
 await viewport(1366,1000);await cdp('Page.navigate',{url:pathToFileURL(join(root,'dist/viewer.html')).href});await wait("!!document.querySelector('.open-main')");
 for(const [path,isTar,count,cards] of paths){
  const doc=await cdp('DOM.getDocument');const node=await cdp('DOM.querySelector',{nodeId:doc.root.nodeId,selector:isTar?'input[accept]':'input[webkitdirectory]'});
  await cdp('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[path]});
  await wait(`document.querySelectorAll('.episode-button').length===${count} && document.querySelectorAll('.media-card').length===${cards} && !document.querySelector('.loading-view') && !document.querySelector('.media-message')`,45000);
  for(let i=0;i<count;i++){
   if(i){await evaluate(`document.querySelectorAll('.episode-button')[${i}].click()`);await delay(100);}
   await wait(`document.querySelectorAll('.episode-button')[${i}]?.getAttribute('aria-current')==='true' && document.querySelectorAll('.media-card').length===${cards} && !document.querySelector('.media-message') && !document.querySelector('.loading-view')`,45000);
   const alignment=await evaluate("document.querySelector('.alignment-status').textContent");assert.equal(alignment,'Timestamp alignment');
   await click('button[aria-label="Details"]');await delay(50);
   const notices=await evaluate("[...document.querySelectorAll('.details-popover li')].map(li=>li.textContent)");
   assert.ok(notices.every(n=>!n.includes('Estimated alignment')));
   if(cards===7)assert.equal(notices.filter(n=>n.toLowerCase().includes('numeric tactile')).length,4);
   if(i===0)await screenshot(isTar?'tar-'+cards:'folder');
   await click('.details-popover button');
   if(i===0){
    const max=await evaluate("Number(document.querySelector('.timeline').max)");
    for(const ms of [50000,max-40,0]){
     await evaluate(`{const t=document.querySelector('.timeline');t.value=${ms};t.dispatchEvent(new Event('input',{bubbles:true}));}`);
     await delay(100);await wait("!document.querySelector('.playback-bar .spin') && !document.querySelector('.media-message')",45000);
    }
    await click('.play-button');await delay(2500);await click('.play-button');
    assert.ok(await evaluate("Number(document.querySelector('.timeline').value)>2100"));
   }
   report.checks.push({source:isTar?'tar':'folder',episode:i,alignment,notices});
  }
 }
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
 await writeFile(join(output,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{for(const {timeout} of pending.values())clearTimeout(timeout);chrome.kill('SIGTERM');await delay(300);await rm(profile,{recursive:true,force:true}).catch(()=>{});}
