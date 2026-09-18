"""Extract read-only sample frames for the response regression. Requires OpenCV/numpy.
Usage: python tools/check-tactile-samples.py /path/to/extracted-three-task-folders
Diagnostic fixtures and reports are local artifacts, excluded from source/releases.
"""
import argparse,json,subprocess
from pathlib import Path
import cv2
parser=argparse.ArgumentParser();parser.add_argument('samples',type=Path);args=parser.parse_args()
root=Path(__file__).resolve().parents[1];out=root/'artifacts'/'response-samples';out.mkdir(parents=True,exist_ok=True)
# Wrist-video inspection supplies context. Assertions apply only to regions with
# measurable tactile evidence; RGB/gripper state is never input to the filter.
specs=[('capping','离心管装盖_umi','episode_0070*',[(2,'all','white'),(5,'right','white'),(18.8,'left_wrist_right_tactile','response'),(18.8,'right','white'),(60,'left','response'),(115.3,'all','white')]),('folding','折叠四连体无尘服_umi','episode_0055*',[(0,'all','white'),(10,'left_wrist_left_tactile','response'),(18.8,'right','response'),(20,'right','response'),(25,'all','white'),(150.2,'all','white')]),('sorting','离心管分拣_双臂','episode_0066*',[(2,'all','white'),(5,'all','white'),(10,'left','response'),(18.8,'left','response'),(20,'left','response'),(25,'left','white'),(50,'right_wrist_left_tactile','response')])]
manifest=[]
for task,folder,pattern,checks in specs:
 episode=next((args.samples/folder).rglob(pattern))
 for file in sorted(episode.glob('observation.image.*tactile/video.mp4')):
  channel=file.parent.name.removeprefix('observation.image.');cap=cv2.VideoCapture(str(file));fps=cap.get(cv2.CAP_PROP_FPS)
  ok,frame=cap.read();assert ok,file
  ref=cv2.cvtColor(frame,cv2.COLOR_BGR2RGBA);reference=f'{task}-{channel}-ref.rgba';(out/reference).write_bytes(ref.tobytes())
  for time,selector,expected in checks:
   if selector!='all' and not channel.startswith(selector):continue
   cap.set(cv2.CAP_PROP_POS_FRAMES,round(time*fps));ok,frame=cap.read();assert ok,(file,time)
   current=f'{task}-{channel}-{time}.rgba';(out/current).write_bytes(cv2.cvtColor(frame,cv2.COLOR_BGR2RGBA).tobytes())
   manifest.append(dict(task=task,episode=episode.name,channel=channel,time=time,expected=expected,width=ref.shape[1],height=ref.shape[0],reference=reference,current=current))
  cap.release()
path=out/'manifest.json';path.write_text(json.dumps(manifest,indent=2))
subprocess.run(['node','--experimental-strip-types',str(root/'tools'/'check-tactile-frames.mjs'),str(path)],check=True)
