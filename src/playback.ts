import { onBeforeUnmount, ref, watch } from 'vue';
import { localRateAt, mediaTimeAt } from './math';
import type { Media, Timing } from './types';
import type { Transport } from './transport';
import { SynchronizedChannel, allChannelsReady, type ChannelState } from './synchronizedChannel';
import { CalibrationQueue } from './calibrationQueue';
import { playbackMark } from './playbackMetrics';

export function usePlayback() {
  const time = ref(0), duration = ref(0), rate = ref(1), playing = ref(false), busy = ref(false), generation = ref(0);
  const preparing = ref(false), revealed = ref(false), preparedCount = ref(0), channelCount = ref(0);
  const externalHold=ref(false);
  const channels = new Map<string, SynchronizedChannel>(), calibrations = new CalibrationQueue();
  const stalled = new Map<SynchronizedChannel, number>();
  let raf = 0, last = performance.now(), buffering = false, firstMovement = false;
  const target = (b: SynchronizedChannel, ms: number) => Math.min(Math.max(0, b.media.duration - .0001), mediaTimeAt(b.timing, ms));
  const end = (b: SynchronizedChannel) => b.timing.episode.at(-1)! + (b.media.duration - b.timing.media.at(-1)!) * 1000;
  const active = (b: SynchronizedChannel, ms: number) => ms >= b.timing.episode[0] && ms < end(b);
  const owned = (b: SynchronizedChannel) => channels.get(b.media.id) === b;
  const pauseTransports = () => channels.forEach(b => b.pause());

  function hold() {
    ++generation.value; revealed.value = false; preparing.value = channels.size > 0;
    busy.value = false; buffering = true; stalled.clear();
    channels.forEach(b => b.invalidate(generation.value));
  }
  function register(b: SynchronizedChannel, transport: Transport) {
    if (!owned(b)) { transport.dispose(); return; }
    b.attach(transport);
  }
  function pause() { playing.value = false; busy.value = false; buffering = false; pauseTransports(); }
  function play() {
    if(externalHold.value)return;
    if (!duration.value) return;
    if (time.value >= duration.value - 1) { seek(0, true); return; }
    last = performance.now(); buffering = true; busy.value = !preparing.value; playing.value = true; firstMovement = true; playbackMark('play');
  }
  function seek(ms: number, resume = playing.value) {
    pause(); time.value = Math.max(0, Math.min(duration.value, ms)); hold();
    if (resume && time.value < duration.value) play();
  }
  function step(direction: number) {
    const first = [...channels.values()].find(b => b.state !== 'failure' && active(b, time.value));
    if (first) {
      const frames = first.timing.episode;
      if (direction > 0) seek(frames.find(t => t > time.value + .1) ?? duration.value, false);
      else { let previous = 0; for (const t of frames) { if (t >= time.value - .1) break; previous = t; } seek(previous, false); }
    } else seek(time.value + direction * 1000 / 30, false);
  }
  function reset(ms = 0, media: Media[] = [], timings: Record<string, Timing> = {}) {
    pause(); channels.forEach(b => b.dispose()); channels.clear();
    time.value = 0; duration.value = ms;
    for (const item of media) channels.set(item.id, new SynchronizedChannel(item, timings[item.id]));
    channelCount.value = channels.size; preparedCount.value = 0; hold();
    // Motion-only recordings need no media barrier.
    if (!channels.size) { preparing.value = false; revealed.value = ms > 0; }
  }
  function tick(now: number) {
    try {
    const elapsed = now - last; last = now;
    if (preparing.value) {
      pauseTransports();
      for (const b of channels.values()) b.pulse(target(b, time.value), .65 * rate.value * localRateAt(b.timing, time.value), rate.value * localRateAt(b.timing, time.value));
      preparedCount.value = [...channels.values()].filter(b => b.state === 'ready' || b.state === 'failure').length;
      if (allChannelsReady(channels.values())) {
        preparing.value = false; revealed.value = true; busy.value = false;
        playbackMark('joint-ready', undefined, { generation: generation.value, episodeMs: time.value });
        // Reveal the staged frames before any transport or the shared clock moves.
      }
    } else if (playing.value) {
      const next = buffering ? time.value : Math.min(duration.value, time.value + elapsed * rate.value);
      let waiting = false;
      for (const b of channels.values()) {
        const transport = b.transport;
        if (b.state === 'failure' || !transport) continue;
        if (!active(b, next)) { b.pause(); continue; }
        if (!b.prepare(target(b, next), buffering ? .65 * rate.value * localRateAt(b.timing, next) : 0)) {
          waiting = true;
          if (!stalled.has(b)) stalled.set(b, now);
          else if (now - stalled.get(b)! > 30000) b.fail();
        } else stalled.delete(b);
      }
      buffering = waiting; busy.value = waiting;
      if (!waiting) {
        if (firstMovement && next > time.value) { playbackMark('clock-moving'); firstMovement = false; }
        time.value = next;
      }
      for (const b of channels.values()) if (b.state === 'ready' && active(b, time.value)) b.present(target(b, time.value), rate.value * localRateAt(b.timing, time.value), !waiting);
      if (time.value >= duration.value) pause();
    }
    // Camera buffering and the two bounded calibration jobs share startup, not a
    // serial dependency. The presentation barrier still holds every channel.
    calibrations.pump();
    } finally { raf = requestAnimationFrame(tick); }
  }
  watch(rate, () => { if (channels.size) hold(); }, { flush: 'sync' });
  raf = requestAnimationFrame(tick);
  const visibility = () => { if (document.hidden) pause(); };
  document.addEventListener('visibilitychange', visibility);
  onBeforeUnmount(() => { reset(); cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', visibility); });
  return {
    time, duration, rate, playing, busy, generation, preparing, revealed, preparedCount, channelCount,
    externalHold,setExternalHold:(value:boolean)=>{externalHold.value=value;if(value)pause();},
    channel: (id: string) => channels.get(id)!,
    bind: (b: SynchronizedChannel, failed: () => void, changed: (state: ChannelState) => void, render: (generation: number, time: number) => void) => { if (owned(b)) b.bind(changed, failed, render); },
    register, pause, play, seek, step, reset,
    prepareTactile: <T>(run: () => Promise<T>, signal: AbortSignal) => calibrations.run(run, signal),
    prepared: (b: SynchronizedChannel) => { if (owned(b)) b.prepared(); },
    preparationFailed: (b: SynchronizedChannel) => { if (owned(b)) b.fail(); },
    replace: (b: SynchronizedChannel) => { if (owned(b)) { b.detach(); hold(); } },
    redraw: () => { if (preparing.value) hold(); },
    unregister: (b: SynchronizedChannel) => { if (owned(b)) b.dispose(); },
    toggle: () => playing.value ? pause() : play(),
  };
}
export type Playback = ReturnType<typeof usePlayback>;
