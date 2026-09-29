import { detectTactileRegion, borrowTactileRegion, regionGeometry, type RegionGeometry, type RegionMethod } from './tactileRoi.ts';

/** Fixed, calibrated image response. No contact inference or temporal adaptation. */
export type TactileBaseline = {
  width: number; height: number; sampleCount: number;
  baseline: Uint8Array; noiseFloor: Float32Array;
  roiMask: Uint8Array; roiStatus: 'ready' | 'not-found'; roiConfidence: number;
  roiCurve?: Float32Array; roiMethod?: RegionMethod; roiDonor?: string;
};

export function baselineGeometry(model:TactileBaseline,episodeId=''):RegionGeometry|undefined {
  return model.roiStatus==='ready'&&model.roiMethod!=='neighbor'&&model.roiCurve?.length
    ?regionGeometry(model.baseline,model.width,model.height,model.roiCurve,model.roiConfidence,episodeId):undefined;
}
export function adoptBaselineRegion(model:TactileBaseline,donor:RegionGeometry):TactileBaseline|undefined {
  const region=borrowTactileRegion(model.baseline,model.width,model.height,donor);
  return region?{...model,roiMask:region.mask,roiCurve:region.curve,roiStatus:region.status,roiConfidence:region.confidence,roiMethod:'neighbor',roiDonor:donor.episodeId}:undefined;
}
export function copyTactileBaseline(model:TactileBaseline):TactileBaseline {
  return {...model,baseline:model.baseline.slice(),noiseFloor:model.noiseFloor.slice(),roiMask:model.roiMask.slice(),roiCurve:model.roiCurve?.slice()};
}

// Python round() uses ties-to-even, including for fractional recorded frame rates.
export function tactileBaselineCount(fps: number, totalFrames: number): number {
  const value = 2 * (Number.isFinite(fps) && fps > 0 ? fps : 30);
  const floor = Math.floor(value);
  const rounded = value - floor === .5 ? floor + floor % 2 : Math.round(value);
  return Math.min(Math.max(0, Math.floor(totalFrames)), Math.max(8, rounded));
}

export function tactileGray(rgba: Uint8ClampedArray, gray: Uint8Array = new Uint8Array(rgba.length / 4)): Uint8Array {
  if (rgba.length !== gray.length * 4) throw new Error('Frame dimensions differ');
  // OpenCV's 8-bit RGB-to-gray fixed-point conversion (source bitmap order is RGB).
  for (let p = 0, i = 0; p < gray.length; p++, i += 4)
    gray[p] = (rgba[i] * 9798 + rgba[i + 1] * 19235 + rgba[i + 2] * 3735 + 16384) >> 15;
  return gray;
}

export class TactileCalibration {
  private frames: Uint8Array[] = [];
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('Frame dimensions differ');
    this.width = width; this.height = height;
  }
  add(rgba: Uint8ClampedArray): Uint8Array {
    if (rgba.length !== this.width * this.height * 4) throw new Error('Frame dimensions differ');
    const gray = tactileGray(rgba);
    this.frames.push(gray);
    // The worker can reuse this immutable sample for initial playback after finish().
    return gray;
  }
  addGray(gray: Uint8Array): void {
    if (gray.length !== this.width * this.height) throw new Error('Frame dimensions differ');
    this.frames.push(gray.slice());
  }
  finish(measure?: (stage: 'statistics' | 'region', milliseconds: number) => void): TactileBaseline {
    const started = performance.now();
    const frames = this.frames, n = frames.length;
    if (!n) throw new Error('No baseline frames');
    const baseline = new Uint8Array(this.width * this.height), noiseFloor = new Float32Array(baseline.length);
    const histogram = new Uint32Array(256);
    const middleLow = Math.floor((n - 1) / 2), middleHigh = Math.ceil((n - 1) / 2);
    const rank = .99 * (n - 1), lowerRank = Math.floor(rank), upperRank = Math.ceil(rank);
    for (let p = 0; p < baseline.length; p++) {
      histogram.fill(0); let min = 255, max = 0;
      for (const gray of frames) { const v = gray[p]; histogram[v]++; min = Math.min(min, v); max = Math.max(max, v); }
      let count = 0, low = -1, high = min;
      for (let v = min; v <= max; v++) {
        count += histogram[v];
        if (low < 0 && count > middleLow) low = v;
        if (count > middleHigh) { high = v; break; }
      }
      const median = Math.floor((low + high) / 2); baseline[p] = median;
      // Traverse the same histogram by absolute deviation from the truncated median.
      count = 0; low = -1; high = 0;
      for (let d = 0; d <= Math.max(median - min, max - median); d++) {
        count += (median + d <= 255 ? histogram[median + d] : 0) + (d && median - d >= 0 ? histogram[median - d] : 0);
        if (low < 0 && count > lowerRank) low = d;
        if (count > upperRank) { high = d; break; }
      }
      noiseFloor[p] = low + (high - low) * (rank - lowerRank);
    }
    this.clear();
    const regionStarted = performance.now();
    measure?.('statistics', regionStarted - started);
    const region = detectTactileRegion(baseline, this.width, this.height);
    measure?.('region', performance.now() - regionStarted);
    return { width: this.width, height: this.height, sampleCount: n, baseline, noiseFloor,
      roiMask: region.mask, roiStatus: region.status, roiConfidence: region.confidence, roiCurve: region.curve, roiMethod: region.method };
  }
  clear(): void { this.frames = []; }
}

