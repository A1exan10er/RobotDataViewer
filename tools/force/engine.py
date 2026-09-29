"""Ordered, bounded native force preparation. No browser or recording state here."""
from collections import OrderedDict, deque
from concurrent.futures import ThreadPoolExecutor
import gc
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time

import cv2
import numpy as np
import onnxruntime as ort
from model import MODEL_ID, PIPELINE, Preprocessor, forces


def cpu_budget():
    try:
        import psutil
        return max(1, psutil.cpu_count(logical=False) or 1)
    except ImportError:
        return max(1, (os.cpu_count() or 2)//2)


def checksum(path):
    h=hashlib.sha256()
    with open(path,'rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
    return h.hexdigest()


def binary(name):
    directory=os.environ.get('RDV_FFMPEG_DIR')
    return str(Path(directory)/(name+('.exe' if os.name=='nt' else ''))) if directory else shutil.which(name) or name


def probe(path):
    result=subprocess.run([binary('ffprobe'),'-v','error','-select_streams','v:0',
        '-show_entries','stream=width,height:frame=best_effort_timestamp_time','-of','json',str(path)],
        capture_output=True,check=True,timeout=120)
    meta=json.loads(result.stdout);width=meta['streams'][0]['width'];height=meta['streams'][0]['height']
    if not 0<width*height<=16_777_216:raise ValueError('Unsupported video dimensions')
    pts=[float(f['best_effort_timestamp_time']) for f in meta['frames']]
    if not pts or len(pts)>2_000_000 or not all(np.isfinite(pts)) or any(b<=a for a,b in zip(pts,pts[1:])):
        raise ValueError('Invalid video timestamps')
    return width,height,[p-pts[0] for p in pts]


class Engine:
    def __init__(self, model_dir, threads=None, provider='auto', progress=lambda p:None, total_frames=None):
        started=time.perf_counter();self.directory=Path(model_dir)
        self.manifest=json.loads((self.directory/'model.json').read_text())
        cores=cpu_budget();self.prep_threads=min(2,max(1,cores-1))
        self.threads=min(8,max(1,cores-self.prep_threads-1),max(1,threads or 8))
        cv2.setNumThreads(1)
        self.session=None;self.backend='CPUExecutionProvider';self.fallback=[];self.selection=[]
        self.init_seconds=0;self.progress=progress
        self._choose(provider,total_frames)
        self.init_seconds=time.perf_counter()-started

    def _session(self, provider):
        # Release the previous full model before constructing another provider.
        self.session=None;gc.collect()
        options=ort.SessionOptions();options.intra_op_num_threads=self.threads;options.inter_op_num_threads=1
        options.execution_mode=ort.ExecutionMode.ORT_SEQUENTIAL
        options.graph_optimization_level=ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        options.add_session_config_entry('session.intra_op.allow_spinning','0')
        options.add_session_config_entry('session.inter_op.allow_spinning','0')
        settings={}
        if provider=='DmlExecutionProvider':options.enable_mem_pattern=False
        if provider=='CUDAExecutionProvider':
            if hasattr(ort,'preload_dlls'):ort.preload_dlls(directory='')
            settings={'use_tf32':'0','cudnn_conv_algo_search':'HEURISTIC','cudnn_conv_use_max_workspace':'0','gpu_mem_limit':str(2*1024**3)}
        if provider=='CoreMLExecutionProvider':
            settings={'ModelFormat':'MLProgram','MLComputeUnits':'ALL','RequireStaticInputShapes':'1','AllowLowPrecisionAccumulationOnGPU':'0'}
        self.session=ort.InferenceSession(str(self.directory/'force.onnx'),options,
            providers=[(provider,settings)] if provider=='CPUExecutionProvider' else [(provider,settings),'CPUExecutionProvider'])
        if provider not in self.session.get_providers():raise RuntimeError(f'{provider} could not initialize')
        self.session.disable_fallback();self.backend=provider

    def _validate(self):
        path=self.directory/'validation.npz'
        if not path.exists():raise RuntimeError('Native numerical validation cases are missing')
        elapsed=[];maximum=0.
        with np.load(path,allow_pickle=False) as data:
            for x,expected,score in zip(data['inputs'],data['normalized'],data['scores']):
                start=time.perf_counter();pred,actual_score=self.session.run(None,{'input':x});elapsed.append(time.perf_counter()-start)
                actual=np.maximum(pred[0],0)*[2.6,5.7];expected=np.maximum(expected,0)*[2.6,5.7]
                np.testing.assert_allclose(actual,expected,atol=.001,rtol=.001)
                if (float(actual_score)>=.1)!=(float(score)>=.1):raise ValueError('Contact validation failed')
                maximum=max(maximum,float(np.max(abs(actual-expected))))
        return {'secondsPerFrame':float(np.median(elapsed[1:])), 'maxForceError':maximum,'cases':len(elapsed)}

    def _choose(self, requested,total_frames):
        self._session('CPUExecutionProvider');cpu=self._validate();self.selection.append({'provider':self.backend,**cpu})
        candidates=[p for p in ('CUDAExecutionProvider','DmlExecutionProvider','CoreMLExecutionProvider') if p in ort.get_available_providers()]
        if requested=='cpu':return
        if requested=='auto' and total_frames is not None and total_frames*cpu['secondsPerFrame']<5:
            self.fallback.append('Short job: CPU estimate below GPU startup allowance (5 seconds)');return
        if requested!='auto':candidates=[requested]
        if not candidates:self.fallback.append('No native GPU provider installed');return
        for provider in candidates:
            try:
                self._session(provider);result=self._validate();self.selection.append({'provider':provider,**result})
                if result['secondsPerFrame']<cpu['secondsPerFrame']*.95:return
                self.fallback.append(f'{provider} was not faster than CPU')
            except Exception as error:self.fallback.append(f'{provider}: {type(error).__name__}: {error}')
        self._session('CPUExecutionProvider')

    def estimate(self,path,sensor,cancel=lambda:False):
        started=time.perf_counter();width,height,pts=probe(path)
        stats={'decode':0.,'preprocessing':0.,'inference':0.,'initialization':self.init_seconds,'duplicates':0,'frames':len(pts)}
        process=subprocess.Popen([binary('ffmpeg'),'-v','error','-threads','1','-i',str(path),'-map','0:v:0','-threads','1',
            '-vsync','0','-f','rawvideo','-pix_fmt','bgr24','pipe:1'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        local=threading.local();reference=None;normal=[];shear=[];queue=deque();memo=OrderedDict();memo_lock=threading.Lock();first_key=None
        def checked():
            if cancel():raise InterruptedError('Cancelled')
        def read():
            checked();start=time.perf_counter();raw=bytearray();count=width*height*3
            while len(raw)<count:
                checked();block=process.stdout.read(count-len(raw))
                if not block:raise ValueError('Truncated decoded video')
                raw.extend(block)
            stats['decode']+=time.perf_counter()-start
            return np.frombuffer(raw,np.uint8).reshape(height,width,3)
        def preprocess(frame):
            checked();start=time.perf_counter()
            if not hasattr(local,'preprocessor'):local.preprocessor=Preprocessor(reference)
            processor=local.preprocessor;gray=processor.gray(frame)
            # Compare complete processed images, never approximate pixels or flow.
            key=gray.tobytes()
            with memo_lock:cached=memo.get(key)
            x=None if cached is not None else processor(frame)
            return key,x,time.perf_counter()-start,cached
        try:
            reference=read()
            with ThreadPoolExecutor(max_workers=self.prep_threads,thread_name_prefix='force-preprocess') as pool:
                submitted=0
                while len(normal)<len(pts):
                    while submitted<len(pts) and len(queue)<self.prep_threads+1:
                        frame=reference if submitted==0 else read()
                        queue.append(pool.submit(preprocess,frame));submitted+=1
                    key,x,seconds,cached=queue.popleft().result();stats['preprocessing']+=seconds;checked()
                    if first_key is None:first_key=key
                    with memo_lock:cached=memo.get(key,cached)
                    if cached is not None:
                        s,fz=cached;stats['duplicates']+=1
                        with memo_lock:
                            if key in memo:memo.move_to_end(key)
                    else:
                        start=time.perf_counter()
                        try:prediction,score=self.session.run(None,{'input':x})
                        except Exception as error:
                            if self.backend=='CPUExecutionProvider':raise
                            self.fallback.append(f'{self.backend} failed during inference: {error}')
                            self._session('CPUExecutionProvider');prediction,score=self.session.run(None,{'input':x})
                        if not np.isfinite(prediction).all() or not np.isfinite(score).all():raise ValueError('Nonfinite inference output')
                        s,fz=forces(prediction[0],float(score));stats['inference']+=time.perf_counter()-start
                        with memo_lock:
                            memo[key]=(s,fz)
                            while len(memo)>32:
                                oldest=next(iter(memo))
                                if oldest==first_key:memo.move_to_end(oldest)
                                else:memo.popitem(last=False)
                    checked();shear.append(s);normal.append(fz)
                    self.progress({'sensor':sensor,'frame':len(normal),'frames':len(pts),'stage':'calculating',
                        'elapsed':time.perf_counter()-started,'backend':self.backend})
                if process.stdout.read(1):raise ValueError('Decoded frame count differs from timestamps')
                if process.wait(timeout=10):raise ValueError('Video decoder failed')
        finally:
            process.stdout.close()
            if process.poll() is None:process.kill();process.wait()
            for future in queue:future.cancel()
        stats.update(seconds=time.perf_counter()-started,backend=self.backend,fallback=self.fallback,threads=self.threads,selection=self.selection)
        track={'sensor':sensor,'video':{'sha256':checksum(path),'bytes':Path(path).stat().st_size,'frames':len(pts),'width':width,'height':height},
            'model':{'id':MODEL_ID,'weightsSha256':self.manifest['weightsSha256'],'pipeline':PIPELINE},
            'reference':{'frame':0,'time':pts[0]},'unit':'N','time':pts,'shear':shear,'fz':normal,'valid':[1]*len(pts)}
        return track,stats
