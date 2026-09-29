"""Atomic, content-addressed LRU for completed version-1 force tracks only."""
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import threading
import time

FORMAT='robot-data-viewer-force'
LIMIT=256*1024*1024
SENSORS=('l_tact_l','l_tact_r','r_tact_l','r_tact_r')

def identity(track):
    return {k:track[k] for k in ('sensor','video','model','reference')} | {'time':track['time']}

def key(request):
    return hashlib.sha256(json.dumps(identity(request),sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()

def validate(track):
    if track['sensor'] not in SENSORS or track.get('unit')!='N':raise ValueError('Invalid sensor or unit')
    video=track['video'];count=video['frames']
    if type(count)!=int or not 0<count<=2_000_000:raise ValueError('Invalid frame count')
    if len(video['sha256'])!=64 or any(c not in '0123456789abcdef' for c in video['sha256']):raise ValueError('Invalid checksum')
    if any(type(video[k])!=int or video[k]<=0 for k in ('bytes','width','height')):raise ValueError('Invalid dimensions')
    if track['reference']!={'frame':0,'time':track['time'][0]}:raise ValueError('Invalid reference')
    if not all(len(track[k])==count for k in ('time','shear','fz','valid')) or not all(v==1 for v in track['valid']):raise ValueError('Incomplete track')
    if any(not math.isfinite(v) or v<0 for v in track['time']) or any(a>=b for a,b in zip(track['time'],track['time'][1:])):raise ValueError('Invalid timestamps')
    if any(not math.isfinite(v) or v<0 or v>1e6 for k in ('shear','fz') for v in track[k]):raise ValueError('Invalid force samples')
    key(track)

class TrackCache:
    def __init__(self,root,limit=LIMIT):
        self.root=Path(root);self.root.mkdir(parents=True,exist_ok=True);self.limit=limit;self.lock=threading.RLock();self.depth=0
        with self.guard():
            for path in self.root.glob('*.part'):path.unlink(missing_ok=True)
            self._evict()
    @contextmanager
    def guard(self):
        with self.lock:
            if self.depth:
                yield;return
            with (self.root/'.lock').open('a+b') as lock:
                if os.name=='nt':
                    import msvcrt
                    lock.seek(0);lock.write(b'0');lock.flush();lock.seek(0);msvcrt.locking(lock.fileno(),msvcrt.LK_LOCK,1)
                else:
                    import fcntl
                    fcntl.flock(lock,fcntl.LOCK_EX)
                self.depth+=1
                try:yield
                finally:
                    self.depth-=1
                    if os.name=='nt':lock.seek(0);msvcrt.locking(lock.fileno(),msvcrt.LK_UNLCK,1)
                    else:fcntl.flock(lock,fcntl.LOCK_UN)
    def _files(self):return list(self.root.glob('*.json'))
    def usage(self):
        with self.guard():
            files=self._files();return {'bytes':sum(p.stat().st_size for p in files),'limit':self.limit,'tracks':len(files)}
    def _evict(self):
        files=sorted(self._files(),key=lambda p:p.stat().st_mtime_ns);size=sum(p.stat().st_size for p in files)
        for path in files:
            if size<=self.limit:break
            size-=path.stat().st_size;path.unlink()
    def get(self,request):
        with self.guard():
            path=self.root/(key(request)+'.json')
            try:
                if path.stat().st_size>self.limit:raise ValueError('Oversized track')
                track=json.loads(path.read_text());validate(track)
                if identity(track)!=identity(request):raise ValueError('Mismatched track')
                os.utime(path,None);return track
            except (OSError,ValueError,KeyError,TypeError):
                path.unlink(missing_ok=True);return None
    def put(self,track):
        validate(track);body=json.dumps(track,separators=(',',':'),allow_nan=False).encode()
        if len(body)>self.limit:return
        with self.guard():
            path=self.root/(key(track)+'.json');temp=path.with_suffix('.part')
            try:
                with temp.open('wb') as stream:stream.write(body);stream.flush();os.fsync(stream.fileno())
                os.replace(temp,path);self._evict()
            finally:temp.unlink(missing_ok=True)
    def delete(self,requests=None):
        with self.guard():
            for path in self._files() if requests is None else [self.root/(key(r)+'.json') for r in requests]:path.unlink(missing_ok=True)
            return self.usage()
