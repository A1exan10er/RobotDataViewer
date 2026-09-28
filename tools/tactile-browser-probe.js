// Browser-test instrumentation. Install before opening a recording, never shipped.
window.__tactileModels=[];window.__tactileInputs=new WeakMap();window.__canvasInputs=new WeakMap();
for(const method of ['drawImage','putImageData']){
 const draw=CanvasRenderingContext2D.prototype[method];
 CanvasRenderingContext2D.prototype[method]=function(image,...args){const input=window.__tactileInputs.get(method==='drawImage'?image:image.data.buffer);if(input)window.__canvasInputs.set(this.canvas,input);return draw.call(this,image,...args);};
}
{
  const Base=window.Worker;
  window.Worker=class extends Base {
    constructor(...args){
      super(...args);this.frames=new Set();this.redrawInputs=new Map();
      this.addEventListener('message',event=>{
        if(this.frames.has(event.data.id)&&window.__tactileDelay&&!event.replayed){
          event.stopImmediatePropagation();const reply=new MessageEvent('message',{data:event.data});
          Object.defineProperty(reply,'replayed',{value:true});setTimeout(()=>this.dispatchEvent(reply),window.__tactileDelay);return;
        }
        this.frames.delete(event.data.id);
      });
      this.addEventListener('message',event=>{
        for(const frame of event.data.result?.frames||[]){const gray=frame.gray?new Uint8Array(frame.gray):this.redrawInputs.get(event.data.id);if(gray)window.__tactileInputs.set(frame.differenceImage||frame.difference,{gray,time:frame.time});}this.redrawInputs.delete(event.data.id);
        const model=event.data.reference??event.data.result?.reference??event.data.result?.frames?.find(f=>f.reference)?.reference;
        if(model?.baseline&&model?.noiseFloor&&!this.modelCaptured){this.modelCaptured=true;window.__tactileModels.push(model);}
      });
    }
    postMessage(data,...args){if((data.kind==='calibrated'||(data.method==='init'&&data.args.isTactile))&&window.__failCalibration){window.__failCalibration=false;queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:{id:data.id,error:'Injected baseline failure'}})));return;}if(data.kind==='frame'||data.method==='redraw')this.frames.add(data.id);if(data.method==='redraw')this.redrawInputs.set(data.id,new Uint8Array(data.args.gray).slice());return super.postMessage(data,...args);}
  };
}
window.__installTactileCheck=Filter=>{
  const filters=new Map();
  window.__pixels=source=>{const c=document.createElement('canvas');c.width=source.videoWidth||source.width;c.height=source.videoHeight||source.height;c.getContext('2d').drawImage(source,0,0);return c.getContext('2d').getImageData(0,0,c.width,c.height).data;};
  window.__sourcePixels=card=>{if(card.dataset.mode!=='software')return window.__pixels(card.querySelector('video'));const gray=window.__canvasInputs.get(card.querySelector('.difference-cell canvas'))?.gray;if(!gray)throw new Error('No decoded grayscale sample');return Uint8ClampedArray.from({length:gray.length*4},(_,i)=>i%4===3?255:gray[i>>>2]);};
  window.__check=()=>[...document.querySelectorAll('.tactile-card')].map(card=>{
    const current=window.__sourcePixels(card),actual=window.__pixels(card.querySelector('.difference-cell canvas')),expected=new Uint8ClampedArray(actual.length);
    let errors=Infinity,changed=0,strong=0,matched;
    // Decoder/native calibration completion order varies; compare against the
    // captured immutable models rather than assuming worker order is channel order.
    for(const model of window.__tactileModels){
      if(model.width*model.height*4!==current.length)continue;
      if(!filters.has(model))filters.set(model,new Filter(model));
      filters.get(model).render(current,expected,Number(card.querySelector('input[type=range]').value),!card.querySelector('input[type=checkbox]').checked);
      let mismatch=0;for(let i=0;i<actual.length;i++)if(actual[i]!==expected[i])mismatch++;
      if(mismatch<errors){errors=mismatch;matched=model;}if(!errors)break;
    }
    for(let i=0;i<actual.length;i+=4){const v=Math.max(actual[i],actual[i+1],actual[i+2]);if(v>0)changed++;if(v>100)strong++;}
    let outside=0;
    if(matched)for(let p=0;p<matched.roiMask.length;p++)if(!matched.roiMask[p]&&(actual[p*4]||actual[p*4+1]||actual[p*4+2]||actual[p*4+3]!==255))outside++;
    return {id:card.dataset.channel,changed,strong,errors,outside,roiStatus:matched?.roiStatus,confidence:matched?.roiConfidence,maskPixels:matched?.roiMask.reduce((a,b)=>a+b,0)};
  });
};
