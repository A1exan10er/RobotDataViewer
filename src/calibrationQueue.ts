type Job={run:()=>Promise<unknown>;signal:AbortSignal;resolve:(value:any)=>void;reject:(error:unknown)=>void;abort:()=>void};
/** Bounds calibration/decoder initialization without waiting for camera buffering. */
export class CalibrationQueue {
  private jobs:Job[]=[];private running=0;
  private limit:number;
  constructor(limit=2){this.limit=limit;}
  run<T>(run:()=>Promise<T>,signal:AbortSignal):Promise<T>{
    return new Promise((resolve,reject)=>{
      const job:Job={run,signal,resolve,reject,abort:()=>{this.jobs=this.jobs.filter(j=>j!==job);reject(signal.reason);}};
      if(signal.aborted){reject(signal.reason);return;}
      signal.addEventListener('abort',job.abort,{once:true});this.jobs.push(job);
    });
  }
  pump(){
    while(this.running<this.limit&&this.jobs.length){
      const job=this.jobs.shift()!;if(job.signal.aborted)continue;
      this.running++;
      void Promise.resolve().then(()=>{job.signal.throwIfAborted();return job.run();}).then(job.resolve,job.reject).finally(()=>{this.running--;job.signal.removeEventListener('abort',job.abort);});
    }
  }
}
