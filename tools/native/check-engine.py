"""Native pipeline regressions without a second full model instance."""
import json,sys,tempfile
from pathlib import Path
import cv2,numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'force'))
from engine import Engine

class Session:
    def __init__(self,fail=False):self.calls=0;self.fail=fail
    def run(self,*args):
        self.calls+=1
        if self.fail:raise RuntimeError('Injected device loss')
        return np.array([[.1,.2]],np.float32),np.array(.8,np.float32)

def engine():
    e=Engine.__new__(Engine);e.session=Session();e.backend='CPUExecutionProvider';e.fallback=[];e.selection=[];e.prep_threads=2;e.threads=1;e.init_seconds=0
    e.manifest=json.loads((Path(__file__).resolve().parents[2]/'vendor/force/model.json').read_text());e.progress=lambda p:None
    return e
with tempfile.TemporaryDirectory() as root:
    path=Path(root)/'video.avi';writer=cv2.VideoWriter(str(path),cv2.VideoWriter_fourcc(*'MJPG'),10,(160,90));assert writer.isOpened()
    image=np.random.default_rng(2).integers(20,220,(90,160,3),dtype=np.uint8)
    for _ in range(8):writer.write(image)
    writer.release()
    e=engine();track,stats=e.estimate(path,'l_tact_l')
    assert e.session.calls==1 and stats['duplicates']==7,stats
    assert len(track['fz'])==8 and all(abs(f-1.14)<1e-6 for f in track['fz'])
    assert all(abs(f-.26)<1e-6 for f in track['shear'])
    e=engine();cancelled=[False];e.progress=lambda _:cancelled.__setitem__(0,True)
    try:e.estimate(path,'l_tact_l',cancel=lambda:cancelled[0]);raise AssertionError('Cancellation ignored')
    except InterruptedError:pass
    e=engine();e.session=Session(True);e.backend='CUDAExecutionProvider'
    def fallback(provider):e.session=Session();e.backend=provider
    e._session=fallback;track,stats=e.estimate(path,'l_tact_l')
    assert e.backend=='CPUExecutionProvider' and len(e.fallback)==1 and len(track['time'])==8
print('PASS: exact duplicates preserve nonzero reference, ordered all-frame results, cancellation, GPU failure fallback')
