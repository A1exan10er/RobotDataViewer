type VideoSource = Pick<HTMLVideoElement, 'currentTime' | 'readyState' | 'seeking' | 'addEventListener' | 'removeEventListener'>;
type ClosableFrame = { close(): void };

/** One in-flight render; coalesce incoming updates to the newest video frame. */
export class TactilePlayback<Frame extends ClosableFrame> {
  private readonly video: VideoSource;
  private readonly render: (gain: number, cleanup: boolean) => Promise<Frame | undefined>;
  private readonly paint: (frame: Frame, sourceTime: number) => void;
  private readonly failed: () => void;
  private disposed = false;
  private pending = false;
  private requested = false;
  private generation = 0;
  private lastTime = -1;
  private gain = 1;
  private cleanup = true;

  constructor(video: VideoSource, render: (gain: number, cleanup: boolean) => Promise<Frame | undefined>, paint: (frame: Frame, sourceTime: number) => void, failed: () => void) {
    this.video = video; this.render = render; this.paint = paint; this.failed = failed;
    video.addEventListener('seeking', this.invalidate);
    video.addEventListener('seeked', this.refresh);
    video.addEventListener('pause', this.refresh);
  }

  invalidate = () => {
    this.generation++; this.lastTime = -1; this.requested = true;
  };
  private refresh = () => { this.update(this.gain, this.cleanup); };

  update(gain: number, cleanup: boolean): void {
    if (this.disposed) return;
    if (gain !== this.gain || cleanup !== this.cleanup) {
      this.gain = gain; this.cleanup = cleanup; this.invalidate();
    }
    if (this.pending) { this.requested = true; return; }
    if (this.video.readyState < 2 || this.video.seeking || this.lastTime === this.video.currentTime) return;
    this.pending = true; this.requested = false; this.lastTime = this.video.currentTime;
    const generation = this.generation, sourceTime = this.lastTime;
    let result: Promise<Frame | undefined>;
    try { result = this.render(gain, cleanup); }
    catch { this.pending = false; this.failed(); return; }
    void result.then(frame => {
      if (!frame) return;
      try {
        // Normal playback advances while the worker runs. Its latest completed
        // result is still useful, even when rendering takes over 100 ms.
        // Only a seek/settings change or disposal invalidates the captured frame.
        if (!this.disposed && !this.video.seeking && generation === this.generation) this.paint(frame, sourceTime);
      } finally { frame.close(); }
    }).catch(() => {
      if (!this.disposed && generation === this.generation) this.failed();
    }).finally(() => {
      this.pending = false;
      if (this.requested && !this.disposed) this.refresh();
    });
  }

  dispose(): void {
    this.disposed = true; this.generation++;
    this.video.removeEventListener('seeking', this.invalidate);
    this.video.removeEventListener('seeked', this.refresh);
    this.video.removeEventListener('pause', this.refresh);
  }
}
