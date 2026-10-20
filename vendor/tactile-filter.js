const ROI_WIDTH = 640, ROI_HEIGHT = 360, ROI_SIZE = ROI_WIDTH * ROI_HEIGHT;
// The detected curve follows the outer rim, not the useful sensing surface.
// A Euclidean guard also excludes its sloping upper/lower sections. Measured at
// 640x360, 56 px clears the broad rim in the local recordings; the existing 3 px
// erosion below adds protection against interpolation and small rim movement.
const TACTILE_RIM_INSET = 56;
const rimOffsets = Float64Array.from({ length: 2 * TACTILE_RIM_INSET + 1 }, (_, i) => Math.sqrt(TACTILE_RIM_INSET ** 2 - (i - TACTILE_RIM_INSET) ** 2));
const f32 = Math.fround;
// Centre-aligned bilinear sampling, with replicated edge pixels (also used by the oracle).
function analysisGray(source, width, height) {
    const gray = new Float32Array(ROI_SIZE);
    for (let y = 0; y < ROI_HEIGHT; y++) {
        const sy = Math.max(0, Math.min(height - 1, (y + .5) * height / ROI_HEIGHT - .5));
        const y0 = Math.floor(sy), y1 = Math.min(height - 1, y0 + 1), fy = sy - y0;
        for (let x = 0; x < ROI_WIDTH; x++) {
            const sx = Math.max(0, Math.min(width - 1, (x + .5) * width / ROI_WIDTH - .5));
            const x0 = Math.floor(sx), x1 = Math.min(width - 1, x0 + 1), fx = sx - x0;
            const top = source[y0 * width + x0] * (1 - fx) + source[y0 * width + x1] * fx;
            const bottom = source[y1 * width + x0] * (1 - fx) + source[y1 * width + x1] * fx;
            gray[y * ROI_WIDTH + x] = (top * (1 - fy) + bottom * fy) / 255;
        }
    }
    return gray;
}
function morphology(source, iterations, dilate = false) {
    let input = source.slice(), output = new Uint8Array(ROI_SIZE);
    for (let n = 0; n < iterations; n++) {
        for (let y = 0; y < ROI_HEIGHT; y++)
            for (let x = 0; x < ROI_WIDTH; x++) {
                const p = y * ROI_WIDTH + x;
                const up = ((y + ROI_HEIGHT - 1) % ROI_HEIGHT) * ROI_WIDTH + x, down = ((y + 1) % ROI_HEIGHT) * ROI_WIDTH + x;
                const left = y * ROI_WIDTH + (x + ROI_WIDTH - 1) % ROI_WIDTH, right = y * ROI_WIDTH + (x + 1) % ROI_WIDTH;
                output[p] = dilate ? input[p] | input[up] | input[down] | input[left] | input[right]
                    : (x && y && x < ROI_WIDTH - 1 && y < ROI_HEIGHT - 1 ? input[p] & input[up] & input[down] & input[left] & input[right] : 0);
            }
        [input, output] = [output, input];
    }
    return input;
}
function mainComponent(foreground) {
    const labels = new Int32Array(ROI_SIZE), queue = new Int32Array(ROI_SIZE);
    let serial = 0, best = 0, bestArea = 0, bestCenter = 0, bestSpans = false;
    for (let start = 0; start < ROI_SIZE; start++) {
        if (!foreground[start] || labels[start])
            continue;
        const label = ++serial;
        let head = 0, tail = 1, maxX = 0, minY = ROI_HEIGHT, maxY = 0, sumX = 0;
        queue[0] = start;
        labels[start] = label;
        const visit = (p) => { if (foreground[p] && !labels[p]) {
            labels[p] = label;
            queue[tail++] = p;
        } };
        while (head < tail) {
            const p = queue[head++], x = p % ROI_WIDTH, y = Math.floor(p / ROI_WIDTH);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
            sumX += x;
            if (y)
                visit(p - ROI_WIDTH);
            if (y < ROI_HEIGHT - 1)
                visit(p + ROI_WIDTH);
            if (x)
                visit(p - 1);
            if (x < ROI_WIDTH - 1)
                visit(p + 1);
        }
        const spans = tail >= ROI_SIZE * .01 && maxX > ROI_WIDTH * .45 && maxY - minY > ROI_HEIGHT * .45;
        if ((spans && !bestSpans) || (spans === bestSpans && (tail > bestArea || (tail === bestArea && sumX / tail > bestCenter)))) {
            best = label;
            bestArea = tail;
            bestCenter = sumX / tail;
            bestSpans = spans;
        }
    }
    return Uint8Array.from(labels, value => best && value === best ? 1 : 0);
}
function peaks(gray, foreground) {
    const smooth = new Float32Array(ROI_SIZE), score = new Float32Array(ROI_SIZE);
    for (let y = 0; y < ROI_HEIGHT; y++)
        for (let x = 0; x < ROI_WIDTH; x++) {
            let sum = 0;
            for (let dy = -1; dy <= 1; dy++)
                for (let dx = -1; dx <= 1; dx++)
                    sum = f32(sum + gray[Math.max(0, Math.min(ROI_HEIGHT - 1, y + dy)) * ROI_WIDTH + Math.max(0, Math.min(ROI_WIDTH - 1, x + dx))]);
            smooth[y * ROI_WIDTH + x] = sum / 9;
        }
    for (let y = 0; y < ROI_HEIGHT; y++)
        for (let x = 0; x < ROI_WIDTH; x++) {
            const p = y * ROI_WIDTH + x;
            const gx = x && x < ROI_WIDTH - 1 ? f32(smooth[p + 1] - smooth[p - 1]) : 0;
            const gy = y && y < ROI_HEIGHT - 1 ? f32(smooth[p + ROI_WIDTH] - smooth[p - ROI_WIDTH]) : 0;
            const gradient = f32(Math.sqrt(f32(f32(gx * gx) + f32(gy * gy))));
            score[p] = f32(.65 * smooth[p]) + f32(2.2 * gradient);
        }
    const rows = [];
    for (let y = 0; y < ROI_HEIGHT; y++) {
        const row = [];
        for (let x = 8; x < Math.floor(ROI_WIDTH * .42); x++) {
            const p = y * ROI_WIDTH + x, value = score[p];
            if (foreground[p] && value >= .38 && value >= score[p - 1] && value >= score[p + 1])
                row.push({ x, value });
        }
        row.sort((a, b) => b.value - a.value);
        // The neighboring gripper can have a brighter rim, but leads into a dark gap.
        // Apply after the reference's top-12 selection so calibration is reproducible.
        rows.push(row.slice(0, 12).filter(({ x }) => {
            const surface = gray.slice(y * ROI_WIDTH + x + 14, y * ROI_WIDTH + x + 31);
            surface.sort();
            return surface[8] > .075;
        }));
    }
    return rows;
}
function fitArc(rows, broader = false) {
    const votes = [];
    for (let y = 0; y < ROI_HEIGHT; y++)
        for (const { x, value } of rows[y])
            if (x >= 18 && x <= ROI_WIDTH * .22)
                votes.push({ weight: value * (1.35 - Math.min(Math.abs(y - 180) / 180, .9)), x, y });
    votes.sort((a, b) => b.weight - a.weight || b.x - a.x || b.y - a.y);
    let weight = 0, weightedX = 0, weightedY = 0;
    for (const v of votes.slice(0, 80)) {
        const w = f32(v.weight);
        weight += w;
        weightedX += f32(w * v.x);
        weightedY += f32(w * v.y);
    }
    const meetingX = weight ? f32(weightedX / weight) : ROI_WIDTH * .08, meetingY = weight ? f32(weightedY / weight) : 180;
    let bestScore = -1, bestY = 0;
    // Reuse row selections: a broad search visits thousands of candidate curves.
    // Allocating one point object per supported row per candidate causes GC stalls.
    const selectedRows = new Int16Array(ROI_HEIGHT), bestRows = new Int16Array(ROI_HEIGHT).fill(-1);
    const yStart = broader ? 95 : Math.max(95, meetingY - 55), yEnd = broader ? 255 : Math.min(255, meetingY + 55);
    const xStart = broader ? 18 : Math.max(18, meetingX - 32), xEnd = broader ? ROI_WIDTH * .20 : Math.min(ROI_WIDTH * .20, meetingX + 32);
    for (let y0 = yStart; y0 < yEnd; y0 += 8)
        for (let x0 = xStart; x0 < xEnd; x0 += 4)
            for (let k = 0; k < 22; k++) {
                const curvature = .0014 + k * (.0065 - .0014) / 21;
                let total = 0, count = 0;
                for (let y = 0; y < ROI_HEIGHT; y++) {
                    const predicted = x0 + curvature * (y - y0) ** 2;
                    let value = 0, selected = -1;
                    for (const peak of rows[y]) {
                        const error = Math.abs(peak.x - predicted);
                        if (error > 12)
                            continue;
                        const score = peak.value * (1 - error / 12.000001) * (1 + .22 * Math.max(0, peak.x - predicted) / 12.000001);
                        if (score > value) {
                            value = score;
                            selected = peak.x;
                        }
                    }
                    selectedRows[y] = selected;
                    if (selected >= 0) {
                        total += value;
                        count++;
                    }
                }
                const score = total * (.5 + Math.min(count / 220, 1)) - Math.abs(x0 - meetingX) * .10 - Math.abs(y0 - meetingY) * .025;
                if (score > bestScore) {
                    bestScore = score;
                    bestY = y0;
                    bestRows.set(selectedRows);
                }
            }
    const bestPoints = Array.from(bestRows, (x, y) => ({ x, y })).filter(p => p.x >= 0);
    if (bestPoints.length < ROI_HEIGHT * .20)
        return { curve: new Float32Array(), confidence: 0 };
    // Two-column least squares: x = intercept + curvature * (y - vertexY)^2.
    const z = bestPoints.map(p => f32(f32(p.y - bestY) ** 2));
    const meanZ = z.reduce((a, b) => a + b, 0) / z.length, meanX = bestPoints.reduce((a, p) => a + p.x, 0) / z.length;
    let numerator = 0, denominator = 0;
    for (let i = 0; i < z.length; i++) {
        numerator += (z[i] - meanZ) * (bestPoints[i].x - meanX);
        denominator += (z[i] - meanZ) ** 2;
    }
    const slope = denominator ? numerator / denominator : 0, intercept = f32(meanX - slope * meanZ), curvature = Math.max(.0005, Math.min(.012, f32(slope)));
    const model = Float32Array.from({ length: ROI_HEIGHT }, (_, y) => f32(intercept + f32(curvature * f32(f32(y - bestY) ** 2))));
    const selected = [], observed = new Uint8Array(ROI_HEIGHT);
    for (let y = 0; y < ROI_HEIGHT; y++) {
        let value = 0, x = -1;
        for (const peak of rows[y]) {
            const error = Math.abs(peak.x - model[y]);
            if (error > 18)
                continue;
            const score = peak.value * (1 - error / 18.000001) * (1 + .35 * Math.max(0, peak.x - model[y]) / 18.000001);
            if (score > value) {
                value = score;
                x = peak.x;
            }
        }
        if (x >= 0) {
            selected.push({ x, y });
            observed[y] = 1;
        }
    }
    let curve = model;
    if (selected.length >= 4) {
        const blended = new Float32Array(ROI_HEIGHT);
        let next = 0;
        for (let y = 0; y < ROI_HEIGHT; y++) {
            while (next < selected.length && selected[next].y < y)
                next++;
            let x;
            if (!next)
                x = selected[0].y === y ? selected[0].x : model[0];
            else if (next === selected.length)
                x = model[ROI_HEIGHT - 1];
            else {
                const a = selected[next - 1], b = selected[next];
                x = a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y);
            }
            x = Math.max(f32(model[y] - 18), Math.min(f32(model[y] + 18), x));
            let support = 0;
            for (let r = Math.max(0, y - 10); r <= Math.min(ROI_HEIGHT - 1, y + 10); r++)
                support += observed[r];
            const w = Math.min(f32(support / 10), f32(.55));
            blended[y] = w * x + f32(f32(1 - w) * model[y]);
        }
        const median = new Float32Array(ROI_HEIGHT);
        for (let y = 0; y < ROI_HEIGHT; y++) {
            const values = blended.slice(Math.max(0, y - 20), Math.min(ROI_HEIGHT, y + 21));
            values.sort();
            median[y] = (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2;
        }
        curve = new Float32Array(ROI_HEIGHT);
        for (let y = 0; y < ROI_HEIGHT; y++) {
            let sum = 0;
            for (let k = -15; k <= 15; k++)
                sum += median[Math.max(0, Math.min(ROI_HEIGHT - 1, y + k))] * f32(1 / 31);
            curve[y] = sum;
        }
    }
    const error = selected.length ? selected.reduce((sum, p) => sum + Math.abs(p.x - curve[p.y]), 0) / selected.length : 30;
    return { curve, confidence: Math.max(0, Math.min(1, selected.length / ROI_HEIGHT * (1 - Math.min(error / 30, .85)))) };
}
function validCurve(curve, confidence) {
    const leftmost = curve.length ? Math.min(...curve) : Infinity;
    return curve.length === ROI_HEIGHT && curve.every(Number.isFinite) && Number.isFinite(confidence) && confidence >= .75 && curve[0] - leftmost >= 25 && curve[ROI_HEIGHT - 1] - leftmost >= 25;
}
function regionMask(foreground, curve, width, height) {
    const region = mainComponent(foreground), mask = new Uint8Array(width * height);
    const topSlope = (curve[TACTILE_RIM_INSET] - curve[0]) / TACTILE_RIM_INSET;
    const bottomSlope = (curve[ROI_HEIGHT - 1] - curve[ROI_HEIGHT - 1 - TACTILE_RIM_INSET]) / TACTILE_RIM_INSET;
    // Continue the rim beyond the image instead of treating its cut-off endpoints
    // as flat caps. Otherwise a crescent leaks back in near the top/bottom corners.
    const extended = Float64Array.from({ length: ROI_HEIGHT + 2 * TACTILE_RIM_INSET }, (_, i) => {
        const y = i - TACTILE_RIM_INSET;
        return y < 0 ? curve[0] + y * topSlope : y >= ROI_HEIGHT ? curve[ROI_HEIGHT - 1] + (y - ROI_HEIGHT + 1) * bottomSlope : curve[y];
    });
    for (let y = 0; y < ROI_HEIGHT; y++) {
        let boundary = 0;
        // Dilate the excluded side by a disk, rather than adding a horizontal offset
        // that becomes too narrow wherever the arc slopes steeply.
        for (let k = 0; k < rimOffsets.length; k++)
            boundary = Math.max(boundary, extended[y + k] + rimOffsets[k]);
        for (let x = 0; x < ROI_WIDTH; x++)
            if (x < boundary)
                region[y * ROI_WIDTH + x] = 0;
    }
    const eroded = morphology(region, 3);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
            mask[y * width + x] = eroded[Math.min(ROI_HEIGHT - 1, Math.floor((y + .5) * ROI_HEIGHT / height)) * ROI_WIDTH + Math.min(ROI_WIDTH - 1, Math.floor((x + .5) * ROI_WIDTH / width))];
    return mask;
}
function regionForeground(gray) { return morphology(morphology(Uint8Array.from(gray, v => v > .075 ? 1 : 0), 3, true), 3); }
function detectTactileRegion(baseline, width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || baseline.length !== width * height)
        throw new Error('Invalid tactile region dimensions');
    const gray = analysisGray(baseline, width, height), foreground = regionForeground(gray), rows = peaks(gray, foreground);
    const primary = fitArc(rows);
    let result = primary;
    for (const method of ['local', 'broader']) {
        if (method === 'broader')
            result = fitArc(rows, true);
        if (!validCurve(result.curve, result.confidence))
            continue;
        const mask = regionMask(foreground, result.curve, width, height);
        if (mask.some(Boolean))
            return { ...result, mask, status: 'ready', method };
    }
    return { ...primary, mask: new Uint8Array(baseline.length), status: 'not-found' };
}
function rimStrips(gray, curve) {
    const rim = new Uint8Array(ROI_HEIGHT * 45);
    for (let y = 0; y < ROI_HEIGHT; y++)
        for (let k = 0; k < 45; k++)
            rim[y * 45 + k] = Math.round(gray[y * ROI_WIDTH + Math.max(0, Math.min(ROI_WIDTH - 1, Math.round(curve[y]) + k - 12))] * 255);
    return rim;
}
function regionGeometry(baseline, width, height, curve, confidence, episodeId = '') {
    if (!validCurve(curve, confidence))
        throw new Error('Invalid donor curve');
    return { width, height, curve: curve.slice(), rim: rimStrips(analysisGray(baseline, width, height), curve), confidence, episodeId };
}
/** Validate a donor against the current rim without requiring another curve fit. */
function borrowTactileRegion(baseline, width, height, donor) {
    if (donor.width !== width || donor.height !== height || baseline.length !== width * height || donor.rim.length !== ROI_HEIGHT * 45 || !validCurve(donor.curve, donor.confidence))
        return;
    const gray = analysisGray(baseline, width, height), current = rimStrips(gray, donor.curve);
    let upper = 0, lower = 0;
    for (let y = 0; y < ROI_HEIGHT; y++) {
        let a = 0, b = 0, aa = 0, bb = 0, ab = 0;
        for (let k = 0; k < 45; k++) {
            const u = current[y * 45 + k], v = donor.rim[y * 45 + k];
            a += u;
            b += v;
            aa += u * u;
            bb += v * v;
            ab += u * v;
        }
        const va = aa - a * a / 45, vb = bb - b * b / 45;
        if (va / 45 < 25 || vb / 45 < 25)
            continue;
        if ((ab - a * b / 45) / Math.sqrt(va * vb) >= .70) {
            if (y < 180)
                upper++;
            else
                lower++;
        }
    }
    if (upper + lower < 180 || upper < 20 || lower < 20)
        return;
    const mask = regionMask(regionForeground(gray), donor.curve, width, height);
    if (!mask.some(Boolean))
        return;
    return { mask, curve: donor.curve.slice(), confidence: donor.confidence, status: 'ready', method: 'neighbor' };
}
/** Geometry-only donor preparation: at most eight opening samples, no noise statistics. */
function detectRegionSamples(frames, width, height) {
    if (!frames.length || frames.some(f => f.length !== width * height))
        return;
    const median = new Uint8Array(width * height), values = new Uint8Array(frames.length);
    for (let p = 0; p < median.length; p++) {
        frames.forEach((f, i) => { values[i] = f[p]; });
        values.sort();
        median[p] = Math.floor((values[(values.length - 1) >> 1] + values[values.length >> 1]) / 2);
    }
    const region = detectTactileRegion(median, width, height);
    return region.status === 'ready' ? regionGeometry(median, width, height, region.curve, region.confidence) : undefined;
}


