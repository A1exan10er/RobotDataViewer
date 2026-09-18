<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Signal } from '../types';
import { nearestIndex, timeText } from '../math';
import { language, t } from '../i18n';
const props = defineProps<{ signals: Signal[]; time: number; duration: number }>();
const selected = ref(props.signals[0]?.id || '');
const signal = computed(()=>props.signals.find(s=>s.id===selected.value));
function label(s: Signal) {
  const zh=language.value==='zh';
  const [kind,column]=s.id.split('.');
  const group=kind==='eef_pose'?(zh?'位置':'Position'):kind==='gripper'?t('gripper'):kind==='joint_position'?(zh?'关节位置':'Joint position'):kind==='joint_velocity'?(zh?'关节速度':'Joint velocity'):kind.replaceAll('_',' ');
  return `${group} · ${column.replace('left_', t('left')+' ').replace('right_',t('right')+' ').replaceAll('_',' ')}`;
}
const extent=computed(()=>{let min=Infinity,max=-Infinity;for(const v of signal.value?.values||[]){min=Math.min(min,v);max=Math.max(max,v);}if(!Number.isFinite(min))return[0,1];const pad=Math.max((max-min)*.12,.001);return[min-pad,max+pad];});
const x=(v:number)=>48+v/Math.max(1,props.duration)*930;
const y=(v:number)=>132-(v-extent.value[0])/(extent.value[1]-extent.value[0])*110;
const path=computed(()=>{
  const s=signal.value;if(!s)return'';const stride=Math.max(1,Math.floor(s.t.length/900));const points:number[]=[];
  // Keep per-bucket minima and maxima; narrow spikes remain visible in long recordings.
  for(let i=0;i<s.t.length;i+=stride){let low=i,high=i;for(let j=i;j<Math.min(i+stride,s.t.length);j++){if(s.values[j]<s.values[low])low=j;if(s.values[j]>s.values[high])high=j;}points.push(...[low,high].sort((a,b)=>a-b));}
  return points.map((i,k)=>`${k?'L':'M'}${x(s.t[i]).toFixed(2)},${y(s.values[i]).toFixed(2)}`).join(' ');
});
const current=computed(()=>{const s=signal.value;if(!s?.t.length||props.time<s.t[0]||props.time>s.t[s.t.length-1])return null;return s.values[nearestIndex(s.t,props.time)];});
</script>
<template>
  <div class="signal-plot" v-if="signal"><div class="signal-toolbar"><label>{{ t('selectSignal') }}<select v-model="selected"><option v-for="s in signals" :key="s.id" :value="s.id">{{ label(s) }}</option></select></label><span class="signal-value">{{ current?.toFixed(4) ?? '—' }} <small>{{ signal.unit || t('units') }}</small></span></div>
  <svg viewBox="0 0 1000 160" role="img" :aria-label="label(signal)"><g v-for="i in [0,1,2,3,4]" :key="i"><line x1="48" x2="978" :y1="22+i*27.5" :y2="22+i*27.5" stroke="#29333e"/><text x="40" :y="26+i*27.5" text-anchor="end">{{ (extent[1]-(extent[1]-extent[0])*i/4).toFixed(3) }}</text></g><path :d="path" fill="none" stroke="#79a8f5" stroke-width="1.6"/><line :x1="x(time)" :x2="x(time)" y1="15" y2="137" stroke="#dce9ff" stroke-dasharray="3 4"/><circle v-if="current !== null" :cx="x(time)" :cy="y(current)" r="3.5" fill="#dce9ff"/><text x="48" y="154">00:00</text><text x="978" y="154" text-anchor="end">{{ timeText(duration) }}</text></svg></div>
  <p v-else class="empty-signals">{{ t('noSignals') }}</p>
</template>
