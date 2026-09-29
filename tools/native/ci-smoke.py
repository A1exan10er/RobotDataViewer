"""Extract the actual native ZIP and exercise CPU preparation plus restart reuse."""
import json,os,subprocess,sys,zipfile
from pathlib import Path
import cv2,numpy as np
ROOT=Path(__file__).resolve().parents[2];label=sys.argv[1];version=json.loads((ROOT/'package.json').read_text())['version']
output=ROOT/'artifacts/native-extracted'/label;output.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(ROOT/'dist'/f'RobotDataViewer-{version}-{label}.zip') as archive:archive.extractall(output)
base=output/'RobotDataViewer'
if '--addon' in sys.argv:
 with zipfile.ZipFile(ROOT/'dist'/f'RobotDataViewer-{version}-{label}-nvidia.zip') as archive:archive.extractall(base)
 if os.name!='nt':(base/'nvidia/RobotDataViewerEngine').chmod(0o755)
exe=base/('RobotDataViewer.exe' if os.name=='nt' else 'RobotDataViewer')
if os.name!='nt':
 exe.chmod(0o755)
 for p in (base/'ffmpeg').glob('ff*'):p.chmod(0o755)
folder=ROOT/'artifacts/native-smoke-fixture/observation.image.left_wrist_left_tactile';folder.mkdir(parents=True,exist_ok=True)
# AVI/MJPEG avoids optional video encoders on CI. The engine probes the container.
writer=cv2.VideoWriter(str(folder/'video.avi'),cv2.VideoWriter_fourcc(*'MJPG'),10,(640,360))
assert writer.isOpened()
rng=np.random.default_rng(7);reference=rng.integers(0,255,(360,640,3),dtype=np.uint8)
for i in range(4):writer.write(reference)
writer.release();(folder/'video.avi').replace(folder/'video.mp4')
os.environ['RDV_FFMPEG_DIR']=str(base/'ffmpeg')
for pass_number in (1,2):
 subprocess.run([sys.executable,str(ROOT/'tools/native/smoke.py'),str(exe),'--source',str(folder.parent),
  '--storage',str(ROOT/'artifacts/native-smoke-cache'/label),'--output',str(ROOT/f'artifacts/native-smoke-{label}-{pass_number}.json')],check=True)
