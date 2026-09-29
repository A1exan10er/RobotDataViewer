// Built after the pinned LibAV, DeepFlow and ONNX factories. No network requests.
let session, cv, av, manifest, inputMemory=0, inputCapacity=0, backend='wasm';
const unbase64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
function copyPixels(pixels){
  if(pixels.data.length>inputCapacity){if(inputMemory)cv._free(inputMemory);inputCapacity=pixels.data.length;inputMemory=cv._malloc(inputCapacity);}
  cv.HEAPU8.set(pixels.data,inputMemory);return inputMemory;
}
async function init({assets,decoder,forceWasm=false}){
  manifest=assets.manifest;
  cv=await DeepFlowFactory({wasmBinary:unbase64(assets.deepflowWasm)});
  ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;
  const moduleUrl=URL.createObjectURL(new Blob([assets.ortModule],{type:'text/javascript'}));
  const wasmUrl=URL.createObjectURL(new Blob([unbase64(assets.ortWasm)],{type:'application/wasm'}));
  // Both paths must be explicit: the pinned factory resolves a WASM filename
  // against import.meta.url even when wasmBinary is supplied (invalid for blob:).
  ort.env.wasm.wasmPaths={mjs:moduleUrl,wasm:wasmUrl};
  const model=unbase64(assets.model);
  try {
    let gpuError='';
    if(!forceWasm&&navigator.gpu&&await navigator.gpu.requestAdapter()){
      try{session=await ort.InferenceSession.create(model,{executionProviders:['webgpu'],enableMemPattern:false,graphOptimizationLevel:'extended'});backend='webgpu';}
      catch(error){session=null;gpuError=String(error);}
    }
    if(!session)try{session=await ort.InferenceSession.create(model,{executionProviders:['wasm'],enableMemPattern:false,graphOptimizationLevel:'extended'});}catch(error){throw new Error(gpuError+' '+error);}
    // Reject a GPU implementation that cannot reproduce the pinned zero-input oracle.
    if(backend==='webgpu'){
      const z=new ort.Tensor('float32',new Float32Array(3*640*360),[1,3,360,640]);
      const result=await session.run({input:z});
      const correct=Array.from(result.normalized.data).every((v,i)=>Math.abs((v-manifest.zero.normalized[i])*manifest.scales[i])<=.001+.001*Math.abs(manifest.zero.normalized[i]*manifest.scales[i])) &&
        (Number(result.contactScore.data[0])>=.1)===(manifest.zero.contactScore>=.1);
      Object.values(result).forEach(t=>t.dispose());z.dispose();
      if(!correct){await session.release();session=await ort.InferenceSession.create(model,{executionProviders:['wasm'],enableMemPattern:false,graphOptimizationLevel:'extended'});backend='wasm';}
    }
  } finally {URL.revokeObjectURL(moduleUrl);URL.revokeObjectURL(wasmUrl);}
  if(decoder)av=await LibAV.LibAV({noworker:true,factory:options=>LibAVFactory({...options,
    ...(decoder.wasmModule?{instantiateWasm(imports,ready){WebAssembly.instantiate(decoder.wasmModule,imports).then(instance=>ready(instance,decoder.wasmModule));return {};}}:{wasmBinary:decoder.wasmBinary})})});
  return {backend};
}
async function inferPixels(pixels,reset=false){
  const memory=copyPixels(pixels),w=pixels.width,h=pixels.height;
  if(reset&&!cv._force_reset(memory,w,h))throw new Error(cv.UTF8ToString(cv._force_error()));
  const pointer=cv._force_input(memory,w,h);
  if(!pointer)throw new Error(cv.UTF8ToString(cv._force_error()));
  const input=new ort.Tensor('float32',cv.HEAPF32.subarray(pointer/4,pointer/4+3*640*360),[1,3,360,640]);
  let result;
  try{
    result=await session.run({input});
    const values=result.normalized.data,contact=Number(result.contactScore.data[0]);
    if(![values[0],values[1],contact].every(Number.isFinite))throw new Error('Nonfinite force output');
    return {shear:contact<.1?0:Math.max(0,values[0]*2.6),fz:contact<.1?0:Math.max(0,values[1]*5.7),contact,normalized:Array.from(values)};
  }finally{input.dispose();Object.values(result||{}).forEach(t=>t.dispose());}
}
async function calculate({blob,sensor,sha,expectedFrames}){
  let fmt,ctx,pkt,frame,scaled,scale,stream,base,reference=false;
  const time=[],shear=[],fz=[],valid=[];let width=0,height=0;
  const started=performance.now();
  try{
    await av.mkreadaheadfile('force.mp4',blob);
    let streams;[fmt,streams]=await av.ff_init_demuxer_file('force.mp4');
    stream=streams.find(s=>s.codec_type===av.AVMEDIA_TYPE_VIDEO);
    if(!stream)throw new Error('No video stream');
    [,ctx,pkt,frame]=await av.ff_init_decoder(stream.codec_id,{codecpar:stream.codecpar,time_base:[stream.time_base_num,stream.time_base_den]});
    scaled=await av.av_frame_alloc();
    let eof=false;
    while(!eof){
      const [status,packets]=await av.ff_read_frame_multi(fmt,pkt,{limit:1});eof=status===av.AVERROR_EOF;
      if(status<0&&!eof&&status!==-av.EAGAIN)throw new Error('Could not read video');
      const frames=await av.ff_decode_multi(ctx,pkt,frame,packets[stream.index]||[],{fin:eof,copyoutFrame:'ptr'});
      try{
        for(const f of frames){
          const [pts,hi,num,den,w,h,format]=await Promise.all([av.AVFrame_pts(f),av.AVFrame_ptshi(f),av.AVFrame_time_base_num(f),av.AVFrame_time_base_den(f),av.AVFrame_width(f),av.AVFrame_height(f),av.AVFrame_format(f)]);
          if(w*h>8_388_608)throw new Error('Sensor image is too large');
          if(reference&&(w!==width||h!==height))throw new Error('Frame dimensions changed');
          width=w;height=h;
          const raw=av.i64tof64(pts,hi)*(num||stream.time_base_num)/(den||stream.time_base_den);base??=raw;
          const stamp=raw-base;
          if(!Number.isFinite(stamp)||(time.length&&stamp<=time.at(-1)))throw new Error('Invalid frame timestamps');
          scale??=await av.sws_getContext(w,h,format,w,h,av.AV_PIX_FMT_RGBA,2,0,0,0);
          await av.sws_scale_frame(scale,scaled,f);
          const pixels=await av.ff_copyout_frame_video_imagedata(scaled);
          const estimate=await inferPixels(pixels,!reference);reference=true;
          time.push(stamp);shear.push(estimate.shear);fz.push(estimate.fz);valid.push(1);
          postMessage({progress:{sensor,frame:time.length,frames:expectedFrames,stage:'calculating'}});
        }
      }finally{for(const f of frames)await av.av_frame_free_js(f);}
    }
    if(!time.length||time.length!==expectedFrames)throw new Error('Decoded frame count does not match recording');
    return {track:{sensor,video:{sha256:sha,bytes:blob.size,frames:time.length,width,height},model:{id:manifest.model,weightsSha256:manifest.weightsSha256,pipeline:manifest.pipeline},
      reference:{frame:0,time:time[0]},unit:'N',time:Float64Array.from(time),shear:Float32Array.from(shear),fz:Float32Array.from(fz),valid:Uint8Array.from(valid)},seconds:(performance.now()-started)/1000,backend};
  }finally{
    for(const release of [()=>scale&&av.sws_freeContext(scale),()=>scaled&&av.av_frame_free_js(scaled),()=>ctx&&av.ff_free_decoder(ctx,pkt,frame),()=>fmt&&av.avformat_close_input_js(fmt),()=>av.unlink('force.mp4')])try{await release();}catch{}
  }
}
// One RPC is in flight; the owner terminates this worker on cancellation.
self.onmessage=async({data})=>{
  try{const result=await(data.type==='init'?init(data):data.type==='sample'?inferPixels(data.pixels,data.reset):calculate(data));postMessage({id:data.id,result});}
  catch(error){postMessage({id:data.id,error:String(error?.message||error)});}
};
