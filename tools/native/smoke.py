"""Exercise an extracted portable launcher over its authenticated HTTP interface."""
import argparse,json,os,subprocess,time,urllib.request
from pathlib import Path
from urllib.parse import urlsplit,parse_qs
p=argparse.ArgumentParser();p.add_argument('launcher',type=Path);p.add_argument('--source',type=Path);p.add_argument('--storage',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
command=[str(a.launcher.resolve()),'--no-browser','--storage',str(a.storage.resolve())]
process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
report={};job=None
try:
 url=process.stdout.readline().strip();parts=urlsplit(url);origin=parts.scheme+'://'+parts.netloc;token=parse_qs(parts.fragment)['native'][0]
 def call(path,method='GET',data=None,headers=None):
  req=urllib.request.Request(origin+'/api/v1/'+path,method=method,data=data if isinstance(data,bytes) else json.dumps(data).encode() if data is not None else None,
    headers={'Authorization':'Bearer '+token,'Origin':origin,**(headers or {})})
  with urllib.request.urlopen(req,timeout=60) as response:return json.load(response)
 report['capabilities']=call('capabilities')
 with urllib.request.urlopen(origin) as response:assert b'1.4.0' in response.read()
 if a.source:
  import hashlib,sys
  sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'force'))
  from engine import probe
  from prepare import sensor
  items=[];files=[];model=report['capabilities']['model']
  for path in sorted(a.source.glob('**/video.mp4')):
   channel=sensor(path)
   if channel is None:continue
   width,height,pts=probe(path);raw=path.read_bytes();files.append(path)
   items.append({'sensor':channel,'video':{'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),'frames':len(pts),'width':width,'height':height},
    'model':{'id':model['model'],'weightsSha256':model['weightsSha256'],'pipeline':model['pipeline']},'reference':{'frame':0,'time':pts[0]},'time':pts})
  started=time.perf_counter();cached=call('cache','POST',{'items':items});report['cacheLookupSeconds']=time.perf_counter()-started
  report['cachedTracks']=len(cached['tracks'])
  if not cached['tracks']:
   started=time.perf_counter();job=call('jobs','POST',{'items':items})['id']
   for index,path in enumerate(files):
    with path.open('rb') as stream:
     offset=0
     for block in iter(lambda:stream.read(4*1024*1024),b''):
      call(f'jobs/{job}/video/{index}','PUT',block,{'X-Upload-Offset':str(offset)});offset+=len(block)
   call(f'jobs/{job}/start','POST',{})
   deadline=time.monotonic()+1800
   while time.monotonic()<deadline:
    state=call(f'jobs/{job}')
    if state['state'] in ('complete','failed','cancelled'):break
    time.sleep(.1)
   assert state['state']=='complete',state
   assert len(state['tracks'])==len(items) and not state['errors'],state
   report['preparationSeconds']=time.perf_counter()-started;report['diagnostics']=state['diagnostics'];report['transfer']=state['transfer']
   assert len(call('cache','POST',{'items':items})['tracks'])==len(items)
   call(f'jobs/{job}','DELETE');job=None
  report['storage']=call('capabilities')['storage']
 report['passed']=True
finally:
 if job:
  try:call(f'jobs/{job}','DELETE')
  except Exception:pass
 process.terminate()
 try:process.wait(timeout=10)
 except subprocess.TimeoutExpired:process.kill();process.wait()
 a.output.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k not in ('capabilities','diagnostics')}))
