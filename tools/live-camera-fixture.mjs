// Build a local-only browser fixture. No simulation hook ships in the viewer.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..'),out=resolve(root,'artifacts/live-camera-web');await mkdir(out,{recursive:true});
const fixture=JSON.parse(await readFile(resolve(root,'tests/fixtures/tactile-roi.json'),'utf8')).cases.find(c=>c.name==='biased-neighbor');
const gray=inflateSync(Buffer.from(fixture.baseline,'base64')),rgba=Buffer.alloc(gray.length*4);
for(let p=0;p<gray.length;p++){rgba[p*4]=rgba[p*4+1]=rgba[p*4+2]=gray[p];rgba[p*4+3]=255;}
await writeFile(resolve(out,'baseline.rgba'),rgba);
await copyFile(resolve(root,'dist/viewer.html'),resolve(out,'viewer.html'));
const simulation=String.raw`
const base=fetch('baseline.rgba').then(r=>r.arrayBuffer());
const events=new EventTarget();let count=8,freeze=false,contact=false,denied=false,missingRegion=false,busy=false,opens=0;
const owned=[];
const devices=()=>Array.from({length:count},(_,i)=>({deviceId:'fixture-'+i,kind:'videoinput',groupId:'usb-'+i,label:'USB Camera'}));
const error=name=>Object.assign(new Error(name),{name});
const adapter={enumerateDevices:async()=>devices(),getSupportedConstraints:()=>({resizeMode:true}),addEventListener:(...a)=>events.addEventListener(...a),removeEventListener:(...a)=>events.removeEventListener(...a),getUserMedia:async constraints=>{
  if(denied)throw error('NotAllowedError');if(!count)throw error('NotFoundError');if(constraints.audio!==false)throw new Error('Unexpected audio request');
  const selected=typeof constraints.video==='object'?constraints.video.deviceId?.exact:'fixture-0';const index=Number(selected.split('-')[1]);
  if(index>=count)throw error('NotFoundError');if(busy&&index===0)throw error('NotReadableError');
  const height=index<4?480:360,width=640,config=constraints.video;
  if(typeof config==='object'&&(config.width?.exact&&config.width.exact!==width||config.height?.exact&&config.height.exact!==height))throw error('OverconstrainedError');
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');
  const pixels=new Uint8ClampedArray(await base);const data=new ImageData(pixels,width,360);let step=0;
  const draw=()=>{
    if(freeze)return;
    if(index>=4){if(missingRegion){ctx.fillStyle='#666';ctx.fillRect(0,0,width,height);}else ctx.putImageData(data,0,0);if(contact){ctx.fillStyle='#e6aa99';ctx.fillRect(275,145,75,65);}}
    else {ctx.fillStyle=['#284152','#354337','#483a30','#35314c'][index];ctx.fillRect(0,0,width,height);ctx.strokeStyle='#a4c5d2';ctx.lineWidth=2;for(let x=0;x<width;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,height);ctx.stroke();}for(let y=0;y<height;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(width,y);ctx.stroke();}ctx.fillStyle='#f5b575';ctx.fillRect(110+(step%140),150,90,100);ctx.fillStyle='#8bd4c2';ctx.beginPath();ctx.arc(450,270,55,0,7);ctx.fill();ctx.fillStyle='#edf5ff';ctx.font='22px sans-serif';ctx.fillText('Simulated camera '+(index+1),20,48);ctx.font='14px sans-serif';ctx.fillText('640 × 480 / 30 Hz',20,75);}
    step++;ctx.fillStyle=step%2?'#889099':'#9098a0';ctx.fillRect(width-2,height-2,2,2);
  };
  draw();const stream=canvas.captureStream(30),track=stream.getVideoTracks()[0],stop=track.stop.bind(track);const clock=setInterval(draw,1000/30);
  track.getSettings=()=>({deviceId:selected,width,height,frameRate:30,resizeMode:'none'});track.stop=()=>{clearInterval(clock);stop();};
  owned.push({index,track});opens++;return stream;
}};
Object.defineProperty(navigator,'mediaDevices',{value:adapter,configurable:true});
window.addEventListener('DOMContentLoaded',()=>{
  const controls=document.getElementById('fixture-controls');
  for(const n of [0,1,4,8]){const button=document.createElement('button');button.textContent=n+' devices';button.onclick=()=>{count=n;for(const item of owned)if(item.index>=n&&item.track.readyState==='live'){item.track.stop();item.track.dispatchEvent(new Event('ended'));}events.dispatchEvent(new Event('devicechange'));};controls.append(button);}
  for(const [name,toggle] of [['Freeze frames',v=>freeze=v],['Contact',v=>contact=v],['Deny permission',v=>denied=v],['Missing region',v=>missingRegion=v],['Busy camera 1',v=>busy=v]]){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.onchange=()=>toggle(input.checked);label.append(input,name);controls.append(label);}
  const stats=document.createElement('output');stats.id='fixture-stats';controls.append(stats);setInterval(()=>{stats.textContent='Active tracks: '+owned.filter(s=>s.track.readyState==='live').length+' · Opens: '+opens;},250);
});
`;
await writeFile(resolve(out,'simulation.js'),simulation);
let html=await readFile(resolve(root,'dist/viewer.html'),'utf8');
html=html.replace('<div id="app">','<div id="fixture-controls" style="position:relative;z-index:120;display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px;background:#272018;color:#f1d4a4;font-size:12px">SIMULATED HARDWARE</div><div id="app">');
html=html.replace('<script>','<script src="simulation.js"></script><script>');await writeFile(resolve(out,'index.html'),html);console.log(out);
