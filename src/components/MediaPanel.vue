<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Maximize2, AlertCircle, SlidersHorizontal } from 'lucide-vue-next';
import type { Media, Timing } from '../types';
import type { Playback } from '../playback';
import { channelName, t } from '../i18n';
import { TactileFilter } from '../tactileFilter';
import { TactileRenderer } from '../tactile';
import { NativeTransport, SoftwareTransport, type Transport, type DecodedFrame } from '../transport';

const props = defineProps<{ media: Media; url?: string; blob?: Blob; timing: Timing; playback: Playback }>();
defineEmits<{ expand: [] }>();
const video = ref<HTMLVideoElement | null>(null), canvas = ref<HTMLCanvasElement | null>(null);
const surface = ref<HTMLCanvasElement | null>(null), software = ref(false), opening = ref(true);
const aspect = ref('16 / 9');
let transport:Transport | null=null, currentFrame:DecodedFrame | null=null;
const failed = ref(!props.url || props.media.failed), referenceError = ref(false), ready = ref(false), gain = ref(8), cleanup = ref(true);
let touchRenderer:TactileRenderer|null=null, touchFilter:TactileFilter|null=null;
let settingsRenderer:TactileRenderer|null=null, settingsReady:Promise<unknown>|null=null, settingsPending=false, settingsRequested=false, settingsGeneration=0;
let reference: Uint8ClampedArray | null = null, output: ImageData | null = null;
let buffer: HTMLCanvasElement | null = null, decoder: HTMLVideoElement | null = null;
let animationFrame = 0, lastDraw = 0, lastTime = -1, disposed = false, referenceTimeout = 0;
const showAll = computed({ get: () => !cleanup.value, set: (value: boolean) => { cleanup.value = !value; } });
const outside = computed(() => {
  const ep = props.timing.episode, media = props.timing.media;
  const end = ep[ep.length - 1] + (props.media.duration - media[media.length - 1]) * 1000;
  return props.playback.time.value < ep[0] || props.playback.time.value >= end;
});
function draw() {
  if(software.value){drawSoftwareDifference();return;}
  if(touchRenderer&&video.value){touchRenderer.update(video.value,gain.value,cleanup.value);return;}
  const v = software.value ? surface.value : video.value, c = canvas.value;
  if (!v || !c || !reference || (!software.value && (v as HTMLVideoElement).readyState < 2) || !buffer || disposed) return;
  if ((software.value ? (v as HTMLCanvasElement).width : (v as HTMLVideoElement).videoWidth) !== buffer.width || (software.value ? (v as HTMLCanvasElement).height : (v as HTMLVideoElement).videoHeight) !== buffer.height) { referenceError.value = true; return; }
  try {
    const context = buffer.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(v, 0, 0);
    const pixels = context.getImageData(0, 0, buffer.width, buffer.height);
    if (!output) output = context.createImageData(buffer.width, buffer.height);
    (touchFilter??=new TactileFilter(buffer.width,buffer.height,reference)).render(pixels.data,output.data,gain.value,cleanup.value);
    c.getContext('2d')!.putImageData(output, 0, 0);
  } catch { referenceError.value = true; }
}
function callback(now: number) {
  if (disposed || !video.value) return;
  // Hidden source videos may not receive compositor frame callbacks. Sample the
  // media clock independently; TactilePlayback still bounds work to one request.
  if (!software.value && ready.value && video.value.currentTime !== lastTime && now - lastDraw >= 1000/Math.min(30,props.media.fps || 30)-2) {
    draw(); lastDraw = now; lastTime = video.value.currentTime;
  }
  animationFrame = requestAnimationFrame(callback);
}
async function loaded() {
  const v = video.value;
  if (!v || disposed) return;
  if(software.value)return;opening.value=false;
  if (props.media.kind !== 'tactile' || decoder || ready.value) return;
  // Decode the first frame independently so opening/expanding/seeking never rebases touch.
  const d = document.createElement('video'); decoder = d;
  d.muted = true; d.preload = 'auto'; d.playsInline = true;
  const cleanup = () => { clearTimeout(referenceTimeout); d.pause(); d.removeAttribute('src'); d.load(); if (decoder === d) decoder = null; };
  referenceTimeout = window.setTimeout(() => { referenceError.value = true; cleanup(); }, 10000);
  d.onerror = () => { referenceError.value = true; cleanup(); };
  d.onloadeddata = async () => {
    if (disposed) { cleanup(); return; }
    try {
      if(typeof OffscreenCanvas!=='undefined'&&typeof createImageBitmap==='function'){
        touchRenderer=new TactileRenderer(image=>{if(canvas.value&&!disposed)canvas.value.getContext('2d')!.drawImage(image,0,0);},()=>{referenceError.value=true;});
        const size=await touchRenderer.reference(d);if(disposed||software.value)return;
        aspect.value=`${size.width} / ${size.height}`;
        ready.value=true;await nextTick();if(canvas.value){canvas.value.width=size.width!;canvas.value.height=size.height!;}
        draw();return;
      }
      buffer = document.createElement('canvas'); buffer.width = d.videoWidth; buffer.height = d.videoHeight;
      const ctx = buffer.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(d, 0, 0); reference = ctx.getImageData(0, 0, buffer.width, buffer.height).data;
      ready.value = true;
      aspect.value = `${buffer.width} / ${buffer.height}`;
      await nextTick();
      if (canvas.value) { canvas.value.width = buffer.width; canvas.value.height = buffer.height; }
      draw();
    } catch { if(!disposed&&!software.value)referenceError.value = true; }
    finally { cleanup(); }
  };
  d.src = props.url!;
}
function drawSoftwareDifference(){
  const frame=currentFrame,c=canvas.value;if(!frame||!c)return;
  if(c.width!==frame.width||c.height!==frame.height){c.width=frame.width;c.height=frame.height;}
  const ctx=c.getContext('2d')!;
  if(frame.gain===gain.value && frame.cleanup===cleanup.value && frame.differenceImage?.width){ctx.drawImage(frame.differenceImage,0,0);return;}
  if(frame.gain===gain.value && frame.cleanup===cleanup.value && frame.difference){ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.difference),frame.width,frame.height),0,0);return;}
  // Buffered frames can briefly retain previous settings. Coalesce their redraws
  // in a worker too, including settings changed while the video is paused.
  if(!reference||!surface.value)return;
  if(typeof OffscreenCanvas!=='undefined'&&typeof createImageBitmap==='function'){
    if(settingsPending){settingsRequested=true;return;}
    if(!settingsRenderer){
      settingsRenderer=new TactileRenderer(()=>{},()=>{if(!disposed)referenceError.value=true;});
      settingsReady=settingsRenderer.reference(new ImageData(reference.slice(),frame.width,frame.height));
    }
    settingsPending=true;settingsRequested=false;
    const generation=settingsGeneration, frameGain=gain.value, frameCleanup=cleanup.value;
    void settingsReady!.then(()=>{
      if(disposed||currentFrame!==frame)return;
      return settingsRenderer!.render(surface.value!,frameGain,frameCleanup);
    }).then(image=>{
      if(!image)return;
      try{if(!disposed&&currentFrame===frame&&generation===settingsGeneration)ctx.drawImage(image,0,0);}
      finally{image.close();}
    }).catch(()=>{if(!disposed&&generation===settingsGeneration)referenceError.value=true;}).finally(()=>{
      settingsPending=false;if(settingsRequested&&!disposed)drawSoftwareDifference();
    });
    return;
  }
  // Compatibility fallback for browsers without offscreen bitmap processing.
  buffer??=document.createElement('canvas');
  if(buffer.width!==frame.width||buffer.height!==frame.height){buffer.width=frame.width;buffer.height=frame.height;}
  const read=buffer.getContext('2d',{willReadFrequently:true})!;read.drawImage(surface.value,0,0);
  const current=read.getImageData(0,0,frame.width,frame.height);
  if(!output||output.width!==frame.width||output.height!==frame.height)output=new ImageData(frame.width,frame.height);
  (touchFilter??=new TactileFilter(frame.width,frame.height,reference)).render(current.data,output.data,gain.value,cleanup.value);ctx.putImageData(output,0,0);
}
function decoded(frame:DecodedFrame){
  if(disposed||!surface.value)return;
  currentFrame=frame;if(frame.reference){reference=new Uint8ClampedArray(frame.reference);touchFilter=null;}
  aspect.value=`${frame.width} / ${frame.height}`;
  const c=surface.value;if(c.width!==frame.width||c.height!==frame.height){c.width=frame.width;c.height=frame.height;}
  const bitmapContext=frame.image?c.getContext('bitmaprenderer'):null;
  if(frame.image&&bitmapContext)bitmapContext.transferFromImageBitmap(frame.image);
  else if(frame.image)c.getContext('2d')!.drawImage(frame.image,0,0);
  else if(frame.pixels)c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels),frame.width,frame.height),0,0);
  c.dataset.presentedTime=String(frame.time);opening.value=false;
  if(props.media.kind==='tactile'){ready.value=!!(frame.differenceImage||frame.difference);drawSoftwareDifference();}
}
function fallback(){
  if(disposed||software.value||props.media.failed)return;
  transport?.dispose();touchRenderer?.dispose();touchRenderer=null;referenceError.value=false;software.value=true;opening.value=true;failed.value=false;
  if(!props.blob){failed.value=true;opening.value=false;return;}
  try{transport=new SoftwareTransport(props.blob,props.timing.media,props.media.fps,decoded,error=>{failed.value=true;opening.value=false;console.warn('Video decoder:',error);},props.media.kind==='tactile');
    if(transport instanceof SoftwareTransport){transport.setGain(gain.value);transport.setCleanup(cleanup.value);}
    props.playback.register(props.media,props.timing,transport,()=>{failed.value=true;opening.value=false;});
  }catch{failed.value=true;opening.value=false;}
}
onMounted(()=>{
  if(failed.value){opening.value=false;return;}
  const v=video.value;if(!v)return;
  if(props.media.kind==='tactile')animationFrame=requestAnimationFrame(callback);
  if(new URLSearchParams(location.search).has('software') || (props.media.codec&&!v.canPlayType('video/mp4; codecs="'+props.media.codec+'"'))){fallback();return;}
  transport=new NativeTransport(v);props.playback.register(props.media,props.timing,transport,()=>{failed.value=true;opening.value=false;});
  if(v.error)fallback();else if(v.readyState>=2)void loaded();
});
watch([gain,cleanup],()=>{settingsGeneration++;if(transport instanceof SoftwareTransport){transport.setGain(gain.value);transport.setCleanup(cleanup.value);}draw();});
onBeforeUnmount(() => {
  disposed = true;transport?.dispose();touchRenderer?.dispose();settingsRenderer?.dispose();
  clearTimeout(referenceTimeout);
  cancelAnimationFrame(animationFrame);
  props.playback.unregister(props.media.id);
  if (video.value) { video.value.pause(); video.value.removeAttribute('src'); video.value.load(); }
  if (decoder) { decoder.onloadeddata = null; decoder.onerror = null; decoder.pause(); decoder.removeAttribute('src'); decoder.load(); }
  reference = null; buffer = null; output = null;currentFrame=null;
});
</script>