// OpenCV COLORMAP_INFERNO, 256 RGB entries. Kept inline for the bundled workers.
const INFERNO = new Uint8Array([
  0,0,4,1,0,5,1,1,6,1,1,8,2,1,10,2,2,12,2,2,14,3,2,16,4,3,18,4,3,20,5,4,23,6,4,25,7,5,27,8,5,29,9,6,31,10,7,34,
  11,7,36,12,8,38,13,8,41,14,9,43,16,9,45,17,10,48,18,10,50,20,11,52,21,11,55,22,11,57,24,12,60,25,12,62,27,12,65,28,12,67,30,12,69,31,12,72,
  33,12,74,35,12,76,36,12,79,38,12,81,40,11,83,41,11,85,43,11,87,45,11,89,47,10,91,49,10,92,50,10,94,52,10,95,54,9,97,56,9,98,57,9,99,59,9,100,
  61,9,101,62,9,102,64,10,103,66,10,104,68,10,104,69,10,105,71,11,106,73,11,106,74,12,107,76,12,107,77,13,108,79,13,108,81,14,108,82,14,109,84,15,109,85,15,109,
  87,16,110,89,16,110,90,17,110,92,18,110,93,18,110,95,19,110,97,19,110,98,20,110,100,21,110,101,21,110,103,22,110,105,22,110,106,23,110,108,24,110,109,24,110,111,25,110,
  113,25,110,114,26,110,116,26,110,117,27,110,119,28,109,120,28,109,122,29,109,124,29,109,125,30,109,127,30,108,128,31,108,130,32,108,132,32,107,133,33,107,135,33,107,136,34,106,
  138,34,106,140,35,105,141,35,105,143,36,105,144,37,104,146,37,104,147,38,103,149,38,103,151,39,102,152,39,102,154,40,101,155,41,100,157,41,100,159,42,99,160,42,99,162,43,98,
  163,44,97,165,44,96,166,45,96,168,46,95,169,46,94,171,47,94,173,48,93,174,48,92,176,49,91,177,50,90,179,50,90,180,51,89,182,52,88,183,53,87,185,53,86,186,54,85,
  188,55,84,189,56,83,191,57,82,192,58,81,193,58,80,195,59,79,196,60,78,198,61,77,199,62,76,200,63,75,202,64,74,203,65,73,204,66,72,206,67,71,207,68,70,208,69,69,
  210,70,68,211,71,67,212,72,66,213,74,65,215,75,63,216,76,62,217,77,61,218,78,60,219,80,59,221,81,58,222,82,56,223,83,55,224,85,54,225,86,53,226,87,52,227,89,51,
  228,90,49,229,92,48,230,93,47,231,94,46,232,96,45,233,97,43,234,99,42,235,100,41,235,102,40,236,103,38,237,105,37,238,106,36,239,108,35,239,110,33,240,111,32,241,113,31,
  241,115,29,242,116,28,243,118,27,243,120,25,244,121,24,245,123,23,245,125,21,246,126,20,246,128,19,247,130,18,247,132,16,248,133,15,248,135,14,248,137,12,249,139,11,249,140,10,
  249,142,9,250,144,8,250,146,7,250,148,7,251,150,6,251,151,6,251,153,6,251,155,6,251,157,7,252,159,7,252,161,8,252,163,9,252,165,10,252,166,12,252,168,13,252,170,15,
  252,172,17,252,174,18,252,176,20,252,178,22,252,180,24,251,182,26,251,184,29,251,186,31,251,188,33,251,190,35,250,192,38,250,194,40,250,196,42,250,198,45,249,199,47,249,201,50,
  249,203,53,248,205,55,248,207,58,247,209,61,247,211,64,246,213,67,246,215,70,245,217,73,245,219,76,244,221,79,244,223,83,244,225,86,243,227,90,243,229,93,242,230,97,242,232,101,
  242,234,105,241,236,109,241,237,113,241,239,117,241,241,121,242,242,125,242,244,130,243,245,134,243,246,138,244,248,142,245,249,146,246,250,150,248,251,154,249,252,157,250,253,161,252,255,164
]);
const GAMMA = Uint8Array.from({ length: 256 }, (_, i) => Math.floor(Math.pow(i / 255, .7) * 255));
// OpenCV chooses a 17-tap kernel for sigma=2 on float32 data; BORDER_DEFAULT is REFLECT_101.
const GAUSSIAN = Float32Array.from({ length: 17 }, (_, i) => Math.exp(-((i - 8) ** 2) / 8));
const gaussianSum = Array.from({ length: 17 }, (_, i) => Math.exp(-((i - 8) ** 2) / 8)).reduce((a, b) => a + b, 0);
for (let i = 0; i < 17; i++) GAUSSIAN[i] = Math.exp(-((i - 8) ** 2) / 8) / gaussianSum;
function reflect101(i: number, size: number): number {
  if (size === 1) return 0;
  const period = 2 * (size - 1), position = ((i % period) + period) % period;
  return position < size ? position : period - position;
}

