"""Synthetic companion export matching inspected T1E1 layout; no customer data."""
import csv,json,math,os,subprocess,tarfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
base=root/'artifacts'/'headcam-fixture';episode=base/'T1E1';episode.mkdir(parents=True,exist_ok=True)
def write_json(path,data):
 path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(data,ensure_ascii=False,indent=2))
def write_csv(path,columns,rows):
 path.parent.mkdir(parents=True,exist_ok=True)
 with path.open('w',newline='') as f:
  w=csv.writer(f);w.writerow(columns);w.writerows(rows)
write_json(episode/'metadata.json',{'format':'ego-headcam-companion-1','umi_episode':'umi','episode_id':'synthetic-headcam','duration_seconds':12,'total_frames':720,'fps_config':60,'alignment_status':'timestamp_aligned'})
pose=lambda x:{'tcp.x':x,'tcp.y':0,'tcp.z':0,'tcp.qw':1,'tcp.qx':0,'tcp.qy':0,'tcp.qz':0}
write_json(episode/'umi'/'metadata.json',{'robot':'umi','task_title':'Synthetic head camera + UMI / 头戴相机兼容测试','coordinate_reference':{'type':'umi_episode_start_relative_pose','sides':{'left':{'pose':pose(0)},'right':{'pose':pose(.4)}}}})
for index,name in enumerate(['ego_left','ego_right','left_wrist_view','right_wrist_view','left_wrist_left_tactile','left_wrist_right_tactile','right_wrist_left_tactile','right_wrist_right_tactile']):
 head=name.startswith('ego_');tactile='tactile' in name
 folder=(episode if head else episode/'umi')/('observation.image.'+name);folder.mkdir(parents=True,exist_ok=True)
 fps=60 if head else 30;size='1920x1080' if head else '640x360' if tactile else '640x480'
 cmd=[os.environ.get('FFMPEG','ffmpeg'),'-v','error','-y','-f','lavfi','-i',f'testsrc2=size={size}:rate={fps}:duration=12','-vf',f'hue=h={index*35}','-c:v','libx264' if head else 'libx265','-preset','ultrafast','-crf','25','-pix_fmt','yuv420p','-threads','2']
 if not head:cmd+=['-x265-params','pools=2:frame-threads=1:log-level=error','-tag:v','hev1']
 subprocess.run(cmd+['-movflags','+faststart',str(folder/'video.mp4')],check=True)
 times=[round((7.648807 if head else 0)+i*1000/fps*(1.009 if head else 1)+math.sin(i*1.7)*(1.2 if head else 3),6) for i in range(fps*12)]
 cols=['timestamp_ms','is_new','source_raw_index','source_sequence'] if head else ['timestamp_ms','is_new']
 rows=[[t,1,580+i,4404+i] if head else [t,1] for i,t in enumerate(times)]
 write_csv(folder/'timestamps_raw.csv',cols,rows)
 write_csv(folder/'timestamps.csv',cols,rows if head else rows[:-1])
 print(name,flush=True)
write_csv(episode/'umi/observation.state.eef_pose/data.csv',['timestamp_ms','left_x','left_y','left_z','right_x','right_y','right_z'],[[i*1000/30,math.sin(i/100)*.1,math.cos(i/100)*.1,i/3000,math.sin(i/100)*.1,math.cos(i/100)*.1,i/3000] for i in range(360)])
write_csv(episode/'umi/observation.state.gripper/data.csv',['timestamp_ms','left_gripper','right_gripper'],[[i*1000/30,.02+math.sin(i/100)*.01,.03] for i in range(360)])
for sensor in ['left_wrist_left_tactile','left_wrist_right_tactile','right_wrist_left_tactile','right_wrist_right_tactile']:
 write_csv(episode/('umi/observation.state.'+sensor+'/data.csv'),['timestamp_ms','x','y','z'],[])
with tarfile.open(base/'headcam.tar','w') as archive:archive.add(episode,arcname='T1E1')
print(base)
