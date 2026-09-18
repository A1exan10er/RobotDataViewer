// Isolated Chrome/CDP test. No existing browser session or user profile is read.
// Usage: RDV_FOLDER=/path/to/five-episode-ARX5-task node tools/browser-tactile-clean.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname,'..');
const output=join(root,'artifacts','tactile-browser');await mkdir(output,{recursive:true});
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
const folder=process.env.RDV_FOLDER || '/home/tianyu/Downloads/task-e7244f5d-part-01-of-01';
const report={checks:[],errors,requests};
const capping=process.env.RDV_TASK==='capping', contactTime=capping?18800:10000;
const seek=async ms=>{await evaluate(`{const s=document.querySelector('.timeline');s.value=${ms};s.dispatchEvent(new Event('input',{bubbles:true}));}`);await delay(100);await wait("!document.querySelector('.playback-bar .spin') && !document.querySelector('.media-message')",45000);await delay(100);};
try{
 report.browser=(await cdp('Browser.getVersion',{},true)).product;
 const target=await cdp('Target.createTarget',{url:'about:blank'},true);session=(await cdp('Target.attachToTarget',{targetId:target.targetId,flatten:true},true)).sessionId;
 await cdp('Page.enable');await cdp('Runtime.enable');await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['http://*','https://*','ws://*','wss://*']});
 await viewport(1366,1000);await cdp('Page.navigate',{url:pathToFileURL(join(root,'dist/viewer.html')).href+'?software=1'});await wait("!!document.querySelector('.open-main')");
 const doc=await cdp('DOM.getDocument');const node=await cdp('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'input[webkitdirectory]'});await cdp('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[folder]});
 await wait("document.querySelectorAll('.media-card').length>=6 && !document.querySelector('.media-message')",45000);
 assert.ok(await evaluate("[...document.querySelectorAll('.tactile-card input[type=checkbox]')].every(c=>!c.checked)"));
 await seek(0);
 await evaluate(`{${await readFile(join(root,'vendor/tactile-filter.js'),'utf8')};window.__Filter=TactileFilter;}`);
 await evaluate(`{
 window.__pixels=source=>{const c=document.createElement('canvas');c.width=source.videoWidth||source.width;c.height=source.videoHeight||source.height;c.getContext('2d').drawImage(source,0,0);return c.getContext('2d').getImageData(0,0,c.width,c.height).data;};
 window.__filters=[...document.querySelectorAll('.tactile-card')].map(c=>{const source=c.querySelector('.software-video');return new window.__Filter(source.width,source.height,window.__pixels(source));});
 window.__check=()=>[...document.querySelectorAll('.tactile-card')].map((c,k)=>{const source=c.querySelector('.software-video'),current=window.__pixels(source),actual=window.__pixels(c.querySelector('.difference-cell canvas')),expected=new Uint8ClampedArray(actual.length),gain=Number(c.querySelector('input[type=range]').value),cleanup=!c.querySelector('input[type=checkbox]').checked;window.__filters[k].render(current,expected,gain,cleanup);let changed=0,dark=0,errors=0;for(let i=0;i<actual.length;i+=4){if(Math.min(actual[i],actual[i+1],actual[i+2])<255)changed++;if(Math.min(actual[i],actual[i+1],actual[i+2])<175)dark++;for(let j=0;j<4;j++)if(actual[i+j]!==expected[i+j])errors++;}return {id:c.dataset.channel,changed,dark,errors};});
 }`);
 const check=async()=>{const values=await evaluate('window.__check()');assert.ok(values.every(v=>v.errors===0),JSON.stringify(values));return values;};
 await seek(2000);report.noTouch=await check();assert.ok(report.noTouch.every(v=>v.changed===0));
 await screenshot('no-touch');report.checks.push('All four sampled open-gripper channels are exactly white with cleanup enabled');
 await seek(contactTime);report.contact=await check();assert.ok(report.contact.filter(v=>capping?v.id==='l_tact_r':v.id.startsWith('l_')).every(v=>v.dark>100));
 if(capping)assert.ok(report.contact.filter(v=>v.id.startsWith('r_')).every(v=>v.changed===0));
 await screenshot('contact');
 const original=await evaluate("Array.from(window.__pixels(document.querySelector('.tactile-card .software-video')))");
 await click(capping?'[data-channel=l_tact_r] .icon-button':'.tactile-card .icon-button');assert.ok(await evaluate("getComputedStyle(document.querySelector('.expanded-panel .tactile-source')).display==='none'"));await screenshot('contact-expanded');await click('.expanded-close');await check();
 await evaluate("document.querySelector('.tactile-card .gain-popover').open=true");await screenshot('settings');
 await evaluate("[...document.querySelectorAll('.tactile-card input[type=checkbox]')].forEach(c=>c.click())");await delay(100);await check();
 assert.deepEqual(await evaluate("Array.from(window.__pixels(document.querySelector('.tactile-card .software-video')))"),original);
 await seek(2000);report.unfiltered=await check();assert.ok(report.unfiltered.every(v=>v.changed>100000));
 await screenshot('no-touch-unfiltered');report.checks.push('Show all changes reveals unfiltered image response without changing the source image');
 await click('.play-button');await evaluate("[...document.querySelectorAll('.tactile-card input[type=checkbox]')].forEach(c=>c.click())");await delay(1800);await click('.play-button');await delay(100);await check();
 await seek(contactTime);const first=await evaluate("Array.from(window.__pixels(document.querySelector('.difference-cell canvas')))");
 for(const gain of [1,16,8]){await evaluate(`{const g=document.querySelector('.tactile-card input[type=range]');g.value=${gain};g.dispatchEvent(new Event('input',{bubbles:true}));}`);await delay(100);await check();}
 await click('[aria-label="Next frame"]');await delay(200);await check();await click('[aria-label="Previous frame"]');await delay(200);await check();
 await seek(20000);await seek(contactTime);assert.deepEqual(await evaluate("Array.from(window.__pixels(document.querySelector('.difference-cell canvas')))"),first);
 await seek(2000);assert.ok((await check()).every(v=>v.changed===0));report.checks.push('Gain changes, toggling during playback, held-reference seek repeatability, and return to white after release pass');
 await click('.language-button');await screenshot('settings-zh');assert.ok(await evaluate("document.querySelector('.cleanup-setting').textContent.includes('显示全部变化')"));
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
 await writeFile(join(output,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{for(const {timeout} of pending.values())clearTimeout(timeout);chrome.kill('SIGTERM');await delay(300);await rm(profile,{recursive:true,force:true}).catch(()=>{});}
