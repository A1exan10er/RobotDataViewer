import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools/native'))
from launcher import Application, Service
from instance import Instance
from test_native_force import fixture


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = Application(ROOT / 'dist', ROOT / 'vendor/force', self.temp.name)
        self.service = Service(self.app)

    def tearDown(self):
        self.service.close()
        self.temp.cleanup()

    def call(self, path='', method='GET', body=None, headers=None):
        request = urllib.request.Request(self.service.origin + '/api/v1/service' + path, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization': 'Bearer ' + self.app.token, 'Origin': self.service.origin, **(headers or {})})
        with urllib.request.urlopen(request, timeout=3) as response:
            return json.load(response)

    def test_public_status_has_no_secrets_and_controls_require_authentication(self):
        value = self.call(headers={'Authorization': ''})
        self.assertEqual(set(value), {'application', 'protocol', 'state'})
        for path in ('/activate', '/session', '/shutdown'):
            for headers in ({'Authorization': ''}, {'Origin': 'https://example.com'}, {'Host': 'evil.test'}):
                with self.assertRaises(urllib.error.HTTPError) as raised:
                    self.call(path, 'POST', {}, headers)
                self.assertEqual(raised.exception.code, 403)
        self.assertFalse(self.app.stop_event.is_set())

    def test_idle_shutdown_closes_port_and_preserves_results(self):
        track = fixture(); self.app.cache.put(track)
        self.assertEqual(self.call('/shutdown', 'POST', {}), {'state': 'stopping'})
        self.assertTrue(self.app.request_stop())  # Idempotent during concurrent cleanup.
        self.assertTrue(self.service.done.wait(5))
        with self.assertRaises(OSError):
            socket.create_connection(('127.0.0.1', self.service.server.server_port), timeout=1)
        self.assertFalse(self.app.temp.exists())
        self.assertEqual(self.app.cache.get(track), track)
        self.assertNotIn('onnxruntime', sys.modules)

    def test_browser_calculation_requires_confirmation_and_can_cancel_exit(self):
        name = 'browser-session-12345'
        self.call('/session', 'POST', {'id': name, 'preparing': True})
        with self.assertRaises(urllib.error.HTTPError) as raised:
            self.call('/shutdown', 'POST', {})
        self.assertEqual(raised.exception.code, 409)
        self.assertFalse(self.app.stop_event.is_set())
        self.call('/session', 'DELETE', {'id': name})
        self.assertFalse(self.app.service_state()['preparing'])
        self.call('/session', 'POST', {'id': name, 'preparing': True})
        self.call('/shutdown', 'POST', {'cancelActive': True})
        self.assertTrue(self.service.done.wait(5))

    def test_native_job_and_new_activity_cannot_race_shutdown(self):
        job = self.app.create([fixture()])
        (job['directory'] / '0.mp4').write_bytes(b'partial')
        self.assertFalse(self.app.request_stop())
        self.assertTrue(self.app.request_stop(confirm=True))
        with self.assertRaisesRegex(ValueError, 'stopping'): self.app.create([fixture()])
        with self.assertRaisesRegex(ValueError, 'stopping'): self.app.start(job)
        with self.assertRaisesRegex(ValueError, 'stopping'): self.app.session('browser-session-12345', True)
        self.assertTrue(self.service.done.wait(5))
        self.assertEqual(job['state'], 'cancelled')
        self.assertFalse(job['directory'].exists())

    def test_shutdown_unblocks_stalled_upload(self):
        job = self.app.create([fixture()])
        client = socket.create_connection(('127.0.0.1', self.service.server.server_port))
        try:
            client.sendall((f"PUT /api/v1/jobs/{job['id']}/video/0 HTTP/1.1\r\n"
                f"Host: {self.service.origin[7:]}\r\nOrigin: {self.service.origin}\r\n"
                f"Authorization: Bearer {self.app.token}\r\nContent-Length: 3\r\nX-Upload-Offset: 0\r\n\r\na").encode())
            time.sleep(.1)
            self.app.request_stop(confirm=True)
            self.assertTrue(self.service.done.wait(5))
            self.assertFalse(self.app.temp.exists())
        finally:
            client.close()

    def test_shutdown_terminates_and_reaps_owned_worker(self):
        job = self.app.create([fixture()])
        process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        job['process'] = process
        try:
            self.app.request_stop(confirm=True)
            self.assertTrue(self.service.done.wait(8))
            self.assertIsNotNone(process.poll())
            self.assertFalse(job['directory'].exists())
        finally:
            if process.poll() is None: process.kill(); process.wait()

    def test_activation_is_queued_for_gui_thread(self):
        self.assertEqual(self.call('/activate', 'POST', {}), {'activated': True})
        self.assertTrue(self.app.activate_event.is_set())


class InstanceTests(unittest.TestCase):
    def test_simultaneous_processes_have_exactly_one_owner(self):
        with tempfile.TemporaryDirectory() as folder:
            code = "import sys; sys.path.insert(0,sys.argv[1]); from instance import Instance; i=Instance(sys.argv[2],{'root':'concurrent'}); print(i.acquire(),flush=True); sys.stdin.readline(); i.close()"
            processes = [subprocess.Popen([sys.executable,'-c',code,str(ROOT/'tools/native'),folder],
                stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for _ in range(4)]
            try:
                results = [process.stdout.readline().strip() for process in processes]
                self.assertEqual(results.count('True'),1,results)
                self.assertEqual(results.count('False'),3,results)
            finally:
                for process in processes:
                    _,error=process.communicate('\n',timeout=5)
                    self.assertEqual(process.returncode,0,error)

    def test_one_owner_stale_record_recovery_and_separate_installations(self):
        with tempfile.TemporaryDirectory() as folder:
            first, second = Instance(folder, {'root': 'one'}), Instance(folder, {'root': 'one'})
            separate = Instance(folder, {'root': 'two'})
            try:
                self.assertTrue(first.acquire()); self.assertFalse(second.acquire())
                self.assertTrue(separate.acquire())
                first.publish(1234, 'secret')
                if os.name != 'nt': self.assertEqual(first.record.stat().st_mode & 0o777, 0o600)
                # An abandoned record can only be removed after acquiring the OS lock.
                first.file.close(); first.file = None
                self.assertTrue(second.acquire()); self.assertFalse(second.record.exists())
            finally:
                first.close(); second.close(); separate.close()

    def test_repeated_launch_authenticates_to_existing_service(self):
        with tempfile.TemporaryDirectory() as folder:
            app = Application(ROOT / 'dist', ROOT / 'vendor/force', Path(folder) / 'data')
            service = Service(app)
            first, second = Instance(Path(folder) / 'runtime', {'root': 'one'}), Instance(Path(folder) / 'runtime', {'root': 'one'})
            try:
                self.assertTrue(first.acquire()); first.publish(service.server.server_port, app.token)
                self.assertFalse(second.claim_or_activate(timeout=1))
                self.assertTrue(app.activate_event.is_set())
                value = json.loads(first.record.read_text()); value['created'] -= 1
                first.record.write_text(json.dumps(value))
                with patch('instance.urllib.request.build_opener') as opener:
                    self.assertFalse(second.activate()); opener.assert_not_called()
            finally:
                first.close(); second.close(); service.close()


if __name__ == '__main__':
    unittest.main()
