// Isolated Chrome/CDP test. No existing browser session or user profile is read.
// Usage: node tools/browser-check.mjs [--package /path/to/RobotDataViewer]
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname,'..');
const packageIndex=process.argv.indexOf('--package');
const sampleDir=packageIndex>=0?resolve(process.argv[packageIndex+1]):null;
const fixtureIndex=process.argv.indexOf('--fixtures');
const fixtures=fixtureIndex>=0?resolve(process.argv[fixtureIndex+1]):null;
const output=join(root,'artifacts','direct-browser');await mkdir(output,{recursive:true});
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
const setFolder=async folder=>{
  const oldSource=await evaluate("document.querySelector('.media-card video')?.src || ''");
  const expected=JSON.parse(await readFile(join(folder,'manifest.json'),'utf8')).episodes[0].title;
  const doc=await cdp('DOM.getDocument');const node=await cdp('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'input[type=file]'});
  await cdp('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[folder]});
  await wait(`!!document.querySelector('.error-banner') || (document.querySelector('.recording-heading h1')?.textContent === ${JSON.stringify(expected)} && !document.querySelector('.loading-view') && (document.querySelector('.media-card video')?.src || '') !== ${JSON.stringify(oldSource)})`);
};
const report={checks:[],errors,requests};
const archive='/home/tianyu/Downloads/episode_0012_20260807-131606_yanqiang_umi_none.tar';
const status=()=>evaluate(`({title:document.querySelector('h1')?.textContent,loading:!!document.querySelector('.loading-view'),error:document.querySelector('.error-banner')?.textContent,cards:[...document.querySelectorAll('.media-card')].map(c=>({id:c.dataset.channel,mode:c.dataset.mode,time:c.querySelector('.software-video')?.dataset.presentedTime,native:c.querySelector('video')?.readyState,messages:[...c.querySelectorAll('.media-message')].map(x=>x.textContent)}))})`);
async function selectSource(path,tar=false){
 const doc=await cdp('DOM.getDocument');const node=await cdp('DOM.querySelector',{nodeId:doc.root.nodeId,selector:tar?'input[accept]':'input[webkitdirectory]'});
 await cdp('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[path]});
 await wait("!!document.querySelector('.recording-heading h1') && !document.querySelector('.loading-view') || !!document.querySelector('.error-banner')",45000);
}
try{
 report.browser=(await cdp('Browser.getVersion',{},true)).product;
 const target=await cdp('Target.createTarget',{url:'about:blank'},true);session=(await cdp('Target.attachToTarget',{targetId:target.targetId,flatten:true},true)).sessionId;
 await cdp('Page.enable');await cdp('Runtime.enable');await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['http://*','https://*','ws://*','wss://*']});
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:"{const Base=Worker;window.__liveWorkers=new Set();window.Worker=class extends Base{constructor(...args){super(...args);window.__liveWorkers.add(this);}terminate(){window.__liveWorkers.delete(this);return super.terminate();}};}"});
 await viewport(1366,900);await cdp('Page.navigate',{url:pathToFileURL(join(root,'dist/viewer.html')).href});await wait("!!document.querySelector('.open-main')");await screenshot('welcome');
 await selectSource(archive,true);
 console.log(JSON.stringify(await status()));
 await wait("document.querySelectorAll('.media-card').length===6 && [...document.querySelectorAll('.software-video')].every(c=>c.dataset.presentedTime!==undefined) && !document.querySelector('.media-message')",45000);
 console.log(JSON.stringify(await status()));await screenshot('original-tar');report.checks.push('Original TAR opens with six software-decoded HEVC videos and tactile references');
 await click('.play-button');await delay(3500);await click('.play-button');
 report.playbackMs=await evaluate("Number(document.querySelector('.timeline').value)");assert.ok(report.playbackMs>1000);await screenshot('playing');
 await evaluate("{const s=document.querySelector('.timeline');s.value=51700;s.dispatchEvent(new Event('input',{bubbles:true}));}");
 await wait("[...document.querySelectorAll('.software-video')].every(c=>Number(c.dataset.presentedTime)>50)",30000);
 report.seek=await status();console.log(JSON.stringify(report.seek));await screenshot('seek');report.checks.push('Original HEVC playback and synchronized seek');

 const hash=()=>evaluate("[...document.querySelectorAll('.difference-cell canvas')].map(c=>{const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<p.length;i++)n=(n+p[i]*(i%97+1))%1000000007;return n})");
 const seek=async ms=>{await evaluate(`{const t=document.querySelector('.timeline');t.value=${ms};t.dispatchEvent(new Event('input',{bubbles:true}));}`);await wait("!document.querySelector('.playback-bar .spin') && !document.querySelector('.transport-status .spin')");await delay(700);};
 const before=await hash();await click('.tactile-card .icon-button');await delay(100);await screenshot('touch-expanded');await click('.expanded-close');assert.deepEqual(await hash(),before);
 await seek(10000);await seek(51700);assert.deepEqual(await hash(),before);report.checks.push('Fixed tactile reference survives seeking and expansion with identical difference pixels');
 report.speeds=[];
 for(const speed of [.25,.5,1,1.5,2]){
   await seek(1000);await evaluate(`{const r=document.querySelector('select[aria-label="Playback speed"]');r.value=${JSON.stringify(String(speed))};r.dispatchEvent(new Event('change',{bubbles:true}));}`);
   await click('.play-button');await delay(1500);await click('.play-button');const delta=await evaluate("Number(document.querySelector('.timeline').value)-1000");assert.ok(delta>1500*speed*.65&&delta<1500*speed*1.5,`Speed ${speed}: ${delta}`);report.speeds.push({speed,delta});
 }
 report.checks.push('Six original HEVC streams play at every speed from 0.25x to 2x');
 await seek(0);await click('button[aria-label="Next frame"]');await delay(700);assert.ok(await evaluate("Number(document.querySelector('.timeline').value)>0"));await click('button[aria-label="Previous frame"]');await delay(700);assert.equal(await evaluate("Number(document.querySelector('.timeline').value)"),0);
 const max=await evaluate("Number(document.querySelector('.timeline').max)");await seek(max-1);assert.ok((await status()).cards.every(c=>c.messages.length===0));await seek(0);report.checks.push('Forward/backward frame steps and seeks to both endpoints');
 await click('.language-button');await viewport(1920,1080);await screenshot('original-zh');assert.ok(await evaluate("document.documentElement.scrollWidth<=innerWidth"));await click('.language-button');await viewport(1366,768);
 await selectSource('/home/tianyu/Projects/QualityCheck/local-data/verified/store_slippers_UMI/20260911/duanzongyu/episode_0043_20260911-161730_duanzongyu_umi_none');
 await wait("document.querySelectorAll('.software-video').length===6 && [...document.querySelectorAll('.software-video')].every(c=>c.dataset.presentedTime!==undefined) && !document.querySelector('.media-message')",30000);await screenshot('original-umi-folder');
 await selectSource('/home/tianyu/Projects/QualityCheck/local-data/verified/pack_dental_instruments/20260903/lanpengfei/episode_0060_20260903-161516_lanpengfei_arx5_none');
 await wait("document.querySelectorAll('.media-card').length===7 && !document.querySelector('.media-message')",30000);await screenshot('original-arx5-folder');
 await click('.play-button');await delay(1500);await click('.play-button');assert.ok(await evaluate("Number(document.querySelector('.timeline').value)>500"));report.checks.push('Original UMI and ARX5 folders open and play directly');
 await selectSource('/home/tianyu/Projects/QualityCheck/local-data');
 await wait("document.querySelectorAll('.episode-button').length>100 && document.querySelectorAll('.media-card').length===6 && !document.querySelector('.media-message')",45000);
 await click('.play-button');await delay(1000);await click('.play-button');assert.ok(await evaluate("Number(document.querySelector('.timeline').value)>500"));
 report.libraryModes=(await status()).cards.map(c=>c.mode);
 report.discoveredEpisodes=await evaluate("document.querySelectorAll('.episode-button').length");await screenshot('local-data-library');
 await evaluate("{const q=document.querySelector('.search-field input');q.value='episode_0043_20260911';q.dispatchEvent(new Event('input',{bubbles:true}));}");assert.equal(await evaluate("document.querySelectorAll('.episode-button').length"),1);await click('.episode-button');
 await wait("document.querySelector('.recording-overline')?.textContent.includes('EPISODE_0043_20260911') && !document.querySelector('.loading-view') && !document.querySelector('.media-message')",30000);report.checks.push('Parent local-data discovery and episode search/switching');
 await selectSource(archive,true);await wait("document.querySelectorAll('.media-card').length===6 && !document.querySelector('.media-message')",30000);report.checks.push('Switch back from original folders to TAR without stale media');

 await evaluate("{const s=document.querySelector('.timeline');for(const t of [17000,75000,3000,91000,12500]){s.value=t;s.dispatchEvent(new Event('input',{bubbles:true}));}}");
 await wait("!document.querySelector('.playback-bar .spin') && [...document.querySelectorAll('.software-video')].every(c=>Math.abs(Number(c.dataset.presentedTime)-12.5)<.04)",30000);report.checks.push('Rapid seeks finish on the most recent requested frame');
 report.liveDecoders=await evaluate('window.__liveWorkers.size');assert.equal(report.liveDecoders,6);report.checks.push('Source switching terminates old decoders; only six active workers remain');
 await cdp('Page.navigate',{url:pathToFileURL(join(root,'dist/viewer.html')).href+'?software=1'});await wait("!!document.querySelector('.open-main')");
 await selectSource('/home/tianyu/Projects/RobotDataViewer/artifacts/fixtures/complete');
 await wait("document.querySelectorAll('.media-card').length===3 && [...document.querySelectorAll('.software-video')].every(c=>c.dataset.presentedTime!==undefined) && !document.querySelector('.media-message')",30000);
 await seek(2100);const forced=await status();assert.ok(forced.cards.every(c=>c.mode==='software'&&Math.abs(Number(c.time)-2)<.068));await screenshot('forced-software-h264');report.checks.push('Forced software H.264 decoding preserves 15/30 FPS and 100 ms capture offsets');
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
 await writeFile(join(output,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){console.log(JSON.stringify(await status()));await screenshot('failure').catch(()=>{});throw error;}
finally{for(const {timeout} of pending.values())clearTimeout(timeout);chrome.kill('SIGTERM');await delay(300);await rm(profile,{recursive:true,force:true}).catch(()=>{});}
