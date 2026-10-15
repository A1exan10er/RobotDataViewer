"""Stage a complete, tested desktop release; fail closed on missing or mixed builds."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile
import zipfile

PLATFORMS = ('linux-x64', 'windows-x64', 'macos-x64', 'macos-arm64')
ENTRY_POINTS = {'linux': 'Start Viewer.sh', 'windows': 'Start Viewer.cmd', 'macos': 'Start Viewer.command'}


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def inspect_archive(path, version, platform=None):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), f'{path}: duplicate archive entries')
        require(all(not PurePosixPath(n).is_absolute() and '..' not in PurePosixPath(n).parts and '\\' not in n for n in names), f'{path}: unsafe archive path')
        require(archive.testzip() is None, f'{path}: corrupt ZIP')
        base = 'RobotDataViewer/'
        required = ['BUILD.json', 'viewer.html', 'force-runtime.js', 'START_HERE.txt',
                    'QUICKSTART_EN.md', 'QUICKSTART_ZH.md', 'LIVE_CAMERAS.md',
                    'THIRD_PARTY_NOTICES.md', 'sources/RobotDataViewer-source.tar.gz']
        if platform:
            system = platform.split('-')[0]
            extension = '.exe' if system == 'windows' else ''
            required += [ENTRY_POINTS[system], 'RobotDataViewer' + extension,
                         'model/force.onnx', 'model/model.json', 'ffmpeg/ffmpeg' + extension, 'ffmpeg/ffprobe' + extension]
            require(any(n.startswith(base + '_internal/') for n in names), f'{path}: missing runtime')
            require(any(n.startswith(base + 'licenses/') for n in names), f'{path}: missing dependency licenses')
            if system != 'windows':
                for name in (ENTRY_POINTS[system], 'RobotDataViewer', 'ffmpeg/ffmpeg', 'ffmpeg/ffprobe'):
                    require((archive.getinfo(base + name).external_attr >> 16) & 0o111, f'{path}: {name} is not executable')
        require(all(base + name in names for name in required), f'{path}: incomplete package')
        metadata = json.loads(archive.read(base + 'BUILD.json'))
        require(metadata['version'] == version, f'{path}: version mismatch')
        require(re.fullmatch(r'[a-f0-9]{40}', metadata.get('commit', '')), f'{path}: missing build commit')
        require(metadata.get('dirty') is False, f'{path}: uncommitted build cannot be released')
        if platform:
            require(metadata.get('platform') == platform, f'{path}: platform mismatch')
        viewer = archive.read(base + 'viewer.html')
        require(hashlib.sha256(viewer).hexdigest() == metadata['viewerSha256'], f'{path}: viewer checksum mismatch')
        require(f'name="application-version" content="{version}"'.encode() in viewer, f'{path}: stale viewer')
        source = archive.read(base + 'sources/RobotDataViewer-source.tar.gz')
        with tarfile.open(fileobj=io.BytesIO(source)) as sources:
            source_metadata = json.load(sources.extractfile('RobotDataViewer/BUILD.json'))
        common = {key: metadata[key] for key in ('version', 'commit', 'sourceTree', 'dirty', 'viewerSha256')}
        require(source_metadata == common, f'{path}: source provenance differs')
        return common, source


def assemble(directory, reports, output, version):
    directory, reports, output = map(Path, (directory, reports, output))
    require(directory.resolve() != output.resolve(), 'Stage into a separate output directory')
    selected = []
    common = source = None
    for platform in (*PLATFORMS, None):
        name = f'RobotDataViewer-{version}-{platform}.zip' if platform else 'RobotDataViewer.zip'
        matches = list(directory.rglob(name))
        require(len(matches) == 1, f'Expected exactly one {name}, found {len(matches)}')
        path = matches[0]
        metadata, package_source = inspect_archive(path, version, platform)
        if common is None:
            common, source = metadata, package_source
        require(metadata == common and package_source == source, f'{name}: mixed source or viewer builds')
        sha = digest(path)
        if platform:
            for kind in ('startup', 'cameras'):
                candidates = list(reports.rglob(f'native-{kind}-{platform}.json'))
                require(len(candidates) == 1, f'{name}: missing or ambiguous {kind} report')
                result = json.loads(candidates[0].read_text())
                require(result.get('passed') is True and result.get('archiveSha256') == sha,
                        f'{name}: {kind} report did not pass for this archive')
            for number in (1, 2):
                candidates = list(reports.rglob(f'native-smoke-{platform}-{number}.json'))
                require(len(candidates) == 1, f'{name}: missing force smoke report {number}')
                result = json.loads(candidates[0].read_text())
                require(result.get('archiveSha256') == sha and result.get('cachedTracks') == number - 1,
                        f'{name}: force smoke report does not match archive')
        selected.append((path, {'name': name, 'bytes': path.stat().st_size, 'sha256': sha}))
    output.mkdir(parents=True, exist_ok=True)
    for path, _ in selected:
        shutil.copy2(path, output / path.name)
    source_name = f'RobotDataViewer-{version}-repaired-source.tar.gz'
    (output / source_name).write_bytes(source)
    assets = [item for _, item in selected] + [{'name': source_name, 'bytes': len(source), 'sha256': hashlib.sha256(source).hexdigest()}]
    manifest = {**common, 'assets': assets, 'validation': 'extracted startup, synthetic browser cameras, native force cold/cache checks on all four platforms'}
    manifest_path = output / 'RELEASE-MANIFEST.json'
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    sums = ''.join(f'{a["sha256"]}  {a["name"]}\n' for a in assets)
    (output / 'SHA256SUMS.txt').write_text(sums + f'{digest(manifest_path)}  {manifest_path.name}\n')
    return manifest


def verify_staged(directory):
    directory = Path(directory)
    manifest = json.loads((directory / 'RELEASE-MANIFEST.json').read_text())
    require(manifest.get('dirty') is False, 'Uncommitted release')
    version = manifest['version']
    expected = {f'RobotDataViewer-{version}-{p}.zip' for p in PLATFORMS} | {'RobotDataViewer.zip', f'RobotDataViewer-{version}-repaired-source.tar.gz'}
    require({a['name'] for a in manifest['assets']} == expected and len(manifest['assets']) == len(expected), 'Incomplete release manifest')
    for asset in manifest['assets']:
        path = directory / asset['name']
        require(path.stat().st_size == asset['bytes'] and digest(path) == asset['sha256'], f'{path.name}: staged checksum differs')
    sums = dict(line.split('  ', 1)[::-1] for line in (directory / 'SHA256SUMS.txt').read_text().splitlines())
    require(set(sums) == expected | {'RELEASE-MANIFEST.json'}, 'Incomplete checksum list')
    for name, sha in sums.items():
        require(digest(directory / name) == sha, f'{name}: checksum list differs')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--reports', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--version', default='1.5.0-rc.3')
    args = parser.parse_args()
    if args.output:
        parser.error('--reports is required with --output') if not args.reports else None
        result = assemble(args.directory, args.reports, args.output, args.version)
    else:
        result = verify_staged(args.directory)
    print(json.dumps(result, indent=2))
