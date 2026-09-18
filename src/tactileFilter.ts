/** Relative image response, not pressure. No temporal state or contact inference. */
export class TactileFilter {
  private readonly width: number;
  private readonly height: number;
  private readonly reference: Uint8ClampedArray;
  private readonly step: number;
  private readonly columns: number;
  private readonly rows: number;
  private readonly energy: Float32Array;
  private readonly horizontal: Float32Array;
  private readonly smooth: Float32Array;
  private readonly mask: Float32Array;
  private readonly visited: Uint8Array;
  private readonly queue: Int32Array;
  private readonly histogram = new Uint32Array(4081);
  private readonly palette = new Uint8ClampedArray(4097 * 3);
  private paletteGain = -1;
  private readonly x0: Int32Array;
  private readonly x1: Int32Array;
  private readonly blendX: Float32Array;

  constructor(width: number, height: number, reference: Uint8ClampedArray) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || reference.length !== width * height * 4) throw new Error('Frame dimensions differ');
    this.width=width; this.height=height;
    this.reference = reference.slice();
    // Analyze small neighborhoods on a bounded grid, without a second full-size image.
    this.step = Math.max(1, Math.ceil(Math.max(width, height) / 160));
    this.columns = Math.ceil(width / this.step); this.rows = Math.ceil(height / this.step);
    const size = this.columns * this.rows;
    this.energy = new Float32Array(size); this.horizontal = new Float32Array(size);
    this.smooth = new Float32Array(size); this.mask = new Float32Array(size);
    this.visited = new Uint8Array(size); this.queue = new Int32Array(size);
    this.x0 = new Int32Array(width); this.x1 = new Int32Array(width); this.blendX = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      const gx = Math.max(0, Math.min(this.columns - 1, (x + .5) / this.step - .5));
      this.x0[x] = Math.floor(gx); this.x1[x] = Math.min(this.columns - 1, this.x0[x] + 1); this.blendX[x] = gx - this.x0[x];
    }
  }

  render(current: Uint8ClampedArray, output: Uint8ClampedArray, gain = 8, cleanup = true): void {
    const reference = this.reference;
    if (current.length !== reference.length || output.length !== reference.length) throw new Error('Frame dimensions differ');
    gain = Number.isFinite(gain) ? Math.max(1, Math.min(16, gain)) : 8;
    if (gain !== this.paletteGain) {
      this.paletteGain = gain;
      for (let i = 0; i <= 4096; i++) {
        const response = 1 - Math.exp(-Math.sqrt(i / 64 * gain) / 2);
        const opacity = Math.min(1, response * 4), heat = Math.max(0, (response - .25) / .75);
        this.palette[i * 3] = 255 - 35 * heat * opacity;
        this.palette[i * 3 + 1] = 255 - (45 + 175 * heat) * opacity;
        this.palette[i * 3 + 2] = 255 - (230 + 5 * heat) * opacity;
      }
    }
    if (!cleanup) {
      for (let i = 0; i < output.length; i += 4) {
        const change = Math.max(Math.abs(current[i] - reference[i]), Math.abs(current[i + 1] - reference[i + 1]), Math.abs(current[i + 2] - reference[i + 2]));
        const color = Math.min(4096, Math.round(change * 64)) * 3;
        for (let c = 0; c < 3; c++) output[i + c] = this.palette[color + c];
        output[i + 3] = 255;
      }
      return;
    }
    const {width, height, columns, rows, step, energy, horizontal, smooth, histogram, mask, visited, queue} = this;
    // Average absolute RGB change, retaining color changes whose signed mean cancels.
    for (let gy = 0; gy < rows; gy++) for (let gx = 0; gx < columns; gx++) {
      const xEnd = Math.min(width, (gx + 1) * step), yEnd = Math.min(height, (gy + 1) * step);
      let sum = 0;
      for (let y = gy * step; y < yEnd; y++) for (let x = gx * step; x < xEnd; x++) {
        const i = (y * width + x) * 4;
        sum += Math.max(Math.abs(current[i] - reference[i]), Math.abs(current[i + 1] - reference[i + 1]), Math.abs(current[i + 2] - reference[i + 2]));
      }
      energy[gy * columns + gx] = sum / ((xEnd - gx * step) * (yEnd - gy * step));
    }
    const quantile = (fraction: number) => {
      let count = 0;
      for (let i = 0; i < histogram.length; i++) { count += histogram[i]; if (count >= smooth.length * fraction) return i / 16; }
      return 255;
    };
    mask.fill(0);
    // Fine neighborhoods retain small strong patches; larger neighborhoods pool
    // weak coherent changes. Both use the same fixed reference and bounded grid.
    for (const radius of [1, 4]) {
      const diameter = radius * 2 + 1;
      for (let y = 0; y < rows; y++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += energy[y * columns + Math.max(0, Math.min(columns - 1, k))];
        for (let x = 0; x < columns; x++) {
          horizontal[y * columns + x] = sum / diameter;
          sum += energy[y * columns + Math.min(columns - 1, x + radius + 1)] - energy[y * columns + Math.max(0, x - radius)];
        }
      }
      histogram.fill(0);
      for (let x = 0; x < columns; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += horizontal[Math.max(0, Math.min(rows - 1, k)) * columns + x];
        for (let y = 0; y < rows; y++) {
          const i = y * columns + x;
          smooth[i] = sum / diameter;
          histogram[Math.max(0, Math.min(4080, Math.round(smooth[i] * 16)))]++;
          sum += horizontal[Math.min(rows - 1, y + radius + 1) * columns + x] - horizontal[Math.max(0, y - radius) * columns + x];
        }
      }
      const median = quantile(.5);
      histogram.fill(0);
      for (const value of smooth) histogram[Math.min(4080, Math.round(Math.abs(value - median) * 16))]++;
      const spread = Math.max(.5, 1.4826 * quantile(.5));
      // An absolute floor excludes camera noise; the cap preserves broad, strong
      // changes even when contact occupies most of the image.
      const low = Math.max(4, Math.min(16, median + 2 * spread));
      const minArea = Math.min(smooth.length, Math.max(3, Math.ceil(smooth.length * (radius === 1 ? .0014 : .0056))));
      const minEvidence = smooth.length * (radius === 1 ? 160 : 250) / 14400;
      visited.fill(0);
      // Accumulated change lets many weak pixels support a region without a
      // mandatory strong center. An isolated fluctuation cannot pass both gates.
      for (let start = 0; start < smooth.length; start++) {
        if (visited[start] || smooth[start] <= low) continue;
        let head = 0, count = 1, evidence = 0; queue[0] = start; visited[start] = 1;
        while (head < count) {
          const i = queue[head++], x = i % columns, y = Math.floor(i / columns);
          evidence += (smooth[i] - low) / spread;
          for (let ny = Math.max(0, y - 1); ny <= Math.min(rows - 1, y + 1); ny++) for (let nx = Math.max(0, x - 1); nx <= Math.min(columns - 1, x + 1); nx++) {
            const next = ny * columns + nx;
            if (!visited[next] && smooth[next] > low) { visited[next] = 1; queue[count++] = next; }
          }
        }
        if (count >= minArea && evidence >= minEvidence) for (let j = 0; j < count; j++) {
          const i = queue[j]; mask[i] = Math.max(mask[i], smooth[i] - low);
        }
      }
    }
    // Feather accepted regions, leaving every excluded pixel exactly opaque white.
    for (let y = 0; y < height; y++) {
      const gy = Math.max(0, Math.min(rows - 1, (y + .5) / step - .5)), y0 = Math.floor(gy), y1 = Math.min(rows - 1, y0 + 1), blendY = gy - y0;
      for (let x = 0; x < width; x++) {
        const a = y0 * columns + this.x0[x], b = y0 * columns + this.x1[x], c = y1 * columns + this.x0[x], d = y1 * columns + this.x1[x], blendX = this.blendX[x];
        const top = mask[a] + (mask[b] - mask[a]) * blendX, bottom = mask[c] + (mask[d] - mask[c]) * blendX;
        const color = Math.min(4096, Math.round((top + (bottom - top) * blendY) * 64)) * 3, i = (y * width + x) * 4;
        for (let channel = 0; channel < 3; channel++) output[i + channel] = this.palette[color + channel];
        output[i + 3] = 255;
      }
    }
  }
}
