#!/usr/bin/env python3
"""Prepare independent frame-indexed force tracks from a folder or original TAR."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time

import cv2
import numpy as np
import onnxruntime as ort
from model import ROOT, MODEL_ID, PIPELINE, Preprocessor, forces

SENSORS={'left_wrist_left_tactile':'l_tact_l','left_wrist_right_tactile':'l_tact_r',
         'right_wrist_left_tactile':'r_tact_l','right_wrist_right_tactile':'r_tact_r'}

def sensor(path):
    return next((value for key,value in SENSORS.items() if key in str(path).replace('\\','/').split('/')[-2]),None)

def checksum(path):
    digest=hashlib.sha256()
    with open(path,'rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):digest.update(chunk)
    return digest.hexdigest()

def estimate(path, channel, session, manifest):
    metadata=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0',
        '-show_entries','stream=width,height:frame=best_effort_timestamp_time','-of','json',str(path)]))
    width,height=metadata['streams'][0]['width'],metadata['streams'][0]['height']
    pts=[float(f['best_effort_timestamp_time']) for f in metadata['frames']]
    if not pts or any(b<=a for a,b in zip(pts,pts[1:])):raise ValueError('Missing or invalid video timestamps')
    origin=pts[0];pts=[t-origin for t in pts]
    process=subprocess.Popen(['ffmpeg','-v','error','-threads','1','-i',str(path),'-map','0:v:0','-threads','1',
        '-vsync','0','-f','rawvideo','-pix_fmt','bgr24','pipe:1'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    normal=[];shear=[];preprocessor=None
    try:
        for i in range(len(pts)):
            count=width*height*3; raw=bytearray()
            while len(raw)<count:
                block=process.stdout.read(count-len(raw))
                if not block:raise ValueError(f'Decoding ended before frame {i}')
                raw.extend(block)
            frame=np.frombuffer(raw,np.uint8).reshape(height,width,3)
            if preprocessor is None:preprocessor=Preprocessor(frame)
            prediction,score=session.run(None,{'input':preprocessor(frame)})
            if not np.isfinite(prediction).all() or not np.isfinite(score).all():raise ValueError('Nonfinite inference output')
            s,fz=forces(prediction[0],float(score));shear.append(s);normal.append(fz)
            if i%30==0 or i+1==len(pts):print(f'{channel}: {i+1}/{len(pts)}',file=sys.stderr,flush=True)
        if process.stdout.read(1):raise ValueError('Decoded frame count differs from timestamp count')
        if process.wait()!=0:raise ValueError('Video decoding failed')
    finally:
        process.stdout.close()
        if process.poll() is None:process.terminate();process.wait()
    return {'sensor':channel,'video':{'sha256':checksum(path),'bytes':path.stat().st_size,'frames':len(pts),'width':width,'height':height},
        'model':{'id':MODEL_ID,'weightsSha256':manifest['weightsSha256'],'pipeline':PIPELINE},
        'reference':{'frame':0,'time':pts[0]},'unit':'N','time':pts,'shear':shear,'fz':normal,'valid':[1]*len(pts)}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path)
    parser.add_argument('--output',type=Path,required=True,help='Separate .rdv-force.json file; originals are never changed')
    parser.add_argument('--episode',default='',help='Only video paths containing this episode identifier')
    parser.add_argument('--sensor',choices=list(SENSORS.values()))
    parser.add_argument('--threads',type=int,default=2)
    args=parser.parse_args()
    if args.output.exists():parser.error('Output already exists; select a new output path')
    cv2.setNumThreads(max(1,args.threads))
    options=ort.SessionOptions();options.graph_optimization_level=ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED;options.intra_op_num_threads=max(1,args.threads);options.inter_op_num_threads=1
    manifest=json.loads((ROOT/'vendor/force/model.json').read_text())
    session=ort.InferenceSession(str(ROOT/'vendor/force/force.onnx'),options,providers=['CPUExecutionProvider'])
    tracks=[];errors=[];started=time.perf_counter()
    with tempfile.TemporaryDirectory(prefix='rdv-force-') as temp:
        archive=tarfile.open(args.source,'r:') if args.source.is_file() else None
        try:
            entries=archive.getmembers() if archive else sorted(args.source.rglob('video.mp4'))
            for entry in entries:
                name=entry.name if archive else str(entry)
                if not name.endswith('/video.mp4') or args.episode not in name:continue
                channel=sensor(name)
                if channel is None or (args.sensor and args.sensor!=channel):continue
                path=entry
                if archive:
                    if not entry.isfile():continue
                    path=Path(temp)/'sensor.mp4'
                    stream=archive.extractfile(entry)
                    with stream,open(path,'wb') as target:
                        for chunk in iter(lambda:stream.read(1024*1024),b''):target.write(chunk)
                try:tracks.append(estimate(path,channel,session,manifest))
                except Exception as e:errors.append({'path':name,'error':str(e)});print(f'{name}: {e}',file=sys.stderr)
        finally:
            if archive:archive.close()
    if not tracks:raise SystemExit('No complete force tracks were prepared')
    args.output.parent.mkdir(parents=True,exist_ok=True)
    with args.output.open('x') as f:json.dump({'format':'robot-data-viewer-force','version':1,'tracks':tracks},f,separators=(',',':'),allow_nan=False)
    print(json.dumps({'output':str(args.output),'tracks':len(tracks),'seconds':time.perf_counter()-started,'errors':errors}))
    return 1 if errors else 0

if __name__=='__main__':raise SystemExit(main())
