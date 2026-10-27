"""Validate the extracted package's browser lifecycle and source desktop controls."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('archive', type=Path)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='rdv-lifecycle-') as temporary:
    root = Path(temporary)
    with zipfile.ZipFile(args.archive) as archive:
        archive.extractall(root)
        if os.name != 'nt':
            for item in archive.infolist():
                if item.external_attr >> 16 & 0o111: (root / item.filename).chmod(0o755)
    base = root / 'RobotDataViewer'
    # Synthetic recording only; no customer fixtures or external codecs needed.
    fixture = root / 'synthetic.tar'
    with tarfile.open(fixture, 'w') as archive:
        body = json.dumps({'robot': 'arx5', 'task_title': 'Shutdown test'}).encode()
        info = tarfile.TarInfo('episode/metadata.json'); info.size = len(body)
        archive.addfile(info, io.BytesIO(body))
        archive.add(ROOT / 'tests/fixtures/timing-30fps.mp4', arcname='episode/observation.image.left_wrist_left_tactile/video.mp4')
    executable = base / ('RobotDataViewer.exe' if os.name == 'nt' else 'RobotDataViewer')
    environment = {**os.environ, 'RDV_TEST_DESKTOP': '1'}
    subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_desktop.py', '-v'], cwd=ROOT, env=environment, check=True)
    log = root / 'service.log'
    with log.open('wb') as stream:
        process = subprocess.Popen([str(executable), '--no-browser', '--storage', str(root / 'storage')], stdout=stream, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 30; url = None
            while time.monotonic() < deadline:
                url = next((s for s in log.read_text(errors='replace').splitlines() if s.startswith('http://127.0.0.1:')), None)
                if url: break
                assert process.poll() is None, log.read_text(errors='replace')
                time.sleep(.1)
            assert url, 'Service did not start'
            subprocess.run(['node', str(ROOT/'tools/browser-service.mjs'), '--url', url, '--file', str(base/'viewer.html'),
                '--fixture', str(fixture), '--output', str(args.output.resolve()), '--archive-sha256', hashlib.sha256(args.archive.read_bytes()).hexdigest()], check=True)
            process.wait(timeout=10)
            assert process.returncode == 0
            assert not list((root/'storage/temporary').glob('launch-*'))
        finally:
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
