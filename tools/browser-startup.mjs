// Isolated Chrome/CDP test. No existing browser session or user profile is read.
// Usage: RDV_NATIVE=1 RDV_LABEL=joint-native node tools/browser-startup.mjs
// Default: synthetic fixture with delayed calibration and fault injection.
// RDV_NATIVE, RDV_COMPAT, RDV_REAL, RDV_FOLDER and RDV_CALIBRATION_DELAY select paths.
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname,'..');
const output=join(root,'artifacts',process.env.RDV_LABEL||'startup-browser');await mkdir(output,{recursive:true});
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
const folder=process.env.RDV_FOLDER||join(root,'artifacts/tactile-fixtures',process.env.RDV_OFFSETS?'offsets':'source');
const report={hostBefore:{memory:await readFile('/proc/meminfo','utf8'),pressure:await readFile('/proc/pressure/memory','utf8')},mode:process.env.RDV_COMPAT?'compatibility':process.env.RDV_NATIVE?'native':'software',calibrationDelayMs:Number(process.env.RDV_CALIBRATION_DELAY??5000),source:folder,checks:[],errors,requests};
const injection=`
window.__workers=0;window.__sampling=0;window.__fitting=0;window.__delayCalibration=${Number(process.env.RDV_CALIBRATION_DELAY??5000)};window.__paints={};window.__firstPaints=[];window.__paintedEpisodes=new Set();
const Base=Worker;
window.Worker=class extends Base {
 constructor(...args){if(window.__throwWorker>0&&!--window.__throwWorker)throw new Error('Injected worker construction failure');super(...args);window.__workers++;this.delayed=new Map();this.dead=false;this.timers=new Map();
 this.addEventListener('message',event=>{const waitMs=this.delayed.get(event.data.id);if(waitMs!==undefined&&!event.replayed){this.delayed.delete(event.data.id);event.stopImmediatePropagation();const timer=setTimeout(()=>{this.timers.delete(timer);if(this.dead){event.data.result?.frames?.forEach(f=>{f.image?.close();f.differenceImage?.close();});event.data.image?.close();return;}const next=new MessageEvent('message',{data:event.data});Object.defineProperty(next,'replayed',{value:true});this.dispatchEvent(next);},waitMs);this.timers.set(timer,event.data);}});}
 postMessage(data,...args){if(data.method==='redraw'&&window.__throwRedraw){window.__throwRedraw=false;throw new Error('Injected redraw dispatch failure');}if(data.kind==='sample')window.__sampling++;if(data.kind==='calibrated'||(data.method==='init'&&data.args.isTactile&&!data.args.reference)){window.__fitting++;this.delayed.set(data.id,window.__delayCalibration);}if((data.kind==='frame'||data.method==='redraw')&&window.__frameDelay)this.delayed.set(data.id,window.__frameDelay);return super.postMessage(data,...args);}
 terminate(){if(!this.dead){this.dead=true;window.__workers--;for(const [timer,data] of this.timers){clearTimeout(timer);data.result?.frames?.forEach(f=>{f.image?.close();f.differenceImage?.close();});data.image?.close();}this.timers.clear();}return super.terminate();}
};
for(const method of ['drawImage','putImageData']){const original=CanvasRenderingContext2D.prototype[method];CanvasRenderingContext2D.prototype[method]=function(...args){const card=this.canvas.closest?.('.tactile-card');if(window.__throwCanvas===card?.dataset.channel&&this.canvas.closest('.difference-cell')){window.__throwCanvas=null;throw new Error('Injected canvas failure');}const result=original.apply(this,args);if(card&&this.canvas.closest('.difference-cell')){window.__paints[card.dataset.channel]=(window.__paints[card.dataset.channel]||0)+1;const selection=performance.getEntriesByName('rdv:episode-selection').at(-1)?.startTime,key=selection+':'+card.dataset.channel;if(!window.__paintedEpisodes.has(key)){window.__paintedEpisodes.add(key);window.__firstPaints.push({selection,channel:card.dataset.channel,episodeMs:Number(document.querySelector('.timeline').value),staged:true});}}return result;};}
`;
const timeline=()=>evaluate('Number(document.querySelector(".timeline").value)');
const expectedPanels=Number(process.env.RDV_PANELS||(process.env.RDV_REAL?7:5));
const jointReady=(failed=0)=>`(()=>{
 const cards=[...document.querySelectorAll('.media-card')],touch=cards.filter(c=>c.classList.contains('tactile-card')),selected=document.querySelector('.episode-button.selected');
 const entries=performance.getEntriesByType('mark'),selection=entries.filter(e=>e.name==='rdv:episode-selection').at(-1),joint=entries.filter(e=>e.name==='rdv:joint-ready').at(-1);
 return cards.length===${expectedPanels}&&touch.length===4&&!!selected&&!document.querySelector('.loading-view')&&!!selection&&!!joint&&joint.startTime>selection.startTime&&cards.filter(c=>c.dataset.preparation==='failure').length===${failed}&&cards.every(c=>c.dataset.revealed==='true'&&Number(c.dataset.generation)===joint.detail.generation&&(c.dataset.preparation==='failure'?!!c.querySelector('.media-message'):c.dataset.preparation==='ready'&&Number(c.dataset.readyGeneration)===joint.detail.generation&&!c.querySelector('.media-message')&&entries.some(e=>e.name==='rdv:channel-ready'&&e.detail.channel===c.dataset.channel&&e.detail.generation===joint.detail.generation&&e.startTime>selection.startTime)))&&touch.filter(c=>c.dataset.preparation!=='failure').every(c=>Number(c.querySelector('.difference-cell canvas').dataset.generation)===joint.detail.generation);
})()`;
const ready=jointReady();
const marks=()=>evaluate("performance.getEntriesByType('mark').filter(e=>e.name.startsWith('rdv:')).map(e=>({name:e.name,time:e.startTime,...e.detail}))");
const controlSeek=async ms=>{await evaluate(`{const s=document.querySelector('.timeline');s.value=${ms};s.dispatchEvent(new Event('input',{bubbles:true}));}`);await wait('Number(document.querySelector(".timeline").value)==='+ms,3000);};
const held=async()=>{
 const state=await evaluate(`({time:Number(document.querySelector('.timeline').value),moving:[...document.querySelectorAll('.media-card video')].filter(v=>!v.paused).length,revealed:[...document.querySelectorAll('.media-card')].some(c=>c.dataset.revealed==='true')})`);
 assert.equal(state.moving,0,'No native transport may play during joint preparation');assert.equal(state.revealed,false,'All views stay behind preparation overlays');return state;
};
const jointFrames=async()=>evaluate(`(()=>{const target=Number(document.querySelector('.timeline').value)/1000,offsets=${JSON.stringify(process.env.RDV_OFFSETS?{l_tact_l:[.25,1.05],l_tact_r:[.5,.95],r_tact_l:[.75,1.1],r_tact_r:[1,.9]}:{})};return [...document.querySelectorAll('.media-card')].map(c=>({channel:c.dataset.channel,state:c.dataset.preparation,revealed:c.dataset.revealed,target:Math.min(7.9999,Math.max(0,(target-(offsets[c.dataset.channel]?.[0]||0))/(offsets[c.dataset.channel]?.[1]||1))),time:c.classList.contains('tactile-card')?Number(c.querySelector('.difference-cell canvas').dataset.presentedTime):c.dataset.mode==='software'?Number(c.querySelector('.software-video').dataset.presentedTime):c.querySelector('video').currentTime}));})()`);
const assertFrames=async()=>{const frames=await jointFrames();assert.equal(frames.length,expectedPanels);for(const frame of frames){assert.equal(frame.state,'ready');assert.equal(frame.revealed,'true');if(!process.env.RDV_REAL)assert.ok(frame.time<=frame.target+.002&&frame.target-frame.time<.035,JSON.stringify(frame));}return frames;};
try{
 report.browser=(await cdp('Browser.getVersion',{},true)).product;
 const target=await cdp('Target.createTarget',{url:'about:blank'},true);session=(await cdp('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
 await cdp('Page.enable');await cdp('Runtime.enable');await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['http://*','https://*','ws://*','wss://*']});
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:injection+(process.env.RDV_COMPAT?'window.OffscreenCanvas=undefined;window.createImageBitmap=undefined;':'')+`
 window.__jointViolations=[];function checkJoint(){const cards=[...document.querySelectorAll('.media-card')];if(cards.length){const all=cards.every(c=>c.dataset.revealed==='true'),playing=cards.some(c=>[...c.querySelectorAll('video')].some(v=>!v.paused));if(playing&&!all)window.__jointViolations.push('native playback before joint reveal');if(cards.some(c=>c.dataset.revealed==='true')&&(!all||cards.some(c=>!['ready','failure'].includes(c.dataset.preparation))))window.__jointViolations.push('partial reveal');}requestAnimationFrame(checkJoint);}requestAnimationFrame(checkJoint);
 `});
 await viewport(1366,1000);await cdp('Page.navigate',{url:pathToFileURL(join(root,'dist/viewer.html')).href+(process.env.RDV_LEGACY_NATIVE?'?nativeTactile=1':process.env.RDV_NATIVE?'':'?software=1')});await wait("!!document.querySelector('.open-main')");
 const doc=await cdp('DOM.getDocument');const node=await cdp('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'input[webkitdirectory]'});await cdp('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[folder]});
 await wait("!!document.querySelector('.timeline')");await click('.play-button');
 if(!process.env.RDV_REAL){await delay(500);assert.equal((await held()).time,0);}
 await click('.play-button');await controlSeek(1000);await click('[aria-label="Next frame"]');await wait('Number(document.querySelector(".timeline").value)>1000',3000);const stepped=await timeline();
 await evaluate("{const s=document.querySelector('.playback-extras select');s.value=2;s.dispatchEvent(new Event('change',{bubbles:true}));}");
 if(!process.env.RDV_REAL)await held();
 await click('.tactile-card .icon-button');await screenshot('preparing-expanded');await click('.expanded-close');await click('.language-button');await screenshot('preparing-zh');await click('.language-button');
 await evaluate("{const s=document.querySelector('.playback-extras select');s.value=1;s.dispatchEvent(new Event('change',{bubbles:true}));}");
 await wait(ready,35000);await delay(150);assert.equal(await timeline(),stepped,'Pause cancels queued Play');report.initialFrames=await assertFrames();report.coldMarks=await marks();
 if(process.env.RDV_PREPARED)assert.equal(await evaluate("document.querySelectorAll('.tactile-card[data-mode=software]').length"),4,'Prepared packages without codec metadata use sequential tactile decoding');
 const selection=report.coldMarks.find(m=>m.name==='rdv:episode-selection').time,joint=report.coldMarks.find(m=>m.name==='rdv:joint-ready');report.coldJointReadyMs=joint.time-selection;
 assert.equal(report.coldMarks.filter(m=>m.name==='rdv:clock-moving').length,0,'No clock movement before cancelled Play');await screenshot('ready-together');
 await click('.play-button');await wait('Number(document.querySelector(".timeline").value)>'+stepped,3000);report.firstPlaybackMarks=await marks();
 const play=report.firstPlaybackMarks.filter(m=>m.name==='rdv:play').at(-1),movement=report.firstPlaybackMarks.filter(m=>m.name==='rdv:clock-moving').at(-1);report.readyPlayToClockMs=movement.time-play.time;if(!process.env.RDV_REAL)assert.ok(report.readyPlayToClockMs<1000);
 await click('.play-button');await controlSeek(2500);await wait(ready,10000);await assertFrames();
 const before=await evaluate('({...window.__paints})');await click('.play-button');const start=await timeline(),wall=Date.now();await delay(2200);await click('.play-button');const after=await evaluate('({...window.__paints})');
 report.live={advancedMs:(await timeline())-start,wallMs:Date.now()-wall};report.continuedPaints=Object.fromEntries(Object.keys(after).map(k=>[k,after[k]-(before[k]||0)]));assert.ok(Object.values(report.continuedPaints).every(n=>n>15),JSON.stringify(report.continuedPaints));
 report.checks.push('Preparation holds RGB and the clock; queued Play cancellation, seek, step, speed, expansion, both languages, joint reveal and continued tactile updates pass');
 if(!process.env.RDV_REAL){
  // Settings change while the destination render is delayed: only the newest
  // staged settings may satisfy the current generation's readiness.
  await evaluate('window.__frameDelay=250');await controlSeek(4000);
  await evaluate("{const card=document.querySelector('.tactile-card'),gain=card.querySelector('input[type=range]');gain.value=16;gain.dispatchEvent(new Event('input',{bubbles:true}));card.querySelector('input[type=checkbox]').click();}");
  await wait(ready,15000);await assertFrames();
  assert.ok(await evaluate("(()=>{const card=document.querySelector('.tactile-card'),generation=Number(card.dataset.generation),paints=performance.getEntriesByName('rdv:tactile-paint').filter(e=>e.detail.channel===card.dataset.channel&&e.detail.generation===generation);return paints.length>0&&paints.every(e=>e.detail.settingsRevision>0&&e.detail.gain===16&&e.detail.cleanup===false)&&paints.some(e=>e.detail.staged);})()"),'Only the latest staged settings may release readiness');
  await evaluate('window.__frameDelay=0');report.checks.push('Delayed seeks and settings changes acknowledge only the latest staged generation and settings');
 }

 const fitting=await evaluate('window.__fitting'),sampling=await evaluate('window.__sampling'),oldSelection=(await marks()).filter(m=>m.name==='rdv:episode-selection').at(-1).time;
 await click('.episode-button.selected');await wait(`performance.getEntriesByName('rdv:episode-selection').at(-1).startTime>${oldSelection}`);await wait(ready,15000);await assertFrames();
 report.cachedMarks=await marks();const cachedSelection=report.cachedMarks.filter(m=>m.name==='rdv:episode-selection').at(-1).time;
 assert.equal(report.cachedMarks.filter(m=>m.name==='rdv:calibration-cache-hit'&&m.time>cachedSelection).length,4);assert.equal(await evaluate('window.__fitting'),fitting);assert.equal(await evaluate('window.__sampling'),sampling);
 report.cachedJointReadyMs=report.cachedMarks.filter(m=>m.name==='rdv:joint-ready').at(-1).time-cachedSelection;
 const expectedWorkers=await evaluate("document.querySelectorAll('.media-card[data-mode=software]').length+document.querySelectorAll('.tactile-card[data-mode=native]').length");assert.equal(await evaluate('window.__workers'),expectedWorkers);
 report.checks.push('Cached reopening completes with four cache hits, no new sampling/fitting and the expected worker count');
 // Replacing the source clears models; interrupt both running and queued jobs.
 const doc2=await cdp('DOM.getDocument');const node2=await cdp('DOM.querySelector',{nodeId:doc2.root.nodeId,selector:'input[webkitdirectory]'});await cdp('DOM.setFileInputFiles',{nodeId:node2.nodeId,files:[folder]});
 await wait('window.__fitting>'+fitting,15000);await click('.episode-button.selected');await delay(40);await click('.episode-button');
 await wait("!!document.querySelector('.timeline')");await click('.play-button');if(!process.env.RDV_REAL){await delay(500);assert.equal((await held()).time,0);}
 await wait(ready,35000);await wait('Number(document.querySelector(".timeline").value)>0',3000);await click('.play-button');
 report.finalWorkers=await evaluate('window.__workers');assert.equal(report.finalWorkers,expectedWorkers);report.checks.push('Queued Play starts automatically only after joint readiness; source replacement and rapid switches release obsolete workers');
 if(!process.env.RDV_REAL){
  if(process.env.RDV_NATIVE||process.env.RDV_LEGACY_NATIVE){
   const selector=process.env.RDV_LEGACY_NATIVE?'.tactile-card video':'.media-card:not(.tactile-card) video';
   await evaluate(`window.__delayCalibration=0;document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('error'))`);
   await wait(ready,15000);assert.equal(await evaluate("document.querySelectorAll('.tactile-card[data-mode=software]').length"),process.env.RDV_LEGACY_NATIVE?1:4);await assertFrames();
   report.checks.push('Native-to-software fallback re-enters joint readiness at the held timestamp');
  }
  await evaluate("window.__throwCanvas=document.querySelector('.tactile-card').dataset.channel");await controlSeek(3000);await wait(jointReady(1),15000);
  assert.ok(await evaluate("document.querySelector('.tactile-card[data-preparation=failure] .media-message').textContent.includes('could not be prepared')"));
  await click('.play-button');const beforeFailure=await timeline();await wait('Number(document.querySelector(".timeline").value)>'+String(beforeFailure+200),3000);await click('.play-button');
  await evaluate(`window.__throwWorker=${process.env.RDV_NATIVE?1:2}`);await click('.episode-button.selected');await wait(jointReady(1),15000);
  assert.ok(await evaluate("document.querySelector('.tactile-card[data-preparation=failure] .media-message').textContent.includes('could not be prepared')"));
  await click('.play-button');await wait('Number(document.querySelector(".timeline").value)>200',3000);await click('.play-button');
  await click('.episode-button.selected');await wait(ready,15000);assert.equal(await evaluate('window.__workers'),expectedWorkers);
  if(!process.env.RDV_LEGACY_NATIVE){
   await evaluate("{window.__throwRedraw=true;const gain=document.querySelector('.tactile-card input[type=range]');gain.value=16;gain.dispatchEvent(new Event('input',{bubbles:true}));}");await wait(jointReady(1),15000);
   assert.ok(await evaluate("document.querySelector('.tactile-card[data-preparation=failure] .media-message').textContent.includes('could not be prepared')"));
   await click('.episode-button.selected');await wait(ready,15000);assert.equal(await evaluate('window.__workers'),expectedWorkers);
   report.checks.push('A paused settings redraw dispatch failure is contained in its panel');
  }
  report.checks.push('Synchronous canvas and pre-registration worker failures show a panel notice, allow other channels to play, and release resources');
 }

 report.jointViolations=await evaluate('window.__jointViolations');assert.deepEqual(report.jointViolations,[]);assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
 report.finalMarks=await marks();report.hostAfter={memory:await readFile('/proc/meminfo','utf8'),pressure:await readFile('/proc/pressure/memory','utf8')};await writeFile(join(output,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({mode:report.mode,coldJointReadyMs:report.coldJointReadyMs,cachedJointReadyMs:report.cachedJointReadyMs,readyPlayToClockMs:report.readyPlayToClockMs,live:report.live,continuedPaints:report.continuedPaints,finalWorkers:report.finalWorkers,checks:report.checks,errors,requests},null,2));
}catch(error){report.failure=String(error);report.marks=await marks().catch(()=>[]);report.body=await evaluate('document.body.innerText').catch(()=>null);await screenshot('failure').catch(()=>{});report.hostAfter={memory:await readFile('/proc/meminfo','utf8'),pressure:await readFile('/proc/pressure/memory','utf8')};await writeFile(join(output,'results.json'),JSON.stringify(report,null,2));throw error;}
finally{for(const {timeout} of pending.values())clearTimeout(timeout);const exited=once(chrome,'exit').catch(()=>{});chrome.kill('SIGTERM');await Promise.race([exited,delay(3000)]);if(chrome.exitCode===null&&chrome.signalCode===null){chrome.kill('SIGKILL');await Promise.race([exited,delay(1000)]);}await rm(profile,{recursive:true,force:true}).catch(()=>{});}
