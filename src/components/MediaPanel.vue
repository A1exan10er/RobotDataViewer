<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Maximize2, AlertCircle, SlidersHorizontal } from 'lucide-vue-next';
import type { Media, Timing } from '../types';
import type { Playback } from '../playback';
import type { ChannelState } from '../synchronizedChannel';
import { channelName, t } from '../i18n';
import type { TactileBaseline } from '../tactileFilter';
import { tactileCache, calibrationKey } from '../tactileCache';
import { collectNativeBaseline } from '../tactileCalibration';
import { playbackMark } from '../playbackMetrics';
import { RenderOrder } from '../renderOrder';
import { TactileRenderer, type TactileImage } from '../tactile';
import { NativeTransport, SoftwareTransport, sequentialTactile, closeFrame, type Transport, type DecodedFrame } from '../transport';

const props = defineProps<{ media: Media; url?: string; blob?: Blob; timing: Timing; playback: Playback }>();
defineEmits<{ expand: [] }>();
const video=ref<HTMLVideoElement|null>(null),canvas=ref<HTMLCanvasElement|null>(null),surface=ref<HTMLCanvasElement|null>(null);
const query=new URLSearchParams(location.search);
const software=ref(query.has('software')||(props.media.kind==='tactile'&&sequentialTactile(props.media.codec||'')&&!query.has('nativeTactile'))),opening=ref(true),aspect=ref('16 / 9'),state=ref<ChannelState>('preparing');
const readyGeneration=ref(-1);
const failed=ref(!props.url||props.media.failed),referenceError=ref(false),ready=ref(false),gain=ref(10),cleanup=ref(true),regionMissing=ref(false);
let transport:Transport|null=null,currentFrame:DecodedFrame|null=null,reference:TactileBaseline|null=null;
let touchRenderer:TactileRenderer|null=null;
let settingsPending=false,settingsRequested=false,calibrationAbort:AbortController|null=null;
const renderOrder=new RenderOrder();
let animationFrame=0,lastDraw=0,lastTime=-1,disposed=false,firstCamera=false;
const tactile=props.media.kind==='tactile';
const channel=props.playback.channel(props.media.id);
let openingTimer:ReturnType<typeof setTimeout>|undefined;
let settingsRevision=0,stagePending=false;
let stageRequest:{generation:number;settingsRevision:number}|null=null;
const pixelMode=()=>typeof OffscreenCanvas==='undefined'||typeof createImageBitmap!=='function';
const showAll=computed({get:()=>!cleanup.value,set:(value:boolean)=>{cleanup.value=!value;}});
const outside=computed(()=>{const ep=props.timing.episode,media=props.timing.media;return props.playback.time.value<ep[0]||props.playback.time.value>=ep.at(-1)!+(props.media.duration-media.at(-1)!)*1000;});
const mark=(event:string,detail?:unknown)=>playbackMark(event,props.media.id,detail);
function painted(sourceTime=video.value?.currentTime??0,generation=props.playback.generation.value,staged=false){
  renderOrder.didPaint();if(staged)channel.acknowledge(generation,sourceTime);
  if(canvas.value){canvas.value.dataset.presentedTime=String(sourceTime);canvas.value.dataset.generation=String(generation);}
  mark('tactile-paint',{generation,sourceTime,settingsRevision,staged,gain:gain.value,cleanup:cleanup.value});
  if(!ready.value){ready.value=true;mark('tactile-first-frame');}
}
function paint(image:TactileImage,sourceTime=video.value?.currentTime??0,generation=props.playback.generation.value,staged=false){
  if(disposed||!['frame','ready'].includes(state.value)||!canvas.value)return;
  const context=canvas.value.getContext('2d')!;
  if(image instanceof ImageData)context.putImageData(image,0,0);else context.drawImage(image,0,0);
  painted(sourceTime,generation,staged);
}
function channelState(value:ChannelState){state.value=value;readyGeneration.value=value==='ready'?channel.generation:-1;if(value==='ready')mark('channel-ready',{generation:channel.generation});}
function stageFrame(generation:number){
  if(disposed)return;
  if(!tactile){channel.acknowledge(generation,transport?.currentTime??0);return;}
  if(software.value){drawSoftwareDifference();return;}
  stageRequest={generation,settingsRevision};renderStagedFrame();
}
function renderStagedFrame(){
  if(stagePending||!stageRequest||disposed||!touchRenderer||!video.value)return;
  const request=stageRequest;stageRequest=null;
  if(request.generation!==props.playback.generation.value||request.settingsRevision!==settingsRevision)return;
  const ticket=renderOrder.capture(),sourceTime=video.value.currentTime;
  const accepts=()=>!disposed&&state.value==='frame'&&renderOrder.accepts(ticket)&&request.generation===props.playback.generation.value&&request.settingsRevision===settingsRevision;
  stagePending=true;
  void touchRenderer.render(video.value,gain.value,cleanup.value).then(image=>{
    if(!image)return;
    try{if(accepts())paint(image,sourceTime,request.generation,true);}finally{image.close();}
  }).catch(()=>{if(accepts())rendererFailed();}).finally(()=>{stagePending=false;renderStagedFrame();});
}
function automaticPaint(image:TactileImage,sourceTime?:number){
  if(props.playback.revealed.value&&state.value==='ready')paint(image,sourceTime);
}
function preparationFailed(){
  if(disposed)return;
  stageRequest=null;state.value='failure';if(!regionMissing.value)referenceError.value=true;
  renderOrder.invalidate();calibrationAbort?.abort();touchRenderer?.dispose();
  touchRenderer=null;currentFrame=null;reference=null;opening.value=false;
}
function rendererFailed(){props.playback.preparationFailed(channel);}
function decoderFailed(error?:unknown){if(disposed)return;if(!tactile)failed.value=true;opening.value=false;props.playback.preparationFailed(channel);if(error)console.warn('Video decoder:',error);}
function draw(){
  if(!tactile||disposed||state.value!=='ready'||!props.playback.revealed.value)return;
  try{if(software.value)drawSoftwareDifference();else if(touchRenderer&&video.value)touchRenderer.update(video.value,gain.value,cleanup.value);}catch{rendererFailed();}
}
function callback(now:number){
  if(disposed)return;
  if(!software.value&&state.value==='ready'&&video.value&&video.value.currentTime!==lastTime&&now-lastDraw>=1000/Math.min(30,props.media.fps||30)-2){draw();lastDraw=now;lastTime=video.value.currentTime;}
  animationFrame=requestAnimationFrame(callback);
}
async function useModel(model:TactileBaseline,signal:AbortSignal){
  signal.throwIfAborted();
  reference=model;regionMissing.value=model.roiStatus==='not-found';aspect.value=`${model.width} / ${model.height}`;
  await nextTick();if(disposed||signal.aborted)return;
  if(canvas.value){canvas.value.width=model.width;canvas.value.height=model.height;const context=canvas.value.getContext('2d')!;context.fillStyle='#000';context.fillRect(0,0,model.width,model.height);}
  if(regionMissing.value){ready.value=true;props.playback.preparationFailed(channel);}
}
async function loaded(){
  if(!video.value||disposed||software.value)return;
  clearTimeout(openingTimer);opening.value=false;
  if(!tactile){if(!firstCamera){firstCamera=true;mark('camera-first-frame');}props.playback.prepared(channel);return;}
  if(calibrationAbort||!transport)return;
  const abort=new AbortController();calibrationAbort=abort;
  const key=calibrationKey(pixelMode()?'native-rgba':'native-bitmap',props.media.fps,props.timing.media.length);
  mark('calibration-queued');
  try{
    await props.playback.prepareTactile(async()=>{
      // Allocate calibration resources only when this job has a slot.
      const renderer=new TactileRenderer(automaticPaint,rendererFailed,pixelMode());touchRenderer=renderer;
      abort.signal.addEventListener('abort',()=>renderer.dispose(),{once:true});
      const cached=props.blob&&tactileCache.get(props.blob,key);
      mark(cached?'calibration-cache-hit':'calibration-start');
      const timer=setTimeout(()=>abort.abort(new Error('Baseline preparation timed out')),30000);
      try{
        let model:TactileBaseline;
        if(cached){await renderer.reference(cached);model=cached;}
        else{
          await collectNativeBaseline(props.url!,props.timing.media,props.media.duration,props.media.fps,async source=>{await renderer.sample(source);},abort.signal);
          model=await renderer.calibrated();abort.signal.throwIfAborted();
          if(props.blob)tactileCache.put(props.blob,key,model);
        }
        abort.signal.throwIfAborted();mark('calibration-complete',{cached:!!cached});await useModel(model,abort.signal);
      }finally{clearTimeout(timer);}
    },abort.signal);
    abort.signal.throwIfAborted();if(!disposed&&!regionMissing.value)props.playback.prepared(channel);
  }catch{if(!disposed&&!software.value){props.playback.preparationFailed(channel);touchRenderer?.dispose();touchRenderer=null;}}
}
function paintDifference(frame:DecodedFrame,generation:number,staged:boolean){
  const c=canvas.value;if(!c)return;
  if(c.width!==frame.width||c.height!==frame.height){c.width=frame.width;c.height=frame.height;}
  const ctx=c.getContext('2d')!;
  if(frame.differenceImage?.width)ctx.drawImage(frame.differenceImage,0,0);
  else if(frame.difference)ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.difference),frame.width,frame.height),0,0);
  else throw new Error('No tactile response frame');
  painted(frame.time,generation,staged);
}
function drawSoftwareDifference(){
  try{
    const frame=currentFrame,player=transport;
    if(!frame||!canvas.value||!['frame','ready'].includes(state.value))return;
    if(frame.gain===gain.value&&frame.cleanup===cleanup.value){paintDifference(frame,props.playback.generation.value,state.value==='frame');return;}
    if(!(player instanceof SoftwareTransport)||!frame.gray)return;
    if(settingsPending){settingsRequested=true;return;}
    settingsPending=true;settingsRequested=false;
    const ticket=renderOrder.capture(),frameGain=gain.value,frameCleanup=cleanup.value,frameGeneration=props.playback.generation.value,frameSettings=settingsRevision;
    void player.redraw(frame,frameGain,frameCleanup).then(rendered=>{
      try{if(!disposed&&renderOrder.accepts(ticket)&&frameSettings===settingsRevision&&frameGeneration===props.playback.generation.value)paintDifference(rendered,frameGeneration,state.value==='frame');}
      finally{closeFrame(rendered);}
    }).catch(()=>{if(!disposed&&renderOrder.accepts(ticket))rendererFailed();}).finally(()=>{settingsPending=false;if(settingsRequested&&!disposed)drawSoftwareDifference();});
  }catch{rendererFailed();}
}
function decoded(frame:DecodedFrame){
  if(disposed)return;
  currentFrame=frame;if(frame.reference)reference=frame.reference;
  aspect.value=`${frame.width} / ${frame.height}`;
  opening.value=false;
  if(tactile){drawSoftwareDifference();return;}
  const c=surface.value;if(!c)return;if(c.width!==frame.width||c.height!==frame.height){c.width=frame.width;c.height=frame.height;}
  // Transfer the decoded source without an extra per-frame canvas copy. Paused
  // settings redraws capture this surface, so the queue need not own its bitmap.
  const bitmapContext=frame.image?c.getContext('bitmaprenderer'):null;
  if(frame.image&&bitmapContext)bitmapContext.transferFromImageBitmap(frame.image);
  else if(frame.image)c.getContext('2d')!.drawImage(frame.image,0,0);
  else if(frame.pixels)c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels),frame.width,frame.height),0,0);
  c.dataset.presentedTime=String(frame.time);opening.value=false;
  if(!firstCamera){firstCamera=true;mark('camera-first-frame');}
}
function fallback(initial=false){
  if(disposed||(software.value&&!initial)||props.media.failed||state.value==='failure')return;
  clearTimeout(openingTimer);renderOrder.invalidate();
  if(!initial)props.playback.replace(channel);
  calibrationAbort?.abort();transport?.dispose();touchRenderer?.dispose();touchRenderer=null;reference=null;ready.value=false;referenceError.value=false;regionMissing.value=false;software.value=true;opening.value=true;failed.value=false;
  state.value='preparing';
  if(!props.blob){failed.value=true;opening.value=false;props.playback.preparationFailed(channel);return;}
  const abort=new AbortController();calibrationAbort=abort;
  const start=async()=>{
    abort.signal.throwIfAborted();
    const key=calibrationKey('libav-rgba',props.media.fps,props.timing.media.length),cached=tactile?tactileCache.get(props.blob!,key):undefined;
    if(tactile)mark(cached?'calibration-cache-hit':'calibration-start');
    const player=new SoftwareTransport(props.blob!,props.timing.media,props.media.fps,decoded,decoderFailed,tactile,cached,metrics=>mark('decoder-metrics',metrics));transport=player;
    abort.signal.addEventListener('abort',()=>player.dispose(),{once:true});
    player.setGain(gain.value);player.setCleanup(cleanup.value);
    props.playback.register(channel,player);
    await player.initialized;abort.signal.throwIfAborted();
    if(!tactile)props.playback.prepared(channel);
    if(tactile){const model=player.reference!;if(!cached)tactileCache.put(props.blob!,key,model);mark('calibration-complete',{cached:!!cached});await useModel(model,abort.signal);if(!regionMissing.value&&!abort.signal.aborted)props.playback.prepared(channel);}
  };
  if(tactile)mark('calibration-queued');
  void (tactile?props.playback.prepareTactile(start,abort.signal):start()).catch(error=>{if(!disposed&&!abort.signal.aborted)decoderFailed(error);});
}
onMounted(()=>{
  props.playback.bind(channel,tactile?preparationFailed:decoderFailed,channelState,stageFrame);
  if(failed.value){opening.value=false;props.playback.preparationFailed(channel);return;}
  if(software.value){fallback(true);return;}
  const v=video.value;if(!v){props.playback.preparationFailed(channel);return;}
  openingTimer=setTimeout(()=>{if(!disposed&&opening.value)decoderFailed(new Error('Video opening timed out'));},30000);
  if(tactile)animationFrame=requestAnimationFrame(callback);
  if(new URLSearchParams(location.search).has('software')||(props.media.codec&&!v.canPlayType('video/mp4; codecs="'+props.media.codec+'"'))){fallback();return;}
  transport=new NativeTransport(v);props.playback.register(channel,transport);
  if(v.error)fallback();else if(v.readyState>=2)void loaded();
});
watch([gain,cleanup],()=>{settingsRevision++;renderOrder.invalidate();props.playback.redraw();if(transport instanceof SoftwareTransport){transport.setGain(gain.value);transport.setCleanup(cleanup.value);}draw();});
watch(()=>props.playback.generation.value,()=>{stageRequest=null;renderOrder.invalidate();touchRenderer?.suspend();if(software.value)currentFrame=null;},{flush:'sync'});
watch(()=>props.playback.revealed.value,value=>{if(value)draw();});
onBeforeUnmount(()=>{
  disposed=true;stageRequest=null;clearTimeout(openingTimer);renderOrder.invalidate();calibrationAbort?.abort();transport?.dispose();touchRenderer?.dispose();cancelAnimationFrame(animationFrame);props.playback.unregister(channel);
  if(video.value){video.value.pause();video.value.removeAttribute('src');video.value.load();}
  reference=null;currentFrame=null;
});
</script>

