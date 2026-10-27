"""Per-user installation ownership. A stale record never authorizes killing a PID."""
import hashlib
import json
import os
from pathlib import Path
import time
import urllib.request


class Instance:
    def __init__(self, directory, identity):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if os.name != 'nt':
            directory.chmod(0o700)
        self.identity = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        self.record = directory / (self.identity + '.json')
        self.path = directory / (self.identity + '.lock')
        self.file = None

    def acquire(self):
        if self.file:
            return True
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        stream = os.fdopen(fd, 'r+b')
        try:
            if os.name == 'nt':
                import msvcrt
                if not self.path.stat().st_size:
                    stream.write(b'0'); stream.flush()
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            stream.close()
            return False
        self.file = stream
        # Only the lock owner can replace or remove the runtime record.
        self.record.unlink(missing_ok=True)
        return True

    def publish(self, port, token):
        import psutil
        if not self.file:
            raise RuntimeError('Instance lock is not held')
        value = {'identity': self.identity, 'pid': os.getpid(),
                 'created': psutil.Process().create_time(), 'port': port, 'token': token}
        temporary = self.record.with_suffix('.part')
        fd = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream)
        os.replace(temporary, self.record)

    def activate(self):
        import psutil
        try:
            value = json.loads(self.record.read_text())
            if value['identity'] != self.identity or type(value['port']) is not int or not 0 < value['port'] < 65536:
                return False
            process = psutil.Process(value['pid'])
            if process.create_time() != value['created']:
                return False
            origin = f"http://127.0.0.1:{value['port']}"
            request = urllib.request.Request(origin + '/api/v1/service/activate', data=b'{}',
                headers={'Authorization': 'Bearer ' + value['token'], 'Origin': origin, 'Content-Type': 'application/json'})
            # Never send the launch secret through an environment-configured proxy.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(request, timeout=2) as response:
                return json.load(response).get('activated') is True
        except (OSError, ValueError, KeyError, TypeError, psutil.Error):
            return False

    def claim_or_activate(self, timeout=10):
        deadline = time.monotonic() + timeout
        while True:
            if self.acquire():
                return True
            if self.activate():
                return False
            if time.monotonic() >= deadline:
                raise RuntimeError('The existing viewer is starting or stopping. Try again shortly. / 查看器正在启动或退出，请稍后重试。')
            time.sleep(.1)

    def close(self):
        if not self.file:
            return
        self.record.unlink(missing_ok=True)
        if os.name == 'nt':
            import msvcrt
            self.file.seek(0)
            msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
        self.file.close()
        self.file = None
        # Keep the lock inode: unlinking it would allow two concurrent owners.
