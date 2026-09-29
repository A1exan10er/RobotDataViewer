"""Generate independent checked-neighbor mask goldens, without customer data."""
import base64,json,sys,zlib
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools/reference'))
from tactile_roi import synthetic_baseline,detect_region,borrow_region
encode=lambda a:base64.b64encode(zlib.compress(a.tobytes(),9)).decode()
donor=synthetic_baseline(neighbor=False);region=detect_region(donor)
y,x=np.mgrid[:360,:640]
cases=[]
for name,current in {
 'same-rim':donor.copy(),
 'brightness':np.clip(np.floor(donor.astype(float)*.8+12+.5),0,255).astype(np.uint8),
 'partial-occlusion':np.where((y>=130)&(y<210),0,donor).astype(np.uint8),
 'shifted':donor[y,np.maximum(0,x-20)],
 'black':np.zeros_like(donor),'white':np.full_like(donor,255),
 'noise':np.random.default_rng(23).integers(0,256,donor.shape,dtype=np.uint8),
}.items():
 mask=borrow_region(current,donor,region['curve'],region['confidence'])
 cases.append(dict(name=name,current=encode(current),mask=None if mask is None else encode(mask)))
Path(__file__).with_name('fixtures').joinpath('tactile-neighbor.json').write_text(json.dumps(dict(width=640,height=360,baseline=encode(donor),curve=encode(region['curve'].astype('<f4')),confidence=region['confidence'],cases=cases),indent=2)+'\n')
