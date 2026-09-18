// Isolated Chrome/CDP test. No existing browser session or user profile is read.
// Usage: node tools/browser-smooth.mjs; RDV_ARCHIVE overrides the local sample.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname,'..');
const output=join(root,'artifacts','smooth-browser');await mkdir(output,{recursive:true});
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
const report={checks:[],errors,requests};
const archive=process.env.RDV_ARCHIVE || '/home/tianyu/Downloads/task-e7244f5d-part-01-of-01.tar';
const ready="document.querySelectorAll('.media-card').length===7 && !document.querySelector('.media-message') && !document.querySelector('.loading-view')";
const seek=async ms=>{await evaluate(`{const s=document.querySelector('.timeline');s.value=${ms};s.dispatchEvent(new Event('input',{bubbles:true}));}`);await wait("!document.querySelector('.playback-bar .spin')");await delay(100);};
try{
 const target=await cdp('Target.createTarget',{url:'about:blank'},true);session=(await cdp('Target.attachToTarget',{targetId:target.targetId,flatten:true},true)).sessionId;
 await cdp('Page.enable');await cdp('Runtime.enable');await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['http://*','https://*','ws://*','wss://*']});
 await viewport(1366,900);await cdp('Page.navigate',{url:pathToFileURL(join(root,'dist/viewer.html')).href});await wait("!!document.querySelector('.open-main')");
 const doc=await cdp('DOM.getDocument');const input=await cdp('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'input[accept]'});await cdp('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[archive]});await wait(ready,45000);
 assert.equal(await evaluate("document.querySelectorAll('.episode-button').length"),5);
 await evaluate(`{
 ${await readFile(join(root,'vendor/tactile-filter.js'),'utf8')};window.__Filter=TactileFilter;
 window.__readPixels=c=>{const copy=document.createElement('canvas');copy.width=c.width;copy.height=c.height;const ctx=copy.getContext('2d');ctx.drawImage(c,0,0);return ctx.getImageData(0,0,copy.width,copy.height).data;};
 window.__references=[...document.querySelectorAll('.tactile-card .software-video')].map(window.__readPixels);
 window.__differenceErrors=()=>[...document.querySelectorAll('.tactile-card')].map((card,index)=>{const actual=window.__readPixels(card.querySelector('.difference-cell canvas')),current=window.__readPixels(card.querySelector('.software-video')),reference=window.__references[index],gain=Number(card.querySelector('input[type=range]').value);const surface=card.querySelector('.difference-cell canvas'),expected=new Uint8ClampedArray(actual.length);new window.__Filter(surface.width,surface.height,reference).render(current,expected,gain,!card.querySelector('input[type=checkbox]').checked);let different=0,max=0;for(let i=0;i<actual.length;i+=4)for(let c=0;c<3;c++){const delta=Math.abs(actual[i+c]-expected[i+c]);if(delta){different++;max=Math.max(max,delta);}}return {id:card.dataset.channel,different,max};});
 }`);
 assert.ok(await evaluate("[...document.querySelectorAll('.tactile-card input[type=range]')].every(g=>g.value==='8')"),'Tactile change starts at 8x gain');
 await evaluate("[...document.querySelectorAll('.tactile-card input[type=checkbox]')].filter(c=>c.checked).forEach(c=>c.click())");await delay(100);
 await seek(7000);assert.ok((await evaluate('window.__differenceErrors()')).every(v=>v.different===0));
 await evaluate("{const g=document.querySelector('.tactile-card input[type=range]');g.value=8;g.dispatchEvent(new Event('input',{bubbles:true}));}");await delay(100);assert.ok((await evaluate('window.__differenceErrors()')).every(v=>v.different===0));
 await click('.play-button');await delay(1600);await click('.play-button');await delay(100);assert.ok((await evaluate('window.__differenceErrors()')).every(v=>v.different===0));
 await evaluate("{const g=document.querySelector('.tactile-card input[type=range]');g.value=1;g.dispatchEvent(new Event('input',{bubbles:true}));}");await seek(3000);await seek(7000);assert.ok((await evaluate('window.__differenceErrors()')).every(v=>v.different===0));
 report.checks.push('Worker-rendered tactile differences match the shared tactile response filter exactly at 1x and 8x, while paused, playing, and seeking');
 await click('.tactile-card .icon-button');await delay(100);await screenshot('touch-expanded');await click('.expanded-close');assert.ok((await evaluate('window.__differenceErrors()')).every(v=>v.different===0));
 await click('button[aria-label="Expand panel: Motion"]');await delay(100);await screenshot('motion-expanded');await click('button[aria-label="Reset view"]');await click('.expanded-close');await seek(0);await screenshot('nas-overview');report.checks.push('Cached trajectories support seeking, expansion, and reset');
 report.episodes=[];
 for(let i=0;i<5;i++){
  if(i){await evaluate(`document.querySelectorAll('.episode-button')[${i}].click()`);await wait(ready,30000);}
  await click('.play-button');await wait("document.querySelector('.playback-status')?.textContent.includes('Playing')");
  await evaluate(`{window.__samples=[];window.__capture=true;const tick=()=>{if(!window.__capture)return;const timeline=document.querySelector('.timeline'),surface=document.querySelector('.software-video');if(!timeline||!surface)return;window.__samples.push({at:performance.now(),t:Number(timeline.value),frame:Number(surface.dataset.presentedTime)});window.__captureRaf=requestAnimationFrame(tick);};window.__captureRaf=requestAnimationFrame(tick);}`);
  await delay(2400);await click('.play-button');await evaluate('{window.__capture=false;cancelAnimationFrame(window.__captureRaf);}');
  const samples=await evaluate('window.__samples');const displayed=new Set(samples.map(s=>s.frame)).size;const advanced=samples.at(-1).t-samples[0].t;assert.ok(displayed>=66,`Episode ${i}: ${displayed} frames`);assert.ok(advanced>2200,`Episode ${i}: ${advanced}ms`);
  report.episodes.push({index:i+1,displayed,advancedMs:advanced});
 }
 report.checks.push('All five NAS episodes sustain normal-speed playback with seven streams');
 await seek(20000);await click('.language-button');await viewport(1920,1080);await screenshot('nas-zh');assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);await writeFile(join(output,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){console.log(await evaluate('document.body.innerText.slice(-1800)'));await screenshot('failure').catch(()=>{});throw error;}
finally{for(const {timeout} of pending.values())clearTimeout(timeout);chrome.kill('SIGTERM');await delay(300);await rm(profile,{recursive:true,force:true}).catch(()=>{});}
