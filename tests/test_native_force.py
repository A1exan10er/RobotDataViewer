import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools/native'))
from cache import TrackCache,identity,key
from launcher import Application, Handler, ThreadingHTTPServer


def fixture():
    m=json.loads((ROOT/'vendor/force/model.json').read_text())
    return {'sensor':'l_tact_l','video':{'sha256':'a'*64,'bytes':3,'width':640,'height':360,'frames':2},
        'model':{'id':m['model'],'weightsSha256':m['weightsSha256'],'pipeline':m['pipeline']},
        'reference':{'frame':0,'time':0},'unit':'N','time':[0,.1],'shear':[.17,2.], 'fz':[.27,3.],'valid':[1,1]}

class CacheTests(unittest.TestCase):
    def test_persistent_library_and_read_only_legacy_migration(self):
        with tempfile.TemporaryDirectory() as root:
            legacy=Path(root)/'legacy';old=TrackCache(legacy,1600);track=fixture();old.put(track)
            original=(legacy/(key(track)+'.json')).read_bytes()
            library=TrackCache(Path(root)/'library');library.migrate_from(legacy)
            self.assertEqual(library.get(track),track)
            for i in range(12):
                other=copy.deepcopy(track);other['video']['sha256']=f'{i:064x}';library.put(other)
            restarted=TrackCache(library.root)
            self.assertIsNone(restarted.usage()['limit'])
            self.assertEqual(restarted.usage()['tracks'],13)
            self.assertEqual((legacy/(key(track)+'.json')).read_bytes(),original)
            restarted.delete([track]);restarted.migrate_from(legacy)
            self.assertIsNone(restarted.get(track))  # Explicit deletion never resurrects legacy data.

    def test_failed_atomic_save_preserves_previous_result(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as root:
            track=fixture();cache=TrackCache(root);cache.put(track)
            updated=copy.deepcopy(track);updated['fz'][1]=4
            with patch('cache.os.replace',side_effect=OSError('disk full')):
                with self.assertRaises(OSError):cache.put(updated)
            self.assertEqual(cache.get(track),track)
            self.assertEqual(list(Path(root).glob('*.part')),[])
    def test_corrupt_result_is_discarded_for_recalculation(self):
        with tempfile.TemporaryDirectory() as root:
            track=fixture();cache=TrackCache(root);cache.put(track)
            path=Path(root)/(key(track)+'.json')
            path.write_text('{incomplete')
            self.assertIsNone(cache.get(track));self.assertFalse(path.exists())
    def test_restart_identity_and_deletion(self):
        with tempfile.TemporaryDirectory() as root:
            t=fixture();cache=TrackCache(root);cache.put(t)
            self.assertEqual(TrackCache(root).get(identity(t)),t)
            for kind in ('sensor','timing','checksum','weights','dimensions'):
                other=copy.deepcopy(t)
                if kind=='sensor':other['sensor']='r_tact_r'
                if kind=='timing':other['time'][1]=.2
                if kind=='checksum':other['video']['sha256']='b'*64
                if kind=='weights':other['model']['weightsSha256']='c'*64
                if kind=='dimensions':other['video']['width']=641
                self.assertIsNone(cache.get(identity(other)))
            cache.delete([identity(t)]);self.assertEqual(cache.usage()['bytes'],0)
    def test_incomplete_and_interrupted_writes_eviction(self):
        with tempfile.TemporaryDirectory() as root:
            t=fixture();cache=TrackCache(root,1600);cache.put(t)
            incomplete=copy.deepcopy(t);incomplete['valid'][1]=0
            with self.assertRaises(ValueError):cache.put(incomplete)
            (Path(root)/'interrupted.part').write_bytes(b'bad')
            cache=TrackCache(root,1600);self.assertFalse((Path(root)/'interrupted.part').exists())
            for i in range(10):
                other=copy.deepcopy(t);other['video']['sha256']=f'{i:064x}';cache.put(other)
            self.assertLessEqual(cache.usage()['bytes'],1600);self.assertIsNone(cache.get(t))
            cache.delete();self.assertEqual(cache.usage()['tracks'],0)

class HelperTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.app=Application(ROOT/'dist',ROOT/'vendor/force',self.temp.name)
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler);self.server.app=self.app;self.server.daemon_threads=True
        self.origin=f'http://127.0.0.1:{self.server.server_port}'
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.app.close();self.temp.cleanup()
    def call(self,path,method='GET',body=None,headers=None):
        h={'Authorization':'Bearer '+self.app.token,'Origin':self.origin};h.update(headers or {})
        raw=body if isinstance(body,bytes) else json.dumps(body).encode() if body is not None else None
        req=urllib.request.Request(self.origin+path,data=raw,method=method,headers=h)
        with urllib.request.urlopen(req,timeout=5) as response:return json.load(response)
    def test_authentication_origin_and_no_arbitrary_files(self):
        for headers in ({'Authorization':''},{'Origin':'https://evil.example'},{'Host':'evil.example'}):
            with self.assertRaises(urllib.error.HTTPError) as raised:self.call('/api/v1/capabilities',headers=headers)
            self.assertEqual(raised.exception.code,403)
        self.assertEqual(self.call('/api/v1/capabilities')['version'],1)
        with self.assertRaises(urllib.error.HTTPError):self.call('/../../etc/passwd')
        self.assertIsNone(self.app.active)
        self.assertNotIn('onnxruntime',sys.modules)  # capabilities/cache must not load the model
    def test_upload_bounds_integrity_cancellation(self):
        import hashlib
        t=fixture();t['video']['sha256']=hashlib.sha256(b'abc').hexdigest()
        job=self.call('/api/v1/jobs','POST',{'items':[identity(t)]})['id'];path='/api/v1/jobs/'+job
        with self.assertRaises(urllib.error.HTTPError):self.call(path+'/start','POST',{})
        with self.assertRaises(urllib.error.HTTPError):self.call(path+'/video/0','PUT',b'ab',{'X-Upload-Offset':'1'})
        self.call(path+'/video/0','PUT',b'ab',{'X-Upload-Offset':'0'})
        self.call(path+'/video/0','PUT',b'c',{'X-Upload-Offset':'2'})
        self.assertEqual((self.app.jobs[job]['directory']/'0.mp4').read_bytes(),b'abc')
        self.call(path,'DELETE');self.call(path,'DELETE')
        self.assertFalse(self.app.jobs[job]['directory'].exists());self.assertIsNone(self.app.active)
        self.assertEqual(self.app.cache.usage()['tracks'],0)
    def test_persistent_connection_consumes_start_body(self):
        import http.client
        from unittest.mock import patch
        job=self.call('/api/v1/jobs','POST',{'items':[identity(fixture())]})['id']
        conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port)
        headers={'Authorization':'Bearer '+self.app.token,'Origin':self.origin,'Content-Type':'application/json'}
        with patch.object(self.app,'start'):
            conn.request('POST',f'/api/v1/jobs/{job}/start',body='{}',headers=headers)
            response=conn.getresponse();self.assertEqual(response.status,200);response.read()
            conn.request('GET',f'/api/v1/jobs/{job}',headers=headers)
            response=conn.getresponse();self.assertEqual(response.status,200);response.read()
        conn.close()
    def test_cache_deletion_without_starting_job(self):
        t=fixture();self.app.cache.put(t)
        self.assertEqual(len(self.call('/api/v1/cache','POST',{'items':[identity(t)]})['tracks']),1)
        self.assertEqual(self.call('/api/v1/cache','DELETE',{'items':[identity(t)]})['bytes'],0)
        self.assertIsNone(self.app.active)
    def test_imported_tracks_are_saved_without_model_and_bad_identity_is_rejected(self):
        track=fixture();pack={'format':'robot-data-viewer-force','version':1,'tracks':[track]}
        self.assertEqual(self.call('/api/v1/cache','PUT',pack)['retention'],'persistent')
        self.assertEqual(self.call('/api/v1/cache','POST',{'items':[identity(track)]})['tracks'],[track])
        self.assertIsNone(self.app.active)
        track['model']['pipeline']='unvalidated'
        with self.assertRaises(urllib.error.HTTPError):self.call('/api/v1/cache','PUT',pack)
        self.assertNotIn('onnxruntime',sys.modules)
    def test_backend_choice_is_per_job_and_rejects_arbitrary_providers(self):
        for provider in ('auto','cpu','gpu'):
            job=self.call('/api/v1/jobs','POST',{'items':[identity(fixture())],'provider':provider})['id']
            self.assertEqual(self.app.jobs[job]['provider'],provider)
            self.call('/api/v1/jobs/'+job,'DELETE')
        with self.assertRaises(urllib.error.HTTPError):
            self.call('/api/v1/jobs','POST',{'items':[identity(fixture())],'provider':'untrusted-provider'})
    def test_save_failure_returns_complete_playable_track_with_explicit_unsaved_status(self):
        import io
        from unittest.mock import Mock,patch
        track=fixture();job=self.app.create([identity(track)])
        (job['directory']/'0.json').write_text(json.dumps(track))
        job['process']=Mock(stdout=io.StringIO(json.dumps({'complete':0,'diagnostics':{}})+'\n'))
        job['process'].wait.return_value=0
        with patch.object(self.app.cache,'put',side_effect=OSError('disk full')):
            self.app.monitor(job)
        state=self.call('/api/v1/jobs/'+job['id'])
        self.assertEqual(state['state'],'complete')
        self.assertEqual(state['tracks'],[track]);self.assertEqual(state['savedSensors'],[])
        self.assertIn(track['sensor'],state['storageErrors'])
        self.assertIsNone(self.app.active)
    def test_cancellation_when_worker_exits_during_enumeration(self):
        import psutil
        from unittest.mock import Mock,patch
        job=self.app.create([identity(fixture())])
        process=Mock(pid=12345);process.poll.return_value=None;job['process']=process
        with patch('psutil.Process',side_effect=psutil.NoSuchProcess(process.pid)):
            self.app.cancel(job)
            self.app.cancel(job)
        self.assertEqual(job['state'],'cancelled');self.assertIsNone(self.app.active)
        self.assertFalse(job['directory'].exists())
        job['process']=None

if __name__=='__main__':unittest.main()