<template>
  <article class="media-card" :class="{ 'tactile-card': media.kind === 'tactile', inactive: outside }" :data-channel="media.id" :data-mode="software ? 'software' : 'native'">
    <header class="panel-heading"><span><i class="channel-dot" :class="media.id.startsWith('r_') ? 'right' : media.id.startsWith('l_') ? 'left' : ''"></i>{{ channelName(media.id) }}</span><button class="icon-button" :title="t('expand')" :aria-label="t('expand') + ': ' + channelName(media.id)" @click="$emit('expand')"><Maximize2 :size="15" /></button></header>
    <div class="media-images" :style="media.kind === 'tactile' ? { '--response-aspect': aspect } : undefined">
      <div class="image-cell" :class="{ 'tactile-source': media.kind === 'tactile' }" :aria-hidden="media.kind === 'tactile' ? true : undefined">
        <video v-if="url && !software && !media.failed" ref="video" :src="url" muted playsinline preload="auto" @loadeddata="loaded" @seeked="draw" @timeupdate="draw" @error="fallback" :aria-label="channelName(media.id)"></video>
        <canvas ref="surface" v-show="software" class="software-video" :aria-label="channelName(media.id)"></canvas>
        <div v-if="opening && !failed" class="media-message"><span>{{ t('decoding') }}</span></div>
        <div v-if="failed" class="media-message"><AlertCircle :size="20" /><span>{{ t(url ? 'failed' : 'missingMedia') }}</span></div>
      </div>
      <div v-if="media.kind === 'tactile'" class="image-cell difference-cell">
        <canvas ref="canvas" :aria-label="t('difference')"></canvas>
        <div v-if="failed" class="media-message"><AlertCircle :size="20" /><span>{{ t(url ? 'failed' : 'missingMedia') }}</span></div>
        <div v-else-if="!ready || referenceError" class="media-message"><span>{{ t(referenceError ? 'referenceFailed' : opening ? 'decoding' : 'referenceLoading') }}</span></div>
      </div>
      <span v-if="outside && !failed" class="interval-label">{{ t('outside') }}</span>
    </div>
    <footer v-if="media.kind === 'tactile'" class="tactile-footer">
      <span class="response-legend" :title="t('responseLegend')"><span>{{ t('weak') }}</span><i aria-hidden="true"></i><span>{{ t('strong') }}</span></span>
      <details class="gain-popover"><summary :title="t('tactileSettings')"><SlidersHorizontal :size="14" /><span>{{ gain }}×</span></summary><div><label class="cleanup-setting"><span>{{ t('showAll') }}</span><input type="checkbox" v-model="showAll" :aria-label="t('showAll')" /></label><p class="cleanup-hint">{{ t('cleanupHint') }}</p><label>{{ t('gain') }} <b>{{ gain }}×</b><input type="range" min="1" max="16" step="1" v-model.number="gain" :aria-label="t('gain')" /></label><p class="cleanup-hint">{{ t('reference') }}</p></div></details>
    </footer>
  </article>
</template>
