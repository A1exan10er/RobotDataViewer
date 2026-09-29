#!/usr/bin/env python3
"""Loopback-only portable viewer. The model lives in a lazily started job process."""
import argparse
import atexit
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import signal
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from urllib.parse import urlsplit

HERE=Path(__file__).resolve().parent
FROZEN=bool(getattr(sys,'frozen',False))
ROOT=Path(sys.executable).resolve().parent if FROZEN else HERE.parents[1]
if FROZEN:os.environ.setdefault('RDV_FFMPEG_DIR',str(ROOT/'ffmpeg'))
sys.path.insert(0,str(HERE));sys.path.insert(0,str(ROOT/'tools/force'))
from cache import TrackCache, SENSORS, identity


def cache_home():
    if sys.platform=='win32':base=Path(os.environ.get('LOCALAPPDATA',Path.home()))
    elif sys.platform=='darwin':base=Path.home()/'Library/Caches'
    else:base=Path(os.environ.get('XDG_CACHE_HOME',Path.home()/'.cache'))
    return base/'RobotDataViewer/force-v1'

class Application:
    def __init__(self,web,model,storage,provider='auto'):
        self.web=Path(web);self.model=Path(model);self.token=secrets.token_urlsafe(32);self.cache=TrackCache(Path(storage)/'tracks')
        self.manifest=json.loads((self.model/'model.json').read_text());self.provider=provider
        self.jobs={};self.lock=threading.RLock();self.active=None
        self.work=Path(storage)/'temporary';self.work.mkdir(parents=True,exist_ok=True)
        # Only our marked abandoned launch directories. Never scan user recordings.
        for p in self.work.glob('launch-*'):
            try:
                import psutil
                pid=int((p/'owner').read_text())
                if not psutil.pid_exists(pid):raise ProcessLookupError
            except ProcessLookupError:shutil.rmtree(p,ignore_errors=True)
            except (ValueError,FileNotFoundError):
                if time.time()-p.stat().st_mtime>86400:shutil.rmtree(p,ignore_errors=True)
            except PermissionError:pass
        self.temp=Path(tempfile.mkdtemp(prefix='launch-',dir=self.work));(self.temp/'owner').write_text(str(os.getpid()))
    def close(self):
        for job in list(self.jobs.values()):self.cancel(job)
        shutil.rmtree(self.temp,ignore_errors=True)
    def check(self,item):
        if item['sensor'] not in SENSORS:raise ValueError('Invalid sensor')
        if item['model']!={'id':self.manifest['model'],'weightsSha256':self.manifest['weightsSha256'],'pipeline':self.manifest['pipeline']}:raise ValueError('Model mismatch')
        v=item['video'];n=v['frames'];times=item['time']
        if type(n)!=int or not 0<n<=2_000_000 or len(times)!=n:raise ValueError('Invalid frame count')
        if type(v['bytes'])!=int or not 0<v['bytes']<=16*1024**3:raise ValueError('Invalid video size')
        if not all(type(v[k])==int and 0<v[k]<=16384 for k in ('width','height')):raise ValueError('Invalid dimensions')
        if len(v['sha256'])!=64 or any(c not in '0123456789abcdef' for c in v['sha256']):raise ValueError('Invalid video checksum')
        if item['reference']!={'frame':0,'time':times[0]} or times[0]<0 or any(b<=a for a,b in zip(times,times[1:])):raise ValueError('Invalid timing')
        json.dumps(identity(item),allow_nan=False)
    def create(self,items):
        if not 0<len(items)<=4:raise ValueError('Select one to four tactile videos')
        for item in items:self.check(item)
        with self.lock:
            if self.active is not None:raise ValueError('Another force job is active')
            for old in list(self.jobs):self.cancel(self.jobs[old]);del self.jobs[old]
            name=secrets.token_hex(16);directory=self.temp/name;directory.mkdir()
            (directory/'request.json').write_text(json.dumps(items,allow_nan=False))
            job={'id':name,'items':items,'directory':directory,'state':'uploading','updated':time.monotonic(),'offsets':[0]*len(items),
                'tracks':[],'errors':{},'progress':None,'diagnostics':[],'transfer':0.,'process':None,'cancelled':False,'hashes':[hashlib.sha256() for _ in items],'lock':threading.RLock()}
            self.jobs[name]=job;self.active=name
            threading.Thread(target=self.watchdog,args=(job,),daemon=True).start()
            return job
    def cancel(self,job):
        with job['lock']:
            job['cancelled']=True;process=job['process']
            if process and process.poll() is None:
                import psutil
                try:
                    for child in psutil.Process(process.pid).children(recursive=True):
                        try:child.terminate()
                        except psutil.Error:pass
                except psutil.Error:pass  # The worker may exit between poll and enumeration.
                process.terminate()
        if process:
            try:process.wait(timeout=3)
            except subprocess.TimeoutExpired:process.kill();process.wait()
        with job['lock']:
            job['state']='cancelled';shutil.rmtree(job['directory'],ignore_errors=True)
            if self.active==job['id']:self.active=None
    def start(self,job):
        with job['lock']:
            if job['cancelled'] or job['state']!='uploading' or any(n!=item['video']['bytes'] for n,item in zip(job['offsets'],job['items'])):raise ValueError('Uploads are incomplete')
            addon=ROOT/'nvidia'/('RobotDataViewerEngine.exe' if os.name=='nt' else 'RobotDataViewerEngine')
            args=[str(addon) if FROZEN and addon.is_file() else sys.executable]
            if not FROZEN:args.append(str(HERE/'launcher.py'))
            args+=['--worker',str(job['directory']),'--model',str(self.model),'--provider',self.provider]
            with (job['directory']/'error.log').open('wb') as error_log:
                job['process']=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=error_log,text=True,env={**os.environ,'RDV_FORCE_PARENT_PID':str(os.getpid())})
            job['state']='calculating'
        threading.Thread(target=self.monitor,args=(job,),daemon=True).start()
    def watchdog(self,job):
        while job['state'] in ('uploading','calculating'):
            time.sleep(1)
            if time.monotonic()-job['updated']>120:
                self.cancel(job)
                with job['lock']:job['state']='failed';job['error']='Native preparation stopped responding'
                return
    def monitor(self,job):
        try:
            for line in job['process'].stdout:
                try:event=json.loads(line)
                except ValueError:continue
                with job['lock']:
                    if job['cancelled']:break
                    job['updated']=time.monotonic()
                    if 'progress' in event:job['progress']=event['progress']
                    if 'failed' in event:job['errors'][job['items'][event['failed']]['sensor']]=event['error']
                    if 'complete' in event:
                        track=json.loads((job['directory']/f"{event['complete']}.json").read_text())
                        job['tracks'].append(track);job['diagnostics'].append(event['diagnostics'])
                        try:self.cache.put(track)
                        except OSError as error:event['diagnostics']['cacheError']=str(error)
            code=job['process'].wait()
            with job['lock']:
                if not job['cancelled']:
                    job['state']='complete' if code==0 else 'failed'
                    if code:job['error']='Native engine failed; retry using browser calculation'
        except Exception as error:
            with job['lock']:job['state']='failed';job['error']=str(error)
        finally:
            job['process'].stdout.close();shutil.rmtree(job['directory'],ignore_errors=True)
            with self.lock:
                if self.active==job['id']:self.active=None

