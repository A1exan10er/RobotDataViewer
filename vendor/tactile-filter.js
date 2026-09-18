/** Display-only spatial cleanup, always relative to the same recorded reference. */
class TactileFilter {
    width;
    height;
    reference;
    step;
    columns;
    rows;
    energy;
    horizontal;
    smooth;
    mask;
    visited;
    queue;
    histogram = new Uint32Array(1021);
    x0;
    x1;
    blendX;
    constructor(width, height, reference) {
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || reference.length !== width * height * 4)
            throw new Error('Frame dimensions differ');
        this.width = width;
        this.height = height;
        this.reference = reference.slice();
        // Analyze small neighborhoods on a bounded grid, without a second full-size image.
        this.step = Math.max(1, Math.ceil(Math.max(width, height) / 160));
        this.columns = Math.ceil(width / this.step);
        this.rows = Math.ceil(height / this.step);
        const size = this.columns * this.rows;
        this.energy = new Float32Array(size);
        this.horizontal = new Float32Array(size);
        this.smooth = new Float32Array(size);
        this.mask = new Float32Array(size);
        this.visited = new Uint8Array(size);
        this.queue = new Int32Array(size);
        this.x0 = new Int32Array(width);
        this.x1 = new Int32Array(width);
        this.blendX = new Float32Array(width);
        for (let x = 0; x < width; x++) {
            const gx = Math.max(0, Math.min(this.columns - 1, (x + .5) / this.step - .5));
            this.x0[x] = Math.floor(gx);
            this.x1[x] = Math.min(this.columns - 1, this.x0[x] + 1);
            this.blendX[x] = gx - this.x0[x];
        }
    }
    render(current, output, gain = 8, cleanup = true) {
        const reference = this.reference;
        if (current.length !== reference.length || output.length !== reference.length)
            throw new Error('Frame dimensions differ');
        if (!cleanup) {
            for (let i = 0; i < output.length; i += 4) {
                for (let c = 0; c < 3; c++)
                    output[i + c] = 255 - Math.min(255, Math.abs(current[i + c] - reference[i + c]) * gain);
                output[i + 3] = 255;
            }
            return;
        }
        const { width, height, columns, rows, step, energy, horizontal, smooth, histogram, mask, visited, queue } = this;
        // Average absolute RGB change, retaining color changes whose signed mean cancels.
        for (let gy = 0; gy < rows; gy++)
            for (let gx = 0; gx < columns; gx++) {
                const xEnd = Math.min(width, (gx + 1) * step), yEnd = Math.min(height, (gy + 1) * step);
                let sum = 0;
                for (let y = gy * step; y < yEnd; y++)
                    for (let x = gx * step; x < xEnd; x++) {
                        const i = (y * width + x) * 4;
                        sum += Math.max(Math.abs(current[i] - reference[i]), Math.abs(current[i + 1] - reference[i + 1]), Math.abs(current[i + 2] - reference[i + 2]));
                    }
                energy[gy * columns + gx] = sum / ((xEnd - gx * step) * (yEnd - gy * step));
            }
        // Separable 3x3 neighborhood mean with clamped image boundaries.
        for (let y = 0; y < rows; y++)
            for (let x = 0; x < columns; x++) {
                const i = y * columns + x;
                horizontal[i] = (energy[i - (x > 0 ? 1 : 0)] + energy[i] + energy[i + (x < columns - 1 ? 1 : 0)]) / 3;
            }
        histogram.fill(0);
        for (let y = 0; y < rows; y++)
            for (let x = 0; x < columns; x++) {
                const i = y * columns + x;
                smooth[i] = (horizontal[i - (y > 0 ? columns : 0)] + horizontal[i] + horizontal[i + (y < rows - 1 ? columns : 0)]) / 3;
                histogram[Math.min(1020, Math.round(smooth[i] * 4))]++;
            }
        const quantile = (fraction) => {
            let count = 0;
            for (let i = 0; i < histogram.length; i++) {
                count += histogram[i];
                if (count >= smooth.length * fraction)
                    return i / 4;
            }
            return 255;
        };
        const quiet = quantile(.2), median = quantile(.5), spread = Math.max(1, median - quiet);
        // Estimate background spread before gain. Caps keep broad/strong changes visible.
        const low = Math.max(4, Math.min(14, median + 3 * spread));
        const high = Math.max(8, Math.min(22, median + 7 * spread));
        const minArea = Math.min(smooth.length, Math.max(3, Math.ceil(smooth.length * .0014)));
        const minCore = Math.min(smooth.length, Math.max(2, Math.ceil(smooth.length * .0004)));
        mask.fill(0);
        visited.fill(0);
        // Hysteresis: a connected region must contain a dense, stronger core.
        // A bright isolated pixel or a weak scattered cloud cannot enable a region.
        for (let start = 0; start < smooth.length; start++) {
            if (visited[start] || smooth[start] <= low)
                continue;
            let head = 0, count = 1, core = 0;
            queue[0] = start;
            visited[start] = 1;
            while (head < count) {
                const i = queue[head++], x = i % columns, y = Math.floor(i / columns);
                if (smooth[i] > high && energy[i] > high)
                    core++;
                for (let ny = Math.max(0, y - 1); ny <= Math.min(rows - 1, y + 1); ny++)
                    for (let nx = Math.max(0, x - 1); nx <= Math.min(columns - 1, x + 1); nx++) {
                        const next = ny * columns + nx;
                        if (!visited[next] && smooth[next] > low) {
                            visited[next] = 1;
                            queue[count++] = next;
                        }
                    }
            }
            if (count >= minArea && core >= minCore)
                for (let j = 0; j < count; j++) {
                    const i = queue[j];
                    mask[i] = Math.min(1, (smooth[i] - low) / (high - low));
                }
        }
        // Feather accepted regions, leaving every excluded pixel exactly opaque white.
        // Reuse recorded RGB differences within them instead of inventing a force map.
        for (let y = 0; y < height; y++) {
            const gy = Math.max(0, Math.min(rows - 1, (y + .5) / step - .5)), y0 = Math.floor(gy), y1 = Math.min(rows - 1, y0 + 1), blendY = gy - y0;
            for (let x = 0; x < width; x++) {
                const a = y0 * columns + this.x0[x], b = y0 * columns + this.x1[x], c = y1 * columns + this.x0[x], d = y1 * columns + this.x1[x], blendX = this.blendX[x];
                const top = mask[a] + (mask[b] - mask[a]) * blendX, bottom = mask[c] + (mask[d] - mask[c]) * blendX;
                const strength = (top + (bottom - top) * blendY) * gain, i = (y * width + x) * 4;
                for (let channel = 0; channel < 3; channel++)
                    output[i + channel] = 255 - Math.min(255, Math.abs(current[i + channel] - reference[i + channel]) * strength);
                output[i + 3] = 255;
            }
        }
    }
}
