/** Fixed sensing region, adapted from tools/reference/generate_roi.py.
 * Detection always runs in canonical coordinates; display pixels are never resized.
 */
export type RegionMethod = 'local' | 'broader' | 'neighbor';
export type TactileRegion = { mask: Uint8Array; status: 'ready' | 'not-found'; confidence: number; curve: Float32Array; method?: RegionMethod };
export type RegionGeometry = { width:number; height:number; curve:Float32Array; rim:Uint8Array; confidence:number; episodeId:string };
const ROI_WIDTH = 640, ROI_HEIGHT = 360, ROI_SIZE = ROI_WIDTH * ROI_HEIGHT;
// The detected curve follows the outer rim, not the useful sensing surface.
// A Euclidean guard also excludes its sloping upper/lower sections. Measured at
// 640x360, 56 px clears the broad rim in the local recordings; the existing 3 px
// erosion below adds protection against interpolation and small rim movement.
export const TACTILE_RIM_INSET = 56;
const rimOffsets = Float64Array.from({length:2*TACTILE_RIM_INSET+1},(_,i)=>Math.sqrt(TACTILE_RIM_INSET**2-(i-TACTILE_RIM_INSET)**2));
const f32 = Math.fround;
type Peak = { x: number; value: number };

// Centre-aligned bilinear sampling, with replicated edge pixels (also used by the oracle).
function analysisGray(source: Uint8Array, width: number, height: number): Float32Array {
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

function morphology(source: Uint8Array, iterations: number, dilate = false): Uint8Array {
  let input = source.slice(), output = new Uint8Array(ROI_SIZE);
  for (let n = 0; n < iterations; n++) {
    for (let y = 0; y < ROI_HEIGHT; y++) for (let x = 0; x < ROI_WIDTH; x++) {
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

function mainComponent(foreground: Uint8Array): Uint8Array {
  const labels = new Int32Array(ROI_SIZE), queue = new Int32Array(ROI_SIZE);
  let serial = 0, best = 0, bestArea = 0, bestCenter = 0, bestSpans = false;
  for (let start = 0; start < ROI_SIZE; start++) {
    if (!foreground[start] || labels[start]) continue;
    const label = ++serial; let head = 0, tail = 1, maxX = 0, minY = ROI_HEIGHT, maxY = 0, sumX = 0;
    queue[0] = start; labels[start] = label;
    const visit = (p: number) => { if (foreground[p] && !labels[p]) { labels[p] = label; queue[tail++] = p; } };
    while (head < tail) {
      const p = queue[head++], x = p % ROI_WIDTH, y = Math.floor(p / ROI_WIDTH);
      maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); sumX += x;
      if (y) visit(p - ROI_WIDTH); if (y < ROI_HEIGHT - 1) visit(p + ROI_WIDTH);
      if (x) visit(p - 1); if (x < ROI_WIDTH - 1) visit(p + 1);
    }
    const spans = tail >= ROI_SIZE * .01 && maxX > ROI_WIDTH * .45 && maxY - minY > ROI_HEIGHT * .45;
    if ((spans && !bestSpans) || (spans === bestSpans && (tail > bestArea || (tail === bestArea && sumX / tail > bestCenter)))) {
      best = label; bestArea = tail; bestCenter = sumX / tail; bestSpans = spans;
    }
  }
  return Uint8Array.from(labels, value => best && value === best ? 1 : 0);
}

function peaks(gray: Float32Array, foreground: Uint8Array): Peak[][] {
  const smooth = new Float32Array(ROI_SIZE), score = new Float32Array(ROI_SIZE);
  for (let y = 0; y < ROI_HEIGHT; y++) for (let x = 0; x < ROI_WIDTH; x++) {
    let sum = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
      sum = f32(sum + gray[Math.max(0, Math.min(ROI_HEIGHT - 1, y + dy)) * ROI_WIDTH + Math.max(0, Math.min(ROI_WIDTH - 1, x + dx))]);
    smooth[y * ROI_WIDTH + x] = sum / 9;
  }
  for (let y = 0; y < ROI_HEIGHT; y++) for (let x = 0; x < ROI_WIDTH; x++) {
    const p = y * ROI_WIDTH + x;
    const gx = x && x < ROI_WIDTH - 1 ? f32(smooth[p + 1] - smooth[p - 1]) : 0;
    const gy = y && y < ROI_HEIGHT - 1 ? f32(smooth[p + ROI_WIDTH] - smooth[p - ROI_WIDTH]) : 0;
    const gradient = f32(Math.sqrt(f32(f32(gx * gx) + f32(gy * gy))));
    score[p] = f32(.65 * smooth[p]) + f32(2.2 * gradient);
  }
  const rows: Peak[][] = [];
  for (let y = 0; y < ROI_HEIGHT; y++) {
    const row: Peak[] = [];
    for (let x = 8; x < Math.floor(ROI_WIDTH * .42); x++) {
      const p = y * ROI_WIDTH + x, value = score[p];
      if (foreground[p] && value >= .38 && value >= score[p - 1] && value >= score[p + 1]) row.push({ x, value });
    }
    row.sort((a, b) => b.value - a.value);
    // The neighboring gripper can have a brighter rim, but leads into a dark gap.
    // Apply after the reference's top-12 selection so calibration is reproducible.
    rows.push(row.slice(0, 12).filter(({ x }) => {
      const surface = gray.slice(y * ROI_WIDTH + x + 14, y * ROI_WIDTH + x + 31); surface.sort();
      return surface[8] > .075;
    }));
  }
  return rows;
}

function fitArc(rows: Peak[][], broader = false): { curve: Float32Array; confidence: number } {
  const votes: { weight: number; x: number; y: number }[] = [];
  for (let y = 0; y < ROI_HEIGHT; y++) for (const { x, value } of rows[y]) if (x >= 18 && x <= ROI_WIDTH * .22)
    votes.push({ weight: value * (1.35 - Math.min(Math.abs(y - 180) / 180, .9)), x, y });
  votes.sort((a, b) => b.weight - a.weight || b.x - a.x || b.y - a.y);
  let weight = 0, weightedX = 0, weightedY = 0;
  for (const v of votes.slice(0, 80)) { const w = f32(v.weight); weight += w; weightedX += f32(w * v.x); weightedY += f32(w * v.y); }
  const meetingX = weight ? f32(weightedX / weight) : ROI_WIDTH * .08, meetingY = weight ? f32(weightedY / weight) : 180;
  let bestScore = -1, bestY = 0;
  // Reuse row selections: a broad search visits thousands of candidate curves.
  // Allocating one point object per supported row per candidate causes GC stalls.
  const selectedRows=new Int16Array(ROI_HEIGHT),bestRows=new Int16Array(ROI_HEIGHT).fill(-1);
  const yStart = broader ? 95 : Math.max(95, meetingY - 55), yEnd = broader ? 255 : Math.min(255, meetingY + 55);
  const xStart = broader ? 18 : Math.max(18, meetingX - 32), xEnd = broader ? ROI_WIDTH * .20 : Math.min(ROI_WIDTH * .20, meetingX + 32);
  for (let y0 = yStart; y0 < yEnd; y0 += 8) for (let x0 = xStart; x0 < xEnd; x0 += 4) for (let k = 0; k < 22; k++) {
    const curvature = .0014 + k * (.0065 - .0014) / 21;
    let total = 0, count = 0;
    for (let y = 0; y < ROI_HEIGHT; y++) {
      const predicted = x0 + curvature * (y - y0) ** 2; let value = 0, selected = -1;
      for (const peak of rows[y]) {
        const error = Math.abs(peak.x - predicted); if (error > 12) continue;
        const score = peak.value * (1 - error / 12.000001) * (1 + .22 * Math.max(0, peak.x - predicted) / 12.000001);
        if (score > value) { value = score; selected = peak.x; }
      }
      selectedRows[y]=selected;
      if (selected >= 0) { total += value; count++; }
    }
    const score = total * (.5 + Math.min(count / 220, 1)) - Math.abs(x0 - meetingX) * .10 - Math.abs(y0 - meetingY) * .025;
    if (score > bestScore) { bestScore = score; bestY = y0; bestRows.set(selectedRows); }
  }
  const bestPoints=Array.from(bestRows,(x,y)=>({x,y})).filter(p=>p.x>=0);
  if (bestPoints.length < ROI_HEIGHT * .20) return { curve: new Float32Array(), confidence: 0 };
  // Two-column least squares: x = intercept + curvature * (y - vertexY)^2.
  const z = bestPoints.map(p => f32(f32(p.y - bestY) ** 2));
  const meanZ = z.reduce((a, b) => a + b, 0) / z.length, meanX = bestPoints.reduce((a, p) => a + p.x, 0) / z.length;
  let numerator = 0, denominator = 0;
  for (let i = 0; i < z.length; i++) { numerator += (z[i] - meanZ) * (bestPoints[i].x - meanX); denominator += (z[i] - meanZ) ** 2; }
  const slope = denominator ? numerator / denominator : 0, intercept = f32(meanX - slope * meanZ), curvature = Math.max(.0005, Math.min(.012, f32(slope)));
  const model = Float32Array.from({ length: ROI_HEIGHT }, (_, y) => f32(intercept + f32(curvature * f32(f32(y - bestY) ** 2))));
  const selected: { x: number; y: number }[] = [], observed = new Uint8Array(ROI_HEIGHT);
  for (let y = 0; y < ROI_HEIGHT; y++) {
    let value = 0, x = -1;
    for (const peak of rows[y]) {
      const error = Math.abs(peak.x - model[y]); if (error > 18) continue;
      const score = peak.value * (1 - error / 18.000001) * (1 + .35 * Math.max(0, peak.x - model[y]) / 18.000001);
      if (score > value) { value = score; x = peak.x; }
    }
    if (x >= 0) { selected.push({ x, y }); observed[y] = 1; }
  }
  let curve = model;
  if (selected.length >= 4) {
    const blended = new Float32Array(ROI_HEIGHT); let next = 0;
    for (let y = 0; y < ROI_HEIGHT; y++) {
      while (next < selected.length && selected[next].y < y) next++;
      let x: number;
      if (!next) x = selected[0].y === y ? selected[0].x : model[0];
      else if (next === selected.length) x = model[ROI_HEIGHT - 1];
      else { const a = selected[next - 1], b = selected[next]; x = a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y); }
      x = Math.max(f32(model[y] - 18), Math.min(f32(model[y] + 18), x));
      let support = 0; for (let r = Math.max(0, y - 10); r <= Math.min(ROI_HEIGHT - 1, y + 10); r++) support += observed[r];
      const w = Math.min(f32(support / 10), f32(.55));
      blended[y] = w * x + f32(f32(1 - w) * model[y]);
    }
    const median = new Float32Array(ROI_HEIGHT);
    for (let y = 0; y < ROI_HEIGHT; y++) {
      const values = blended.slice(Math.max(0, y - 20), Math.min(ROI_HEIGHT, y + 21)); values.sort();
      median[y] = (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2;
    }
    curve = new Float32Array(ROI_HEIGHT);
    for (let y = 0; y < ROI_HEIGHT; y++) {
      let sum = 0; for (let k = -15; k <= 15; k++) sum += median[Math.max(0, Math.min(ROI_HEIGHT - 1, y + k))] * f32(1 / 31);
      curve[y] = sum;
    }
  }
  const error = selected.length ? selected.reduce((sum, p) => sum + Math.abs(p.x - curve[p.y]), 0) / selected.length : 30;
  return { curve, confidence: Math.max(0, Math.min(1, selected.length / ROI_HEIGHT * (1 - Math.min(error / 30, .85)))) };
}

function validCurve(curve:Float32Array, confidence:number):boolean {
  const leftmost = curve.length ? Math.min(...curve) : Infinity;
  return curve.length === ROI_HEIGHT && curve.every(Number.isFinite) && Number.isFinite(confidence) && confidence >= .75 && curve[0] - leftmost >= 25 && curve[ROI_HEIGHT-1] - leftmost >= 25;
}
function regionMask(foreground:Uint8Array, curve:Float32Array, width:number, height:number):Uint8Array {
  const region = mainComponent(foreground), mask = new Uint8Array(width * height);
  const topSlope=(curve[TACTILE_RIM_INSET]-curve[0])/TACTILE_RIM_INSET;
  const bottomSlope=(curve[ROI_HEIGHT-1]-curve[ROI_HEIGHT-1-TACTILE_RIM_INSET])/TACTILE_RIM_INSET;
  // Continue the rim beyond the image instead of treating its cut-off endpoints
  // as flat caps. Otherwise a crescent leaks back in near the top/bottom corners.
  const extended=Float64Array.from({length:ROI_HEIGHT+2*TACTILE_RIM_INSET},(_,i)=>{
    const y=i-TACTILE_RIM_INSET;
    return y<0?curve[0]+y*topSlope:y>=ROI_HEIGHT?curve[ROI_HEIGHT-1]+(y-ROI_HEIGHT+1)*bottomSlope:curve[y];
  });
  for (let y = 0; y < ROI_HEIGHT; y++) {
    let boundary=0;
    // Dilate the excluded side by a disk, rather than adding a horizontal offset
    // that becomes too narrow wherever the arc slopes steeply.
    for(let k=0;k<rimOffsets.length;k++)boundary=Math.max(boundary,extended[y+k]+rimOffsets[k]);
    for(let x=0;x<ROI_WIDTH;x++)if(x<boundary)region[y*ROI_WIDTH+x]=0;
  }
  const eroded = morphology(region, 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    mask[y * width + x] = eroded[Math.min(ROI_HEIGHT - 1, Math.floor((y + .5) * ROI_HEIGHT / height)) * ROI_WIDTH + Math.min(ROI_WIDTH - 1, Math.floor((x + .5) * ROI_WIDTH / width))];
  return mask;
}
function regionForeground(gray:Float32Array){return morphology(morphology(Uint8Array.from(gray,v=>v>.075?1:0),3,true),3);}
export function detectTactileRegion(baseline: Uint8Array, width: number, height: number): TactileRegion {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || baseline.length !== width * height) throw new Error('Invalid tactile region dimensions');
  const gray = analysisGray(baseline, width, height), foreground = regionForeground(gray), rows = peaks(gray, foreground);
  const primary = fitArc(rows);let result = primary;
  for(const method of ['local','broader'] as const){
    if(method==='broader')result=fitArc(rows,true);
    if(!validCurve(result.curve,result.confidence))continue;
    const mask=regionMask(foreground,result.curve,width,height);
    if(mask.some(Boolean))return {...result,mask,status:'ready',method};
  }
  return {...primary,mask:new Uint8Array(baseline.length),status:'not-found'};
}
function rimStrips(gray:Float32Array, curve:Float32Array):Uint8Array {
  const rim=new Uint8Array(ROI_HEIGHT*45);
  for(let y=0;y<ROI_HEIGHT;y++)for(let k=0;k<45;k++)rim[y*45+k]=Math.round(gray[y*ROI_WIDTH+Math.max(0,Math.min(ROI_WIDTH-1,Math.round(curve[y])+k-12))]*255);
  return rim;
}
export function regionGeometry(baseline:Uint8Array,width:number,height:number,curve:Float32Array,confidence:number,episodeId=''):RegionGeometry {
  if(!validCurve(curve,confidence))throw new Error('Invalid donor curve');
  return {width,height,curve:curve.slice(),rim:rimStrips(analysisGray(baseline,width,height),curve),confidence,episodeId};
}
/** Validate a donor against the current rim without requiring another curve fit. */
export function borrowTactileRegion(baseline:Uint8Array,width:number,height:number,donor:RegionGeometry):TactileRegion|undefined {
  if(donor.width!==width||donor.height!==height||baseline.length!==width*height||donor.rim.length!==ROI_HEIGHT*45||!validCurve(donor.curve,donor.confidence))return;
  const gray=analysisGray(baseline,width,height), current=rimStrips(gray,donor.curve);let upper=0,lower=0;
  for(let y=0;y<ROI_HEIGHT;y++){
    let a=0,b=0,aa=0,bb=0,ab=0;
    for(let k=0;k<45;k++){const u=current[y*45+k],v=donor.rim[y*45+k];a+=u;b+=v;aa+=u*u;bb+=v*v;ab+=u*v;}
    const va=aa-a*a/45,vb=bb-b*b/45;
    if(va/45<25||vb/45<25)continue;
    if((ab-a*b/45)/Math.sqrt(va*vb)>=.70){if(y<180)upper++;else lower++;}
  }
  if(upper+lower<180||upper<20||lower<20)return;
  const mask=regionMask(regionForeground(gray),donor.curve,width,height);
  if(!mask.some(Boolean))return;
  return {mask,curve:donor.curve.slice(),confidence:donor.confidence,status:'ready',method:'neighbor'};
}
/** Geometry-only donor preparation: at most eight opening samples, no noise statistics. */
export function detectRegionSamples(frames:Uint8Array[],width:number,height:number):RegionGeometry|undefined {
  if(!frames.length||frames.some(f=>f.length!==width*height))return;
  const median=new Uint8Array(width*height),values=new Uint8Array(frames.length);
  for(let p=0;p<median.length;p++){frames.forEach((f,i)=>{values[i]=f[p];});values.sort();median[p]=Math.floor((values[(values.length-1)>>1]+values[values.length>>1])/2);}
  const region=detectTactileRegion(median,width,height);
  return region.status==='ready'?regionGeometry(median,width,height,region.curve,region.confidence):undefined;
}
