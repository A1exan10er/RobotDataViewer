// Isolated Chrome/CDP test. No existing browser session or user profile is read.
// Usage: python3 tests/make_headcam_fixture.py && node tools/browser-headcam.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname,'..');
const output=join(root,'artifacts','headcam-browser');await mkdir(output,{recursive:true});
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
const report={checks:[],playback:[],errors,requests};
const fixture=join(root,'artifacts/headcam-fixture');
const status=()=>evaluate(`({title:document.querySelector('.recording-heading h1')?.textContent,episodes:document.querySelectorAll('.episode-button').length,alignment:document.querySelector('.alignment-status')?.textContent,time:Number(document.querySelector('.timeline')?.value),cards:[...document.querySelectorAll('.media-card')].map(c=>({id:c.dataset.channel,mode:c.dataset.mode,time:c.dataset.mode==='software'?Number(c.querySelector('.software-video')?.dataset.presentedTime):c.querySelector('video')?.currentTime,messages:[...c.querySelectorAll('.media-message')].map(e=>e.textContent)}))})`);
async function selectSource(path,tar=false){
 const doc=await cdp('DOM.getDocument'),node=await cdp('DOM.querySelector',{nodeId:doc.root.nodeId,selector:tar?'input[accept]':'input[webkitdirectory]'});
 await cdp('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[path]});
 await wait("document.querySelectorAll('.media-card').length===8 && !document.querySelector('.loading-view')",45000);
 await seek(100);
}
async function seek(ms){
 await evaluate(`{const t=document.querySelector('.timeline');t.value=${ms};t.dispatchEvent(new Event('input',{bubbles:true}));}`);
 await wait("!document.querySelector('.playback-bar .spin') && !document.querySelector('.media-message')",30000);await delay(350);
}
async function play(label){
 await seek(1000);
 await evaluate(`window.__samples=[];window.__tick=setInterval(()=>window.__samples.push({at:performance.now(),t:Number(document.querySelector('.timeline').value),busy:document.querySelector('.playback-status').textContent.includes('Synchronizing')}),40);document.querySelector('.play-button').click()`);
 await delay(5500);await click('.play-button');
 const samples=await evaluate('clearInterval(window.__tick);window.__samples');
 const steady=samples.filter(s=>s.at>samples[0].at+1000),elapsed=samples.at(-1).at-samples[0].at,advanced=samples.at(-1).t-samples[0].t;
 report.playback.push({label,elapsed,advanced,busy:steady.filter(s=>s.busy).length,status:await status()});
 if(label!=='software'){assert.ok(advanced/elapsed>.95,label+' lost playback time');assert.equal(steady.filter(s=>s.busy).length,0,label+' buffers after startup');}
 else assert.ok(advanced>500,'Software fallback must decode and advance; full-HD 60 fps may exceed CPU capacity');
 const paused=(await status()).time;await delay(250);assert.equal((await status()).time,paused);
}
try{
 report.browser=(await cdp('Browser.getVersion',{},true)).product;
 const target=await cdp('Target.createTarget',{url:'about:blank'},true);session=(await cdp('Target.attachToTarget',{targetId:target.targetId,flatten:true},true)).sessionId;
 await cdp('Page.enable');await cdp('Runtime.enable');await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['http://*','https://*','ws://*','wss://*']});await viewport(1600,1100);
 for(const mode of ['folder','tar','software']){
  await cdp('Page.navigate',{url:pathToFileURL(join(root,'dist/viewer.html')).href+(mode==='software'?'?software=1':'')});await wait("!!document.querySelector('.open-main')");
  await selectSource(join(fixture,mode==='folder'?'T1E1':'headcam.tar'),mode!=='folder');
  const state=await status();assert.equal(state.episodes,1);assert.equal(state.alignment,'Timestamp alignment');
  assert.deepEqual(state.cards.map(c=>c.id),['ego_left','ego_right','l_wrist','r_wrist','l_tact_l','l_tact_r','r_tact_l','r_tact_r']);
  assert.ok(await evaluate("document.body.innerText.includes('Head camera · Left eye') && document.body.innerText.includes('Head camera · Right eye')"));
  if(mode==='software')assert.ok(state.cards.every(c=>c.mode==='software'));
  await play(mode);
  await seek(5000);const first=await status();await seek(1500);await seek(5000);const repeat=await status();
  for(let i=0;i<8;i++)assert.ok(Math.abs(first.cards[i].time-repeat.cards[i].time)<.001,'Repeated seek is stable');
  await click('[aria-label="Next frame"]');await delay(400);assert.ok((await status()).time>5000);
  await click('[aria-label="Previous frame"]');await delay(400);assert.ok((await status()).time<5030);
  await click('[data-channel=ego_left] .icon-button');await delay(200);assert.ok(await evaluate("!!document.querySelector('.expanded-panel [data-channel=ego_left], .expanded-panel[data-channel=ego_left]')"));await screenshot(mode+'-expanded');await click('.expanded-close');
  await click('.language-button');assert.ok(await evaluate("document.body.innerText.includes('头戴相机 · 左眼') && document.body.innerText.includes('头戴相机 · 右眼')"));
  await screenshot(mode+'-zh');await click('.language-button');
  assert.ok(await evaluate("document.documentElement.scrollWidth<=innerWidth"));
  report.checks.push(mode+': eight channels; exact timestamps; '+(mode==='software'?'software decoding advances (throughput recorded)':'uninterrupted playback')+'; pause, seek, step, expansion and Chinese labels');
 }
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);await writeFile(join(output,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){console.log(JSON.stringify(await status()));await screenshot('failure').catch(()=>{});throw error;}
finally{for(const {timeout} of pending.values())clearTimeout(timeout);chrome.kill('SIGTERM');await delay(300);await rm(profile,{recursive:true,force:true}).catch(()=>{});}