<template>
  <article class="media-card" :class="{ 'tactile-card': media.kind === 'tactile', inactive: outside }" :data-channel="media.id" :data-preparation="state" :data-generation="playback.generation.value" :data-ready-generation="readyGeneration" :data-revealed="playback.revealed.value" :data-mode="software ? 'software' : 'native'">
    <header class="panel-heading"><span><i class="channel-dot" :class="media.id.startsWith('r_') ? 'right' : media.id.startsWith('l_') ? 'left' : ''"></i>{{ channelName(media.id) }}</span><button class="icon-button" :title="t('expand')" :aria-label="t('expand') + ': ' + channelName(media.id)" @click="$emit('expand')"><Maximize2 :size="15" /></button></header>
    <div class="media-images" :style="media.kind === 'tactile' ? { '--response-aspect': aspect } : undefined">
      <div class="image-cell" :class="{ 'tactile-source': media.kind === 'tactile' }" :aria-hidden="media.kind === 'tactile' ? true : undefined">
        <video v-if="url && !software && !media.failed" ref="video" :src="url" muted playsinline preload="auto" @loadeddata="loaded" @seeked="draw" @timeupdate="draw" @error="fallback()" :aria-label="channelName(media.id)"></video>
        <canvas ref="surface" v-show="software" class="software-video" :aria-label="channelName(media.id)"></canvas>
        <div v-if="!tactile && !playback.revealed.value && !failed" class="media-message joint-preparation"><span>{{ t(state==='ready' ? 'waitingTogether' : 'preparingTogether') }}</span></div>
        <div v-if="failed" class="media-message"><AlertCircle :size="20" /><span>{{ t(url ? 'failed' : 'missingMedia') }}</span></div>
      </div>
      <div v-if="media.kind === 'tactile'" class="image-cell difference-cell">
        <canvas ref="canvas" :aria-label="t('difference')"></canvas>
        <div v-if="failed" class="media-message"><AlertCircle :size="20" /><span>{{ t(url ? 'failed' : 'missingMedia') }}</span></div>
        <div v-else-if="referenceError || (!regionMissing && (!ready || !playback.revealed.value))" class="media-message joint-preparation"><span>{{ t(referenceError ? 'referenceFailed' : state === 'preparing' ? 'referenceLoading' : state === 'ready' ? 'waitingTogether' : 'referenceJoining') }}</span></div>
        <div v-else-if="regionMissing" class="media-message region-missing" role="status"><span>{{ t('regionMissing') }}</span></div>
      </div>
      <span v-if="outside && !failed" class="interval-label">{{ t('outside') }}</span>
    </div>
    <footer v-if="media.kind === 'tactile'" class="tactile-footer">
      <span class="response-legend" :title="t('responseLegend')"><span>{{ t('weak') }}</span><i aria-hidden="true"></i><span>{{ t('strong') }}</span></span>
      <details class="gain-popover"><summary :title="t('tactileSettings')"><SlidersHorizontal :size="14" /><span>{{ gain }}×</span></summary><div><label class="cleanup-setting"><span>{{ t('showAll') }}</span><input type="checkbox" v-model="showAll" :aria-label="t('showAll')" /></label><p class="cleanup-hint">{{ t('cleanupHint') }}</p><label>{{ t('gain') }} <b>{{ gain }}×</b><input type="range" min="1" max="16" step="1" v-model.number="gain" :aria-label="t('gain')" /></label><p class="cleanup-hint">{{ t('reference') }}</p></div></details>
    </footer>
  </article>
</template>
