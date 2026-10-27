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
import socket
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
from cache import TrackCache, SENSORS, identity, validate


def cache_home():
    if sys.platform=='win32':base=Path(os.environ.get('LOCALAPPDATA',Path.home()))
    elif sys.platform=='darwin':base=Path.home()/'Library/Caches'
    else:base=Path(os.environ.get('XDG_CACHE_HOME',Path.home()/'.cache'))
    return base/'RobotDataViewer/force-v1'

def results_home():
    if sys.platform=='win32':base=Path(os.environ.get('LOCALAPPDATA',Path.home()))
    elif sys.platform=='darwin':base=Path.home()/'Library/Application Support'
    else:base=Path(os.environ.get('XDG_DATA_HOME',Path.home()/'.local/share'))
    return base/'RobotDataViewer/force-prepared-v1'

class Application:
    def __init__(self,web,model,storage,provider='auto'):
        self.web=Path(web);self.model=Path(model);self.token=secrets.token_urlsafe(32);self.cache=TrackCache(Path(storage)/'tracks')
        self.manifest=json.loads((self.model/'model.json').read_text());self.provider=provider
        self.migration_pending=False
        if Path(storage)==results_home():
            try:self.cache.migrate_from(cache_home()/'tracks')
            except OSError:self.migration_pending=True
        self.jobs={};self.lock=threading.RLock();self.active=None
        self.stop_event=threading.Event();self.activate_event=threading.Event()
        self.sessions={};self.closed=False;self.close_lock=threading.Lock()
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
        with self.close_lock:
            if self.closed:return
            self.stop_event.set()
            for job in list(self.jobs.values()):self.cancel(job)
            shutil.rmtree(self.temp,ignore_errors=True)
            self.closed=True
    def service_state(self):
        with self.lock:
            preparing=bool(self.active or any(self.sessions.values()))
            return {'application':'RobotDataViewer','protocol':1,
                    'state':'stopping' if self.stop_event.is_set() else 'running','preparing':preparing}
    def session(self,name,preparing):
        if not isinstance(name,str) or not 16<=len(name)<=64 or not all(c.isalnum() or c=='-' for c in name):
            raise ValueError('Invalid session')
        if preparing is not None and type(preparing)!=bool:raise ValueError('Invalid activity')
        with self.lock:
            if self.stop_event.is_set():raise ValueError('Service is stopping')
            # Keep only active calculations. If a browser crashes mid-calculation,
            # conservatively ask before shutdown rather than silently losing work.
            if preparing:self.sessions[name]=True
            else:self.sessions.pop(name,None)
    def request_stop(self,confirm=False):
        with self.lock:
            if self.stop_event.is_set():return True
            if self.service_state()['preparing'] and not confirm:return False
            self.stop_event.set()
            return True
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
    def create(self,items,provider=None):
        provider=provider or self.provider
        if provider not in ('auto','cpu','gpu','CUDAExecutionProvider','DmlExecutionProvider','CoreMLExecutionProvider'):
            raise ValueError('Invalid inference backend')
        if not 0<len(items)<=4:raise ValueError('Select one to four tactile videos')
        for item in items:self.check(item)
        with self.lock:
            if self.stop_event.is_set():raise ValueError('Service is stopping')
            if self.active is not None:raise ValueError('Another force job is active')
            for old in list(self.jobs):self.cancel(self.jobs[old]);del self.jobs[old]
            name=secrets.token_hex(16);directory=self.temp/name;directory.mkdir()
            (directory/'request.json').write_text(json.dumps(items,allow_nan=False))
            job={'id':name,'items':items,'directory':directory,'state':'uploading','updated':time.monotonic(),'offsets':[0]*len(items),
                'tracks':[],'errors':{},'savedSensors':[],'storageErrors':{},'provider':provider,'progress':None,'diagnostics':[],'transfer':0.,'process':None,'cancelled':False,'hashes':[hashlib.sha256() for _ in items],'lock':threading.RLock()}
            self.jobs[name]=job;self.active=name
            threading.Thread(target=self.watchdog,args=(job,),daemon=True).start()
            return job
    def cancel(self,job):
        with job['lock']:
            job['cancelled']=True;process=job['process']
            children=[]
            if process and process.poll() is None:
                import psutil
                try:
                    children=psutil.Process(process.pid).children(recursive=True)
                    for child in children:
                        try:child.terminate()
                        except psutil.Error:pass
                except psutil.Error:pass  # The worker may exit between poll and enumeration.
                try:process.terminate()
                except ProcessLookupError:pass
        if process:
            try:process.wait(timeout=3)
            except subprocess.TimeoutExpired:process.kill();process.wait()
        if children:
            _,alive=psutil.wait_procs(children,timeout=2)
            for child in alive:
                try:child.kill()
                except psutil.Error:pass
            psutil.wait_procs(alive,timeout=2)
        monitor=job.get('monitor')
        if monitor and monitor is not threading.current_thread():monitor.join(timeout=5)
        with job['lock']:
            job['state']='cancelled';shutil.rmtree(job['directory'],ignore_errors=True)
            if self.active==job['id']:self.active=None
    def start(self,job):
        with self.lock,job['lock']:
            if self.stop_event.is_set():raise ValueError('Service is stopping')
            if job['cancelled'] or job['state']!='uploading' or any(n!=item['video']['bytes'] for n,item in zip(job['offsets'],job['items'])):raise ValueError('Uploads are incomplete')
            addon=ROOT/'nvidia'/('RobotDataViewerEngine.exe' if os.name=='nt' else 'RobotDataViewerEngine')
            args=[str(addon) if FROZEN and addon.is_file() and job['provider']!='cpu' else sys.executable]
            if not FROZEN:args.append(str(HERE/'launcher.py'))
            # Existing NVIDIA add-ons understand the provider name, not the new UI alias.
            provider='CUDAExecutionProvider' if FROZEN and addon.is_file() and job['provider']=='gpu' else job['provider']
            args+=['--worker',str(job['directory']),'--model',str(self.model),'--provider',provider]
            with (job['directory']/'error.log').open('wb') as error_log:
                job['process']=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=error_log,text=True,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0,
                    env={**os.environ,'RDV_FORCE_PARENT_PID':str(os.getpid())})
            job['state']='calculating'
            job['monitor']=threading.Thread(target=self.monitor,args=(job,),daemon=True)
            job['monitor'].start()
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
                        try:self.cache.put(track);job['savedSensors'].append(track['sensor'])
                        except OSError as error:
                            event['diagnostics']['cacheError']=str(error)
                            job['storageErrors'][track['sensor']]='Result could not be saved; export to retain it'
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
    def handle(self):
        try:super().handle()
        except (ConnectionError,TimeoutError,OSError):pass  # Shutdown closes in-flight uploads and keep-alive sockets.
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
        public_status=path=='/api/v1/service' and self.command=='GET'
        if not self.authorized(api and not public_status):self.reply(403,{'error':'Local authentication required'});self.close_connection=True;return
        try:
            if public_status:
                # No token, paths, PID, recordings, or activity details in the public health response.
                state=self.app.service_state();state.pop('preparing')
                self.reply(200,state);return
            if path=='/api/v1/service/shutdown' and self.command=='POST':
                body=self.body();confirmed=body.get('cancelActive',False)
                if type(confirmed)!=bool:raise ValueError('Invalid shutdown confirmation')
                if not self.app.request_stop(confirmed):self.reply(409,{'error':'preparation-active'});return
                self.reply(200,{'state':'stopping'});return
            if self.app.stop_event.is_set():self.reply(503,{'error':'Service is stopping'});return
            if path=='/api/v1/service/activate' and self.command=='POST':
                self.body();self.app.activate_event.set();self.reply(200,{'activated':True});return
            if path=='/api/v1/service/session' and self.command in ('POST','DELETE'):
                body=self.body();self.app.session(body['id'],body.get('preparing') if self.command=='POST' else None)
                self.reply(200,{'registered':True});return
            if not api:
                name={'/':'viewer.html','/viewer.html':'viewer.html','/force-runtime.js':'force-runtime.js'}.get(path)
                if self.command!='GET' or not name:self.reply(404,{'error':'Not found'});return
                self.reply(200,(self.app.web/name).read_bytes(),'text/html; charset=utf-8' if name.endswith('html') else 'text/javascript');return
            if path=='/api/v1/capabilities' and self.command=='GET':
                self.reply(200,{'version':1,'native':True,'serviceControl':1,'storage':self.app.cache.usage(),'model':self.app.manifest,'migrationPending':self.app.migration_pending});return
            if path=='/api/v1/cache' and self.command=='PUT':
                pack=self.body()
                if pack.get('format')!='robot-data-viewer-force' or pack.get('version')!=1:raise ValueError('Invalid force file')
                tracks=pack['tracks']
                if not 0<len(tracks)<=4:raise ValueError('Too many sensors')
                for track in tracks:self.app.check(track);validate(track)
                for track in tracks:self.app.cache.put(track)
                self.reply(200,self.app.cache.usage());return
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
                body=self.body();self.reply(200,{'id':self.app.create(body['items'],body.get('provider'))['id']});return
            parts=path.split('/')
            if len(parts)<5 or parts[1:4]!=['api','v1','jobs']:self.reply(404,{'error':'Unknown endpoint'});return
            job=self.app.jobs.get(parts[4])
            if job is None:self.reply(404,{'error':'Unknown job'});return
            if len(parts)==5 and self.command=='DELETE':self.app.cancel(job);self.reply(200,{'cancelled':True});return
            if len(parts)==5 and self.command=='GET':
                with job['lock']:self.reply(200,{k:job[k] for k in ('state','progress','tracks','errors','diagnostics','transfer','savedSensors','storageErrors')})
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


