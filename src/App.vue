<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { Aperture, ArrowUpRight, FolderOpen, Search, PanelLeftClose, PanelLeftOpen, Play, Pause, SkipBack, SkipForward, ChevronDown, X, Info, Activity, ScanEye, Layers3, Move3D, Fingerprint, Globe2, ChevronRight, AlertCircle, Keyboard, LoaderCircle } from 'lucide-vue-next';
import { language, t, channelName, type Word } from './i18n';
import { openRecording, type RecordingSource } from './source';
import { usePlayback } from './playback';
import { timeText } from './math';
import type { Episode, EpisodeData } from './types';
import MediaPanel from './components/MediaPanel.vue';
import TrajectoryView from './components/TrajectoryView.vue';
import SignalPlot from './components/SignalPlot.vue';

const samplePackage = shallowRef<RecordingSource | null>(null), active = shallowRef<Episode | null>(null), data = shallowRef<EpisodeData | null>(null);
const urls = shallowRef<Record<string,string>>({}), input = ref<HTMLInputElement | null>(null), archiveInput = ref<HTMLInputElement | null>(null);
const query = ref(''), sidebar = ref(true), expanded = ref(''), loading = ref(false), error = ref<Word | null>(null), showInfo = ref(false), showHelp = ref(false);
const controller = usePlayback();
const { time, duration, playing, busy, rate } = controller;
let generation = 0, ownedUrls: string[] = [];
let loadAbort = new AbortController(), openAbort = new AbortController();
let beforeExpand: HTMLElement | null = null;
const filtered = computed(()=>samplePackage.value?.manifest.episodes.filter(ep=>`${ep.title} ${ep.robot} ${ep.id}`.toLowerCase().includes(query.value.toLowerCase())) || []);
const rgb = computed(()=>active.value?.media.filter(m=>m.kind==='rgb') || []);
const tactile = computed(()=>active.value?.media.filter(m=>m.kind==='tactile') || []);
const estimated = computed(()=>Object.values(data.value?.timings || {}).some(t=>t.estimated));
const hasMotion = computed(()=>!!data.value?.trajectories.length);
function revoke() { ownedUrls.forEach(url=>URL.revokeObjectURL(url)); ownedUrls=[]; urls.value={}; }
async function selectEpisode(ep: Episode) {
  loadAbort.abort(); loadAbort=new AbortController();
  const version=++generation;
  controller.reset(); expanded.value=''; showInfo.value=false; loading.value=true; error.value=null;
  active.value=null;data.value=null;
  await nextTick(); revoke();
  try {
    const parsed=await samplePackage.value!.data(ep.data,loadAbort.signal);
    if(version!==generation)return;
    for(const media of ep.media) if(!parsed.timings[media.id]) throw new Error('invalidPackage');
    const map:Record<string,string>={};
    for(const media of ep.media) {const file=samplePackage.value!.file(media.path);if(file){const url=URL.createObjectURL(file);map[media.id]=url;ownedUrls.push(url);}}
    urls.value=map; data.value=parsed; active.value=ep; controller.reset(ep.durationMs);
    document.querySelector('.workspace')?.scrollTo(0,0);
  } catch { if(version===generation)error.value='openError'; }
  finally { if(version===generation)loading.value=false; }
}
async function choose(event: Event) {
  const files=[...((event.target as HTMLInputElement).files || [])];
  if(!files.length)return;
  openAbort.abort();const abort=new AbortController();openAbort=abort;
  loadAbort.abort();++generation;controller.reset();active.value=null;data.value=null;await nextTick();revoke();loading.value=true;error.value=null;
  try {const parsed=await openRecording(files,event.target===archiveInput.value,abort.signal);if(abort.signal.aborted){parsed.dispose();return;}samplePackage.value?.dispose();samplePackage.value=parsed;query.value='';await selectEpisode(parsed.manifest.episodes[0]);}
  catch(e){if(!abort.signal.aborted){error.value=e instanceof Error && e.message==='invalidArchive'?'invalidArchive':'missingRecording';loading.value=false;}}
  finally {(event.target as HTMLInputElement).value='';}
}
function expand(id:string) {beforeExpand=document.activeElement as HTMLElement;expanded.value=id;nextTick(()=>document.querySelector<HTMLButtonElement>('.expanded-close')?.focus());}
function closeExpand() {expanded.value='';nextTick(()=>beforeExpand?.focus());}
function keyboard(event:KeyboardEvent) {
  if(event.key==='Escape'){if(expanded.value)closeExpand();showInfo.value=false;showHelp.value=false;return;}
  const target=event.target as HTMLElement;
  if(target.closest('input,select,textarea,button,summary,[contenteditable=true]')||!active.value)return;
  if(event.code==='Space'){event.preventDefault();controller.toggle();}
  if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();controller.step(event.key==='ArrowLeft'?-1:1);}
}
watch(language,()=>{document.documentElement.lang=language.value==='en'?'en':'zh-CN';});
onMounted(()=>window.addEventListener('keydown',keyboard));
onBeforeUnmount(()=>{++generation;loadAbort.abort();openAbort.abort();samplePackage.value?.dispose();revoke();window.removeEventListener('keydown',keyboard);});
const issueLabel=(code:string):Word=>code==='estimated_alignment'?'estimated':code==='empty_signal'?'emptyTactile':code==='missing_trajectory'?'noTrajectory':'unavailableSignals';
</script>

