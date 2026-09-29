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
from model import ROOT
from engine import Engine

SENSORS={'left_wrist_left_tactile':'l_tact_l','left_wrist_right_tactile':'l_tact_r',
         'right_wrist_left_tactile':'r_tact_l','right_wrist_right_tactile':'r_tact_r'}

def sensor(path):
    return next((value for key,value in SENSORS.items() if key in str(path).replace('\\','/').split('/')[-2]),None)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path)
    parser.add_argument('--output',type=Path,required=True,help='Separate .rdv-force.json file; originals are never changed')
    parser.add_argument('--episode',default='',help='Only video paths containing this episode identifier')
    parser.add_argument('--sensor',choices=list(SENSORS.values()))
    parser.add_argument('--threads',type=int,default=8)
    parser.add_argument('--expected-frames',type=int,help='Total frame count for provider startup-cost selection')
    parser.add_argument('--provider',default='auto',help='auto, cpu, or an ONNX execution provider')
    args=parser.parse_args()
    if args.output.exists():parser.error('Output already exists; select a new output path')
    def progress(p):
        if p['frame']%30==0 or p['frame']==p['frames']:print(f"{p['sensor']}: {p['frame']}/{p['frames']} ({p['backend']})",file=sys.stderr,flush=True)
    engine=Engine(ROOT/'vendor/force',args.threads,args.provider,progress,args.expected_frames)
    diagnostics=[]
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
                try:
                    track,stats=engine.estimate(path,channel);tracks.append(track);diagnostics.append(stats)
                except Exception as e:errors.append({'path':name,'error':str(e)});print(f'{name}: {e}',file=sys.stderr)
        finally:
            if archive:archive.close()
    if not tracks:raise SystemExit('No complete force tracks were prepared')
    args.output.parent.mkdir(parents=True,exist_ok=True)
    with args.output.open('x') as f:json.dump({'format':'robot-data-viewer-force','version':1,'tracks':tracks},f,separators=(',',':'),allow_nan=False)
    print(json.dumps({'output':str(args.output),'tracks':len(tracks),'seconds':time.perf_counter()-started,'errors':errors,'diagnostics':diagnostics}))
    return 1 if errors else 0

if __name__=='__main__':raise SystemExit(main())
