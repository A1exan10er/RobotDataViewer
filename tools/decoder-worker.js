// App worker appended after the pinned libav.js frontend and WASM factory.
// One decoder per channel; requests are serialized and returned frames bounded.
let av, fmt, stream, ctx, pkt, frame, scale, scaled, eof=false, base=null, tactile=false, reference=null, touchFilter=null;
async function initialize({blob,wasmBinary,isTactile}) {
  tactile=!!isTactile;
  av=await LibAV.LibAV({noworker:true,factory:options=>LibAVFactory({...options,wasmBinary})});
  await av.mkreadaheadfile('recording.mp4',blob);
  let streams;[fmt,streams]=await av.ff_init_demuxer_file('recording.mp4');
  stream=streams.find(s=>s.codec_type===av.AVMEDIA_TYPE_VIDEO);
  if(!stream)throw new Error('No video stream');
  [,ctx,pkt,frame]=await av.ff_init_decoder(stream.codec_id,{codecpar:stream.codecpar,time_base:[stream.time_base_num,stream.time_base_den]});
  scaled=await av.av_frame_alloc();
}
async function batch({time=0,seek=false,gain=1,cleanup=true}) {
  if(seek && base!==null){
    const ticks=Math.round((time+base)*stream.time_base_den/stream.time_base_num);
    const result=await av.av_seek_frame(fmt,stream.index,ticks|0,Math.floor(ticks/4294967296),1);
    if(result<0)throw new Error('Could not seek video');
    await av.avcodec_flush_buffers(ctx);eof=false;
  }
  const output=[];
  while(output.length<4 && !eof){
    const [result,packets]=await av.ff_read_frame_multi(fmt,pkt,{limit:1});
    eof=result===av.AVERROR_EOF;
    if(result<0 && !eof && result!==-av.EAGAIN)throw new Error('Could not read video');
    // Keep decoded YUV frames inside WASM; copying them to JS and back caused large allocation bursts.
    const frames=await av.ff_decode_multi(ctx,pkt,frame,packets[stream.index]||[],{fin:eof,copyoutFrame:'ptr'});
    try {
      for(const f of frames){
        const [pts,hi,num,den,width,height,format]=await Promise.all([
          av.AVFrame_pts(f),av.AVFrame_ptshi(f),av.AVFrame_time_base_num(f),av.AVFrame_time_base_den(f),
          av.AVFrame_width(f),av.AVFrame_height(f),av.AVFrame_format(f)
        ]);
        const raw=av.i64tof64(pts,hi)*(num||stream.time_base_num)/(den||stream.time_base_den);
        if(base===null)base=raw;
        const t=raw-base;if(t<time-.002)continue;
        if(!scale)scale=await av.sws_getContext(width,height,format,width,height,av.AV_PIX_FMT_RGBA,2,0,0,0);
        await av.sws_scale_frame(scale,scaled,f);
        const pixels=await av.ff_copyout_frame_video_imagedata(scaled);
        const decoded={time:t,width:pixels.width,height:pixels.height,gain,cleanup};
        output.push(decoded);
        if(typeof createImageBitmap==='function')decoded.image=await createImageBitmap(pixels);
        else decoded.pixels=pixels.data.buffer;
        if(tactile){
          if(!reference){reference=pixels.data.slice();decoded.reference=reference.slice().buffer;touchFilter=new TactileFilter(pixels.width,pixels.height,reference);}
          const delta=new Uint8ClampedArray(pixels.data.length);
          touchFilter.render(pixels.data,delta,gain,cleanup);
          if(typeof createImageBitmap==='function')decoded.differenceImage=await createImageBitmap(new ImageData(delta,pixels.width,pixels.height));
          else decoded.difference=delta.buffer;
        }
      }
    }catch(error){
      for(const f of output){f.image?.close();f.differenceImage?.close();}
      throw error;
    }finally{for(const f of frames)await av.av_frame_free_js(f);}
  }
  return {frames:output,eof};
}
let chain=Promise.resolve(),newestSeek=0;
self.onmessage=event=>{
  const {id,method,args}=event.data;
  if(method==='batch'&&args.seek)newestSeek=id;
  chain=chain.then(async()=>{
    if(method==='batch'&&id<newestSeek){self.postMessage({id,result:{frames:[],eof:false}});return;}
    try{const result=method==='init'?await initialize(args):await batch(args);self.postMessage({id,result},[...new Set(result?.frames?.flatMap(f=>[f.image,f.pixels,f.differenceImage,f.difference,f.reference].filter(Boolean))||[])]);}
    catch(error){self.postMessage({id,error:String(error?.message||error)});}
  });
};