class ServiceServer(ThreadingHTTPServer):
    daemon_threads=True
    def __init__(self,app):
        self.clients=set();self.clients_lock=threading.Lock()
        super().__init__(('127.0.0.1',0),Handler)
        self.app=app
    def get_request(self):
        client,address=super().get_request()
        with self.clients_lock:self.clients.add(client)
        return client,address
    def close_request(self,request):
        with self.clients_lock:self.clients.discard(request)
        super().close_request(request)
    def disconnect_clients(self):
        with self.clients_lock:clients=list(self.clients)
        for client in clients:
            try:client.shutdown(socket.SHUT_RDWR)
            except OSError:pass
            client.close()


class Service:
    def __init__(self,app):
        self.app=app;self.server=ServiceServer(app);self.done=threading.Event()
        self.origin=f'http://127.0.0.1:{self.server.server_port}'
        self.url=self.origin+'/#native='+app.token
        self.thread=threading.Thread(target=self.serve,name='viewer-http',daemon=True)
        self.thread.start()
        self.cleaner=threading.Thread(target=self.cleanup,name='viewer-shutdown',daemon=True)
        self.cleaner.start()
    def serve(self):
        try:self.server.serve_forever(poll_interval=.1)
        finally:self.app.stop_event.set()
    def cleanup(self):
        self.app.stop_event.wait()
        # Let the authenticated shutdown response reach the initiating browser.
        time.sleep(.15)
        try:
            self.server.shutdown()
            self.server.disconnect_clients()
            self.server.server_close()
            self.app.close()
            self.thread.join(timeout=2)
        finally:self.done.set()
    def close(self):
        self.app.request_stop(confirm=True)
        self.cleaner.join()


