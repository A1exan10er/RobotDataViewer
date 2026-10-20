// Isolated Chrome/CDP test. No existing browser session or user profile is read.
// Usage: RDV_FOLDER=/path/to/recording RDV_PANELS=7 node tools/browser-force.mjs
// RDV_IMPORT, RDV_TAR, RDV_SOFTWARE, RDV_COMPAT, RDV_REFERENCE,
// RDV_FAILURE, RDV_CANCEL, RDV_PREP_CONTROLS, RDV_PERSISTENCE and
// RDV_STORAGE_FAILURE select validation cases.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname,'..');
const output=join(root,'artifacts',process.env.RDV_LABEL||'force-browser');await mkdir(output,{recursive:true});
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

const folder=resolve(process.env.RDV_FOLDER||join(root,'artifacts/tactile-fixtures/short'));
const prepared=!!(process.env.RDV_IMPORT||process.env.RDV_PREPARED);
const report={errors,requests,checks:[]};
const host=async()=>({memory:await readFile('/proc/meminfo','utf8'),pressure:await readFile('/proc/pressure/memory','utf8')});
// Only inspect this harness's browser tree; shared mappings are counted per process.
let peakRssKiB=0,sampling=false;
const memoryTimer=setInterval(async()=>{
 if(sampling)return;sampling=true;
 try{let total=0;const pending=[chrome.pid],seen=new Set();
  while(pending.length&&seen.size<100){const pid=pending.pop();if(seen.has(pid))continue;seen.add(pid);
   try{total+=Number((await readFile(`/proc/${pid}/status`,'utf8')).match(/VmRSS:\s+(\d+)/)?.[1]||0);
    pending.push(...(await readFile(`/proc/${pid}/task/${pid}/children`,'utf8')).trim().split(/\s+/).filter(Boolean).map(Number));}catch{}
  }peakRssKiB=Math.max(peakRssKiB,total);
 }finally{sampling=false;}
},1000);
const ready=("document.querySelectorAll('.media-card').length===5 && [...document.querySelectorAll('.media-card')].every(c=>c.dataset.revealed==='true' && c.dataset.preparation==='ready' && c.dataset.generation===c.dataset.readyGeneration)").replace("length===5","length==="+(process.env.RDV_PANELS||5));
try{
 report.hostBefore=await host();
 const target=await cdp('Target.createTarget',{url:'about:blank'},true);session=(await cdp('Target.attachToTarget',{targetId:target.targetId,flatten:true},true)).sessionId;
 await cdp('Page.enable');await cdp('Runtime.enable');await cdp('Network.enable');await cdp('Network.setBlockedURLs',{urls:['http://*','https://*','ws://*','wss://*']});
 await viewport(1366,1000);
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`window.__forceWorkers=0;window.__forcePosts=[];const W=window.Worker;window.Worker=class extends W{constructor(...args){super(...args);window.__forceWorkers++;this.addEventListener('message',e=>{if(e.data.result?.track){const t=e.data.result.track;window.__forcePosts.push({...t,time:Array.from(t.time),shear:Array.from(t.shear),fz:Array.from(t.fz),valid:Array.from(t.valid)});}});}postMessage(data,...args){if(window.__failForce && data.type==='calculate' && data.sensor==='r_tact_l'){setTimeout(()=>this.dispatchEvent(new MessageEvent('message',{data:{id:data.id,error:'Injected corrupt sensor'}})),30);return;}return super.postMessage(data,...args);}terminate(){window.__forceWorkers--;super.terminate();}};`+(process.env.RDV_COMPAT?'window.OffscreenCanvas=undefined;window.createImageBitmap=undefined;':'')});
 await cdp('Page.navigate',{url:pathToFileURL(resolve(process.env.RDV_VIEWER||join(root,'dist/viewer.html'))).href+(process.env.RDV_SOFTWARE?'?software=1':'')});await wait("!!document.querySelector('.open-main')");

 if(process.env.RDV_REFERENCE){
  console.log('ORACLE load assets');
  await evaluate(`new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='./force-runtime.js';s.onload=resolve;s.onerror=reject;document.head.append(s);})`);
  console.log('ORACLE create worker');
  await evaluate(`{const assets=window.RDV_FORCE_ASSETS;delete window.RDV_FORCE_ASSETS;const url=URL.createObjectURL(new Blob([assets.worker],{type:'text/javascript'}));window.__oracleWorker=new Worker(url);URL.revokeObjectURL(url);let id=0;window.__oracleAsk=(payload)=>new Promise((resolve,reject)=>{const expected=++id;window.__oracleWorker.onerror=e=>reject(new Error(e.message));window.__oracleWorker.onmessage=({data})=>{if(data.id===expected)data.error?reject(new Error(data.error)):resolve(data.result);};window.__oracleWorker.postMessage({id:expected,...payload});});window.__oracleAssets=assets;void 0;}`);
  console.log('ORACLE init');
  await evaluate("window.__oracleAsk({type:'init',assets:window.__oracleAssets,forceWasm:true})");
  console.log('ORACLE ready');
  const cases=JSON.parse(await readFile(join(root,'artifacts/force-reference/manifest.json'),'utf8'));report.numerics=[];
  for(const c of cases){
    console.log('ORACLE case',c.name);
    let actual;
    for(const kind of ['reference','current']){
      const rgba=(await readFile(join(root,`artifacts/force-reference/${c.name}-${kind}.rgba`))).toString('base64');
      actual=await evaluate(`window.__oracleAsk({type:'sample',reset:${kind==='reference'},pixels:{width:${c.width},height:${c.height},data:Uint8Array.from(atob(${JSON.stringify(rgba)}),c=>c.charCodeAt(0))}})`);
    }
    const values=[actual.shear,actual.fz],errors=values.map((v,i)=>Math.abs(v-c.forces[i]));report.numerics.push({name:c.name,values,expected:c.forces,errorN:errors});
    assert.equal(actual.contact>=.1,c.score>=.1);assert.ok(errors.every((e,i)=>e<=.001+.001*Math.abs(c.forces[i])),JSON.stringify(report.numerics.at(-1)));
  }
  await evaluate('window.__oracleWorker.terminate();delete window.__oracleWorker;delete window.__oracleAssets;delete window.__oracleAsk;');
  report.checks.push('Browser DeepFlow + ONNX meets identical-input force oracle');
 }
 const doc=await cdp('DOM.getDocument');const node=await cdp('DOM.querySelector',{nodeId:doc.root.nodeId,selector:process.env.RDV_TAR?'input[accept*=".tar"]':'input[webkitdirectory]'});
 const openTime=Date.now();await cdp('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[folder]});await wait(ready,45000);report.startupMs=Date.now()-openTime;
 assert.ok(await evaluate("!document.querySelector('.force-toolbar input[type=checkbox]').checked && !performance.getEntriesByType('resource').some(r=>r.name.includes('force-runtime'))"));
 const workers=await evaluate('window.__forceWorkers');
 if(process.env.RDV_STORAGE_FAILURE)await evaluate(`{
   const put=IDBObjectStore.prototype.put;
   IDBObjectStore.prototype.put=function(...args){if(this.name==='tracks')throw new DOMException('Injected full storage','QuotaExceededError');return put.apply(this,args);};
 }`);
 if(process.env.RDV_FAILURE)await evaluate('window.__failForce=true');
 if(process.env.RDV_IMPORT){
  const input=await cdp('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'.force-toolbar input[type=file]'});await cdp('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[resolve(process.env.RDV_IMPORT)]});await delay(150);
 }
 if(process.env.RDV_CANCEL){
  await click('.force-toolbar input[type=checkbox]');await wait('window.__forceWorkers>'+workers,20000);
  if(process.env.RDV_CANCEL_PROGRESS)await wait("/[1-9][0-9]*\\/[0-9]+/.test(document.querySelector('.force-progress small')?.textContent||'')",30000);
  await click('.force-progress button');await delay(150);
  assert.equal(await evaluate('window.__forceWorkers'),workers);assert.equal(await evaluate('window.__forcePosts.length'),0);assert.ok(await evaluate("!document.querySelector('.force-toolbar input[type=checkbox]').checked && !document.querySelector('.play-button').disabled"));report.checks.push('Cancellation releases initializing worker and restores paused controls');
 }

 const started=Date.now();await click('.force-toolbar input[type=checkbox]');
 if(!prepared){await wait("!!document.querySelector('.force-progress')");assert.ok(await evaluate("document.querySelector('.play-button').disabled"));}
 if(process.env.RDV_PREP_CONTROLS){
  await evaluate("{const s=document.querySelector('.timeline');s.value=4000;s.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.transport button:last-child').click();const speed=document.querySelector('.playback-extras select');speed.value='2';speed.dispatchEvent(new Event('change',{bubbles:true}));}");await wait(ready,30000);assert.equal(await evaluate("Number(document.querySelector('.timeline').value)"),4500);await delay(100);assert.equal(await evaluate("Number(document.querySelector('.timeline').value)"),4500);report.checks.push('Seek, step and rate remain responsive while force preparation holds playback');
 }
 await wait("!document.querySelector('.force-progress') && document.querySelectorAll('.force-readout svg').length==="+(process.env.RDV_FAILURE?3:4),240000);report.preparationMs=Date.now()-started;
 const state=await evaluate("({notice:document.querySelector('.inline-error')?.textContent,panels:[...document.querySelectorAll('.force-readout')].map(r=>({frame:r.dataset.forceFrame,text:r.textContent})),workers:window.__forceWorkers,posts:window.__forcePosts.length})");console.log(JSON.stringify(state));
 assert.equal(state.posts,prepared?0:process.env.RDV_FAILURE?3:4,'Every sensor must use a complete track');assert.equal(state.workers,workers,'Inference worker must be released');assert.equal(state.panels.filter(p=>p.frame===String(process.env.RDV_PREP_CONTROLS?9:0)).length,process.env.RDV_FAILURE?3:4);
 if(prepared)assert.ok(await evaluate("!performance.getEntriesByType('resource').some(r=>r.name.includes('force-runtime'))"));
 await writeFile(join(output,'browser-tracks.rdv-force.json'),JSON.stringify({format:'robot-data-viewer-force',version:1,tracks:await evaluate('window.__forcePosts')}));
 assert.equal(await evaluate("Number(document.querySelector('.timeline').value)"),process.env.RDV_PREP_CONTROLS?4500:0,'Preparation must remain paused');
 await evaluate("document.querySelector('.force-toolbar').scrollIntoView({block:'start'});");await screenshot('force-normal-en');await click('[data-channel=l_tact_l] .icon-button');await click('.language-button');await screenshot('force-expanded-zh');await click('.expanded-close');await click('.language-button');
 await evaluate(`{const s=document.querySelector('.timeline');s.value=${Number(process.env.RDV_SEEK_MS||60)};s.dispatchEvent(new Event('input',{bubbles:true}));}`);await wait(ready,30000);
 assert.ok(await evaluate("[...document.querySelectorAll('.tactile-card')].every(c=>!c.querySelector('.force-readout svg') || Number(c.querySelector('.force-readout').dataset.forceTime)<=Number(c.querySelector('.difference-cell canvas').dataset.presentedTime)+.000001)"));
 const before=await evaluate("[...document.querySelectorAll('.force-values')].map(x=>x.textContent)");await evaluate("{const s=document.querySelector('.tactile-card input[type=range]');s.value=16;s.dispatchEvent(new Event('input',{bubbles:true}));}");await delay(200);assert.deepEqual(await evaluate("[...document.querySelectorAll('.force-values')].map(x=>x.textContent)"),before);
 await click('.play-button');await delay(400);assert.ok(await evaluate("Number(document.querySelector('.timeline').value)>60"));
 await click('.force-toolbar input[type=checkbox]');await delay(50);await click('.force-toolbar input[type=checkbox]');await wait("!document.querySelector('.force-progress')",15000);assert.equal(await evaluate('window.__forcePosts.length'),state.posts,'Cached return must perform no new inference');
 if(process.env.RDV_STORAGE_FAILURE){
  assert.ok(await evaluate("document.body.innerText.includes('could not be saved')"),'Unsaved result must have an explicit warning');
  assert.equal(await evaluate("document.querySelectorAll('.force-readout svg').length"),4);
  report.checks.push('Quota failure preserves playback and visibly reports that results were not saved');
 }
 if(process.env.RDV_PERSISTENCE){
  const reopen=async()=>{
   await cdp('Page.reload',{ignoreCache:true});await wait("!!document.querySelector('.open-main')");
   const doc=await cdp('DOM.getDocument'),node=await cdp('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'input[webkitdirectory]'});
   await cdp('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[folder]});await wait(ready,45000);
   assert.equal(await evaluate('window.__forcePosts.length'),0);
   const start=Date.now();await click('.force-toolbar input[type=checkbox]');
   await wait("!document.querySelector('.force-progress') && document.querySelectorAll('.force-readout svg').length===4",120000);
   return Date.now()-start;
  };
  report.savedReloadMs=await reopen();
  assert.equal(await evaluate('window.__forcePosts.length'),0,'Reopening must perform no inference');
  assert.ok(await evaluate("!performance.getEntriesByType('resource').some(r=>r.name.includes('force-runtime'))"),'Cached reopen must not load model assets');
  assert.ok(await evaluate("document.querySelector('.force-ready').textContent.includes('4/4')"));
  await evaluate(`new Promise((resolve,reject)=>{
   const open=indexedDB.open('robot-data-viewer-force',1);open.onerror=()=>reject(open.error);
   open.onsuccess=()=>{const db=open.result,tx=db.transaction('tracks','readwrite'),store=tx.objectStore('tracks'),read=store.openCursor();
    read.onsuccess=()=>{const cursor=read.result;if(!cursor){reject(new Error('No persisted track'));return;}cursor.update({...cursor.value,body:'corrupt'});};
    tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);
   };
  })`);
  report.corruptReloadMs=await reopen();
  assert.equal(await evaluate('window.__forcePosts.length'),1,'Only the corrupt sensor should be recalculated');
  report.checks.push('Reload reuses all four persisted tracks without loading model assets; corrupt saved sensor alone is repaired');
 }
 assert.equal(requests.length,0);assert.equal(errors.length,0,JSON.stringify(errors));report.checks.push('Opt-in only; full preparation pauses clock; complete successful tracks; source-frame values; settings independent; cache; workers released; offline; expanded Chinese');
}catch(error){report.failure=String(error.stack||error);await screenshot('failure').catch(()=>{});throw error;}
finally{clearInterval(memoryTimer);report.peakBrowserRssMiB=peakRssKiB/1024;report.hostAfter=await host();await writeFile(join(output,'results.json'),JSON.stringify(report,null,2));await cdp('Browser.close',{},true).catch(()=>{});await delay(500);if(chrome.exitCode===null)chrome.kill('SIGKILL');await rm(profile,{recursive:true,force:true}).catch(()=>{});}
