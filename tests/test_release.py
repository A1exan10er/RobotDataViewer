import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
import zipfile
from hashlib import sha256

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from verify_release import PLATFORMS, ENTRY_POINTS, assemble, inspect_archive, verify_staged
from publish_release import publish


class ReleaseTests(unittest.TestCase):
    version = '1.5.0-rc.3'

    def package(self, directory, platform=None, dirty=False, executable=True, commit='a' * 40):
        viewer = f'<meta name="application-version" content="{self.version}">'.encode()
        meta = {'version': self.version, 'commit': commit, 'sourceTree': 'b' * 40, 'dirty': dirty, 'viewerSha256': sha256(viewer).hexdigest()}
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as archive:
            data = json.dumps(meta).encode(); info = tarfile.TarInfo('RobotDataViewer/BUILD.json'); info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
        files = {n: b'test' for n in ['force-runtime.js', 'START_HERE.txt', 'QUICKSTART_EN.md', 'QUICKSTART_ZH.md', 'LIVE_CAMERAS.md', 'THIRD_PARTY_NOTICES.md']}
        files.update({'viewer.html': viewer, 'sources/RobotDataViewer-source.tar.gz': buffer.getvalue()})
        if platform:
            meta['platform'] = platform
            system = platform.split('-')[0]; ext = '.exe' if system == 'windows' else ''
            files.update({n: b'test' for n in [ENTRY_POINTS[system], 'RobotDataViewer' + ext, '_internal/runtime', 'licenses/license', 'model/force.onnx', 'model/model.json', 'ffmpeg/ffmpeg' + ext, 'ffmpeg/ffprobe' + ext]})
        files['BUILD.json'] = json.dumps(meta).encode()
        path = directory / (f'RobotDataViewer-{self.version}-{platform}.zip' if platform else 'RobotDataViewer.zip')
        with zipfile.ZipFile(path, 'w') as archive:
            for name, data in files.items():
                info = zipfile.ZipInfo('RobotDataViewer/' + name); info.external_attr = (0o100755 if executable else 0o100644) << 16
                archive.writestr(info, data)
        return path

    def reports(self, directory, platform, path):
        sha = sha256(path.read_bytes()).hexdigest()
        for kind in ('startup', 'cameras'):
            (directory / f'native-{kind}-{platform}.json').write_text(json.dumps({'passed': True, 'archiveSha256': sha}))
        for n in (1, 2):
            (directory / f'native-smoke-{platform}-{n}.json').write_text(json.dumps({'cachedTracks': n - 1, 'archiveSha256': sha}))

    def test_complete_release_and_tampered_download(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); inputs = root / 'inputs'; inputs.mkdir(); output = root / 'staged'
            for p in PLATFORMS:
                path = self.package(inputs, p); self.reports(inputs, p, path)
            self.package(inputs)
            assemble(inputs, inputs, output, self.version)
            self.assertEqual(len(verify_staged(output)['assets']), 6)
            (output / 'RobotDataViewer.zip').write_bytes(b'partial transfer')
            with self.assertRaisesRegex(ValueError, 'checksum differs'): verify_staged(output)

    def test_missing_platform_stale_report_and_mixed_build_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); output = root / 'stage'
            with self.assertRaisesRegex(ValueError, 'Expected exactly one'): assemble(root, root, output, self.version)
            path = self.package(root, 'linux-x64')
            with self.assertRaisesRegex(ValueError, 'startup report'): assemble(root, root, output, self.version)
            self.reports(root, 'linux-x64', path)
            (root / 'native-cameras-linux-x64.json').write_text(json.dumps({'passed': True, 'archiveSha256': 'old'}))
            with self.assertRaisesRegex(ValueError, 'cameras report'): assemble(root, root, output, self.version)
            self.reports(root, 'linux-x64', path)
            self.package(root, 'windows-x64', commit='c' * 40)
            with self.assertRaisesRegex(ValueError, 'mixed source'): assemble(root, root, output, self.version)

    def test_dirty_or_nonexecutable_package_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, 'uncommitted'): inspect_archive(self.package(root, dirty=True), self.version)
            with self.assertRaisesRegex(ValueError, 'not executable'): inspect_archive(self.package(root, 'linux-x64', executable=False), self.version, 'linux-x64')

    def test_publication_verifies_downloads_and_restores_replaced_asset_on_failure(self):
        class Host:
            def __init__(self, corrupt=False):
                self.files = {'RobotDataViewer.zip': b'previous version'}
                self.body = 'original notes'
                self.corrupt = corrupt
            def release(self):
                return {'id': 1, 'tag_name': 'v1.5.0-rc.3', 'prerelease': True, 'draft': False,
                        'html_url': 'https://example.test/release', 'body': self.body,
                        'assets': [{'name': n, 'size': len(v), 'digest': 'sha256:' + sha256(v).hexdigest()} for n, v in self.files.items()]}
            def download(self, asset, path):
                data = self.files[asset['name']]
                if self.corrupt and path.parent.name == 'verified-downloads' and asset['name'] == 'RobotDataViewer.zip': data = b'incomplete'
                path.write_bytes(data)
            def upload(self, release, path): self.files[path.name] = path.read_bytes()
            def notes(self, release, path): self.body = path.read_text()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); inputs = root / 'inputs'; inputs.mkdir(); output = root / 'staged'
            for platform in PLATFORMS:
                path = self.package(inputs, platform); self.reports(inputs, platform, path)
            self.package(inputs); assemble(inputs, inputs, output, self.version)
            notes = root / 'notes.md'; notes.write_text('Repaired packages\n')
            host = Host()
            self.assertTrue(publish(host, output, root / 'backup-ok', notes)['published'])
            self.assertEqual(host.body, notes.read_text())
            host = Host(corrupt=True)
            with self.assertRaisesRegex(ValueError, 'published checksum differs'):
                publish(host, output, root / 'backup-failed', notes)
            self.assertEqual(host.files['RobotDataViewer.zip'], b'previous version')
            self.assertEqual(host.body, 'original notes')


if __name__ == '__main__':
    unittest.main()
