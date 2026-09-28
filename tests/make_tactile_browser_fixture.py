"""Create short deterministic tactile recordings for native/software browser checks."""
import json
import shutil
import subprocess
import tarfile
import sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'tools'/'reference'))
from tactile_roi import synthetic_baseline

root=Path(__file__).resolve().parents[1]/'artifacts'/'tactile-fixtures'
for episode,count in ([] if '--offsets-only' in sys.argv else [('source',240),('short',3),('missing-arc',240)]):
    folder=root/episode;folder.mkdir(parents=True,exist_ok=True)
    (folder/'metadata.json').write_text(json.dumps(dict(robot='umi',task_title='Synthetic tactile calibration')))
    for name in ['left_wrist_view','left_wrist_left_tactile','left_wrist_right_tactile','right_wrist_left_tactile','right_wrist_right_tactile']:
        channel=folder/('observation.image.'+name);channel.mkdir(exist_ok=True)
        w,h,fps=160,96,30
        process=subprocess.Popen(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{w}x{h}','-r',str(fps),'-i','-','-an','-c:v','libx264','-crf','12','-pix_fmt','yuv420p',str(channel/'video.mp4')],stdin=subprocess.PIPE)
        rng=np.random.default_rng(500)
        baseline=synthetic_baseline(w,h,seed=500)
        if episode=='missing-arc' and name=='left_wrist_left_tactile': baseline[:]=100
        for i in range(count):
            image=np.repeat(baseline[:,:,None],3,axis=2).astype(np.int16)+rng.integers(-3,4,(h,w,1))
            if 90<=i<180:
                image[25:72,45:110]+=12 if i<120 else 28
            if 90<=i<210:
                image[baseline<30]+=90  # Outside-only response after the inside contact ends.
            if name=='left_wrist_view': image[:,i%w]=210
            process.stdin.write(np.clip(image,0,255).astype(np.uint8).tobytes())
        process.stdin.close();assert process.wait()==0
        (channel/'timestamps.csv').write_text('timestamp_ms\n'+''.join(f'{i*1000/fps:.6f}\n' for i in range(count)))
    with tarfile.open(root/(episode+'.tar'),'w') as archive:
        archive.add(folder,arcname=episode)
# Reuse identical encoded inputs to isolate offset/capture-rate synchronization.
source=root/'source';offsets=root/'offsets';offsets.mkdir(exist_ok=True)
shutil.copyfile(source/'metadata.json',offsets/'metadata.json')
for name,offset,scale in [('left_wrist_view',0,1),('left_wrist_left_tactile',250,1.05),('left_wrist_right_tactile',500,.95),('right_wrist_left_tactile',750,1.1),('right_wrist_right_tactile',1000,.9)]:
    target=offsets/('observation.image.'+name);target.mkdir(exist_ok=True)
    shutil.copyfile(source/target.name/'video.mp4',target/'video.mp4')
    (target/'timestamps.csv').write_text('timestamp_ms\n'+''.join(f'{offset+i*1000/30*scale:.6f}\n' for i in range(240)))
print(root)
# Original v1 prepared packages omit codecs. Keep that omission to verify probing
# selects sequential tactile decoding without changing the recording format.
prepared=root/'prepared';prepared.mkdir(exist_ok=True)
media=[];timings={}
for cid,name in [('l_wrist','left_wrist_view'),('l_tact_l','left_wrist_left_tactile'),('l_tact_r','left_wrist_right_tactile'),('r_tact_l','right_wrist_left_tactile'),('r_tact_r','right_wrist_right_tactile')]:
    path=cid+'.mp4';shutil.copyfile(source/('observation.image.'+name)/'video.mp4',prepared/path)
    media.append(dict(id=cid,kind='tactile' if 'tact' in cid else 'rgb',path=path,original=path,width=160,height=96,fps=30,frames=240,duration=8))
    timings[cid]=dict(media=[i/30 for i in range(240)],episode=[i*1000/30 for i in range(240)],estimated=False)
(prepared/'data.json').write_text(json.dumps(dict(timings=timings,trajectories=[],signals=[])))
(prepared/'manifest.json').write_text(json.dumps(dict(format='robot-data-viewer',version=1,episodes=[dict(id='prepared',title='Prepared tactile calibration',robot='umi',durationMs=8000,data='data.json',media=media,issues=[],sourceName='prepared')])) )