def version():
    source=ROOT/'BUILD.json' if FROZEN else ROOT/'package.json'
    return json.loads(source.read_text())['version']


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--web',type=Path,default=ROOT if FROZEN else ROOT/'dist');parser.add_argument('--model',type=Path,default=ROOT/'model' if FROZEN else ROOT/'vendor/force')
    parser.add_argument('--storage',type=Path,default=results_home());parser.add_argument('--no-browser',action='store_true');parser.add_argument('--worker',type=Path)
    parser.add_argument('--headless',action='store_true',help='Run in the terminal without a desktop window')
    parser.add_argument('--provider',default='auto');args=parser.parse_args()
    if args.worker:
        from worker import run
        run(args.worker,args.model,args.provider);return
    def stopped(*_):raise KeyboardInterrupt
    signal.signal(signal.SIGTERM,stopped)
    if hasattr(signal,'SIGHUP'):signal.signal(signal.SIGHUP,stopped)
    if hasattr(signal,'SIGBREAK'):signal.signal(signal.SIGBREAK,stopped)
    headless=args.headless or args.no_browser
    desktop=service=app=instance=None
    try:
        if not headless:
            from desktop import Desktop
            desktop=Desktop(version())
            desktop.root.update()
            from instance import Instance
            instance=Instance(results_home().parent/'runtime',{
                'root':str(ROOT.resolve()),'version':version(),'web':str(args.web.resolve()),
                'model':str(args.model.resolve()),'storage':str(args.storage.resolve())})
            if not instance.claim_or_activate():return
        for path in (args.web/'viewer.html',args.web/'force-runtime.js',args.model/'model.json',args.model/'force.onnx'):
            if not path.is_file():raise ValueError('The package is incomplete. Extract the complete package. / 请完整解压软件包。\n'+str(path))
        app=Application(args.web,args.model,args.storage,args.provider)
        atexit.register(app.close)
        service=Service(app)
        if instance:instance.publish(service.server.server_port,app.token)
        print(service.url,flush=True)
        print('Robot Data Viewer is running. Stop & Exit closes the service; Ctrl+C also stops terminal launches.',flush=True)
        if desktop:
            desktop.attach(service)
            desktop.root.after(0,desktop.open)
            desktop.run()
        else:
            if not args.no_browser and not webbrowser.open(service.url):print('Open the local URL above in your browser.',flush=True)
            while not service.done.wait(.1):
                if app.activate_event.is_set():app.activate_event.clear();webbrowser.open(service.url)
    except KeyboardInterrupt:pass
    except Exception as error:
        if desktop:desktop.error(error)
        else:
            print('Robot Data Viewer could not start: '+str(error),file=sys.stderr,flush=True)
            # Never run an invisible service if Tk or the display cannot initialize.
            if not headless and os.name=='nt':
                import ctypes
                ctypes.windll.user32.MessageBoxW(None,str(error),'Robot Data Viewer',0x10)
        return 1
    finally:
        if service:service.close()
        elif app:app.close()
        if app:atexit.unregister(app.close)
        if instance:instance.close()
        if desktop:desktop.close()

if __name__=='__main__':sys.exit(main())