function baselineGeometry(model, episodeId = '') {
    return model.roiStatus === 'ready' && model.roiMethod !== 'neighbor' && model.roiCurve?.length
        ? regionGeometry(model.baseline, model.width, model.height, model.roiCurve, model.roiConfidence, episodeId) : undefined;
}
function adoptBaselineRegion(model, donor) {
    const region = borrowTactileRegion(model.baseline, model.width, model.height, donor);
    return region ? { ...model, roiMask: region.mask, roiCurve: region.curve, roiStatus: region.status, roiConfidence: region.confidence, roiMethod: 'neighbor', roiDonor: donor.episodeId } : undefined;
}
function copyTactileBaseline(model) {
    return { ...model, baseline: model.baseline.slice(), noiseFloor: model.noiseFloor.slice(), roiMask: model.roiMask.slice(), roiCurve: model.roiCurve?.slice() };
}
// Python round() uses ties-to-even, including for fractional recorded frame rates.
function tactileBaselineCount(fps, totalFrames) {
    const value = 2 * (Number.isFinite(fps) && fps > 0 ? fps : 30);
    const floor = Math.floor(value);
    const rounded = value - floor === .5 ? floor + floor % 2 : Math.round(value);
    return Math.min(Math.max(0, Math.floor(totalFrames)), Math.max(8, rounded));
}
function tactileGray(rgba, gray = new Uint8Array(rgba.length / 4)) {
    if (rgba.length !== gray.length * 4)
        throw new Error('Frame dimensions differ');
    // OpenCV's 8-bit RGB-to-gray fixed-point conversion (source bitmap order is RGB).
    for (let p = 0, i = 0; p < gray.length; p++, i += 4)
        gray[p] = (rgba[i] * 9798 + rgba[i + 1] * 19235 + rgba[i + 2] * 3735 + 16384) >> 15;
    return gray;
}
class TactileCalibration {
    frames = [];
    width;
    height;
    constructor(width, height) {
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
            throw new Error('Frame dimensions differ');
        this.width = width;
        this.height = height;
    }
    add(rgba) {
        if (rgba.length !== this.width * this.height * 4)
            throw new Error('Frame dimensions differ');
        const gray = tactileGray(rgba);
        this.frames.push(gray);
        // The worker can reuse this immutable sample for initial playback after finish().
        return gray;
    }
    addGray(gray) {
        if (gray.length !== this.width * this.height)
            throw new Error('Frame dimensions differ');
        this.frames.push(gray.slice());
    }
    quietPrefix() {
        const frames = this.frames;
        // Eight opening frames are assumed unloaded. A persistent, coherent image
        // change later in the two-second window ends calibration before that change.
        // This is a conservative image heuristic, not a physical contact classifier.
        if (frames.length <= 8 || this.width < 16 || this.height < 16)
            return frames;
        const columns = Math.ceil(this.width / 8), rows = Math.ceil(this.height / 8), count = columns * rows;
        const anchor = new Uint8Array(this.width * this.height), values = new Uint8Array(8);
        for (let p = 0; p < anchor.length; p++) {
            for (let i = 0; i < 8; i++)
                values[i] = frames[i][p];
            values.sort();
            anchor[p] = Math.floor((values[3] + values[4]) / 2);
        }
        const limits = new Float32Array(count), scores = new Float32Array(count), sizes = new Uint8Array(count);
        for (let y = 0; y < this.height; y++)
            for (let x = 0; x < this.width; x++)
                sizes[Math.floor(y / 8) * columns + Math.floor(x / 8)]++;
        let previous = -1;
        for (let i = 0; i < frames.length; i++) {
            scores.fill(0);
            for (let y = 0; y < this.height; y++)
                for (let x = 0; x < this.width; x++)
                    scores[Math.floor(y / 8) * columns + Math.floor(x / 8)] += Math.abs(frames[i][y * this.width + x] - anchor[y * this.width + x]);
            let changed = 0;
            for (let b = 0; b < count; b++) {
                const value = scores[b] / sizes[b];
                if (i < 8)
                    limits[b] = Math.max(limits[b], value);
                else if (value > limits[b] + 4)
                    changed++;
            }
            if (i < 8)
                continue;
            if (changed >= Math.max(4, Math.ceil(count * .002))) {
                if (previous === i - 1)
                    return frames.slice(0, previous);
                previous = i;
            }
            else
                previous = -1;
        }
        return frames;
    }
    finish(measure) {
        const started = performance.now();
        const candidateCount = this.frames.length, frames = this.quietPrefix(), n = frames.length;
        if (!n)
            throw new Error('No baseline frames');
        const baseline = new Uint8Array(this.width * this.height), noiseFloor = new Float32Array(baseline.length);
        const histogram = new Uint32Array(256);
        const middleLow = Math.floor((n - 1) / 2), middleHigh = Math.ceil((n - 1) / 2);
        const rank = .99 * (n - 1), lowerRank = Math.floor(rank), upperRank = Math.ceil(rank);
        for (let p = 0; p < baseline.length; p++) {
            histogram.fill(0);
            let min = 255, max = 0;
            for (const gray of frames) {
                const v = gray[p];
                histogram[v]++;
                min = Math.min(min, v);
                max = Math.max(max, v);
            }
            let count = 0, low = -1, high = min;
            for (let v = min; v <= max; v++) {
                count += histogram[v];
                if (low < 0 && count > middleLow)
                    low = v;
                if (count > middleHigh) {
                    high = v;
                    break;
                }
            }
            const median = Math.floor((low + high) / 2);
            baseline[p] = median;
            // Traverse the same histogram by absolute deviation from the truncated median.
            count = 0;
            low = -1;
            high = 0;
            for (let d = 0; d <= Math.max(median - min, max - median); d++) {
                count += (median + d <= 255 ? histogram[median + d] : 0) + (d && median - d >= 0 ? histogram[median - d] : 0);
                if (low < 0 && count > lowerRank)
                    low = d;
                if (count > upperRank) {
                    high = d;
                    break;
                }
            }
            noiseFloor[p] = low + (high - low) * (rank - lowerRank);
        }
        this.clear();
        const regionStarted = performance.now();
        measure?.('statistics', regionStarted - started);
        const region = detectTactileRegion(baseline, this.width, this.height);
        measure?.('region', performance.now() - regionStarted);
        return { width: this.width, height: this.height, sampleCount: n, candidateCount, baseline, noiseFloor,
            roiMask: region.mask, roiStatus: region.status, roiConfidence: region.confidence, roiCurve: region.curve, roiMethod: region.method };
    }
    clear() { this.frames = []; }
}
// OpenCV COLORMAP_INFERNO, 256 RGB entries. Kept inline for the bundled workers.
const INFERNO = new Uint8Array([
    0, 0, 4, 1, 0, 5, 1, 1, 6, 1, 1, 8, 2, 1, 10, 2, 2, 12, 2, 2, 14, 3, 2, 16, 4, 3, 18, 4, 3, 20, 5, 4, 23, 6, 4, 25, 7, 5, 27, 8, 5, 29, 9, 6, 31, 10, 7, 34,
    11, 7, 36, 12, 8, 38, 13, 8, 41, 14, 9, 43, 16, 9, 45, 17, 10, 48, 18, 10, 50, 20, 11, 52, 21, 11, 55, 22, 11, 57, 24, 12, 60, 25, 12, 62, 27, 12, 65, 28, 12, 67, 30, 12, 69, 31, 12, 72,
    33, 12, 74, 35, 12, 76, 36, 12, 79, 38, 12, 81, 40, 11, 83, 41, 11, 85, 43, 11, 87, 45, 11, 89, 47, 10, 91, 49, 10, 92, 50, 10, 94, 52, 10, 95, 54, 9, 97, 56, 9, 98, 57, 9, 99, 59, 9, 100,
    61, 9, 101, 62, 9, 102, 64, 10, 103, 66, 10, 104, 68, 10, 104, 69, 10, 105, 71, 11, 106, 73, 11, 106, 74, 12, 107, 76, 12, 107, 77, 13, 108, 79, 13, 108, 81, 14, 108, 82, 14, 109, 84, 15, 109, 85, 15, 109,
    87, 16, 110, 89, 16, 110, 90, 17, 110, 92, 18, 110, 93, 18, 110, 95, 19, 110, 97, 19, 110, 98, 20, 110, 100, 21, 110, 101, 21, 110, 103, 22, 110, 105, 22, 110, 106, 23, 110, 108, 24, 110, 109, 24, 110, 111, 25, 110,
    113, 25, 110, 114, 26, 110, 116, 26, 110, 117, 27, 110, 119, 28, 109, 120, 28, 109, 122, 29, 109, 124, 29, 109, 125, 30, 109, 127, 30, 108, 128, 31, 108, 130, 32, 108, 132, 32, 107, 133, 33, 107, 135, 33, 107, 136, 34, 106,
    138, 34, 106, 140, 35, 105, 141, 35, 105, 143, 36, 105, 144, 37, 104, 146, 37, 104, 147, 38, 103, 149, 38, 103, 151, 39, 102, 152, 39, 102, 154, 40, 101, 155, 41, 100, 157, 41, 100, 159, 42, 99, 160, 42, 99, 162, 43, 98,
    163, 44, 97, 165, 44, 96, 166, 45, 96, 168, 46, 95, 169, 46, 94, 171, 47, 94, 173, 48, 93, 174, 48, 92, 176, 49, 91, 177, 50, 90, 179, 50, 90, 180, 51, 89, 182, 52, 88, 183, 53, 87, 185, 53, 86, 186, 54, 85,
    188, 55, 84, 189, 56, 83, 191, 57, 82, 192, 58, 81, 193, 58, 80, 195, 59, 79, 196, 60, 78, 198, 61, 77, 199, 62, 76, 200, 63, 75, 202, 64, 74, 203, 65, 73, 204, 66, 72, 206, 67, 71, 207, 68, 70, 208, 69, 69,
    210, 70, 68, 211, 71, 67, 212, 72, 66, 213, 74, 65, 215, 75, 63, 216, 76, 62, 217, 77, 61, 218, 78, 60, 219, 80, 59, 221, 81, 58, 222, 82, 56, 223, 83, 55, 224, 85, 54, 225, 86, 53, 226, 87, 52, 227, 89, 51,
    228, 90, 49, 229, 92, 48, 230, 93, 47, 231, 94, 46, 232, 96, 45, 233, 97, 43, 234, 99, 42, 235, 100, 41, 235, 102, 40, 236, 103, 38, 237, 105, 37, 238, 106, 36, 239, 108, 35, 239, 110, 33, 240, 111, 32, 241, 113, 31,
    241, 115, 29, 242, 116, 28, 243, 118, 27, 243, 120, 25, 244, 121, 24, 245, 123, 23, 245, 125, 21, 246, 126, 20, 246, 128, 19, 247, 130, 18, 247, 132, 16, 248, 133, 15, 248, 135, 14, 248, 137, 12, 249, 139, 11, 249, 140, 10,
    249, 142, 9, 250, 144, 8, 250, 146, 7, 250, 148, 7, 251, 150, 6, 251, 151, 6, 251, 153, 6, 251, 155, 6, 251, 157, 7, 252, 159, 7, 252, 161, 8, 252, 163, 9, 252, 165, 10, 252, 166, 12, 252, 168, 13, 252, 170, 15,
    252, 172, 17, 252, 174, 18, 252, 176, 20, 252, 178, 22, 252, 180, 24, 251, 182, 26, 251, 184, 29, 251, 186, 31, 251, 188, 33, 251, 190, 35, 250, 192, 38, 250, 194, 40, 250, 196, 42, 250, 198, 45, 249, 199, 47, 249, 201, 50,
    249, 203, 53, 248, 205, 55, 248, 207, 58, 247, 209, 61, 247, 211, 64, 246, 213, 67, 246, 215, 70, 245, 217, 73, 245, 219, 76, 244, 221, 79, 244, 223, 83, 244, 225, 86, 243, 227, 90, 243, 229, 93, 242, 230, 97, 242, 232, 101,
    242, 234, 105, 241, 236, 109, 241, 237, 113, 241, 239, 117, 241, 241, 121, 242, 242, 125, 242, 244, 130, 243, 245, 134, 243, 246, 138, 244, 248, 142, 245, 249, 146, 246, 250, 150, 248, 251, 154, 249, 252, 157, 250, 253, 161, 252, 255, 164
]);
const GAMMA = Uint8Array.from({ length: 256 }, (_, i) => Math.floor(Math.pow(i / 255, .7) * 255));
// OpenCV chooses a 17-tap kernel for sigma=2 on float32 data; BORDER_DEFAULT is REFLECT_101.
const GAUSSIAN = Float32Array.from({ length: 17 }, (_, i) => Math.exp(-((i - 8) ** 2) / 8));
const gaussianSum = Array.from({ length: 17 }, (_, i) => Math.exp(-((i - 8) ** 2) / 8)).reduce((a, b) => a + b, 0);
for (let i = 0; i < 17; i++)
    GAUSSIAN[i] = Math.exp(-((i - 8) ** 2) / 8) / gaussianSum;
