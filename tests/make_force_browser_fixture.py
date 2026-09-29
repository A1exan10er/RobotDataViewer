"""Make an ignored 6-second multi-channel integration fixture from local episode 0157."""
import json
from pathlib import Path
import subprocess
import tarfile
import cv2
root=Path(__file__).resolve().parents[1]
source=next((root/'artifacts/charger-recordings/verified').glob('**/episode_0157_*'))
target=root/'artifacts/force-fixtures/contact';target.mkdir(parents=True,exist_ok=True)
(target/'metadata.json').write_text(json.dumps({'robot':'arx5','task_title':'Force synchronization fixture','duration_seconds':6}))
times=[i/30 for i in range(8)]+[6,10,15,19]
for path in sorted(source.glob('observation.image.*/video.mp4')):
    capture=cv2.VideoCapture(str(path));fps=capture.get(cv2.CAP_PROP_FPS);indices=[round(t*fps) for t in times]
    frames=[];index=0
    while len(frames)<len(indices):
        ok,frame=capture.read()
        if not ok:break
        while len(frames)<len(indices) and indices[len(frames)]==index:frames.append(frame.copy())
        index+=1
    capture.release()
    if len(frames)!=len(times):raise RuntimeError(f'Incomplete fixture input: {path}')
    channel=target/path.parent.name;channel.mkdir(exist_ok=True);h,w=frames[0].shape[:2]
    encoder=subprocess.Popen(['ffmpeg','-hide_banner','-loglevel','error','-y','-threads','1','-f','rawvideo','-pix_fmt','bgr24','-s',f'{w}x{h}','-r','2','-i','-',
        '-c:v','libx264','-threads','1','-crf','12','-pix_fmt','yuv420p',str(channel/'video.mp4')],stdin=subprocess.PIPE)
    for frame in frames:encoder.stdin.write(frame.tobytes())
    encoder.stdin.close();assert encoder.wait()==0
    (channel/'timestamps.csv').write_text('timestamp_ms\n'+''.join(f'{i*500}\n' for i in range(len(frames))))
with tarfile.open(target.parent/'contact.tar','w') as archive:archive.add(target,arcname=target.name)
print(target)