<template>
  <div class="app-shell" :class="{ 'has-samples': !!samplePackage, 'sidebar-hidden': !sidebar }">
    <input ref="input" class="file-input" type="file" webkitdirectory multiple @change="choose" aria-label="Recording folder" />
    <input ref="archiveInput" class="file-input" type="file" accept=".tar,application/x-tar" @change="choose" aria-label="Episode TAR archive" />
    <header class="app-header" :inert="!!expanded">
      <div class="brand"><div class="brand-mark"><Aperture :size="24" :stroke-width="1.7" /></div><span>{{ t('brand') }}<small>DATA EXPLORER</small></span><span class="version-label">1.1.7</span></div>
      <div class="header-actions"><span class="offline-label"><i></i>{{ t('local') }}</span><button class="language-button" @click="language = language === 'en' ? 'zh' : 'en'" :aria-label="language === 'en' ? '切换为中文' : 'Switch to English'"><Globe2 :size="15" />{{ language==='en'?'中文':'EN' }}</button><button v-if="samplePackage" class="button secondary small" @click="input?.click()"><FolderOpen :size="16" />{{ t('open') }}</button><button v-if="samplePackage" class="button secondary small" @click="archiveInput?.click()">{{ t('openArchive') }}</button></div>
    </header>

    <main v-if="!samplePackage" class="welcome">
      <div class="welcome-copy"><div class="eyebrow"><span></span>ROBOT DATA / {{ language==='en'?'IN FOCUS':'数据可视化' }}</div><h1>{{ t('eyebrow') }}</h1><p class="welcome-intro">{{ t('intro') }}</p><p class="welcome-subtitle">{{ t('welcome') }}</p><button class="button primary open-main" @click="input?.click()" :disabled="loading"><FolderOpen :size="18" />{{ t('open') }}<ArrowUpRight :size="18" /></button><button class="button secondary open-archive" @click="archiveInput?.click()" :disabled="loading">{{ t('openArchive') }}</button><p class="open-hint">{{ t('openHint') }}</p><p v-if="error" class="inline-error"><AlertCircle :size="17" />{{ t(error) }}</p>
        <div class="welcome-steps"><div v-for="(step,i) in ['step1','step2','step3'] as const" :key="step"><span>0{{ i+1 }}</span>{{ t(step) }}</div></div>
      </div>
      <div class="welcome-art" aria-hidden="true"><div class="art-top"><span>SPATIAL RECORDINGS</span><span>XYZ / 6D</span></div><svg viewBox="0 0 560 380"><defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#273240" stroke-width=".7"/></pattern><linearGradient id="pathFade" x1="0" x2="1"><stop stop-color="#55cbbb" stop-opacity=".15"/><stop offset="1" stop-color="#55cbbb"/></linearGradient></defs><g transform="translate(280 130) rotate(-25) skewX(30) scale(1 .62)"><rect x="-230" y="-80" width="480" height="350" fill="url(#grid)"/></g><path d="M75 254C91 158 188 243 208 160S309 132 338 83S428 112 458 58" fill="none" stroke="url(#pathFade)" stroke-width="3"/><path d="M92 303C154 250 246 314 292 213S425 256 476 187" fill="none" stroke="#eeb473" stroke-opacity=".75" stroke-width="2.5"/><circle cx="458" cy="58" r="19" fill="#55cbbb" fill-opacity=".08"/><circle cx="458" cy="58" r="5" fill="#55cbbb"/><circle cx="476" cy="187" r="5" fill="#eeb473"/><path d="M458 58l30 5m-30-5l-7-28m7 28l-15 17" fill="none" stroke="#9dccf5" stroke-width="1.5"/></svg><div class="art-tags"><span><ScanEye :size="16" /> RGB</span><span><Move3D :size="16" />{{ t('trajectory') }}</span><span><Fingerprint :size="16" />{{ t('tactile') }}</span></div><div class="art-caption">{{ t('privacy') }}</div></div>
    </main>

    <template v-else>
      <aside class="sample-sidebar" v-show="sidebar" :inert="!!expanded"><div class="sidebar-heading"><span>{{ t('samples') }}</span><button class="icon-button" :title="t('collapse')" :aria-label="t('collapse')" @click="sidebar=false"><PanelLeftClose :size="17" /></button></div><div class="search-field"><Search :size="15" /><input v-model="query" :placeholder="t('search')" :aria-label="t('search')" /></div><div class="sample-count">{{ filtered.length }} {{ t('records') }}</div><nav class="episode-list" :aria-label="t('samples')"><button v-for="(ep,i) in filtered" :key="ep.id" class="episode-button" :class="{selected:active?.id===ep.id}" :aria-current="active?.id===ep.id ? 'true' : undefined" @click="selectEpisode(ep)"><div class="episode-top"><span class="episode-index">{{ String(i+1).padStart(2,'0') }}</span><span class="robot-tag">{{ ep.robot.toUpperCase() }}</span><ChevronRight :size="14" /></div><strong :title="ep.title">{{ ep.title }}</strong><small class="episode-file" :title="ep.sourceName">{{ ep.sourceName.split('/').filter(Boolean).at(-1) }}</small><div class="episode-bottom"><span>{{ timeText(ep.durationMs).slice(0,-2) }}</span><div><ScanEye v-if="ep.media.some(m=>m.kind==='rgb')" :size="13" /><Fingerprint v-if="ep.media.some(m=>m.kind==='tactile')" :size="13" /><Move3D v-if="!ep.issues.some(i=>i.code==='missing_trajectory')" :size="13" /></div></div></button><p v-if="!filtered.length" class="no-results">{{ t('noResults') }}</p></nav><footer class="sidebar-footer"><Aperture :size="17" /><span>{{ t('privacy') }}</span></footer></aside>

      <main class="workspace" :class="{'full-width':!sidebar}">
        <div v-if="loading" class="loading-view"><LoaderCircle class="spin" :size="24" /><span>{{ t('loading') }}</span></div>
        <div v-if="error" class="error-banner"><AlertCircle :size="18" /><span>{{ t(error) }}</span><button class="button secondary small" @click="input?.click()">{{ t('tryAgain') }}</button></div>
        <template v-if="active && data && !loading">
          <div class="recording-heading" :inert="!!expanded"><div class="recording-title"><div class="recording-overline"><button v-if="!sidebar" class="icon-button" @click="sidebar=true" :aria-label="t('sidebar')"><PanelLeftOpen :size="18" /></button><span>{{ active.robot.toUpperCase() }}</span><span class="overline-divider">/</span><span>{{ active.id.split('/').filter(Boolean).at(-1)?.toUpperCase() }}</span></div><h1 :title="active.title">{{ active.title }}</h1></div><div class="recording-actions"><span class="alignment-status" :class="{estimated}"><i></i>{{ t(estimated?'estimated':'timestamp') }}</span><button class="icon-button" :aria-label="t('details')" :title="t('details')" @click="showInfo=!showInfo"><Info :size="18" /></button></div></div>
          <div class="primary-grid" :class="{'motion-only':!rgb.length, 'camera-only':!hasMotion}">
            <section v-if="rgb.length" class="camera-section"><div class="section-heading" :inert="!!expanded"><h2><ScanEye :size="16" />{{ t('rgb') }}</h2><span>{{ t(samplePackage.kind==='original'?'originalMedia':'preview') }}</span></div><div class="camera-grid" :class="{'one-camera':rgb.length===1}"><MediaPanel v-for="media in rgb" :key="active.id+media.id" :media="media" :url="urls[media.id]" :blob="samplePackage?.file(media.path)" :timing="data.timings[media.id]" :playback="controller" :class="{'expanded-panel':expanded===media.id}" :inert="!!expanded && expanded!==media.id" @expand="expand(media.id)" /></div></section>
            <section v-if="hasMotion" class="motion-section"><div class="section-heading" :inert="!!expanded"><h2><Move3D :size="16" />{{ t('trajectory') }}</h2><span>XYZ · 6D</span></div><TrajectoryView :trajectories="data.trajectories" :time="time" :class="{'expanded-panel':expanded==='motion'}" :inert="!!expanded && expanded!=='motion'" @expand="expand('motion')" /></section>
          </div>
          <section v-if="tactile.length" class="tactile-section"><div class="section-heading" :inert="!!expanded"><h2><Fingerprint :size="16" />{{ t('tactile') }}<small>{{ tactile.length }} {{ t('columns') }}</small></h2><span class="tactile-explainer">{{ t('tactileCaption') }}</span></div><div class="tactile-grid"><MediaPanel v-for="media in tactile" :key="active.id+media.id" :media="media" :url="urls[media.id]" :blob="samplePackage?.file(media.path)" :timing="data.timings[media.id]" :playback="controller" :class="{'expanded-panel':expanded===media.id}" :inert="!!expanded && expanded!==media.id" @expand="expand(media.id)" /></div><p class="tactile-note" :inert="!!expanded">{{ t('tactileNote') }}</p></section>
          <details class="signals-section" :inert="!!expanded" :key="active.id"><summary><span><Activity :size="16" />{{ t('signals') }}<small>{{ data.signals.length }} {{ t('columns') }}</small></span><ChevronDown :size="16" /></summary><SignalPlot :signals="data.signals" :time="time" :duration="duration" /></details>
          <div v-if="showInfo" class="details-popover"><header><h2>{{ t('info') }}</h2><button class="icon-button" @click="showInfo=false" :aria-label="t('close')"><X :size="17" /></button></header><dl><dt>{{ t('title') }}</dt><dd>{{ active.title }}</dd><dt>{{ t('robot') }}</dt><dd>{{ active.robot }}</dd><dt>{{ t('duration') }}</dt><dd>{{ timeText(duration) }}</dd><dt>{{ t('original') }}</dt><dd>{{ samplePackage.kind==='original' ? active.sourceName : 'originals/'+active.id }}</dd></dl><p class="source-name">{{ active.sourceName }}</p><ul v-if="active.issues.length"><li v-for="(issue,i) in active.issues" :key="i">{{ t(issueLabel(issue.code)) }}<span v-if="issue.channel"> · {{ issue.channel }}</span><span v-if="issue.count"> ({{ issue.count }})</span></li></ul></div>
        </template>
      </main>

      <div v-if="expanded" class="expand-backdrop" @click.self="closeExpand"><div class="expanded-top"><span>{{ t('fullscreenHint') }}</span><button class="icon-button expanded-close" :aria-label="t('close')" @click="closeExpand"><X :size="21" /></button></div></div>
      <footer class="playback-bar" v-if="active"><div class="transport"><button class="icon-button" :aria-label="t('previous')" :title="t('previous')" @click="controller.step(-1)"><SkipBack :size="19" /></button><button class="play-button" :aria-label="t(playing?'pause':'play')" :title="t(playing?'pause':'play')" @click="controller.toggle()"><LoaderCircle v-if="busy" class="spin" :size="21" /><Pause v-else-if="playing" :size="21" fill="currentColor" /><Play v-else :size="21" fill="currentColor" /></button><button class="icon-button" :aria-label="t('next')" :title="t('next')" @click="controller.step(1)"><SkipForward :size="19" /></button></div><div class="timeline-group"><div class="timeline-labels"><span class="timecode">{{ timeText(time) }} <small>/ {{ timeText(duration) }}</small></span><span class="playback-status"><i :class="{running:playing}"></i>{{ t(busy?'buffering':playing?'playing':time?'paused':'ready') }}</span></div><input type="range" class="timeline" min="0" :max="duration" step="1" :value="time" :aria-label="t('timeline')" :style="{'--progress': `${time/Math.max(duration,1)*100}%`}" @input="controller.seek(Number(($event.target as HTMLInputElement).value), false)" /></div><div class="playback-extras"><select v-model.number="rate" :aria-label="t('speed')" :title="t('speed')"><option v-for="speed in [.25,.5,1,1.5,2]" :key="speed" :value="speed">{{ speed }}×</option></select><button class="icon-button help-button" :aria-label="t('help')" :title="t('help')" @click="showHelp=!showHelp"><Keyboard :size="19" /></button><div v-if="showHelp" class="shortcut-popover">{{ t('shortcuts') }}<br />{{ t('rotate') }}</div></div></footer>
    </template>
  </div>
</template>
