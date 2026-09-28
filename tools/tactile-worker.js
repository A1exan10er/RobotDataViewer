// Canvas capture is optional: compatibility browsers send one RGBA frame per task.
// All statistics, arc fitting and pixel processing remain off the playback thread.
let canvas, context, filter, calibration, output;
function configure(width,height){
  if(!canvas){canvas=new OffscreenCanvas(width,height);context=canvas.getContext('2d',{willReadFrequently:true});}
  if(width!==canvas.width||height!==canvas.height)throw new Error('Frame dimensions differ');
}
self.onmessage=({data})=>{
  const {id,bitmap,kind,gain=10,cleanup=true,reference}=data;
  try{
    if(kind==='reference'){
      if(!data.pixelMode)configure(reference.width,reference.height);
      filter=new TactileFilter(reference);output={width:reference.width,height:reference.height,data:new Uint8ClampedArray(reference.width*reference.height*4)};
      self.postMessage({id});return;
    }
    if(kind==='calibrated'){
      if(!calibration)throw new Error('No baseline frames');
      const model=calibration.finish();calibration=null;
      filter=new TactileFilter(model);output={width:model.width,height:model.height,data:new Uint8ClampedArray(model.width*model.height*4)};
      self.postMessage({id,reference:model},[model.baseline.buffer,model.noiseFloor.buffer,model.roiMask.buffer]);return;
    }
    let pixels;
    if(data.pixels)pixels={width:data.width,height:data.height,data:new Uint8ClampedArray(data.pixels)};
    else{configure(bitmap.width,bitmap.height);context.drawImage(bitmap,0,0);pixels=context.getImageData(0,0,canvas.width,canvas.height);}
    if(kind==='sample'){
      calibration??=new TactileCalibration(pixels.width,pixels.height);
      if(pixels.width!==calibration.width||pixels.height!==calibration.height)throw new Error('Frame dimensions differ');
      calibration.add(pixels.data);
      self.postMessage({id});return;
    }
    if(!filter)throw new Error('Baseline unavailable');
    if(pixels.width!==output.width||pixels.height!==output.height)throw new Error('Frame dimensions differ');
    filter.render(pixels.data,output.data,gain,cleanup);
    if(data.pixels){const result=output.data.slice();self.postMessage({id,pixels:result.buffer,width:output.width,height:output.height},[result.buffer]);}
    else{context.putImageData(new ImageData(output.data,output.width,output.height),0,0);const image=canvas.transferToImageBitmap();self.postMessage({id,image},[image]);}
  }catch(error){self.postMessage({id,error:String(error?.message||error)});}
  finally{bitmap?.close();}
};
