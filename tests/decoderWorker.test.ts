import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

// Exercise the actual worker orchestration with a deterministic packet decoder.
// Pixel/statistics equivalence is covered separately by the NumPy/OpenCV goldens.
function worker(total=90,cached=false){
  let cursor=0,probeCursor=0,scaled=0,rewinds=0,decodes=0,probe=false;const released:string[]=[];
  const reference={width:2,height:1,sampleCount:60,baseline:new Uint8Array(2),noiseFloor:new Float32Array(2),roiMask:new Uint8Array([1,1]),roiStatus:'ready',roiConfidence:1};
  const av:any={
    AVERROR_EOF:-1,AVMEDIA_TYPE_VIDEO:0,AV_PIX_FMT_RGBA:0,EAGAIN:2,
    mkreadaheadfile:async()=>{},ff_init_demuxer_file:async(name:string)=>{probe=name==='region-probe.mp4';return [probe?9:1,[{index:0,codec_type:0,time_base_num:1,time_base_den:30}]];},
    ff_init_decoder:async()=>probe?[0,11,12,13]:[0,1,2,3],av_frame_alloc:async()=>4,
    ff_read_frame_multi:async(fmt:number)=>fmt===9?(probeCursor<total?[0,{0:[probeCursor++]}]:[-1,{}]):cursor<total?[0,{0:[cursor++]}]:[-1,{}],
    ff_decode_multi:async(_ctx:any,_pkt:any,_frame:any,packets:number[])=>{decodes+=packets.length;return packets;},
    AVFrame_pts:async(f:number)=>f+150,AVFrame_ptshi:async()=>0,AVFrame_time_base_num:async()=>1,AVFrame_time_base_den:async()=>30,
    AVFrame_width:async()=>2,AVFrame_height:async()=>1,AVFrame_format:async()=>0,
    i64tof64:(v:number)=>v,sws_getContext:async()=>1,sws_scale_frame:async(_ctx:any,_out:any,f:number)=>{scaled=f;},
    ff_copyout_frame_video_imagedata:async()=>({width:2,height:1,data:Uint8ClampedArray.from([scaled,scaled,scaled,255,scaled,scaled,scaled,255])}),
    sws_freeContext:async()=>{released.push('scale');},ff_free_decoder:async(ctx:number)=>{assert.equal(ctx,11);released.push('decoder');},avformat_close_input_js:async(fmt:number)=>{assert.equal(fmt,9);released.push('format');},unlink:async()=>{released.push('file');},av_frame_free_js:async()=>{},av_seek_frame:async(_fmt:any,_stream:any,ticks:number)=>{rewinds++;cursor=ticks-150;return 0;},avcodec_flush_buffers:async()=>{},
  };
  const gray=(rgba:Uint8ClampedArray)=>new Uint8Array([rgba[0],rgba[4]]);
  class Calibration{samples:Uint8Array[]=[];width=2;height=1;add(rgba:Uint8ClampedArray){const sample=gray(rgba);this.samples.push(sample);return sample;}finish(){return {...reference,sampleCount:this.samples.length};}}
  class Filter{renderGray(input:Uint8Array,out:Uint8ClampedArray){out.fill(input[0]);}}
  const context=createContext({Uint8Array,Uint8ClampedArray,Float32Array,performance,self:{},LibAV:{LibAV:async()=>av},LibAVFactory:()=>{},TactileCalibration:Calibration,TactileFilter:Filter,copyTactileBaseline:(model:any)=>structuredClone(model),detectRegionSamples:(samples:Uint8Array[])=>({sampleCount:samples.length}),tactileGray:gray,tactileBaselineCount:(fps:number,n:number)=>Math.min(n,Math.max(8,Math.round(fps*2))),args:{blob:{},wasmBinary:new Uint8Array(),isTactile:true,frameRate:30,frameCount:total,reference:cached?reference:undefined}});
  runInContext(readFileSync(new URL('../tools/decoder-worker.js',import.meta.url),'utf8'),context);
  return {run:(expression:string)=>runInContext(expression,context),released,counts:()=>({decodes,rewinds})};
}
test('opening grayscale frames seed playback without rewinding or decoding twice',async()=>{
  const w=worker();const init=await w.run('initialize(args)');assert.equal(init.metrics.baselineSamples,60);assert.equal(init.metrics.seedFrames,60);
  const times:number[]=[];
  for(let i=0;i<16;i++){
    const batch=await w.run(`batch({time:${i*4/30},seek:${i===0}})`);
    for(const f of batch.frames){assert.equal(f.image,undefined);assert.equal(f.pixels,undefined);assert.equal(new Uint8Array(f.gray)[0],times.length);times.push(f.time);}
  }
  assert.equal(times.length,64);assert.equal(w.counts().rewinds,0);assert.equal(w.counts().decodes,64);
  times.forEach((t,i)=>assert.ok(Math.abs(t-i/30)<1e-10));
});
test('seek within retained samples discards obsolete frames; an outside seek rewinds once',async()=>{
  const w=worker();await w.run('initialize(args)');const inside=await w.run('batch({time:.5,seek:true})');
  assert.equal(new Uint8Array(inside.frames[0].gray)[0],15);assert.equal(w.counts().rewinds,0);
  const outside=await w.run('batch({time:2.5,seek:true})');assert.equal(new Uint8Array(outside.frames[0].gray)[0],75);assert.equal(w.counts().rewinds,1);
});
test('cached startup does no baseline decoding and requires no initial rewind',async()=>{
  const w=worker(90,true);const init=await w.run('initialize(args)');assert.equal(init.metrics.baselineSamples,0);assert.equal(w.counts().decodes,0);
  const first=await w.run('batch({time:0,seek:true})');assert.equal(first.frames[0].time,0);assert.deepEqual(w.counts(),{decodes:4,rewinds:0});
});
test('short clips drain retained samples before reporting EOF; redraw does not decode',async()=>{
  const w=worker(3);await w.run('initialize(args)');const first=await w.run('batch({time:0,seek:true})');assert.equal(first.frames.length,3);assert.equal(first.eof,true);assert.equal(w.counts().rewinds,0);
  const before=w.counts();const output=await w.run('redraw({gray:new Uint8Array([17,17]).buffer,time:.03,gain:16,cleanup:false})');
  assert.equal(output.frames[0].time,.03);assert.equal(new Uint8Array(output.frames[0].difference)[0],17);assert.deepEqual(w.counts(),before);
});

test('donor probing decodes at most eight frames and releases isolated contexts without disturbing playback',async()=>{
  const w=worker();await w.run('initialize(args)');
  const donor=await w.run('probeRegion({blob:{},width:2,height:1})');assert.equal(donor.geometry.sampleCount,8);assert.equal(donor.metrics.baselineSamples,60);
  assert.equal(donor.metrics.seedFrames,60);assert.equal(donor.metrics.regionProbeFrames,8);assert.deepEqual(w.released,['scale','decoder','format','file']);
  const first=await w.run('batch({time:0,seek:true})');assert.equal(first.frames[0].time,0);assert.deepEqual(w.counts(),{decodes:68,rewinds:0});
});
test('probe-only workers skip selected-video initialization and short donors finish at EOF',async()=>{
  const w=worker(3);await w.run('initialize({...args,probeOnly:true})');assert.equal(w.counts().decodes,0);
  const donor=await w.run('probeRegion({blob:{},width:2,height:1})');assert.equal(donor.geometry.sampleCount,3);assert.equal(donor.metrics.baselineSamples,0);assert.equal(w.released.length,4);
});
