// Exercise lifecycle UI with real browser cameras and a deliberately stalled force worker.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: Object.fromEntries(['url','file','fixture','output','archive-sha256'].map(k=>[k,{type:'string'}])) });
const executable = process.env.ROBOT_VIEWER_CHROME || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/google/chrome/chrome');
const profile = await mkdtemp(join(tmpdir(), 'rdv-lifecycle-'));
const chrome = spawn(executable, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--use-fake-device-for-media-stream','--disable-background-networking','--no-first-run','--remote-debugging-pipe',`--user-data-dir=${profile}`,'about:blank'], {stdio:['ignore','ignore','pipe','pipe','pipe']});
const pending = new Map(), errors = [], checks = [];
let counter=0, buffer='', stderr='', passed=false;
chrome.stderr.on('data', data=>{stderr=(stderr+data).slice(-4000);});
chrome.on('error', error=>{for(const p of pending.values())p.reject(error);});
chrome.stdio[4].on('data', chunk=>{
  buffer+=chunk;let end;
  while((end=buffer.indexOf('\0'))>=0){
    const raw=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!raw)continue;
    const message=JSON.parse(raw),call=pending.get(message.id);
    if(call){clearTimeout(call.timer);pending.delete(message.id);message.error?call.reject(new Error(JSON.stringify(message.error))):call.resolve(message.result);}
    else if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails);
  }
});
const cdp=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
  const id=++counter,timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timed out: '+stderr));},30000);
  pending.set(id,{resolve,reject,timer});chrome.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');
});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function page(url, initialize=''){
  const {targetId}=await cdp('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await cdp('Target.attachToTarget',{targetId,flatten:true});
  const send=(method,params)=>cdp(method,params,sessionId);
  const evaluate=async expression=>{
    const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;
  };
  const wait=async expression=>{
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){if(await evaluate(expression))return;await delay(100);}
    throw new Error(expression+' timed out: '+await evaluate('document.body.innerText'));
  };
  await send('Page.enable');await send('Runtime.enable');
  if(initialize)await send('Page.addScriptToEvaluateOnNewDocument',{source:initialize});
  await send('Page.navigate',{url});await wait("!!document.querySelector('.mode-switch')");
  return {send,evaluate,wait,click:selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`),close:()=>cdp('Target.closeTarget',{targetId})};
}
const fakeForce=String.raw`
  const originalFetch=window.fetch;window.fetch=(input,options)=>String(input)==='/api/v1/jobs'&&options?.method==='POST'?Promise.resolve(new Response('{}',{status:500})):originalFetch(input,options);
  window.__forceWorkers=0;window.__confirmCount=0;window.__acceptExit=false;
  window.confirm=()=>{window.__confirmCount++;return window.__acceptExit;};
  const NativeWorker=window.Worker;
  window.Worker=class extends NativeWorker {
    postMessage(value,...args){if(value?.type==='init'&&value.assets){this.__force=true;window.__forceWorkers++;}return super.postMessage(value,...args);}
    terminate(){if(this.__force){window.__forceWorkers--;this.__force=false;}return super.terminate();}
  };
  const append=Node.prototype.appendChild;
  Node.prototype.appendChild=function(node){
    if(node.tagName==='SCRIPT'&&node.src.endsWith('/force-runtime.js')){
      window.RDV_FORCE_ASSETS={worker:"onmessage=({data})=>{if(data.type==='init')postMessage({id:data.id,result:{backend:'wasm'}});else if(data.type==='calculate')setInterval(()=>postMessage({progress:{sensor:data.sensor,frame:0,frames:data.expectedFrames,stage:'calculating'}}),500);}"};
      queueMicrotask(()=>node.onload());return node;
    }return append.call(this,node);
  };
`;
try{
  await cdp('Browser.grantPermissions',{permissions:['videoCapture']});
  const one=await page(values.url),two=await page(values.url),portOnly=await page(new URL(values.url).origin);
  await one.wait("!!document.querySelector('.service-bar button')");
  await portOnly.wait("!!document.querySelector('.service-bar')");
  assert.equal(await portOnly.evaluate("!!document.querySelector('.service-bar button')"),false);
  await one.close();await two.send('Page.reload');await two.wait("!!document.querySelector('.service-bar button')");
  checks.push('Closing one tab and reloading another leave the service running; port-only tabs cannot shut it down');
  for(const p of [two,portOnly]){
    await p.click('.mode-switch button:nth-child(2)');await p.click('.live-actions .primary');
    await p.wait("!!document.querySelector('[data-status=streaming] video')?.videoWidth");
    await p.evaluate("window.__track=document.querySelector('[data-status=streaming] video').srcObject.getVideoTracks()[0]");
  }
  const file=await page(pathToFileURL(values.file).href);
  assert.equal(await file.evaluate("!!document.querySelector('.service-bar')"),false);
  const force=await page(values.url,fakeForce);
  const {root}=await force.send('DOM.getDocument');
  const {nodeId}=await force.send('DOM.querySelector',{nodeId:root.nodeId,selector:'input[accept]'});
  await force.send('DOM.setFileInputFiles',{nodeId,files:[values.fixture]});
  await force.wait("!!document.querySelector('.force-controls input[type=checkbox]') || !!document.querySelector('input[aria-label=\"Show estimated force\"]')");
  await force.click('input[aria-label="Show estimated force"]');
  await force.wait("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Retry with browser'))");
  await force.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Retry with browser')).click()");
  await force.wait('window.__forceWorkers===1');
  await force.click('.service-bar button');
  await force.wait('window.__confirmCount===1');
  assert.equal(await force.evaluate("!!document.querySelector('.service-ended')"),false);
  assert.equal(await force.evaluate('window.__forceWorkers'),1);
  await force.evaluate('window.__acceptExit=true');await force.click('.service-bar button');
  for(const p of [force,two,portOnly])await p.wait("!!document.querySelector('.service-ended')");
  assert.equal(await force.evaluate('window.__forceWorkers'),0);
  for(const p of [two,portOnly])assert.equal(await p.evaluate('window.__track.readyState'),'ended');
  assert.equal(await file.evaluate("!!document.querySelector('.mode-switch') && !document.querySelector('.service-ended')"),true);
  checks.push('Active browser force preparation requires confirmation; declining preserves work, accepting terminates its worker');
  checks.push('Other authenticated and port-only tabs release real camera tracks after service shutdown');
  checks.push('HTML-only viewing remains usable and has no service controls');
  assert.deepEqual(errors,[]);passed=true;
}finally{
  await mkdir(dirname(values.output),{recursive:true});
  const report={passed,archiveSha256:values['archive-sha256'],checks,errors};
  await writeFile(values.output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  for(const p of pending.values())clearTimeout(p.timer);
  const exited=new Promise(resolve=>chrome.once('exit',resolve));
  if(chrome.exitCode===null){chrome.kill();await Promise.race([exited,delay(3000)]);}
  await rm(profile,{recursive:true,force:true}).catch(()=>{});
}