class Handler(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,*args):pass  # Never log launch authentication or recording metadata.
    def setup(self):super().setup();self.connection.settimeout(30)
    @property
    def app(self):return self.server.app
    def reply(self,status,value,content_type='application/json'):
        body=json.dumps(value,allow_nan=False).encode() if content_type=='application/json' else value
        self.send_response(status);self.send_header('Content-Type',content_type);self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.send_header('Referrer-Policy','no-referrer')
        self.end_headers();self.wfile.write(body)
    def authorized(self,api):
        origin=f'http://127.0.0.1:{self.server.server_port}'
        if self.headers.get('Host')!=origin[7:]:return False
        if self.headers.get('Origin') not in (None,origin):return False
        if api and not secrets.compare_digest(self.headers.get('Authorization',''),'Bearer '+self.app.token):return False
        if api and self.command!='GET' and self.headers.get('Origin')!=origin:return False
        return True
    def body(self):
        length=int(self.headers.get('Content-Length','-1'))
        if not 0<=length<=64*1024*1024:raise ValueError('Invalid request length')
        return json.loads(self.rfile.read(length))
    def do_GET(self):self.dispatch()
    def do_POST(self):self.dispatch()
    def do_DELETE(self):self.dispatch()
    def do_PUT(self):self.dispatch()
    def dispatch(self):
        path=urlsplit(self.path).path;api=path.startswith('/api/')
        if not self.authorized(api):self.reply(403,{'error':'Local authentication required'});self.close_connection=True;return
        try:
            if not api:
                name={'/':'viewer.html','/viewer.html':'viewer.html','/force-runtime.js':'force-runtime.js'}.get(path)
                if self.command!='GET' or not name:self.reply(404,{'error':'Not found'});return
                self.reply(200,(self.app.web/name).read_bytes(),'text/html; charset=utf-8' if name.endswith('html') else 'text/javascript');return
            if path=='/api/v1/capabilities' and self.command=='GET':
                self.reply(200,{'version':1,'native':True,'storage':self.app.cache.usage(),'model':self.app.manifest});return
            if path=='/api/v1/cache' and self.command=='POST':
                items=self.body()['items']
                if len(items)>4:raise ValueError('Too many sensors')
                for item in items:self.app.check(item)
                self.reply(200,{'format':'robot-data-viewer-force','version':1,'tracks':[t for item in items if (t:=self.app.cache.get(item))]});return
            if path=='/api/v1/cache' and self.command=='DELETE':
                items=self.body().get('items')
                if items is not None:
                    if len(items)>4:raise ValueError('Too many sensors')
                    for item in items:self.app.check(item)
                if self.app.active:raise ValueError('Cancel force preparation before deleting saved results')
                self.reply(200,self.app.cache.delete(items));return
            if path=='/api/v1/jobs' and self.command=='POST':
                self.reply(200,{'id':self.app.create(self.body()['items'])['id']});return
            parts=path.split('/')
            if len(parts)<5 or parts[1:4]!=['api','v1','jobs']:self.reply(404,{'error':'Unknown endpoint'});return
            job=self.app.jobs.get(parts[4])
            if job is None:self.reply(404,{'error':'Unknown job'});return
            if len(parts)==5 and self.command=='DELETE':self.app.cancel(job);self.reply(200,{'cancelled':True});return
            if len(parts)==5 and self.command=='GET':
                with job['lock']:self.reply(200,{k:job[k] for k in ('state','progress','tracks','errors','diagnostics','transfer')})
                return
            if len(parts)==6 and parts[5]=='start' and self.command=='POST':self.body();self.app.start(job);self.reply(200,{'started':True});return
            if len(parts)==7 and parts[5]=='video' and self.command=='PUT':
                index=int(parts[6]);length=int(self.headers.get('Content-Length','-1'));offset=int(self.headers.get('X-Upload-Offset','-1'))
                with job['lock']:
                    if job['cancelled'] or job['state']!='uploading' or not 0<=index<len(job['items']) or not 0<length<=4*1024*1024:raise ValueError('Invalid upload')
                    if offset!=job['offsets'][index] or offset+length>job['items'][index]['video']['bytes']:raise ValueError('Invalid upload offset')
                    started=time.perf_counter();remaining=length
                    with (job['directory']/f'{index}.mp4').open('ab') as stream:
                        while remaining:
                            block=self.rfile.read(min(256*1024,remaining))
                            if not block:raise ValueError('Interrupted upload')
                            stream.write(block);job['hashes'][index].update(block);remaining-=len(block)
                    job['updated']=time.monotonic();job['offsets'][index]+=length;job['transfer']+=time.perf_counter()-started
                    if job['offsets'][index]==job['items'][index]['video']['bytes'] and job['hashes'][index].hexdigest()!=job['items'][index]['video']['sha256']:
                        job['state']='failed';raise ValueError('Uploaded video checksum differs')
                self.reply(200,{'offset':offset+length});return
            self.reply(404,{'error':'Unknown endpoint'})
        except (KeyError,ValueError,TypeError,IndexError,OSError) as error:
            self.close_connection=True;self.reply(400,{'error':str(error)})


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--web',type=Path,default=ROOT if FROZEN else ROOT/'dist');parser.add_argument('--model',type=Path,default=ROOT/'model' if FROZEN else ROOT/'vendor/force')
    parser.add_argument('--storage',type=Path,default=cache_home());parser.add_argument('--no-browser',action='store_true');parser.add_argument('--worker',type=Path)
    parser.add_argument('--provider',default='auto');args=parser.parse_args()
    if args.worker:
        from worker import run
        run(args.worker,args.model,args.provider);return
    def stopped(*_):raise KeyboardInterrupt
    signal.signal(signal.SIGTERM,stopped)
    app=Application(args.web,args.model,args.storage,args.provider)
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);server.daemon_threads=True;server.app=app
    atexit.register(app.close);url=f'http://127.0.0.1:{server.server_port}/#native={app.token}'
    print(url,flush=True)
    if not args.no_browser:webbrowser.open(url)
    try:server.serve_forever(poll_interval=.25)
    except KeyboardInterrupt:pass
    finally:server.server_close();app.close()

if __name__=='__main__':main()
