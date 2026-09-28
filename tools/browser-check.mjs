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
const output=join(root,'artifacts','browser');await mkdir(output,{recursive:true});
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
try {
  report.browser=(await cdp('Browser.getVersion',{},true)).product;
  const target=await cdp('Target.createTarget',{url:'about:blank'},true);
  session=(await cdp('Target.attachToTarget',{targetId:target.targetId,flatten:true},true)).sessionId;
  await cdp('Page.enable');await cdp('Runtime.enable');await cdp('Network.enable');
  await cdp('Network.setBlockedURLs',{urls:['http://*','https://*','ws://*','wss://*']});
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:await readFile(join(root,'tools','tactile-browser-probe.js'),'utf8')});
  await viewport(1366,768);
  await cdp('Page.navigate',{url:pathToFileURL(join(root,'dist','viewer.html')).href});
  await wait("!!document.querySelector('.open-main')");await screenshot('welcome-1366');
  report.checks.push('Standalone file:// startup with network blocked');
  if(sampleDir){
    const manifest=JSON.parse(await readFile(join(sampleDir,'manifest.json'),'utf8'));
    await setFolder(sampleDir);
    await wait("document.querySelectorAll('.media-card video').length > 0 && [...document.querySelectorAll('.media-card video')].every(v=>v.readyState>=2)",30000);
    await wait("[...document.querySelectorAll('.difference-cell canvas')].every(c=>c.width>300) && !document.querySelector('.media-message')",20000);
    await delay(400);await screenshot('recording-en-1366');
    await evaluate("[...document.querySelectorAll('.tactile-card input[type=checkbox]')].filter(c=>c.checked).forEach(c=>c.click())");await delay(100);
    await evaluate(`{${await readFile(join(root,'vendor/tactile-filter.js'),'utf8')};window.__installTactileCheck(TactileFilter);window.__nativeDifferenceErrors=()=>window.__check().map(c=>({...c,different:c.errors}));}`);
    report.checks.push('Real package folder loaded; cameras and tactile references decoded');
    await click('.play-button');await delay(2400);await click('.play-button');
    const progress=await evaluate("Number(document.querySelector('.timeline').value)");assert.ok(progress>1000,`Playback did not advance: ${progress}`);
    report.playbackMs=progress;
    const ep=manifest.episodes[0],data=JSON.parse(await readFile(join(sampleDir,ep.data),'utf8'));
    const seekMs=Math.round(ep.durationMs*.43);
    await evaluate(`{const s=document.querySelector('.timeline');s.value=${seekMs};s.dispatchEvent(new Event('input',{bubbles:true}));}`);
    await wait("[...document.querySelectorAll('.media-card video')].every(v=>!v.seeking)");await delay(200);
    report.seek=await evaluate("[...document.querySelectorAll('.media-card')].map(c=>({id:c.dataset.channel,time:c.querySelector('video').currentTime,error:c.querySelector('video').error?.message||null}))");
    const {mediaTimeAt}=await import('../src/math.ts');
    for(const item of report.seek){assert.equal(item.error,null);const channel=ep.media.find(m=>m.id===item.id);const delta=Math.abs(item.time-mediaTimeAt(data.timings[item.id],seekMs));assert.ok(delta<=1/channel.fps+.002,`Seek drift ${item.id}: ${delta}`);}
    report.checks.push('Synchronized play/pause and seek within one frame');
    assert.ok((await evaluate('window.__nativeDifferenceErrors()')).every(v=>v.different===0),'Native tactile response at default 10x');
    await evaluate("{const g=document.querySelector('.tactile-card input[type=range]');g.value=1;g.dispatchEvent(new Event('input',{bubbles:true}));}");await delay(250);
    assert.ok((await evaluate('window.__nativeDifferenceErrors()')).every(v=>v.different===0),'Native tactile response at 1x');
    report.checks.push('Native worker tactile rendering preserves exact reference differences at 1x and 10x gain');
    await screenshot('seek-en-1366');
    const hash=()=>evaluate("[...document.querySelectorAll('.difference-cell canvas')].map(c=>{const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let s=0;for(let i=0;i<d.length;i++)s=(s+d[i]*(i%97+1))%1000000007;return s})");
    const before=await hash();await click('.tactile-card .icon-button');await delay(150);await screenshot('touch-expanded');
    await click('.expanded-close');await delay(100);assert.deepEqual(await hash(),before);
    report.checks.push('Expanded tactile panel retains exact difference pixels and reference');
    await click('.signals-section summary');await evaluate("document.querySelector('.signals-section').scrollIntoView({block:'end'})");await screenshot('signals-en-1366');
    await click('.language-button');await evaluate("document.querySelector('.workspace').scrollTop=0");await screenshot('recording-zh-1366');
    await viewport(1920,1080);await screenshot('recording-zh-1920');await click('.language-button');await screenshot('recording-en-1920');
    assert.ok(await evaluate("document.documentElement.scrollWidth<=innerWidth"));
    report.checks.push('English/Chinese at laptop and desktop sizes without page overflow');
    if(manifest.episodes.length>1){
      await evaluate("document.querySelectorAll('.episode-button')[1].click()");
      await wait("document.querySelectorAll('.media-card video').length>0 && [...document.querySelectorAll('.media-card video')].every(v=>v.readyState>=2)");
      await delay(200);await click('.play-button');await delay(1500);await click('.play-button');
      assert.ok(await evaluate("Number(document.querySelector('.timeline').value)>500"));
      await screenshot('robot-en-1920');report.checks.push('Switch to real robot recording and replay');
    }
    assert.ok(!await evaluate("/标记为|标注|通过|待修复|quality score|label episode/i.test(document.body.innerText)"));
  }
  if(fixtures){
    await setFolder(join(fixtures,'complete'));
    await wait("document.querySelectorAll('.media-card video').length===3 && [...document.querySelectorAll('.media-card video')].every(v=>v.readyState>=2)");
    await wait("document.querySelector('.difference-cell canvas')?.width===320");
    await evaluate("{for(const v of document.querySelectorAll('video'))v.requestVideoFrameCallback((_,m)=>v.dataset.presentedTime=String(m.mediaTime));const s=document.querySelector('.timeline');s.value=2100;s.dispatchEvent(new Event('input',{bubbles:true}));}");
    await wait("[...document.querySelectorAll('.media-card video')].every(v=>!v.seeking && v.dataset.presentedTime)");
    const presented=await evaluate("[...document.querySelectorAll('.media-card')].map(c=>({id:c.dataset.channel,time:Number(c.querySelector('video').dataset.presentedTime)}))");
    for(const p of presented)assert.ok(Math.abs(p.time-2)<=1/(p.id==='r_wrist'?15:30)+.001,`Decoded frame mismatch: ${JSON.stringify(p)}`);
    report.checks.push('Decoded frames align across 15/30 FPS streams with 100 ms capture offset');
    report.speeds=[];
    for(const speed of [.25,.5,1,1.5,2]){
      await evaluate(`{const s=document.querySelector('.timeline');s.value=100;s.dispatchEvent(new Event('input',{bubbles:true}));const rate=document.querySelector('select[aria-label="Playback speed"]');rate.value=${JSON.stringify(String(speed))};rate.dispatchEvent(new Event('change',{bubbles:true}));}`);
      await wait("[...document.querySelectorAll('.media-card video')].every(v=>!v.seeking)");await delay(80);
      await click('.play-button');await delay(750);await click('.play-button');
      const delta=await evaluate("Number(document.querySelector('.timeline').value)-100");
      assert.ok(delta>750*speed*.55 && delta<750*speed*1.5+100,`Unexpected ${speed}x progress: ${delta}`);report.speeds.push({speed,deltaMs:delta});
    }
    report.checks.push('All five playback speeds advance the shared clock');
    const sought=await evaluate("Number(document.querySelector('.timeline').value)");
    await click('button[aria-label="Next frame"]');await delay(100);
    assert.ok(await evaluate("Number(document.querySelector('.timeline').value)")>sought);
    await click('button[aria-label="Previous frame"]');await delay(100);
    report.checks.push('Forward/backward frame stepping');
    await click('.signals-section summary');assert.ok(await evaluate("document.querySelector('.signal-toolbar select').options.length>=6"));
    await screenshot('synthetic-single-arm');
    for(const kind of ['missing','corrupt']){
      await setFolder(join(fixtures,kind));
      await wait("!!document.querySelector('.media-message') && /missing|could not be played/.test(document.body.innerText)");
      await wait("[...document.querySelectorAll('.media-card video')].filter(v=>!v.error).every(v=>v.readyState>=2)");
      await click('.play-button');await delay(800);await click('.play-button');
      assert.ok(await evaluate("Number(document.querySelector('.timeline').value)>200"),kind+' channel blocked playback');
    }
    report.checks.push('Missing and corrupt video channels do not block remaining playback');
    await setFolder(join(fixtures,'invalid'));await wait("!!document.querySelector('.error-banner')");
    await setFolder(join(fixtures,'signals'));await wait("!!document.querySelector('.trajectory-card') && !document.querySelector('.media-card')");
    await click('.play-button');await delay(800);await click('.play-button');
    assert.ok(await evaluate("Number(document.querySelector('.timeline').value)>200"));
    report.checks.push('Malformed timing data is explained; signal-only recording plays without video');
    for(let i=0;i<3;i++){await setFolder(join(fixtures,'complete'));await wait("document.querySelectorAll('.media-card video').length===3 && [...document.querySelectorAll('.media-card video')].every(v=>v.readyState>=2)");}
    await wait("document.querySelector('.difference-cell canvas')?.width===320");
    assert.equal(await evaluate("document.querySelectorAll('video').length"),3);
    report.checks.push('Repeated package switching leaves only active recording media elements');
  }
  assert.deepEqual(errors,[],'Uncaught browser exceptions');assert.deepEqual(requests,[],'Unexpected network requests');
  report.checks.push('No runtime exceptions, external requests, or labeling controls');
  await writeFile(join(output,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} catch(error) {await screenshot('failure').catch(()=>{});await writeFile(join(output,'failure.json'),JSON.stringify({message:String(error),errors,stderr:stderr.slice(-2500)},null,2));throw error;}
finally {for(const {timeout} of pending.values())clearTimeout(timeout);chrome.kill('SIGTERM');await delay(300);await rm(profile,{recursive:true,force:true}).catch(()=>{});}
