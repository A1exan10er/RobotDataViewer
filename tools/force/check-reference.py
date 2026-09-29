"""Create identical decoded-input oracles for the C++/WASM and ONNX checks."""
import json
from pathlib import Path
import sys
import cv2
import numpy as np
import torch
from model import ROOT, Preprocessor, load_torch, forces

out=ROOT/'artifacts/force-reference';out.mkdir(parents=True,exist_ok=True)
cv2.setNumThreads(1);torch.set_num_threads(2)
net,_=load_torch();rng=np.random.default_rng(11)
baseline=rng.integers(20,220,(360,640,3),dtype=np.uint8)
cases=[('unchanged',baseline,baseline),('weak',baseline,np.clip(baseline.astype(int)+1,0,255).astype(np.uint8)),
       ('shift',baseline,cv2.warpAffine(baseline,np.float32([[1,0,2],[0,1,-1]]),(640,360))),
       ('odd',baseline[:359,:639],baseline[:359,:639].copy())]
cases[-1][2][120:170,200:250]=250
for path in sorted((ROOT/'artifacts/charger-recordings/verified').glob('**/episode_0157_*/observation.image.*tactile/video.mp4')):
    cap=cv2.VideoCapture(str(path));ok,ref=cap.read();cap.set(cv2.CAP_PROP_POS_MSEC,6000);ok2,current=cap.read();cap.release()
    if ok and ok2:cases.append((path.parent.name.split('.')[-1],ref,current))
records=[]
for name,reference,current in cases:
    for label,image in [('reference',reference),('current',current)]:
        cv2.cvtColor(image,cv2.COLOR_BGR2RGBA).tofile(out/f'{name}-{label}.rgba')
    input=Preprocessor(reference)(current);input.tofile(out/f'{name}-input.f32')
    with torch.inference_mode():seg,pred=net(torch.from_numpy(input))
    record={'name':name,'width':current.shape[1],'height':current.shape[0],
        'normalized':pred.numpy()[0].tolist(),'score':float(seg.max()),'forces':forces(pred.numpy()[0],float(seg.max()))}
    records.append(record)
(out/'manifest.json').write_text(json.dumps(records,indent=2)+'\n')
print(f'Created {len(records)} reference cases')
