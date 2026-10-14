<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Maximize2, X, AlertCircle, Play, Square, Pencil } from 'lucide-vue-next';
import { LiveFrameHealth, CAMERA_PROFILES, configuredFrameRate, requestedProfile, validCameraProfile, type LiveCamera, type CameraRole, type CameraProfile } from '../liveCamera';
import { LiveTactile, type LiveTactileState } from '../liveTactile';
import { TactileRenderer, type TactileImage } from '../tactile';
import { lt } from '../liveI18n';
const props = defineProps<{ camera: LiveCamera; index: number; expanded: boolean }>();
const emit = defineEmits<{ role: [role: CameraRole]; name: [name: string]; profile: [profile?: CameraProfile]; start: []; stop: []; retry: []; expand: []; close: [] }>();
const roles = ['unassigned', 'scene', 'tactile'] as const;
const title = computed(() => props.camera.name || props.camera.label || `${lt('camera')} ${props.index+1}`);
const requested = computed(() => requestedProfile(props.camera));
const editingName = ref(false), nameDraft = ref(''), nameInput = ref<HTMLInputElement>();
const settingsOpen = ref(false), settingsError = ref(false);
const draft = ref({ width: '', height: '', frameRate: '' });
async function editName() { nameDraft.value = props.camera.name; editingName.value = true; await nextTick(); nameInput.value?.focus(); }
function saveName() { emit('name', nameDraft.value); editingName.value = false; }
function chooseRole(role: CameraRole) { settingsOpen.value = false; emit('role', role); }
function editSettings() {
  if (settingsOpen.value) { settingsOpen.value = false; return; }
  const profile = requested.value || { ...CAMERA_PROFILES.scene, ...props.camera.settings };
  draft.value = { width: String(profile.width), height: String(profile.height), frameRate: String(profile.frameRate) };
  settingsError.value = false; settingsOpen.value = true;
}
function applySettings() {
  const profile = { width: Number(draft.value.width), height: Number(draft.value.height), frameRate: Number(draft.value.frameRate) };
  settingsError.value = !validCameraProfile(profile);
  if (settingsError.value) return;
  emit('profile', profile); settingsOpen.value = false;
}
function resetSettings() { emit('profile'); settingsOpen.value = false; }
const video = ref<HTMLVideoElement | null>(null), canvas = ref<HTMLCanvasElement | null>(null);
const health = new LiveFrameHealth(), metrics = ref<ReturnType<LiveFrameHealth['read']>>({ fps: undefined, age: undefined, warning: undefined });
const responseState = ref<LiveTactileState>('idle'), samples = ref(0), responseAge = ref<number>(), previewError = ref(false), metricsAvailable = ref(true);
const gain = ref(10), cleanup = ref(true);
const calibrating = computed(() => ['queued','calibrating','processing'].includes(responseState.value));
const response = new LiveTactile<TactileImage>(
  () => new TactileRenderer(() => {}, () => {}, typeof OffscreenCanvas === 'undefined'),
  () => { responseState.value = response.state; samples.value = response.samples; },
  image => { const target = canvas.value; if (!target) return; if (target.width !== image.width || target.height !== image.height) { target.width = image.width; target.height = image.height; } const context = target.getContext('2d')!; if (image instanceof ImageData) context.putImageData(image,0,0); else context.drawImage(image,0,0); },
);
let callback = 0, timer: ReturnType<typeof setInterval>, attachment = 0;
function cancelFrame() { if (callback && video.value?.cancelVideoFrameCallback) video.value.cancelVideoFrameCallback(callback); callback = 0; }
function clearResponse() { response.reset(); responseAge.value = undefined; const target = canvas.value; if (target) target.getContext('2d')?.clearRect(0,0,target.width,target.height); }
function frame(now: number, metadata: VideoFrameCallbackMetadata) {
  const target = video.value;
  if (!target || !props.camera.stream) return;
  health.frame(now, metadata.presentedFrames);
  if (props.camera.role === 'tactile' && !document.hidden) response.frame(target, metadata.presentedFrames, now);
  callback = target.requestVideoFrameCallback(frame);
}
async function attach() {
  const generation = ++attachment; cancelFrame(); clearResponse(); previewError.value = false;
  health.reset(performance.now()); metrics.value = { fps: undefined, age: undefined, warning: undefined };
  await nextTick(); const target = video.value; if (!target || generation !== attachment) return;
  target.srcObject = props.camera.stream || null;
  if (!props.camera.stream) return;
  try {
    await target.play(); if (generation !== attachment) return;
    metricsAvailable.value = typeof target.requestVideoFrameCallback === 'function';
    if (metricsAvailable.value) callback = target.requestVideoFrameCallback(frame);
  } catch { if (generation === attachment) previewError.value = true; }
}
function visibility() {
  health.reset(performance.now());
  if (document.hidden && calibrating.value) clearResponse();
}
watch([() => props.camera.stream, () => props.camera.generation], attach, { flush: 'post' });
watch([gain, cleanup], () => { response.gain = gain.value; response.cleanup = cleanup.value; });
onMounted(() => {
  void attach(); document.addEventListener('visibilitychange', visibility);
  timer = setInterval(() => {
    if (!props.camera.stream) return;
    if (metricsAvailable.value) metrics.value = health.read(performance.now(), !document.hidden, configuredFrameRate(props.camera));
    responseAge.value = response.lastPaint === undefined ? undefined : performance.now() - response.lastPaint;
  }, 500);
});
onBeforeUnmount(() => { ++attachment; cancelFrame(); clearInterval(timer); response.reset(); document.removeEventListener('visibilitychange', visibility); if (video.value) { video.value.pause(); video.value.srcObject = null; } });
</script>
<template>
  <article class="live-card" :class="{expanded, 'live-tactile-card':camera.role==='tactile'}" :data-camera="index" :data-status="camera.status" :data-response="responseState" :data-role="camera.role">
    <header class="live-card-header">
      <div class="live-camera-title"><span class="live-index">{{ String(index+1).padStart(2,'0') }}</span><div><h2 :title="title">{{ title }}</h2><div class="live-device-name" :title="camera.label">{{ lt('device') }}: {{ camera.label || lt('camera') }}</div><span class="live-status" :class="camera.status">{{ lt(camera.status) }}</span></div></div>
      <div class="live-header-actions"><button class="icon-button live-rename" @click="editName" :aria-label="lt('rename')"><Pencil :size="16" /></button><button v-if="expanded" class="icon-button live-close" @click="emit('close')" :aria-label="lt('close')"><X :size="20" /></button><button v-else class="icon-button live-expand" @click="emit('expand')" :aria-label="lt('expand')"><Maximize2 :size="17" /></button></div>
    </header>
    <form v-if="editingName" class="live-name-form" @submit.prevent="saveName" @keydown.esc.stop="editingName=false">
      <label>{{ lt('name') }}<input ref="nameInput" v-model="nameDraft" :placeholder="camera.label || lt('camera')" autocomplete="off" /></label>
      <div class="live-form-actions"><button class="button secondary small" type="submit">{{ lt('save') }}</button><button class="button secondary small" type="button" @click="editingName=false">{{ lt('cancel') }}</button></div>
    </form>
    <fieldset class="live-role-controls"><legend>{{ lt('role') }}</legend><div class="live-role-options"><label v-for="role in roles" :key="role" :class="{selected:camera.role===role}"><input type="radio" :name="`role-${camera.id}`" :value="role" :checked="camera.role===role" @change="chooseRole(role)" /><span>{{ lt(`${role}Role`) }}</span></label></div></fieldset>
    <div class="live-card-controls"><button class="button secondary small live-settings-toggle" :aria-expanded="settingsOpen" @click="editSettings">{{ lt('settings') }}</button><button v-if="['starting','streaming'].includes(camera.status)" class="button secondary small live-stream-toggle" @click="emit('stop')"><Square :size="12" />{{ lt('stop') }}</button><button v-else class="button secondary small live-stream-toggle" :disabled="!camera.present" @click="camera.status==='error'||camera.status==='disconnected'?emit('retry'):emit('start')"><Play :size="12" />{{ lt(camera.status==='error'||camera.status==='disconnected'?'retry':'start') }}</button></div>
    <form v-if="settingsOpen" class="live-settings-form" novalidate @submit.prevent="applySettings" @keydown.esc.stop="settingsOpen=false">
      <p>{{ lt('settingsHint') }}</p>
      <div class="live-setting-fields"><label>{{ lt('width') }}<input v-model="draft.width" type="number" min="1" step="1" name="width" :aria-invalid="settingsError" /></label><label>{{ lt('height') }}<input v-model="draft.height" type="number" min="1" step="1" name="height" :aria-invalid="settingsError" /></label><label>{{ lt('frameRate') }}<input v-model="draft.frameRate" type="number" min="1" step="any" name="frameRate" :aria-invalid="settingsError" /></label></div>
      <p v-if="settingsError" class="live-field-error" role="alert">{{ lt('invalidSettings') }}</p>
      <div class="live-form-actions"><button class="button secondary small" type="submit">{{ lt('apply') }}</button><button class="button secondary small" type="button" @click="settingsOpen=false">{{ lt('cancel') }}</button><button class="button secondary small live-settings-reset" type="button" @click="resetSettings">{{ lt('reset') }}</button></div>
    </form>
    <div class="live-requested">{{ lt('requested') }} <strong v-if="requested">{{ requested.width }} × {{ requested.height }} · {{ requested.frameRate }} Hz</strong><strong v-else>{{ lt('deviceDefault') }}</strong><span v-if="camera.customProfile"> · {{ lt('custom') }}</span></div>
    <div class="live-images" :class="{'with-response':camera.role==='tactile'}">
      <div class="live-image"><div class="live-image-label">{{ lt('raw') }}</div><video ref="video" autoplay muted playsinline :style="{'aspect-ratio':`${camera.settings?.width || 640} / ${camera.settings?.height || (camera.role==='tactile'?360:480)}`}" /><div v-if="camera.status!=='streaming'" class="live-image-overlay">{{ lt(camera.status) }}</div><div v-else-if="metrics.warning==='stale'" class="live-stale-overlay"><AlertCircle :size="16" />{{ lt('stale') }}</div></div>
      <div v-if="camera.role==='tactile'" class="live-image live-response"><div class="live-image-label">{{ lt('heatmap') }}</div><canvas ref="canvas" width="640" height="360" /><div v-if="responseState!=='ready'" class="live-image-overlay"><span>{{ lt(responseState) }}</span><strong v-if="responseState==='calibrating'">{{ samples }} / 60</strong></div><div v-else-if="responseAge!==undefined && responseAge>2000" class="live-stale-overlay">{{ lt('responseStale') }}</div></div>
    </div>
    <div v-if="camera.settings" class="live-metrics"><span>{{ lt('actual') }} <strong>{{ camera.settings.width ?? '—' }} × {{ camera.settings.height ?? '—' }} · {{ camera.settings.frameRate?.toFixed(1) ?? '—' }} Hz</strong></span><span>{{ lt('displayed') }} <strong>{{ metrics.fps?.toFixed(1) ?? '—' }}</strong></span><span>{{ lt('age') }} <strong>{{ metrics.age===undefined?'—':(metrics.age/1000).toFixed(1)+' '+lt('ago') }}</strong></span></div>
    <p v-if="camera.mismatch" class="live-card-warning"><AlertCircle :size="15" />{{ lt('mismatch') }}</p>
    <p v-if="camera.error || previewError" class="live-card-warning" role="alert"><AlertCircle :size="15" />{{ lt(camera.error || 'playback') }}<button v-if="previewError" class="button secondary small" @click="emit('retry')">{{ lt('retry') }}</button></p>
    <p v-if="camera.stream && metrics.warning && metrics.warning!=='stale'" class="live-card-warning">{{ lt(metrics.warning) }}</p>
    <p v-if="camera.stream && !metricsAvailable" class="live-card-warning">{{ lt('frameMetricsUnavailable') }}</p>
    <div v-if="camera.role==='tactile'" class="live-calibration"><p>{{ lt('calibrateHint') }}</p><div class="live-response-controls"><button v-if="calibrating" class="button secondary small" @click="clearResponse">{{ lt('cancel') }} · {{ lt(responseState) }}</button><button v-else class="button secondary small live-calibrate" :disabled="!camera.stream || previewError || !metricsAvailable" @click="response.calibrate(configuredFrameRate(camera))">{{ lt(responseState==='idle'?'calibrate':'recalibrate') }}</button><label>{{ lt('gain') }} <input type="range" min="1" max="16" step=".5" v-model.number="gain" :aria-label="lt('gain')" />{{ gain }}×</label><label><input type="checkbox" v-model="cleanup" :true-value="false" :false-value="true" />{{ lt('allChanges') }}</label></div><div class="live-response-footer"><span>{{ lt('responseNote') }}</span><span v-if="responseAge!==undefined">{{ lt('responseAge') }} {{ (responseAge/1000).toFixed(1) }} s</span></div></div>
  </article>
</template>
