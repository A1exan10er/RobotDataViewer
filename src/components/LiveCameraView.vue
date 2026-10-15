<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { Camera, Play, Square, RefreshCw, AlertCircle, Radio } from 'lucide-vue-next';
import { browserCapture, LiveCameraSession, type LiveCamera, type CameraRole } from '../liveCamera';
import { lt } from '../liveI18n';
import LiveCameraCard from './LiveCameraCard.vue';
const cameras = shallowRef<LiveCamera[]>([]), automatic = ref(false), requesting = ref(false), error = ref(''), expanded = ref('');
const capture = browserCapture(), adapter = capture.adapter;
const localFile = window.location.protocol === 'file:';
let storage: Storage | undefined;
try { storage = localStorage; } catch { /* Optional device memory. */ }
const session = adapter ? new LiveCameraSession(adapter, () => {
  cameras.value = [...session!.cameras.values()].map(camera => ({ ...camera }));
  automatic.value = session!.automatic; requesting.value = session!.requesting; error.value = session!.error || '';
}, storage) : undefined;
const active = computed(() => cameras.value.filter(camera => camera.status === 'streaming').length);
let refreshTimer: ReturnType<typeof setInterval>, previousFocus: HTMLElement | null = null;
function expand(id: string) { previousFocus = document.activeElement as HTMLElement; expanded.value = id; void nextTick(() => document.querySelector<HTMLButtonElement>('.live-card.expanded .live-close')?.focus()); }
function close() { expanded.value = ''; previousFocus?.focus(); }
function key(event: KeyboardEvent) { if (event.key === 'Escape') close(); }
function stopAll() { session?.stopAll(); }
function visible() { if (!document.hidden) void session?.refresh(); }
function retry(id: string) { session?.stop(id); void session?.start(id); }
onMounted(() => {
  void session?.refresh();
  refreshTimer = setInterval(() => { if (session?.automatic && !document.hidden) void session.refresh(); }, 5000);
  window.addEventListener('pagehide', stopAll); window.addEventListener('keydown', key); document.addEventListener('visibilitychange', visible);
});
onBeforeUnmount(() => { clearInterval(refreshTimer); session?.dispose(); window.removeEventListener('pagehide', stopAll); window.removeEventListener('keydown', key); document.removeEventListener('visibilitychange', visible); });
</script>
<template>
  <main class="live-workspace">
    <div class="live-heading" :inert="!!expanded">
      <div><div class="eyebrow"><Radio :size="14" /> {{ lt('live') }}</div><h1>{{ lt('title') }}</h1><p>{{ lt('intro') }}</p></div>
      <div class="live-actions"><button class="button secondary" @click="session?.refresh()" :disabled="!session"><RefreshCw :size="16" />{{ lt('refresh') }}</button><button class="button secondary" @click="stopAll" :disabled="!session"><Square :size="15" />{{ lt('stopAll') }}</button><button class="button primary" @click="session?.startAll()" :disabled="!session || requesting"><Play :size="16" />{{ lt('startAll') }}</button></div>
    </div>
    <div class="live-summary" :inert="!!expanded"><span><i :class="{running:active>0}"></i>{{ active }} {{ lt('active') }} / {{ cameras.filter(c=>c.present).length }} {{ lt('cameras') }}</span><span>{{ lt(automatic ? 'automatic' : 'manual') }}</span></div>
    <p v-if="capture.reason || error" class="live-error" role="alert"><AlertCircle :size="18" />{{ lt(capture.reason || error as 'permission') }}</p>
    <aside v-if="localFile || capture.reason" class="live-startup-help" :aria-label="lt('portableStartup')" :inert="!!expanded">
      <strong>{{ lt('portableStartup') }}</strong>
      <p>{{ lt(localFile ? 'fileStartup' : 'launcherStartup') }}</p>
      <p>{{ lt('launcherFiles') }}</p>
      <p>{{ lt('launcherAddress') }}</p>
      <nav :aria-label="lt('downloadLaunchers')"><span>{{ lt('downloadLaunchers') }}</span>
        <a href="https://github.com/A1exan10er/RobotDataViewer/releases/tag/v1.5.0-rc.3" target="_blank" rel="noopener noreferrer">GitHub</a>
        <a href="https://git.neoteai.com/yangtianyu/RobotDataViewer/releases/tag/v1.5.0-rc.3" target="_blank" rel="noopener noreferrer">Gitea</a>
      </nav>
    </aside>
    <p v-if="requesting" class="live-notice" role="status">{{ lt('requesting') }}</p>
    <section v-if="!cameras.length" class="live-empty" :inert="!!expanded"><Camera :size="46" :stroke-width="1" /><h2>{{ lt('empty') }}</h2><p>{{ lt('emptyHint') }}</p><div class="live-profile-hints"><span>640 × 480 / 30 Hz · {{ lt('scene').split(' · ')[0] }}</span><span>640 × 360 / 30 Hz · {{ lt('tactile').split(' · ')[0] }}</span></div></section>
    <div v-else class="live-grid" :class="{'one-camera':cameras.length===1}">
      <LiveCameraCard v-for="(camera,index) in cameras" :key="camera.id" :camera="camera" :index="index" :expanded="expanded===camera.id" :inert="!!expanded && expanded!==camera.id" @role="(role:CameraRole)=>session?.setRole(camera.id,role)" @name="name=>session?.setName(camera.id,name)" @profile="profile=>session?.setProfile(camera.id,profile)" @start="session?.start(camera.id)" @stop="session?.stop(camera.id)" @retry="retry(camera.id)" @expand="expand(camera.id)" @close="close" />
    </div>
    <p class="live-footnote" :inert="!!expanded">{{ lt('measurementNote') }}</p>
  </main>
</template>
