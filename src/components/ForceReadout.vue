<script setup lang="ts">
import { computed } from 'vue';
import { forceAt, type ForceTrack } from '../forceTracks';
import { t } from '../i18n';
const props=defineProps<{track?:ForceTrack;time:number;available:boolean;failed?:boolean}>();
const sample=computed(()=>props.available?forceAt(props.track,props.time):null);
const maximum=computed(()=>{
  let max=.1;if(props.track)for(let i=0;i<props.track.time.length;i++)if(props.track.valid[i])max=Math.max(max,props.track.fz[i],props.track.shear[i]);
  return max*1.08;
});
const x=(v:number)=>8+(v-(props.track?.time[0]||0))/Math.max(.001,(props.track?.time.at(-1)||0)-(props.track?.time[0]||0))*304;
const y=(v:number)=>64-v/maximum.value*56;
function curve(field:'fz'|'shear'){
  const track=props.track;if(!track)return '';
  const step=Math.max(1,Math.ceil(track.time.length/300));let path='',connected=false;
  for(let i=0;i<track.time.length;i+=step){
    let low=i,high=i,valid=true;
    for(let j=i;j<Math.min(i+step,track.time.length);j++){if(!track.valid[j])valid=false;if(track[field][j]<track[field][low])low=j;if(track[field][j]>track[field][high])high=j;}
    if(!valid){connected=false;continue;}
    for(const index of [low,high].sort((a,b)=>a-b)){path+=`${connected?'L':'M'}${x(track.time[index]).toFixed(2)},${y(track[field][index]).toFixed(2)}`;connected=true;}
  }
  return path;
}
const normalPath=computed(()=>curve('fz')),shearPath=computed(()=>curve('shear'));
</script>
<template>
  <div class="force-readout" :data-force-frame="sample?.frame ?? -1" :data-force-time="sample?.time" :title="t('forceNote')">
    <div class="force-values"><span>{{ t('estimatedForce') }}</span><b class="force-normal">Fz <strong>{{ sample?.fz.toFixed(2) ?? '—' }}</strong> N</b><b class="force-shear">{{ t('shearForce') }} <strong>{{ sample?.shear.toFixed(2) ?? '—' }}</strong> N</b></div>
    <div v-if="track" class="force-chart"><span class="force-scale">{{ maximum.toFixed(1) }} N</span>
    <svg viewBox="0 0 320 74" preserveAspectRatio="none" role="img" :aria-label="t('forceCurve')">
      <path d="M8 64H312" stroke="#36404e"/><path :d="normalPath" class="force-normal"/><path :d="shearPath" class="force-shear"/>
      <line v-if="sample" :x1="x(sample.time)" :x2="x(sample.time)" y1="5" y2="66" stroke="#e4edf6" stroke-dasharray="2 3"/>
    </svg></div>
    <p v-else>{{ t(failed?'forceCalculationFailed':'forceNotPrepared') }}</p>
  </div>
</template>
