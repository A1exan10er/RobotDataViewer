/** Retain the last frame at/before the target and every future frame, without painting. */
export function discardPastFrames<T extends {time:number}>(frames:T[],target:number,close:(frame:T)=>void){
  let index=0;
  while(index+1<frames.length&&frames[index+1].time<=target+.002)index++;
  if(index)frames.splice(0,index).forEach(close);
}