function reflect101(i, size) {
    if (size === 1)
        return 0;
    const period = 2 * (size - 1), position = ((i % period) + period) % period;
    return position < size ? position : period - position;
}
class TactileFilter {
    model;
    gray;
    cleaned;
    horizontal;
    smooth;
    xIndices;
    yIndices;
    visited;
    component;
    minComponent;
    constructor(model, options = {}) {
        const { width, height, baseline, noiseFloor, sampleCount, roiMask, roiStatus, roiConfidence } = model;
        const size = width * height;
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || !Number.isInteger(sampleCount) || sampleCount < 1 || baseline.length !== size || noiseFloor.length !== size || roiMask?.length !== size || !['ready', 'not-found'].includes(roiStatus) || !Number.isFinite(roiConfidence))
            throw new Error('Invalid tactile baseline');
        this.model = { ...model, baseline: baseline.slice(), noiseFloor: noiseFloor.slice(), roiMask: roiMask.slice() };
        this.gray = new Uint8Array(size);
        this.cleaned = new Float32Array(size);
        this.horizontal = new Float32Array(size);
        this.smooth = new Float32Array(size);
        this.xIndices = Int32Array.from({ length: width * 17 }, (_, i) => reflect101(Math.floor(i / 17) + i % 17 - 8, width));
        this.yIndices = Int32Array.from({ length: height * 17 }, (_, i) => reflect101(Math.floor(i / 17) + i % 17 - 8, height) * width);
        const sensingPixels = roiMask.reduce((sum, pixel) => sum + Number(!!pixel), 0);
        this.minComponent = options.spatialCleanup === false || sensingPixels < 9 ? 1 : Math.max(3, Math.min(8, Math.round(sensingPixels / 50000)));
        this.visited = new Uint8Array(size);
        this.component = new Int32Array(size);
    }
    suppressSpeckles() {
        if (this.minComponent <= 1)
            return;
        const { width, height } = this.model, { cleaned, visited, component } = this;
        visited.fill(0);
        // Remove tiny noise islands BEFORE Gaussian smoothing spreads them out.
        // No temporal state: static contact and random seeks produce identical pixels.
        for (let start = 0; start < cleaned.length; start++) {
            if (visited[start] || cleaned[start] <= 0)
                continue;
            let count = 1;
            component[0] = start;
            visited[start] = 1;
            for (let next = 0; next < count; next++) {
                const p = component[next], x = p % width, y = Math.floor(p / width);
                for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++)
                    for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
                        const q = yy * width + xx;
                        if (!visited[q] && cleaned[q] > 0) {
                            visited[q] = 1;
                            component[count++] = q;
                        }
                    }
            }
            if (count < this.minComponent)
                for (let i = 0; i < count; i++)
                    cleaned[component[i]] = 0;
        }
    }
    render(current, output, gain = 10, cleanup = true) {
        if (current.length !== this.gray.length * 4)
            throw new Error('Frame dimensions differ');
        tactileGray(current, this.gray);
        this.renderGray(this.gray, output, gain, cleanup);
    }
    renderGray(gray, output, gain = 10, cleanup = true) {
        const { width, height, baseline, noiseFloor, roiMask, roiStatus } = this.model;
        if (gray.length !== baseline.length || output.length !== baseline.length * 4)
            throw new Error('Frame dimensions differ');
        if (roiStatus !== 'ready') {
            output.fill(0);
            for (let i = 3; i < output.length; i += 4)
                output[i] = 255;
            return;
        }
        gain = Number.isFinite(gain) ? Math.max(1, Math.min(16, gain)) : 10;
        const { cleaned, horizontal, smooth, xIndices, yIndices } = this;
        for (let p = 0; p < gray.length; p++) {
            const delta = Math.abs(gray[p] - baseline[p]);
            cleaned[p] = roiMask[p] ? (cleanup ? Math.max(Math.fround(delta - noiseFloor[p]) - 2, 0) : delta) : 0;
        }
        if (cleanup) {
            this.suppressSpeckles();
            for (let y = 0; y < height; y++)
                for (let x = 0; x < width; x++) {
                    const row = y * width, indices = x * 17;
                    let sum = cleaned[row + x] * GAUSSIAN[8];
                    for (let k = 1; k <= 8; k++)
                        sum += (cleaned[row + xIndices[indices + 8 - k]] + cleaned[row + xIndices[indices + 8 + k]]) * GAUSSIAN[8 + k];
                    horizontal[y * width + x] = sum;
                }
            for (let y = 0; y < height; y++)
                for (let x = 0; x < width; x++) {
                    const indices = y * 17;
                    let sum = horizontal[y * width + x] * GAUSSIAN[8];
                    for (let k = 1; k <= 8; k++)
                        sum += (horizontal[yIndices[indices + 8 - k] + x] + horizontal[yIndices[indices + 8 + k] + x]) * GAUSSIAN[8 + k];
                    smooth[y * width + x] = sum;
                }
        }
        const values = cleanup ? smooth : cleaned;
        for (let p = 0, i = 0; p < values.length; p++, i += 4) {
            let value = GAMMA[Math.min(255, Math.floor(Math.fround(values[p] * gain)))];
            if (!roiMask[p] || (cleanup && value < 10))
                value = 0;
            const color = value * 3;
            output[i] = value ? INFERNO[color] : 0;
            output[i + 1] = value ? INFERNO[color + 1] : 0;
            output[i + 2] = value ? INFERNO[color + 2] : 0;
            output[i + 3] = 255;
        }
    }
}
