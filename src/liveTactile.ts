import type { TactileBaseline } from './tactileFilter.ts';

export interface LiveRenderer<Image> {
  sample(source: ImageBitmapSource): Promise<void>;
  calibrated(): Promise<TactileBaseline>;
  render(source: ImageBitmapSource, gain: number, cleanup: boolean): Promise<Image | undefined>;
  dispose(): void;
}
export class LiveCalibrationPool {
  private active = 0;
  private waiting: Array<() => void> = [];
  async run<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { this.waiting = this.waiting.filter(item => item !== start); reject(signal.reason); };
      const start = () => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) { reject(signal.reason); return; }
        this.active++; resolve();
      };
      if (signal.aborted) { reject(signal.reason); return; }
      if (this.active < 2) start();
      else { this.waiting.push(start); signal.addEventListener('abort', abort, { once: true }); }
    });
    try { signal.throwIfAborted(); return await work(); }
    finally { this.active--; this.waiting.shift()?.(); }
  }
}
export const liveCalibrationPool = new LiveCalibrationPool();
export type LiveTactileState = 'idle' | 'queued' | 'calibrating' | 'processing' | 'ready' | 'region' | 'failed' | 'timeout';

/** One frame in flight, no decode-ahead queue, and no automatic rebasing. */
export class LiveTactile<Image extends { close(): void }> {
  state: LiveTactileState = 'idle';
  samples = 0;
  lastPaint?: number;
  gain = 10;
  cleanup = true;
  private generation = 0;
  private renderer?: LiveRenderer<Image>;
  private abort?: AbortController;
  private busy = false;
  private sequence = -1;
  private collected?: () => void;
  private rejectCollection?: (reason: unknown) => void;
  private create: () => LiveRenderer<Image>;
  private changed: () => void;
  private paint: (image: Image) => void;
  private pool: LiveCalibrationPool;
  constructor(create: () => LiveRenderer<Image>, changed: () => void, paint: (image: Image) => void, pool = liveCalibrationPool) {
    this.create = create; this.changed = changed; this.paint = paint; this.pool = pool;
  }
  reset() {
    ++this.generation; this.abort?.abort(); this.rejectCollection?.(new Error('Cancelled'));
    this.renderer?.dispose(); this.renderer = undefined; this.collected = undefined; this.rejectCollection = undefined;
    this.busy = false; this.samples = 0; this.lastPaint = undefined; this.sequence = -1; this.state = 'idle'; this.changed();
  }
  async calibrate() {
    this.reset(); const generation = this.generation;
    const abort = new AbortController(); this.abort = abort; this.state = 'queued'; this.changed();
    try {
      await this.pool.run(async () => {
        this.renderer = this.create(); this.state = 'calibrating'; this.changed();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => this.rejectCollection?.(new Error('timeout')), 10000);
          const cancelled = () => reject(new Error('Cancelled'));
          abort.signal.addEventListener('abort', cancelled, { once: true });
          const clean = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', cancelled); };
          this.collected = () => { clean(); resolve(); };
          this.rejectCollection = error => { clean(); reject(error); };
        });
        abort.signal.throwIfAborted(); this.state = 'processing'; this.changed();
        const model = await this.renderer!.calibrated();
        abort.signal.throwIfAborted();
        this.state = model.roiStatus === 'ready' ? 'ready' : 'region'; this.changed();
      }, abort.signal);
    } catch (error) {
      if (generation === this.generation) {
        ++this.generation;
        this.renderer?.dispose(); this.renderer = undefined;
        this.state = error instanceof Error && error.message === 'timeout' ? 'timeout' : 'failed'; this.changed();
      }
    }
  }
  frame(source: ImageBitmapSource, sequence: number, sourceTime: number) {
    if (this.busy || !this.renderer || sequence === this.sequence || !['calibrating', 'ready'].includes(this.state)) return;
    this.sequence = sequence; this.busy = true;
    const generation = this.generation, renderer = this.renderer;
    const sampling = this.state === 'calibrating';
    void (async () => {
      try {
        if (sampling) {
          await renderer.sample(source);
          if (generation !== this.generation) return;
          this.samples++; this.changed();
          if (this.samples === 60) { this.state = 'processing'; this.collected?.(); }
        } else {
          const image = await renderer.render(source, this.gain, this.cleanup);
          if (!image) return;
          try { if (generation === this.generation) { this.paint(image); this.lastPaint = sourceTime; this.changed(); } }
          finally { image.close(); }
        }
      } catch (error) {
        if (generation === this.generation) {
          if (sampling) this.rejectCollection?.(error);
          else { renderer.dispose(); this.renderer = undefined; this.state = 'failed'; this.changed(); }
        }
      } finally { if (generation === this.generation) this.busy = false; }
    })();
  }
}