export class TactileFilter {
  private readonly model: TactileBaseline;
  private readonly gray: Uint8Array;
  private readonly cleaned: Float32Array;
  private readonly horizontal: Float32Array;
  private readonly smooth: Float32Array;
  private readonly xIndices: Int32Array;
  private readonly yIndices: Int32Array;
  constructor(model: TactileBaseline) {
    const { width, height, baseline, noiseFloor, sampleCount, roiMask, roiStatus, roiConfidence } = model;
    const size = width * height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || !Number.isInteger(sampleCount) || sampleCount < 1 || baseline.length !== size || noiseFloor.length !== size || roiMask?.length !== size || !['ready', 'not-found'].includes(roiStatus) || !Number.isFinite(roiConfidence))
      throw new Error('Invalid tactile baseline');
    this.model = { ...model, baseline: baseline.slice(), noiseFloor: noiseFloor.slice(), roiMask: roiMask.slice() };
    this.gray = new Uint8Array(size); this.cleaned = new Float32Array(size);
    this.horizontal = new Float32Array(size); this.smooth = new Float32Array(size);
    this.xIndices = Int32Array.from({ length: width * 17 }, (_, i) => reflect101(Math.floor(i / 17) + i % 17 - 8, width));
    this.yIndices = Int32Array.from({ length: height * 17 }, (_, i) => reflect101(Math.floor(i / 17) + i % 17 - 8, height) * width);
  }
  render(current: Uint8ClampedArray, output: Uint8ClampedArray, gain = 10, cleanup = true): void {
    if (current.length !== this.gray.length * 4) throw new Error('Frame dimensions differ');
    tactileGray(current, this.gray);
    this.renderGray(this.gray, output, gain, cleanup);
  }
  renderGray(gray: Uint8Array, output: Uint8ClampedArray, gain = 10, cleanup = true): void {
    const { width, height, baseline, noiseFloor, roiMask, roiStatus } = this.model;
    if (gray.length !== baseline.length || output.length !== baseline.length * 4) throw new Error('Frame dimensions differ');
    if (roiStatus !== 'ready') { output.fill(0); for (let i = 3; i < output.length; i += 4) output[i] = 255; return; }
    gain = Number.isFinite(gain) ? Math.max(1, Math.min(16, gain)) : 10;
    const { cleaned, horizontal, smooth, xIndices, yIndices } = this;
    for (let p = 0; p < gray.length; p++) {
      const delta = Math.abs(gray[p] - baseline[p]);
      cleaned[p] = roiMask[p] ? (cleanup ? Math.max(Math.fround(delta - noiseFloor[p]) - 2, 0) : delta) : 0;
    }
    if (cleanup) {
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const row = y * width, indices = x * 17;
        let sum = cleaned[row + x] * GAUSSIAN[8];
        for (let k = 1; k <= 8; k++) sum += (cleaned[row + xIndices[indices + 8 - k]] + cleaned[row + xIndices[indices + 8 + k]]) * GAUSSIAN[8 + k];
        horizontal[y * width + x] = sum;
      }
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const indices = y * 17;
        let sum = horizontal[y * width + x] * GAUSSIAN[8];
        for (let k = 1; k <= 8; k++) sum += (horizontal[yIndices[indices + 8 - k] + x] + horizontal[yIndices[indices + 8 + k] + x]) * GAUSSIAN[8 + k];
        smooth[y * width + x] = sum;
      }
    }
    const values = cleanup ? smooth : cleaned;
    for (let p = 0, i = 0; p < values.length; p++, i += 4) {
      let value = GAMMA[Math.min(255, Math.floor(Math.fround(values[p] * gain)))];
      if (!roiMask[p] || (cleanup && value < 10)) value = 0;
      const color = value * 3;
      output[i] = value ? INFERNO[color] : 0;
      output[i + 1] = value ? INFERNO[color + 1] : 0;
      output[i + 2] = value ? INFERNO[color + 2] : 0;
      output[i + 3] = 255;
    }
  }
}
