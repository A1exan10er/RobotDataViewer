// Isolated Chrome/CDP test. No existing browser session or user profile is read.
// Usage: RDV_FOLDER=/path/to/recording RDV_CONTACT_MS=10000 node tools/browser-tactile-clean.mjs
// Default: synthetic fixture; RDV_NATIVE, RDV_COMPAT, RDV_SHORT, RDV_RAPID,
// RDV_FAILURE, RDV_NO_ARC, RDV_LIVE and RDV_DELAY_MS exercise edge cases.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname,'..');
const output=join(root,'artifacts',process.env.RDV_LABEL||'tactile-browser');await mkdir(output,{recursive:true});
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
const settingsVisible=async()=>assert.ok(await evaluate("(()=>{const l=document.querySelector('.gain-popover[open] .cleanup-setting'),r=l.getBoundingClientRect();const hit=document.elementFromPoint(r.x+4,r.y+4);return r.top>=0&&r.right<=innerWidth&&!!hit?.closest('.gain-popover');})()"),'Settings are clipped');
const folder=resolve(process.env.RDV_FOLDER || join(root,'artifacts','tactile-fixtures',process.env.RDV_NO_ARC?'missing-arc':process.env.RDV_SHORT?'short':'source'));
const report={checks:[],errors,requests};
const capping=process.env.RDV_TASK==='capping', contactTime=Number(process.env.RDV_CONTACT_MS||(process.env.RDV_FOLDER?(capping?18800:10000):4000));
const seek=async ms=>{await evaluate(`{const s=document.querySelector('.timeline');s.value=${ms};s.dispatchEvent(new Event('input',{bubbles:true}));}`);await delay(100);await wait("!document.querySelector('.playback-bar .spin') && !document.querySelector('.media-message')",45000);await delay(100);};
try{
 report.browser=(await cdp('Browser.getVersion',{},true)).product;
 const target=await cdp('Target.createTarget',{url:'about:blank'},true);session=(await cdp('Target.attachToTarget',{targetId:target.targetId,flatten:true},true)).sessionId;
 await cdp('Page.enable');await cdp('Runtime.enable');await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['http://*','https://*','ws://*','wss://*']});
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'window.__failCalibration='+!!process.env.RDV_FAILURE+';'+(process.env.RDV_COMPAT?'window.OffscreenCanvas=undefined;window.createImageBitmap=undefined;':'')+'window.__tactileDelay='+Number(process.env.RDV_DELAY_MS||0)+';'+await readFile(join(root,'tools','tactile-browser-probe.js'),'utf8')});
 await viewport(1366,1000);await cdp('Page.navigate',{url:pathToFileURL(join(root,'dist/viewer.html')).href+(process.env.RDV_LEGACY_NATIVE?'?nativeTactile=1':process.env.RDV_NATIVE?'':'?software=1')});await wait("!!document.querySelector('.open-main')");
 const doc=await cdp('DOM.getDocument');const node=await cdp('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'input[webkitdirectory]'});await cdp('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[folder]});
 if(process.env.RDV_RAPID){await wait("document.querySelectorAll('.episode-button').length>=2");await evaluate("{const buttons=[...document.querySelectorAll('.episode-button')];buttons[1].click();}");await delay(30);await evaluate("document.querySelectorAll('.episode-button')[0].click()");await delay(30);await evaluate("document.querySelectorAll('.episode-button')[1].click()");}
 if(process.env.RDV_NO_ARC){
  await wait("document.querySelectorAll('.difference-cell .media-message').length===1 && document.querySelector('.difference-cell .media-message').textContent.includes('Arc not detected')",45000);
  if(!process.env.RDV_COMPAT)assert.equal(await evaluate("window.__tactileModels.filter(m=>m.roiStatus==='not-found').length"),1);
  const hiddenBlack=()=>evaluate("(()=>{const c=document.querySelector('[data-channel=l_tact_l] .difference-cell canvas');const a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return a.every((v,i)=>v===(i%4===3?255:0));})()");
  assert.ok(await hiddenBlack());await click('.play-button');await delay(4100);await click('.play-button');
  assert.ok(await evaluate("Number(document.querySelector('.timeline').value)>3000"));
  await evaluate("{const card=document.querySelector('[data-channel=l_tact_l]');card.querySelector('input[type=checkbox]').click();const g=card.querySelector('input[type=range]');g.value=16;g.dispatchEvent(new Event('input',{bubbles:true}));}");
  await delay(300);assert.ok(await hiddenBlack());await screenshot('arc-not-detected');
  await click('[data-channel=l_tact_l] .icon-button');await screenshot('arc-not-detected-expanded');await click('.expanded-close');
  await click('.language-button');assert.ok(await evaluate("document.querySelector('.difference-cell .media-message').textContent.includes('未检测到弧形边界')"));await screenshot('arc-not-detected-zh');
  report.checks.push('Missing arc stays opaque black through playback, gain, Show all changes and expansion; other channels continue; English/Chinese notice visible');
 }else if(process.env.RDV_FAILURE){
  await wait("document.querySelectorAll('.difference-cell .media-message').length===1 && document.querySelector('.difference-cell .media-message').textContent.includes('could not be prepared') && window.__tactileModels.length===3",45000);
  await click('.play-button');await delay(1500);await click('.play-button');assert.ok(await evaluate("Number(document.querySelector('.timeline').value)>1000"));
  report.checks.push('Baseline failure stays visible in one panel while other channels continue playback');
 }else{
 await wait("document.querySelectorAll('.tactile-card').length===4 && document.querySelectorAll('.media-card').length>4 && [...document.querySelectorAll('.media-card')].every(c=>c.dataset.revealed==='true'&&c.dataset.preparation==='ready'&&c.dataset.readyGeneration===c.dataset.generation) && !document.querySelector('.media-message')",45000);
 assert.ok(await evaluate("[...document.querySelectorAll('.tactile-card input[type=checkbox]')].every(c=>!c.checked)"));
 await seek(0);
 await evaluate(`{${await readFile(join(root,'vendor/tactile-filter.js'),'utf8')};window.__Filter=TactileFilter;window.__Calibration=TactileCalibration;}`);
 await evaluate('window.__installTactileCheck(window.__Filter)');
 const check=async()=>{await wait('window.__check().length===4 && window.__check().every(v=>v.errors===0)',10000);const values=await evaluate('window.__check()');assert.ok(values.every(v=>v.errors===0&&v.outside===0&&v.roiStatus==='ready'),JSON.stringify(values));return values;};
 if(process.env.RDV_LIVE){
  await seek(0);
  await evaluate(`{
   window.__liveSamples=[];window.__livePaints={};window.__originalDraw=CanvasRenderingContext2D.prototype.drawImage;
   CanvasRenderingContext2D.prototype.drawImage=function(...args){const r=window.__originalDraw.apply(this,args);const c=this.canvas.closest?.('.difference-cell');if(c){const id=c.closest('.media-card').dataset.channel;window.__livePaints[id]=(window.__livePaints[id]||0)+1;}return r;};
   window.__liveTimer=setInterval(()=>window.__liveSamples.push({at:performance.now(),time:Number(document.querySelector('.timeline').value),busy:!!document.querySelector('.playback-bar .spin'),channels:[...document.querySelectorAll('.tactile-card')].map(c=>{const a=window.__pixels(c.querySelector('.difference-cell canvas'));let strong=0;for(let i=0;i<a.length;i+=4)if(Math.max(a[i],a[i+1],a[i+2])>100)strong++;return {id:c.dataset.channel,strong,paints:window.__livePaints[c.dataset.channel]||0};})}),200);
  }`);
  await click('.play-button');await delay(6500);await click('.play-button');
  const samples=await evaluate('clearInterval(window.__liveTimer);CanvasRenderingContext2D.prototype.drawImage=window.__originalDraw;window.__liveSamples');
  const contacts=samples.filter(s=>s.time>=3500&&s.time<=5500),last=samples.at(-1);
  report.live={wallMs:last.at-samples[0].at,advancedMs:last.time-samples[0].time,busySamples:samples.filter(s=>s.busy&&s.at>samples[0].at+500).length,channels:last.channels,contactSamples:contacts.length,visibleContacts:contacts.filter(s=>s.channels.every(c=>c.strong>100)).length};
  assert.ok(report.live.advancedMs>=report.live.wallMs*.98);assert.equal(report.live.busySamples,0);
  assert.ok(last.channels.every(c=>c.paints>60));assert.ok(contacts.length>0&&report.live.visibleContacts>=contacts.length*.9);
  report.checks.push('Continuous synthetic playback advances in real time, shows contact and keeps all tactile canvases updating');
 }
 if(process.env.RDV_SHORT){assert.ok(await evaluate('window.__tactileModels.length===4 && window.__tactileModels.every(m=>m.sampleCount===3)'));await seek(60);await check();report.checks.push('Three-frame clips calibrate from all available frames and support seeking');}
 else {
 await seek(2000);await check();
 await evaluate("{const s=document.querySelector('.timeline');s.value=4000;s.dispatchEvent(new Event('input',{bubbles:true}));const card=document.querySelector('.tactile-card'),g=card.querySelector('input[type=range]');g.value=16;g.dispatchEvent(new Event('input',{bubbles:true}));card.querySelector('input[type=checkbox]').click();}");
 await wait("!document.querySelector('.playback-bar .spin') && !document.querySelector('.media-message')",15000);await check();
 await evaluate("{const card=document.querySelector('.tactile-card'),g=card.querySelector('input[type=range]');g.value=10;g.dispatchEvent(new Event('input',{bubbles:true}));card.querySelector('input[type=checkbox]').click();}");await check();
 report.checks.push('Settings changed during a staged seek produce exact current-settings pixels');
 await seek(2000);report.noTouch=await check();
 await screenshot('no-touch');report.checks.push('Calibrated opening response matches the shared filter');
 await seek(contactTime);report.contact=await check();assert.ok(report.contact.filter(v=>capping?v.id==='l_tact_r':v.id.startsWith('l_')).every(v=>v.strong>100));

 await screenshot('contact');
 const original=await evaluate("Array.from(window.__sourcePixels(document.querySelector('.tactile-card')))");
 await click(capping?'[data-channel=l_tact_r] .icon-button':'.tactile-card .icon-button');assert.ok(await evaluate("getComputedStyle(document.querySelector('.expanded-panel .tactile-source')).display==='none'"));await screenshot('contact-expanded');await click('.expanded-close');await check();
 await evaluate("document.querySelector('.tactile-card .gain-popover').open=true");await settingsVisible();await screenshot('settings');
 await evaluate("[...document.querySelectorAll('.tactile-card input[type=checkbox]')].forEach(c=>c.click())");await delay(100);await check();
 assert.deepEqual(await evaluate("Array.from(window.__sourcePixels(document.querySelector('.tactile-card')))"),original);
 await seek(2000);report.unfiltered=await check();assert.ok(report.unfiltered.every((v,i)=>v.changed>=report.noTouch[i].changed));
 await screenshot('no-touch-unfiltered');report.checks.push('Show all changes reveals unfiltered image response without changing the source image');
 await click('.play-button');await evaluate("[...document.querySelectorAll('.tactile-card input[type=checkbox]')].forEach(c=>c.click())");await delay(1800);await click('.play-button');await delay(100);await check();
 await seek(contactTime);const first=await evaluate("Array.from(window.__pixels(document.querySelector('.difference-cell canvas')))");
 for(const gain of [1,16,10]){await evaluate(`{const g=document.querySelector('.tactile-card input[type=range]');g.value=${gain};g.dispatchEvent(new Event('input',{bubbles:true}));}`);await delay(100);await check();}
 await click('[aria-label="Next frame"]');await delay(200);await check();await click('[aria-label="Previous frame"]');await delay(200);await check();
 await seek(0);await seek(contactTime);assert.deepEqual(await evaluate("Array.from(window.__pixels(document.querySelector('.difference-cell canvas')))"),first);
 await seek(2000);await check();report.checks.push('Gain changes, toggling during playback, fixed-baseline seek repeatability, and repeatable calibrated output pass');
 if(!process.env.RDV_FOLDER){await seek(6500);report.outsideOnly=await check();assert.ok(report.outsideOnly.every(v=>v.strong===0));report.checks.push('Outside-only changes produce no strong response; every excluded pixel is opaque black');}
 await click('.language-button');await settingsVisible();await screenshot('settings-zh');assert.ok(await evaluate("document.querySelector('.cleanup-setting').textContent.includes('显示全部变化')"));
 await click('.tactile-card .icon-button');await screenshot('expanded-zh');await click('.expanded-close');
 }
 }
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
 await writeFile(join(output,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){report.failure=String(error);report.body=await evaluate('document.body.innerText').catch(()=>null);await screenshot('failure').catch(()=>{});await writeFile(join(output,'results.json'),JSON.stringify(report,null,2));throw error;}finally{for(const {timeout} of pending.values())clearTimeout(timeout);chrome.kill('SIGTERM');await delay(300);await rm(profile,{recursive:true,force:true}).catch(()=>{});}
