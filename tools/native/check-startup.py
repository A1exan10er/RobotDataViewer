"""Verify the user entry point from a relocated, extracted native ZIP."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shlex
import signal
import subprocess
import sys
import tempfile
import time
from urllib.parse import parse_qs, urlsplit
import urllib.request
import zipfile
import psutil

from package_launchers import ENTRY_POINTS


def stop(process):
    try:
        children = psutil.Process(process.pid).children(recursive=True)
    except psutil.NoSuchProcess:
        children = []
    if os.name == 'nt':
        process.send_signal(signal.CTRL_BREAK_EVENT)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.terminate()
    else:
        process.terminate()
    for child in children:
        try:
            child.terminate()
        except psutil.NoSuchProcess:
            pass
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    _, alive = psutil.wait_procs(children, timeout=5)
    for child in alive:
        child.kill()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--camera-output', type=Path, help='Run real browser media API checks with synthetic cameras')
    args = parser.parse_args()
    system = {'Linux': 'linux', 'Windows': 'windows', 'Darwin': 'macos'}[platform.system()]
    report = {'platform': system, 'checks': []}
    archive_sha256 = hashlib.sha256(args.archive.read_bytes()).hexdigest()
    with tempfile.TemporaryDirectory(prefix='rdv-startup-') as temporary:
        root = Path(temporary)
        with zipfile.ZipFile(args.archive) as archive:
            assert archive.testzip() is None
            archive.extractall(root)
            if os.name != 'nt':
                for member in archive.infolist():
                    mode = (member.external_attr >> 16) & 0o777
                    if mode:
                        (root / member.filename).chmod(mode)
        base = root / 'Camera viewer 传感器 & (portable)'
        (root / 'RobotDataViewer').rename(base)
        report['version'] = json.loads((base / 'BUILD.json').read_text())['version']
        entry = base / ENTRY_POINTS[system]
        assert entry.is_file()
        if system == 'linux':
            assert entry.stat().st_mode & 0o111
        executable = base / ('RobotDataViewer.exe' if system == 'windows' else 'RobotDataViewer')
        if system == 'windows':
            command = [str(entry)]
        else:
            command = [str(base / ('Start Viewer.sh' if system == 'linux' else 'Start Viewer.command'))]
        environment = os.environ.copy()
        # A recipient does not need the build venv or Node/Python on PATH.
        environment.pop('PYTHONPATH', None)
        environment.pop('VIRTUAL_ENV', None)
        environment['PATH'] = (str(Path(os.environ['SystemRoot']) / 'System32') if system == 'windows' else '/usr/bin:/bin')
        browser_capture = root / 'opened-url.txt'
        if system == 'windows':
            # This stand-in for the installed browser uses an explicit test-only
            # interpreter. cmd batch arguments split the URL's native= token.
            browser = root / 'capture-browser.py'
            browser.write_text('import pathlib, sys\npathlib.Path(' + repr(str(browser_capture)) + ').write_text(sys.argv[1])\n')
            environment['BROWSER'] = f'"{sys.executable}" "{browser}" %s'
        else:
            browser = root / 'capture-browser'
            browser.write_text('#!/bin/sh\nprintf "%s\\n" "$1" > ' + shlex.quote(str(browser_capture)) + '\n')
            browser.chmod(0o755)
            environment['BROWSER'] = str(browser) + ' %s'
        command += ['--storage', str(root / 'cache')]
        log = root / 'launch.log'
        with log.open('wb') as output:
            process = subprocess.Popen(command, shell=system == 'windows', cwd=root, env=environment, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if system == 'windows' else 0)
            try:
                deadline = time.monotonic() + 30
                url = None
                while time.monotonic() < deadline:
                    lines = log.read_text(encoding='utf-8', errors='replace').splitlines()
                    url = next((line for line in lines if line.startswith('http://127.0.0.1:')), None)
                    if url:
                        break
                    assert process.poll() is None, 'Launcher exited: ' + '\n'.join(lines)
                    time.sleep(.1)
                assert url, 'Launcher did not become ready'
                parts = urlsplit(url)
                origin = parts.scheme + '://' + parts.netloc
                assert parts.hostname == '127.0.0.1'
                page = urllib.request.urlopen(origin, timeout=10).read()
                assert page == (base / 'viewer.html').read_bytes()
                assert f'name="application-version" content="{report["version"]}"'.encode() in page
                request = urllib.request.Request(origin + '/api/v1/capabilities', headers={'Authorization': 'Bearer ' + parse_qs(parts.fragment)['native'][0]})
                assert json.load(urllib.request.urlopen(request, timeout=10))['native']
                report['checks'].append('Relocated package with spaces, Unicode and shell metacharacters starts from another working directory without a development environment')
                report['checks'].append('Serves the packaged version and authenticated native API on loopback')
                while not browser_capture.exists() and time.monotonic() < deadline:
                    time.sleep(.1)
                assert browser_capture.read_text().strip() == url, 'Browser did not receive the complete launch URL'
                report['checks'].append('Default browser receives the complete local launch URL automatically')
                if args.camera_output:
                    subprocess.run(['node', str(Path(__file__).resolve().parents[1] / 'browser-camera-release.mjs'),
                        '--url', url, '--file', str(base / 'viewer.html'), '--output', str(args.camera_output.resolve()),
                        '--archive-sha256', archive_sha256], check=True)
                # Exercise repeat desktop launch while the original keeps its port.
                repeated = subprocess.run(command, shell=system == 'windows', cwd=root, env=environment,
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=20)
                assert repeated.returncode == 0, repeated.stdout.decode(errors='replace')
                assert process.poll() is None
                report['checks'].append('Repeated desktop launch reuses the original service')
                shutdown = urllib.request.Request(origin + '/api/v1/service/shutdown', data=b'{}',
                    headers={'Authorization': 'Bearer ' + parse_qs(parts.fragment)['native'][0], 'Origin': origin})
                assert json.load(urllib.request.urlopen(shutdown, timeout=10))['state'] == 'stopping'
                process.wait(timeout=15)
                assert process.returncode == 0
                report['checks'].append('Browser shutdown exits the desktop launcher cleanly')
            finally:
                stop(process)
        assert not list((root / 'cache').glob('temporary/launch-*')), 'Launch resources were not released'
        report['checks'].append('Launcher shutdown releases its temporary resources')
        # A copied start file must fail clearly rather than opening stale web content.
        executable.rename(executable.with_suffix('.missing'))
        result = subprocess.run(command+['--headless'], shell=system == 'windows', cwd=root, env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=10)
        assert result.returncode != 0 and b'package is incomplete' in result.stdout
        report['checks'].append('Incomplete extraction reports an actionable error')
    report['archiveSha256'] = archive_sha256
    report['passed'] = True
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
