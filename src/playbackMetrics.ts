// Bounded, local diagnostics available to performance tools; never uploaded.
export function playbackMark(event:string,channel?:string,detail?:unknown){
  performance.mark(`rdv:${event}`,{detail:{channel,...(detail as object)}});
  const entries=performance.getEntriesByName(`rdv:${event}`);if(entries.length>128)performance.clearMarks(`rdv:${event}`);
}
