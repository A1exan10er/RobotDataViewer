"""Compare real decoded sample frames to the NumPy/OpenCV reference, read-only.
Usage: python tools/check-tactile-samples.py /path/to/extracted-three-task-folders
Local fixtures/reports stay in ignored artifacts and are never shipped.
"""
import argparse,json,subprocess,importlib.util,sys
from pathlib import Path
import cv2
import numpy as np
parser=argparse.ArgumentParser();parser.add_argument('samples',type=Path);args=parser.parse_args()
root=Path(__file__).resolve().parents[1];out=root/'artifacts'/'response-roi';out.mkdir(parents=True,exist_ok=True)
sys.path.insert(0,str(root/'tools'/'reference'))
from tactile_roi import detect_region
spec=importlib.util.spec_from_file_location('reference',root/'tools'/'reference'/'render_tactile_diff.py')
reference=importlib.util.module_from_spec(spec);spec.loader.exec_module(reference)
specs=[('capping','离心管装盖_umi','episode_0070*',[2,5,18.8,60,115.3]),('folding','折叠四连体无尘服_umi','episode_0055*',[0,10,18.8,20,25,150.2]),('sorting','离心管分拣_双臂','episode_0066*',[2,5,10,18.8,20,25,50])]
(out/'inferno.rgb').write_bytes(cv2.applyColorMap(np.arange(256,dtype=np.uint8),cv2.COLORMAP_INFERNO)[:,0,::-1].tobytes())
manifest=[];gamma=np.array([pow(i/255,.7)*255 for i in range(256)],dtype=np.uint8)
for task,folder,pattern,times in specs:
 episode=next((args.samples/folder).rglob(pattern))
 for file in sorted(episode.glob('observation.image.*tactile/video.mp4')):
  channel=file.parent.name.removeprefix('observation.image.');cap=cv2.VideoCapture(str(file));fps=cap.get(cv2.CAP_PROP_FPS)
  count=min(int(cap.get(cv2.CAP_PROP_FRAME_COUNT)),max(8,round(2*fps)))
  baseline,noise=reference.read_baseline(cap,count)
  region=detect_region(baseline);assert region['status']=='ready',(task,channel,region['confidence'])
  mask_name=f'{task}-{channel}-roi.mask';curve_name=f'{task}-{channel}-curve.f32'
  (out/mask_name).write_bytes(region['mask'].tobytes());(out/curve_name).write_bytes(region['curve'].astype('<f4').tobytes())
  base_name=f'{task}-{channel}-baseline.gray';noise_name=f'{task}-{channel}-noise.f32'
  (out/base_name).write_bytes(baseline.tobytes());(out/noise_name).write_bytes(noise.astype('<f4').tobytes())
  for time in times:
   cap.set(cv2.CAP_PROP_POS_FRAMES,round(time*fps));ok,frame=cap.read();assert ok,(file,time)
   current=f'{task}-{channel}-{time}.rgba';(out/current).write_bytes(cv2.cvtColor(frame,cv2.COLOR_BGR2RGBA).tobytes())
   delta=cv2.absdiff(cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY),baseline).astype(np.float32)
   cleaned=cv2.GaussianBlur(np.maximum(delta-noise-2,0)*region['mask'],(0,0),sigmaX=2,sigmaY=2)
   amplified=np.clip(cleaned*10,0,255).astype(np.uint8);amplified_name=f'{task}-{channel}-{time}-amplified.gray';(out/amplified_name).write_bytes(amplified.tobytes())
   intensity=cv2.LUT(amplified,gamma);intensity[(intensity<10)|(region['mask']==0)]=0
   colored=cv2.applyColorMap(intensity,cv2.COLORMAP_INFERNO);colored[intensity==0]=0
   expected=f'{task}-{channel}-{time}-expected.rgba';(out/expected).write_bytes(cv2.cvtColor(colored,cv2.COLOR_BGR2RGBA).tobytes())
   manifest.append(dict(task=task,channel=channel,time=time,width=baseline.shape[1],height=baseline.shape[0],sampleCount=count,baseline=base_name,noiseFloor=noise_name,current=current,expected=expected,amplified=amplified_name,roiMask=mask_name,roiCurve=curve_name,roiStatus=region['status'],roiConfidence=region['confidence']))
  cap.release()
path=out/'manifest.json';path.write_text(json.dumps(manifest,indent=2))
subprocess.run(['node','--experimental-strip-types',str(root/'tools'/'check-tactile-frames.mjs'),str(path)],check=True)
# Inspect TypeScript-produced masks on the baseline, without modifying recordings.
sheet=np.zeros((4*200,3*320,3),dtype=np.uint8)
seen=set()
for f in manifest:
 if f['baseline'] in seen:continue
 index=len(seen);seen.add(f['baseline'])
 baseline=np.fromfile(out/f['baseline'],dtype=np.uint8).reshape(f['height'],f['width'])
 mask=np.fromfile(out/(f['roiMask']+'.js'),dtype=np.uint8).reshape(baseline.shape)
 rgb=cv2.cvtColor(baseline,cv2.COLOR_GRAY2BGR);rgb[mask==0]//=4
 contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE);cv2.drawContours(rgb,contours,-1,(0,255,255),1)
 tile=cv2.resize(rgb,(320,180));y,x=(index//3)*200,(index%3)*320;sheet[y+20:y+200,x:x+320]=tile
 cv2.putText(sheet,f['task']+' '+f['channel'].replace('_tactile',''),(x+2,y+13),cv2.FONT_HERSHEY_SIMPLEX,.32,(255,255,255),1)
cv2.imwrite(str(out/'mask-contact-sheet.jpg'),sheet)
