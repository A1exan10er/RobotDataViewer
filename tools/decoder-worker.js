// App worker appended after the pinned libav.js frontend and WASM factory.
// One sequential decoder per channel. Opening grayscale samples also seed playback.
let av,fmt,stream,ctx,pkt,frame,scale,scaled,eof=false,base=null,tactile=false,reference=null,touchFilter=null;
let seed=[],seedBytes=0,delta,useBitmaps=true;
const metrics={decodedFrames:0,baselineSamples:0,rewinds:0,decodeMs:0,statisticsMs:0,regionMs:0,initMs:0,regionProbes:0,regionProbeFrames:0};
const snapshot=()=>({...metrics,seedFrames:seed.length,seedBytes});
async function rewind(time){
  const ticks=Math.round((time+base)*stream.time_base_den/stream.time_base_num);
  const result=await av.av_seek_frame(fmt,stream.index,ticks|0,Math.floor(ticks/4294967296),1);
  if(result<0)throw new Error('Could not seek video');
  await av.avcodec_flush_buffers(ctx);eof=false;metrics.rewinds++;
}
// Copy only one bounded packet's RGBA frames. Conversion stays identical to the
// original decoder; its Y plane is not equivalent to the reference RGB grayscale.
async function readPixels(time){
  const started=performance.now();
  const [result,packets]=await av.ff_read_frame_multi(fmt,pkt,{limit:1});eof=result===av.AVERROR_EOF;
  if(result<0&&!eof&&result!==-av.EAGAIN)throw new Error('Could not read video');
  const frames=await av.ff_decode_multi(ctx,pkt,frame,packets[stream.index]||[],{fin:eof,copyoutFrame:'ptr'});
  const output=[];
  try{
    for(const f of frames){
      const [pts,hi,num,den,width,height,format]=await Promise.all([
        av.AVFrame_pts(f),av.AVFrame_ptshi(f),av.AVFrame_time_base_num(f),av.AVFrame_time_base_den(f),
        av.AVFrame_width(f),av.AVFrame_height(f),av.AVFrame_format(f)
      ]);
      const raw=av.i64tof64(pts,hi)*(num||stream.time_base_num)/(den||stream.time_base_den);
      if(base===null)base=raw;
      metrics.decodedFrames++;
      const t=raw-base;if(t<time-.002)continue;
      if(!scale)scale=await av.sws_getContext(width,height,format,width,height,av.AV_PIX_FMT_RGBA,2,0,0,0);
      await av.sws_scale_frame(scale,scaled,f);
      output.push({time:t,pixels:await av.ff_copyout_frame_video_imagedata(scaled)});
    }
    return output;
  }finally{for(const f of frames)await av.av_frame_free_js(f);metrics.decodeMs+=performance.now()-started;}
}
async function initialize({blob,wasmBinary,wasmModule,isTactile,frameRate,frameCount,reference:cached,pixelMode=false,probeOnly=false}){
  const started=performance.now();tactile=!!isTactile;useBitmaps=!pixelMode&&typeof createImageBitmap==='function';
  let rejectInstantiation;
  const instantiationFailed=new Promise((_,reject)=>{rejectInstantiation=reject;});
  av=await Promise.race([instantiationFailed,LibAV.LibAV({noworker:true,factory:options=>LibAVFactory({...options,...(wasmModule?{
    instantiateWasm(imports,ready){WebAssembly.instantiate(wasmModule,imports).then(instance=>ready(instance,wasmModule)).catch(rejectInstantiation);return {};}
  }:{wasmBinary})})})]);
  if(probeOnly)return {};
  await av.mkreadaheadfile('recording.mp4',blob);
  let streams;[fmt,streams]=await av.ff_init_demuxer_file('recording.mp4');
  stream=streams.find(s=>s.codec_type===av.AVMEDIA_TYPE_VIDEO);
  if(!stream)throw new Error('No video stream');
  [,ctx,pkt,frame]=await av.ff_init_decoder(stream.codec_id,{codecpar:stream.codecpar,time_base:[stream.time_base_num,stream.time_base_den]});
  scaled=await av.av_frame_alloc();
  if(tactile&&cached)reference=cached;
  if(tactile&&!cached){
    const total=tactileBaselineCount(frameRate,frameCount);let calibration,count=0,retain=true;
    while(count<total&&!eof){
      for(const {time,pixels} of await readPixels(0)){
        calibration??=new TactileCalibration(pixels.width,pixels.height);
        if(pixels.width!==calibration.width||pixels.height!==calibration.height)throw new Error('Frame dimensions differ');
        const gray=count<total?calibration.add(pixels.data):tactileGray(pixels.data);
        if(count<total){count++;metrics.baselineSamples++;}
        // Leave room for the initial colored reserve within the 64 MiB channel
        // budget. Oversized clips use one rewind, never a seek for every sample.
        const reserve=Math.min(40,Math.max(8,Math.ceil(frameRate*.65)+5))*gray.length*5;
        if(retain&&seedBytes+gray.length+reserve<=64*1024*1024){seed.push({time,gray});seedBytes+=gray.length;}
        else{retain=false;seed=[];seedBytes=0;}
      }
    }
    if(!calibration)throw new Error('No baseline frames');
    reference=calibration.finish((stage,ms)=>{metrics[stage+'Ms']=ms;});
  }
  if(tactile){touchFilter=new TactileFilter(reference);delta=new Uint8ClampedArray(reference.width*reference.height*4);}
  metrics.initMs=performance.now()-started;
  return {reference:reference?copyTactileBaseline(reference):undefined,metrics:snapshot()};
}
// A separate demuxer/decoder context in the same WASM instance leaves the selected
// video's cursor, retained opening samples and EOF state completely untouched.
async function probeRegion({blob,width,height}){
  const name='region-probe.mp4',samples=[];let df,dc,dp,dr,ds,sc;const started=performance.now();
  metrics.regionProbes++;
  try{
    await av.mkreadaheadfile(name,blob);
    const [format,streams]=await av.ff_init_demuxer_file(name);df=format;
    const stream=streams.find(s=>s.codec_type===av.AVMEDIA_TYPE_VIDEO);if(!stream)return {};
    [,dc,dp,dr]=await av.ff_init_decoder(stream.codec_id,{codecpar:stream.codecpar,time_base:[stream.time_base_num,stream.time_base_den]});
    ds=await av.av_frame_alloc();
    for(let packet=0;packet<4096&&samples.length<8;packet++){
      if(performance.now()-started>3000)throw new Error('Region probe timed out');
      const [result,packets]=await av.ff_read_frame_multi(df,dp,{limit:1}),end=result===av.AVERROR_EOF;
      if(result<0&&!end&&result!==-av.EAGAIN)throw new Error('Could not read donor');
      const frames=await av.ff_decode_multi(dc,dp,dr,packets[stream.index]||[],{fin:end,copyoutFrame:'ptr'});
      try{
        for(const frame of frames){
          if(samples.length===8)break;
          const [w,h,format]=await Promise.all([av.AVFrame_width(frame),av.AVFrame_height(frame),av.AVFrame_format(frame)]);
          if(w!==width||h!==height)return {};
          sc??=await av.sws_getContext(w,h,format,w,h,av.AV_PIX_FMT_RGBA,2,0,0,0);
          await av.sws_scale_frame(sc,ds,frame);const pixels=await av.ff_copyout_frame_video_imagedata(ds);
          samples.push(tactileGray(pixels.data));metrics.regionProbeFrames++;
        }
      }finally{for(const frame of frames)await av.av_frame_free_js(frame);}
      if(end)break;
    }
    return {geometry:detectRegionSamples(samples,width,height),metrics:snapshot()};
  }finally{
    // Attempt every release even if an earlier cleanup operation fails.
    for(const release of [()=>sc&&av.sws_freeContext(sc),()=>ds&&av.av_frame_free_js(ds),()=>dc&&av.ff_free_decoder(dc,dp,dr),()=>df&&av.avformat_close_input_js(df),()=>av.unlink(name)])try{await release();}catch{}
  }
}
function geometry({episodeId}){return {geometry:baselineGeometry(reference,episodeId)};}
function adoptRegion({donor}){
  const resolved=adoptBaselineRegion(reference,donor);if(!resolved)return {};
  reference=resolved;touchFilter=new TactileFilter(reference);
  return {reference:copyTactileBaseline(reference)};
}
async function difference(gray,gain,cleanup){
  touchFilter.renderGray(gray,delta,gain,cleanup);
  if(useBitmaps)return {differenceImage:await createImageBitmap(new ImageData(delta,reference.width,reference.height))};
  return {difference:delta.slice().buffer};
}
async function batch({time=0,seek=false,gain=10,cleanup=true,limit=4}){
  if(seek){
    const covered=seed.length&&time>=seed[0].time-.002&&time<=seed.at(-1).time+.002;
    if(covered){while(seed.length&&seed[0].time<time-.002)seedBytes-=seed.shift().gray.byteLength;}
    else if(base!==null||time>.002){
      if(base===null)while(base===null&&!eof)await readPixels(0);
      seed=[];seedBytes=0;await rewind(time);
    }
  }
  const output=[];
  try{
    while(output.length<Math.max(1,Math.min(4,limit))&&(seed.length||!eof)){
      let inputs;
      if(seed.length){const input=seed.shift();seedBytes-=input.gray.byteLength;inputs=[input];}
      else inputs=await readPixels(time);
      for(const {time:t,pixels,gray:stored} of inputs){
        if(tactile){
          if(pixels&&(pixels.width!==reference.width||pixels.height!==reference.height))throw new Error('Frame dimensions differ');
          const gray=stored??tactileGray(pixels.data);
          const decoded={time:t,width:reference.width,height:reference.height,gray:gray.buffer,gain,cleanup};output.push(decoded);
          Object.assign(decoded,await difference(gray,gain,cleanup));
        }else{
          const decoded={time:t,width:pixels.width,height:pixels.height,gain,cleanup};output.push(decoded);
          if(useBitmaps)decoded.image=await createImageBitmap(pixels);
          else decoded.pixels=pixels.data.buffer;
        }
      }
    }
    return {frames:output,eof:eof&&!seed.length,metrics:snapshot()};
  }catch(error){for(const f of output){f.image?.close();f.differenceImage?.close();}throw error;}
}
async function redraw({gray,time,gain,cleanup}){
  if(!touchFilter)throw new Error('Baseline unavailable');
  return {frames:[{time,width:reference.width,height:reference.height,gain,cleanup,...await difference(new Uint8Array(gray),gain,cleanup)}]};
}
let chain=Promise.resolve(),newestSeek=0;
self.onmessage=event=>{
  const {id,method,args}=event.data;
  if(method==='batch'&&args.seek)newestSeek=id;
  chain=chain.then(async()=>{
    if(method==='batch'&&id<newestSeek){self.postMessage({id,result:{frames:[],eof:false}});return;}
    try{
      const methods={init:initialize,redraw,batch,probeRegion,geometry,adoptRegion};
      const result=await methods[method](args);
      const model=result.reference;
      self.postMessage({id,result},[...new Set([
        ...(result.frames?.flatMap(f=>[f.image,f.pixels,f.gray,f.differenceImage,f.difference].filter(Boolean))||[]),
        ...[model?.baseline.buffer,model?.noiseFloor.buffer,model?.roiMask.buffer,model?.roiCurve?.buffer,result.geometry?.curve.buffer,result.geometry?.rim.buffer].filter(Boolean)
      ])]);
    }catch(error){self.postMessage({id,error:String(error?.message||error)});}
  });
};
