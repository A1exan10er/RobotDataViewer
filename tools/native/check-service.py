"""Cancellation and corrupt-sensor checks against an actual portable process."""
import argparse,hashlib,json,os,subprocess,sys,tempfile,time,urllib.request
from pathlib import Path
from urllib.parse import urlsplit,parse_qs
import psutil
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'force'))
from engine import probe
p=argparse.ArgumentParser();p.add_argument('launcher',type=Path);p.add_argument('video',type=Path);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
with tempfile.TemporaryDirectory(prefix='rdv-service-test-') as temp:
 process=subprocess.Popen([str(a.launcher.resolve()),'--no-browser','--storage',temp,'--provider','cpu'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 report={}
 try:
  url=process.stdout.readline().strip();parts=urlsplit(url);origin=parts.scheme+'://'+parts.netloc;token=parse_qs(parts.fragment)['native'][0]
  def call(path,method='GET',value=None,headers=None):
   req=urllib.request.Request(origin+'/api/v1/'+path,method=method,data=value if isinstance(value,bytes) else json.dumps(value).encode() if value is not None else None,
    headers={'Authorization':'Bearer '+token,'Origin':origin,**(headers or {})})
   with urllib.request.urlopen(req,timeout=30) as response:return json.load(response)
  model=call('capabilities')['model'];width,height,pts=probe(a.video);raw=a.video.read_bytes()
  item={'sensor':'l_tact_l','video':{'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),'frames':len(pts),'width':width,'height':height},
   'model':{'id':model['model'],'weightsSha256':model['weightsSha256'],'pipeline':model['pipeline']},'reference':{'frame':0,'time':pts[0]},'time':pts}
  def upload(job,index,data):
   for offset in range(0,len(data),4*1024*1024):call(f'jobs/{job}/video/{index}','PUT',data[offset:offset+4*1024*1024],{'X-Upload-Offset':str(offset)})
  def cancel(phase):
   job=call('jobs','POST',{'items':[item]})['id']
   if phase=='transfer':upload(job,0,raw[:len(raw)//2])
   else:
    upload(job,0,raw);call(f'jobs/{job}/start','POST',{})
    if phase=='processing':
     end=time.monotonic()+60
     while time.monotonic()<end:
      state=call('jobs/'+job)
      if state['progress'] and state['progress']['frame']>=2:break
      if state['state'] not in ('calculating','uploading'):raise AssertionError(state)
      time.sleep(.02)
     else:raise AssertionError('No processing progress')
   started=time.perf_counter();call('jobs/'+job,'DELETE');call('jobs/'+job,'DELETE');seconds=time.perf_counter()-started
   assert call('jobs/'+job)['state']=='cancelled'
   assert not list(Path(temp).glob('temporary/**/*.mp4'))
   assert call('capabilities')['storage']['tracks']==0
   report[phase+'CancellationSeconds']=seconds
  for phase in ('transfer','initialization','processing'):cancel(phase)
  bad=json.loads(json.dumps(item));bad['sensor']='r_tact_r';bad['video']['bytes']=3;bad['video']['sha256']=hashlib.sha256(b'bad').hexdigest()
  job=call('jobs','POST',{'items':[bad,item]})['id'];upload(job,0,b'bad');upload(job,1,raw);call(f'jobs/{job}/start','POST',{})
  end=time.monotonic()+300
  while time.monotonic()<end:
   state=call('jobs/'+job)
   if state['state']=='complete':break
   if state['state']=='failed':raise AssertionError(state)
   time.sleep(.1)
  assert state['state']=='complete' and len(state['tracks'])==1 and 'r_tact_r' in state['errors'],state
  assert call('capabilities')['storage']['tracks']==1
  call('jobs/'+job,'DELETE');call('cache','DELETE',{})
  assert call('capabilities')['storage']['tracks']==0
  assert not list(Path(temp).glob('temporary/**/*.mp4'))
  report['corruptSensorIsolated']=True;report['cacheClearDidNotStartJob']=True
  time.sleep(.2)
  assert not psutil.Process(process.pid).children(recursive=True)
  report['ownedWorkersReleased']=True
  job=call('jobs','POST',{'items':[item]})['id'];upload(job,0,raw);call(f'jobs/{job}/start','POST',{})
  children=psutil.Process(process.pid).children(recursive=True)
  process.kill();process.wait()
  deadline=time.monotonic()+8
  def alive(child):
   try:return child.is_running() and child.status()!=psutil.STATUS_ZOMBIE
   except psutil.Error:return False
  while time.monotonic()<deadline and any(alive(child) for child in children):time.sleep(.1)
  assert not any(alive(child) for child in children),'Orphan engine survived launcher crash'
  assert not list(Path(temp).glob('temporary/**/*.mp4'))
  process=subprocess.Popen([str(a.launcher.resolve()),'--no-browser','--storage',temp],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  parts=urlsplit(process.stdout.readline().strip());origin=parts.scheme+'://'+parts.netloc;token=parse_qs(parts.fragment)['native'][0]
  assert call('capabilities')['storage']['tracks']==0
  assert len(list(Path(temp).glob('temporary/launch-*')))==1
  report['launcherCrashRecovered']=True
 finally:
  process.terminate()
  try:process.wait(timeout=5)
  except subprocess.TimeoutExpired:process.kill();process.wait()
  a.output.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
