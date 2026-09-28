import type { TactileBaseline } from './tactileFilter';
import { DecoderTransport, type DecodedFrame, type DecoderResources } from './softwareTransport';
import workerCode from '../vendor/decoder-worker.js?raw';
import wasmBase64 from '../vendor/decoder.wasm.b64?raw';
import { playbackMark } from './playbackMetrics';
export type { Transport, DecodedFrame } from './softwareTransport';
export { closeFrame } from './softwareTransport';
export { NativeTransport } from './nativeTransport';
let workerUrl='',compiled:Promise<DecoderResources>|undefined;
function resources(){
  if(!workerUrl){workerUrl=URL.createObjectURL(new Blob([workerCode],{type:'text/javascript'}));
    const wasmBinary=Uint8Array.from(atob(wasmBase64.trim()),c=>c.charCodeAt(0));
    const started=performance.now();
    compiled=WebAssembly.compile(wasmBinary).then(wasmModule=>{playbackMark('wasm-ready',undefined,{compileMs:performance.now()-started});return {wasmBinary,wasmModule};},()=>({wasmBinary}));
  }
  return {workerUrl,compiled:compiled!};
}
/** Tactile decoding is sequential even when the browser can play the codec. */
export function sequentialTactile(codec:string){return /^(avc[13]|hev1|hvc1)(\.|$)/i.test(codec);}
export class SoftwareTransport extends DecoderTransport {
  constructor(blob:Blob,pts:number[],fps:number,draw:(frame:DecodedFrame)=>void,failed:(error:unknown)=>void,isTactile=false,reference?:TactileBaseline,diagnostics?:(metrics:Record<string,number>)=>void){
    const {workerUrl,compiled}=resources();
    super(new Worker(workerUrl),compiled,blob,pts,fps,draw,failed,isTactile,reference,diagnostics);
  }
}
