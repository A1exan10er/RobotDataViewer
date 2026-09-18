"""Generate small, explicitly synthetic packages for browser edge-case checks."""
import csv
import importlib.util
import json
import shutil
from pathlib import Path

root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('package_samples',root/'tools/package_samples.py')
pkg=importlib.util.module_from_spec(spec);spec.loader.exec_module(pkg)
base=root/'artifacts'/'fixtures'
if base.exists():shutil.rmtree(base)
source=base/'source';source.mkdir(parents=True)
(source/'metadata.json').write_text(json.dumps({'robot':'synthetic','task_title':'Synthetic single-arm timing fixture / 单臂时间同步测试'}))
def write_csv(path,columns,rows):
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('w',newline='') as f:
        writer=csv.writer(f);writer.writerow(columns);writer.writerows(rows)
for cid,name in [('l_wrist','left_wrist_view'),('r_wrist','right_wrist_view'),('l_tact_l','left_wrist_left_tactile')]:
    folder=source/('observation.image.'+name);folder.mkdir()
    fps=15 if cid=='r_wrist' else 30
    pkg.run(['ffmpeg','-v','error','-f','lavfi','-i',f'testsrc2=size=320x240:rate={fps}:duration=4',
             '-c:v','libx264','-pix_fmt','yuv420p','-threads','2',str(folder/'video.mp4')])
    write_csv(folder/'timestamps.csv',['timestamp_ms','is_new'],[(round(100+i*1000/fps,3),1) for i in range(fps*4)])
write_csv(source/'observation.state.eef_pose/data.csv',['timestamp_ms','x','y','z','r1','r2','r3','r4','r5','r6','gripper'],[(i*40,i/100,.1,.2,1,0,0,0,1,0,.03) for i in range(103)])
write_csv(source/'observation.state.left_wrist_left_tactile/data.csv',['timestamp_ms','x','y','z'],[(i*40,i%5,0,1) for i in range(103)])
package=base/'complete';package.mkdir()
entry=pkg.prepare_episode(source,package,1)
(package/'manifest.json').write_text(json.dumps({'format':'robot-data-viewer','version':1,'episodes':[entry]}))
shutil.copyfile(root/'dist/viewer.html',package/'viewer.html')
missing=base/'missing';shutil.copytree(package,missing)
(missing/entry['media'][0]['path']).unlink()
corrupt=base/'corrupt';shutil.copytree(package,corrupt)
(corrupt/entry['media'][0]['path']).write_bytes(b'not a video')
invalid=base/'invalid';shutil.copytree(package,invalid)
data=json.loads((invalid/entry['data']).read_text());data['timings']['l_wrist']['episode'][1]='nan';(invalid/entry['data']).write_text(json.dumps(data))
signal=base/'signals';shutil.copytree(package,signal)
manifest=json.loads((signal/'manifest.json').read_text());manifest['episodes'][0]['media']=[];(signal/'manifest.json').write_text(json.dumps(manifest))
for name in ('missing','corrupt','invalid','signals'):
    path=base/name/'manifest.json'
    manifest=json.loads(path.read_text());manifest['episodes'][0]['title']=f'Synthetic {name} fixture';path.write_text(json.dumps(manifest))
print(base)
