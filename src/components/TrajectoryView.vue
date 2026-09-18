<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Maximize2, RotateCcw } from 'lucide-vue-next';
import type { Trajectory, Vec3 } from '../types';
import { poseAt } from '../math';
import { language, t } from '../i18n';
const props = defineProps<{ trajectories: Trajectory[]; time: number }>();
defineEmits<{ expand: [] }>();
const canvas = ref<HTMLCanvasElement | null>(null);
const readouts = computed(() => props.trajectories.map(tr => ({ ...tr, current: poseAt(tr.points, props.time) })));
const separate = computed(() => props.trajectories.length > 1 && props.trajectories.some(tr => tr.frame !== 'shared'));
let yaw = -.65, pitch = .55, zoom = 1, panX = 0, panY = 0;
let pointer: { x: number; y: number; pan: boolean } | null = null;
let resize: ResizeObserver | null = null;
const colors: Record<string, string> = { left: '#55cbbb', right: '#eeb473', single: '#76a5f8' };
function reset() { yaw = -.65; pitch = .55; zoom = 1; panX = 0; panY = 0; redraw(); }
type View={offset:number;width:number;span:number;project:(p:number[])=>number[];tracks:{tr:Trajectory;points:{t:number;x:number;y:number}[];drawn:number}[]};
let views:View[]=[],background:HTMLCanvasElement|null=null,trails:HTMLCanvasElement|null=null,dirty=true,trailTime=-Infinity;
function redraw(){dirty=true;draw();}
function draw() {
  const c=canvas.value;if(!c)return;
  const w=c.clientWidth,h=c.clientHeight,ratio=window.devicePixelRatio||1;if(!w||!h)return;
  const pixelWidth=Math.round(w*ratio),pixelHeight=Math.round(h*ratio);
  if(c.width!==pixelWidth||c.height!==pixelHeight){c.width=pixelWidth;c.height=pixelHeight;dirty=true;}
  if(dirty||!background||!trails){
    background??=document.createElement('canvas');trails??=document.createElement('canvas');
    background.width=trails.width=pixelWidth;background.height=trails.height=pixelHeight;
    const ctx=background.getContext('2d')!;ctx.setTransform(ratio,0,0,ratio,0,0);
    views=[];trailTime=-Infinity;
    const groups=separate.value?props.trajectories.map(tr=>[tr]):[props.trajectories];
    const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
    groups.forEach((group,gidx)=>{
      const offset=gidx*w/groups.length,width=w/groups.length;
      const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
      for(const tr of group)for(const p of tr.points)for(let i=0;i<3;i++){min[i]=Math.min(min[i],p.p[i]);max[i]=Math.max(max[i],p.p[i]);}
      if(!Number.isFinite(min[0]))return;
      const span=Math.max(.05,...max.map((v,i)=>v-min[i])),center=min.map((v,i)=>(v+max[i])/2);
      const rotated=(p:number[])=>{const x=p[0]-center[0],y=p[1]-center[1],z=p[2]-center[2];return [x*cy-y*sy,z*cp+(x*sy+y*cy)*sp];};
      const corners:number[][]=[];for(const x of [min[0],max[0]])for(const y of [min[1],max[1]])for(const z of [min[2],max[2]])corners.push(rotated([x,y,z]));
      const dx=Math.max(span*.15,Math.max(...corners.map(p=>p[0]))-Math.min(...corners.map(p=>p[0]))),dy=Math.max(span*.15,Math.max(...corners.map(p=>p[1]))-Math.min(...corners.map(p=>p[1])));
      const scale=Math.min(width*.72/dx,h*.64/dy)*zoom;
      const project=(p:number[])=>{const r=rotated(p);return [offset+width*.5+panX+r[0]*scale,h*.5+panY-r[1]*scale];};
      const line=(a:number[],b:number[],color:string)=>{const s=project(a),e=project(b);ctx.strokeStyle=color;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(s[0],s[1]);ctx.lineTo(e[0],e[1]);ctx.stroke();};
      ctx.save();ctx.beginPath();ctx.rect(offset,0,width,h);ctx.clip();
      const floor=min[2]-.08*span;
      for(let i=-5;i<=5;i++){const d=i*span/8;line([center[0]+d,center[1]-span*.625,floor],[center[0]+d,center[1]+span*.625,floor],'#242e38');line([center[0]-span*.625,center[1]+d,floor],[center[0]+span*.625,center[1]+d,floor],'#242e38');}
      const tracks=group.map(tr=>{
        const stride=Math.max(1,Math.ceil(tr.points.length/1800)),points:View['tracks'][number]['points']=[];
        for(let i=0;i<tr.points.length;i+=stride){const p=tr.points[i],xy=project(p.p);points.push({t:p.t,x:xy[0],y:xy[1]});}
        ctx.beginPath();ctx.strokeStyle=colors[tr.side]+'35';ctx.lineWidth=1.5;ctx.lineJoin='round';
        points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();
        return {tr,points,drawn:-1};
      });
      ctx.font='10px system-ui';ctx.fillStyle='#798797';ctx.fillText('X / Y / Z · m',offset+14,h-14);
      if(separate.value){ctx.fillStyle=colors[group[0].side];ctx.font='11px system-ui';ctx.fillText(t(group[0].side),offset+14,22);}
      ctx.restore();if(gidx>0){ctx.strokeStyle='#2b3440';ctx.beginPath();ctx.moveTo(offset,0);ctx.lineTo(offset,h);ctx.stroke();}
      views.push({offset,width,span,project,tracks});
    });
    dirty=false;
  }
  // Static geometry and completed trail segments are reused. Only new segments and the pose move.
  const trail=trails.getContext('2d')!;trail.setTransform(ratio,0,0,ratio,0,0);
  if(props.time<trailTime){trail.clearRect(0,0,w,h);views.forEach(v=>v.tracks.forEach(t=>t.drawn=-1));}
  for(const view of views){
    trail.save();trail.beginPath();trail.rect(view.offset,0,view.width,h);trail.clip();
    for(const track of view.tracks){
      let end=track.drawn;while(end+1<track.points.length&&track.points[end+1].t<=props.time)end++;
      if(end>track.drawn){
        trail.beginPath();trail.strokeStyle=colors[track.tr.side];trail.lineWidth=2.4;trail.lineJoin='round';trail.lineCap='round';
        const start=Math.max(0,track.drawn);for(let i=start;i<=end;i++){const p=track.points[i];if(i===start)trail.moveTo(p.x,p.y);else trail.lineTo(p.x,p.y);}trail.stroke();track.drawn=end;
      }
    }
    trail.restore();
  }
  trailTime=props.time;
  const ctx=c.getContext('2d')!;ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,w,h);
  ctx.drawImage(background,0,0,w,h);ctx.drawImage(trails,0,0,w,h);
  for(const view of views){
    ctx.save();ctx.beginPath();ctx.rect(view.offset,0,view.width,h);ctx.clip();
    for(const {tr} of view.tracks){
      const point=poseAt(tr.points,props.time);if(!point)continue;const p=view.project(point.p);
      ctx.fillStyle=colors[tr.side]+'20';ctx.beginPath();ctx.arc(p[0],p[1],13,0,Math.PI*2);ctx.fill();
      ctx.fillStyle=colors[tr.side];ctx.beginPath();ctx.arc(p[0],p[1],4.5,0,Math.PI*2);ctx.fill();
      point.axes?.forEach((axis,i)=>{const q=view.project(point.p.map((v,j)=>v+axis[j]*view.span*.10));ctx.strokeStyle=['#f27f83','#74cda4','#7aa7ef'][i];ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(p[0],p[1]);ctx.lineTo(q[0],q[1]);ctx.stroke();});
    }
    ctx.restore();
  }
}
function down(event: PointerEvent) { if(event.button!==0 && event.button!==1)return; event.preventDefault();canvas.value?.setPointerCapture(event.pointerId);pointer={x:event.clientX,y:event.clientY,pan:event.shiftKey||event.button===1}; }
function move(event: PointerEvent) { if(!pointer)return;const dx=event.clientX-pointer.x,dy=event.clientY-pointer.y;if(pointer.pan){panX+=dx;panY+=dy;}else{yaw+=dx*.009;pitch=Math.max(-1.3,Math.min(1.3,pitch+dy*.009));}pointer.x=event.clientX;pointer.y=event.clientY;redraw(); }
function wheel(event: WheelEvent) { zoom=Math.max(.2,Math.min(10,zoom*Math.exp(-event.deltaY*.001)));redraw(); }
function key(event: KeyboardEvent) { if(event.key==='+'||event.key==='='){zoom=Math.min(10,zoom*1.1);redraw();}else if(event.key==='-'){zoom=Math.max(.2,zoom/1.1);redraw();}else if(event.key.toLowerCase()==='r')reset(); }
watch(()=>props.time,draw);
watch(()=>[props.trajectories,language.value],redraw);
onMounted(()=>{resize=new ResizeObserver(redraw);if(canvas.value)resize.observe(canvas.value);draw();});
onBeforeUnmount(()=>{resize?.disconnect();background=null;trails=null;views=[];});
</script>
<template>
  <article class="trajectory-card">
    <header class="panel-heading"><span><i class="channel-dot motion-dot"></i>{{ t('trajectory') }} <small>3D</small></span><div class="panel-actions"><button class="icon-button" :aria-label="t('reset')" :title="t('reset')" @click="reset"><RotateCcw :size="15" /></button><button class="icon-button" :aria-label="t('expand') + ': ' + t('trajectory')" :title="t('expand')" @click="$emit('expand')"><Maximize2 :size="15" /></button></div></header>
    <div class="trajectory-stage"><canvas ref="canvas" tabindex="0" role="img" :aria-label="t('trajectory') + '. ' + t('rotate')" @pointerdown="down" @pointermove="move" @pointerup="pointer = null" @pointercancel="pointer = null" @wheel.prevent="wheel" @keydown="key"></canvas><div v-if="!trajectories.length" class="media-message">{{ t('noTrajectory') }}</div><span class="coordinate-label">{{ t(separate ? 'recorded' : trajectories[0]?.frame === 'shared' ? 'shared' : 'recorded') }}</span></div>
    <div class="pose-readouts"><div v-for="tr in readouts" :key="tr.side" class="pose-row"><span class="side-name" :style="{color: colors[tr.side]}">{{ t(tr.side) }}</span><span v-for="(axis,i) in ['X','Y','Z']" :key="axis"><small>{{ axis }}</small> {{ tr.current?.p[i].toFixed(3) ?? '—' }}</span><span class="gripper-readout"><small>{{ t('gripper') }}</small> {{ tr.current?.g != null ? (tr.current.g*1000).toFixed(1) + ' mm' : '—' }}</span></div></div>
    <footer class="trajectory-hint">{{ t('rotate') }}</footer>
  </article>
</template>
