// Native video frames are read and compared away from the playback/UI thread.
let canvas, context, filter, output;
self.onmessage=({data})=>{
  const {id,bitmap,kind,gain=1,cleanup=true}=data;
  try{
    if(!canvas){canvas=new OffscreenCanvas(bitmap.width,bitmap.height);context=canvas.getContext('2d',{willReadFrequently:true});}
    if(bitmap.width!==canvas.width||bitmap.height!==canvas.height)throw new Error('Frame dimensions differ');
    context.drawImage(bitmap,0,0);
    const pixels=context.getImageData(0,0,canvas.width,canvas.height);
    if(kind==='reference'){
      filter=new TactileFilter(canvas.width,canvas.height,pixels.data);output=new ImageData(canvas.width,canvas.height);
      self.postMessage({id,width:canvas.width,height:canvas.height});
    }else{
      if(!filter)throw new Error('Reference unavailable');
      filter.render(pixels.data,output.data,gain,cleanup);
      context.putImageData(output,0,0);
      const image=canvas.transferToImageBitmap();self.postMessage({id,image},[image]);
    }
  }catch(error){self.postMessage({id,error:String(error?.message||error)});}
  finally{bitmap.close();}
};
