// Pointer/keyboard acceptance in owned, temporary browsers. No application event
// dispatch or input-value assignment is used to operate the camera controls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root=resolve(import.meta.dirname,'..'), firefox=process.argv.includes('--firefox'), hardware=process.argv.includes('--hardware');
const tactileHeight=hardware?Number(process.env.ROBOT_VIEWER_TACTILE_HEIGHT || 360):360;
const output=join(root,'artifacts/camera-controls',`${firefox?'firefox':'chrome'}${hardware?'-hardware':''}`);
await mkdir(output,{recursive:true});
const profiles=join(root,'artifacts/firefox-profiles');await mkdir(profiles,{recursive:true});
const profile=await mkdtemp(join(profiles,'camera-controls-'));
const web=process.env.ROBOT_VIEWER_WEB || join(root,hardware?'dist':'artifacts/live-camera-web');
const server=createServer(async(req,res)=>{
  const name=req.url==='/'?(hardware?'viewer.html':'index.html'):req.url.slice(1).split('?')[0];
  if(!['index.html','viewer.html','simulation.js','baseline.rgba','force-runtime.js'].includes(name)){res.writeHead(404).end();return;}
  try{const data=await readFile(join(web,name));res.setHeader('Content-Type',name.endsWith('.html')?'text/html':name.endsWith('.js')?'text/javascript':'application/octet-stream');res.end(data);}catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=process.env.ROBOT_VIEWER_URL || `http://127.0.0.1:${server.address().port}/`;
let child,session,logs='',evaluate,click,type,press,navigate,resize,screenshot,close;
const report={checks:[],hardware,...(hardware?{tactileHeight}: {})},delay=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async(expr,timeout=30000)=>{const start=Date.now();while(Date.now()-start<timeout){if(await evaluate(expr))return;await delay(100);}throw new Error('Timed out: '+expr);};
const check=message=>{report.checks.push(message);console.log(message);};
const card=i=>`.live-card:nth-child(${i+1})`;
const radio=(i,role)=>`${card(i)} input[type=radio][value=${role}]`;
const value=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).value`);
const status=i=>evaluate(`({...document.querySelector(${JSON.stringify(card(i))}).dataset})`);
const stats=()=>evaluate(`document.querySelector('#fixture-stats')?.textContent`);
const openSettings=i=>click(`${card(i)} .live-settings-toggle`);
const setSettings=async(i,width,height,rate)=>{await openSettings(i);for(const [key,text] of Object.entries({width,height,frameRate:rate}))await type(`${card(i)} input[name=${key}]`,String(text));await click(`${card(i)} .live-settings-form button[type=submit]`);};
const rename=async(i,name)=>{await click(`${card(i)} .live-rename`);await type(`${card(i)} .live-name-form input`,name);await press(`${card(i)} .live-name-form input`,'Enter');};
const awaitTactile=async i=>{
  if(hardware&&tactileHeight!==360){
    await wait(`document.querySelector('${card(i)}').dataset.status!=='starting'`);
    if((await status(i)).status==='error'){
      // An explicit test/operator-selected override, never an application fallback.
      report.presetUnavailable=true;await setSettings(i,640,tactileHeight,30);
      await click(`${card(i)} .live-stream-toggle`);
    }
  }
  await wait(`document.querySelector('${card(i)}').dataset.role==='tactile' && document.querySelector('${card(i)} video').videoHeight===${tactileHeight}`);
};
try {
  if(firefox){
    const portServer=createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
    child=spawn(process.env.GECKODRIVER || (process.env.GECKOWEBDRIVER?join(process.env.GECKOWEBDRIVER,'geckodriver'):'/snap/bin/geckodriver'),['--port',String(port),'--profile-root',profile],{stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
    const request=async(method,path,body)=>{const response=await fetch(`http://127.0.0.1:${port}${path}`,{method,body:body===undefined?undefined:JSON.stringify(body),headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(45000)});const data=await response.json();if(!response.ok)throw new Error(JSON.stringify(data));return data.value;};
    for(let i=0;;i++){try{await request('GET','/status');break;}catch(error){if(i>100)throw error;await delay(100);}}
    const created=await request('POST','/session',{capabilities:{alwaysMatch:{browserName:'firefox','moz:firefoxOptions':{args:['-headless'],prefs:{'media.autoplay.default':0,'browser.shell.checkDefaultBrowser':false,...(hardware?{'media.navigator.permission.disabled':true}: {})}}}}});
    session=created.sessionId;report.browser=`Firefox ${created.capabilities.browserVersion}`;
    const command=(path,data,method='POST')=>request(method,`/session/${session}${path}`,data);
    const element=async selector=>(await command('/element',{using:'css selector',value:selector}))['element-6066-11e4-a52e-4f735466cecf'];
    evaluate=expression=>command('/execute/sync',{script:`return (${expression})`,args:[]});
    click=async selector=>command(`/element/${await element(selector)}/click`,{});
    type=async(selector,text)=>{
      const id=await element(selector);await command(`/element/${id}/click`,{});
      // WebDriver clear does not reliably update Vue's model before a render.
      // Replace the selection through real keyboard input, as the Chrome test does.
      await command('/actions',{actions:[{type:'key',id:'keyboard',actions:[
        {type:'keyDown',value:'\uE009'},{type:'keyDown',value:'a'},
        {type:'keyUp',value:'a'},{type:'keyUp',value:'\uE009'},
      ]}]});
      await command(`/element/${id}/value`,{text});
      assert.equal(await value(selector),text);
    };
    press=async(selector,key)=>command(`/element/${await element(selector)}/value`,{text:{Enter:'\uE007',Escape:'\uE00C',ArrowLeft:'\uE012',ArrowRight:'\uE014',' ':' '}[key]});
    navigate=()=>command('/url',{url});resize=(width,height=1050)=>command('/window/rect',{width,height});
    screenshot=async name=>writeFile(join(output,name+'.png'),Buffer.from(await command('/screenshot',undefined,'GET'),'base64'));
    close=()=>command('',undefined,'DELETE');
  } else {
    const executable=process.env.ROBOT_VIEWER_CHROME || (process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/opt/google/chrome/chrome');
    child=spawn(executable,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--disable-background-networking','--disable-background-timer-throttling','--disable-renderer-backgrounding','--remote-debugging-pipe',`--user-data-dir=${profile}`,...(hardware?['--use-fake-ui-for-media-stream']:[]),'about:blank'],{stdio:['ignore','ignore','pipe','pipe','pipe']});
    child.stderr.on('data',b=>logs+=b);let counter=0,buffer='';const pending=new Map();
    child.stdio[4].on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\0'))>=0){const raw=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!raw)continue;const message=JSON.parse(raw),p=pending.get(message.id);if(p){clearTimeout(p.timer);pending.delete(message.id);message.error?p.reject(new Error(JSON.stringify(message.error))):p.resolve(message.result);}}});
    const cdp=(method,params={},global=false)=>new Promise((resolve,reject)=>{const id=++counter,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method));},30000);pending.set(id,{resolve,reject,timer});child.stdio[3].write(JSON.stringify({id,method,params,...(!global&&session?{sessionId:session}:{})})+'\0');});
    report.browser=(await cdp('Browser.getVersion',{},true)).product;
    const target=await cdp('Target.createTarget',{url:'about:blank'},true);session=(await cdp('Target.attachToTarget',{targetId:target.targetId,flatten:true},true)).sessionId;
    await cdp('Page.enable');await cdp('Runtime.enable');
    evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    click=async selector=>{const point=await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);for(const action of ['mousePressed','mouseReleased'])await cdp('Input.dispatchMouseEvent',{type:action,...point,button:'left',clickCount:1});};
    const key=async(name,code,modifiers=0,text)=>{await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:name,windowsVirtualKeyCode:code,modifiers,...(text?{text}:{})});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:name,windowsVirtualKeyCode:code,modifiers});};
    type=async(selector,text)=>{await click(selector);await key('a',65,2);await cdp('Input.insertText',{text});};
    press=async(selector,name)=>{await click(selector);await key(name,{Enter:13,Escape:27,ArrowLeft:37,ArrowRight:39,' ':32}[name],0,name===' '?' ':name==='Enter'?'\r':undefined);};
    navigate=()=>cdp('Page.navigate',{url});resize=(width,height=1050)=>cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    screenshot=async name=>writeFile(join(output,name+'.png'),Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    close=async()=>{for(const p of pending.values())clearTimeout(p.timer);};
  }
  await resize(1400);await navigate();await wait("!!document.querySelector('.mode-switch')");
  if(!hardware)await click('[data-count="1"]');
  await click('.mode-switch button:nth-child(2)');await click('.live-actions .primary');await wait("!!document.querySelector('[data-status=streaming]')");
  if(!hardware){
    for(const n of [2,3,4,7,8]){await click(`[data-count="${n}"]`);await wait(`document.querySelectorAll('[data-status=streaming]').length===${n}`);}
    check('1/2/3/4/7/8 cameras start automatically with identical device labels');
  }
  const tactile=hardware?0:4;
  await click(radio(tactile,'tactile'));await awaitTactile(tactile);
  await click(radio(tactile,'unassigned'));await press(radio(tactile,'unassigned'),'ArrowLeft');
  await awaitTactile(tactile);
  check('Pointer and keyboard select Tactile while streaming');
  await click(`${card(tactile)} .live-calibrate`);await wait(`document.querySelector('${card(tactile)}').dataset.response==='ready'`,45000);
  const beforeRename=await evaluate(`document.querySelector('${card(tactile)} video').currentTime`);
  const openCount=await stats();await rename(tactile,'Left tactile 左触觉');await delay(1000);
  assert.equal((await status(tactile)).response,'ready');assert.ok(await evaluate(`document.querySelector('${card(tactile)} video').currentTime>${beforeRename}`));
  if(!hardware)assert.equal(await stats(),openCount);
  assert.equal(await evaluate(`document.querySelector('${card(tactile)} h2').textContent`),'Left tactile 左触觉');
  check('Rename preserves progressing raw capture, worker reference and device label');
  await click(`${card(tactile)} .live-rename`);await type(`${card(tactile)} .live-name-form input`,'Discarded name');await press(`${card(tactile)} .live-name-form input`,'Escape');
  assert.equal(await evaluate(`document.querySelector('${card(tactile)} h2').textContent`),'Left tactile 左触觉');
  await openSettings(tactile);await type(`${card(tactile)} input[name=width]`,'123');await delay(5500);
  assert.equal(await value(`${card(tactile)} input[name=width]`),'123');await press(`${card(tactile)} input[name=width]`,'Escape');
  assert.equal((await status(tactile)).response,'ready');check('Name/settings cancellation and five-second discovery refresh preserve drafts and calibration');
  if(!hardware){
    await setSettings(tactile,320,180,5);await wait(`document.querySelector('${card(tactile)} video').videoWidth===320`);
    assert.equal((await status(tactile)).response,'idle');await click(`${card(tactile)} .live-calibrate`);
    await wait(`document.querySelector('${card(tactile)}').dataset.response==='ready'`,35000);
    await wait(`document.querySelector('${card(tactile)} .live-response canvas').width===320`);
    check('Custom tactile dimensions invalidate calibration; 60 real observations at 5 Hz exceed ten seconds and succeed');
  }
  const customIndex=0;
  if(hardware){
    if(tactileHeight!==360){await click(radio(0,'scene'));await wait("document.querySelector('.live-card').dataset.status==='streaming'");await click(radio(0,'tactile'));await awaitTactile(0);}
    else{await setSettings(0,640,480,30);await wait("document.querySelector('.live-card video').videoHeight===480");}
  }
  else{await click(radio(0,'scene'));await setSettings(0,320,240,15);await wait("document.querySelector('.live-card video').videoWidth===320");}
  await wait("document.querySelector('.live-card').dataset.status==='streaming'");
  assert.equal((await status(customIndex)).response,'idle');
  assert.ok(await evaluate("document.querySelector('.live-requested').textContent.includes('Custom')"));
  if(!hardware){await delay(9000);assert.ok(!await evaluate("document.querySelector('.live-card').textContent.includes('Low displayed FPS')"));assert.equal((await status(tactile)).response,'ready');}
  check(hardware?'Explicit custom capture settings apply while preserving the tactile role':'Custom dimensions/rate apply to one camera; slow requested rate does not trigger a false warning');
  await setSettings(0,0,240,15);assert.ok(await evaluate("!!document.querySelector('.live-field-error')"));await press('.live-settings-form input','Escape');
  await setSettings(0,123,321,30);await wait("document.querySelector('.live-card').dataset.status==='error'");
  if(!hardware)assert.equal(await evaluate("document.querySelectorAll('[data-status=streaming]').length"),7);
  await openSettings(0);await click('.live-settings-reset');await click('.live-card .live-stream-toggle');
  if(hardware&&tactileHeight!==360)await awaitTactile(0);
  await wait("document.querySelector('.live-card').dataset.status==='streaming'");
  check('Invalid input preserves capture; unsupported settings fail locally and reset/retry recovers');
  if(hardware){await click(radio(0,'tactile'));await awaitTactile(0);}
  else{await setSettings(0,320,240,15);await wait("document.querySelector('.live-card video').videoWidth===320");}
  await click(`${card(tactile)} .live-expand`);await wait("!!document.querySelector('.live-card.expanded')");
  await rename(tactile,'Left tactile 左触觉');await screenshot('expanded');await click('.live-close');
  await click('.language-button');assert.ok(await evaluate("document.body.textContent.includes('采集设置')"));await screenshot('chinese');
  for(const width of [390,900,1600]){await resize(width);assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'overflow at '+width);}
  await resize(1400);await click('.language-button');await screenshot('normal');check('Expanded editing, English/Chinese and narrow/medium/wide layouts');
  if(!hardware){
    await click(`${card(1)} .live-stream-toggle`);await click('[data-count="3"]');await click('[data-count="8"]');await wait("document.querySelectorAll('[data-status=streaming]').length===7");
    assert.equal((await status(1)).status,'stopped');assert.equal((await status(tactile)).response,'idle');
    assert.equal(await evaluate(`document.querySelector('${card(tactile)} h2').textContent`),'Left tactile 左触觉');
    await click('#reverse-devices');await delay(500);check('Hot-plug preserves names/settings and individual stops; reconnect invalidates calibration');
  }
  await click('.mode-switch button:first-child');await click('.mode-switch button:nth-child(2)');await wait("document.querySelectorAll('.live-card').length>0");
  const saved=await evaluate("[...document.querySelectorAll('.live-card')].map(c=>({name:c.querySelector('h2').textContent,role:c.dataset.role,requested:c.querySelector('.live-requested').textContent,status:c.dataset.status}))");
  assert.equal(saved.find(c=>c.name==='Left tactile 左触觉')?.role,'tactile');assert.ok(saved.every(c=>c.status==='stopped'));
  if(!hardware)assert.ok(saved.find(c=>c.requested.includes('320 × 240')&&c.requested.includes('15 Hz')));
  await navigate();await wait("!!document.querySelector('.mode-switch')");await click('.mode-switch button:nth-child(2)');await wait("document.querySelectorAll('.live-card').length>0");
  assert.ok(await evaluate("[...document.querySelectorAll('.live-card h2')].some(h=>h.textContent==='Left tactile 左触觉')"));check('Identity-based preferences survive reordered discovery, mode exit and page reload');
  if(hardware){
    await click('.live-actions .primary');await wait(`document.querySelector('.live-card video').videoHeight===${tactileHeight}`);await click('.live-calibrate');await wait("document.querySelector('.live-card').dataset.response==='ready'",45000);
    if(process.argv.includes('--operator')){
      console.log('UNPLUG_WINDOW_READY: unplug for three seconds, reconnect, and leave the sensor untouched.');
      await wait("!!document.querySelector('[data-status=disconnected]')",180000);report.disconnectionObserved=true;
      await wait("!!document.querySelector('[data-status=streaming]')",180000);
      assert.equal((await status(0)).role,'tactile');assert.equal((await status(0)).response,'idle');
      assert.equal(await evaluate("document.querySelector('.live-card h2').textContent"),'Left tactile 左触觉');
      await click('.live-calibrate');await wait("document.querySelector('.live-card').dataset.response==='ready'",45000);
      check('Physical unplug/replug restores the named tactile camera and invalidates/rebuilds calibration');
    }
    const start=await evaluate("document.querySelector('.live-card video').currentTime");report.samples=[];
    for(let i=0;i<6;i++){await delay(10000);report.samples.push(await evaluate("({width:document.querySelector('.live-card video').videoWidth,height:document.querySelector('.live-card video').videoHeight,metrics:document.querySelector('.live-metrics').textContent,response:document.querySelector('.live-card').dataset.response,warnings:[...document.querySelectorAll('.live-card-warning')].map(w=>w.textContent)})"));console.log('Physical preview',JSON.stringify(report.samples.at(-1)));}
    assert.ok(await evaluate(`document.querySelector('.live-card video').currentTime>${start+50}`));assert.ok(report.samples.every(s=>s.response==='ready'));
    await screenshot('physical-ready');check('Physical camera reopens with saved tactile profile, recalibrates and previews for one minute');
  }
  await click('.live-actions button:nth-child(2)');await wait("document.querySelectorAll('[data-status=streaming]').length===0");
  await writeFile(join(output,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} catch(error){await screenshot?.('failure').catch(()=>{});const state=await evaluate?.("[...document.querySelectorAll('.live-card')].map(c=>({name:c.querySelector('h2').textContent,...c.dataset,metrics:c.querySelector('.live-metrics')?.textContent,warnings:[...c.querySelectorAll('.live-card-warning')].map(w=>w.textContent)}))").catch(()=>null);await writeFile(join(output,'failure.json'),JSON.stringify({checks:report.checks,error:String(error),state,logs:logs.slice(-5000)},null,2));throw error;}
finally{await close?.().catch(()=>{});if(child&&!child.exitCode){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),delay(5000)]);if(child.exitCode===null)child.kill('SIGKILL');}server.closeAllConnections();await new Promise(r=>server.close(r));await rm(profile,{recursive:true,force:true}).catch(()=>{});}
