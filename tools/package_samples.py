#!/usr/bin/env python3
"""Prepare portable, read-only robot sample packages. Python 3.10+; FFmpeg/ffprobe.

No imports or runtime dependencies on QualityCheck or the collector.
6D rotation and UMI reference transforms are ported from QualityCheck's
server/services/trajectory_viewer.py; stricter validation preserves invalid-data visibility.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import shutil
import statistics
import subprocess
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CAMERAS = {
    'third': 'third_view', 'second_third': 'second_third_view',
    'l_wrist': 'left_wrist_view', 'r_wrist': 'right_wrist_view',
    'l_tact_l': 'left_wrist_left_tactile', 'l_tact_r': 'left_wrist_right_tactile',
    'r_tact_l': 'right_wrist_left_tactile', 'r_tact_r': 'right_wrist_right_tactile',
}


def run(command: list[str]) -> str:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise ValueError(f'{command[0]} failed: {result.stderr[-1800:]}')
    return result.stdout


def probe(path: Path) -> dict:
    value = json.loads(run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
        '-show_frames', '-show_streams', '-show_entries',
        'stream=width,height,avg_frame_rate,duration,codec_name:frame=best_effort_timestamp_time,duration_time',
        '-of', 'json', str(path)]))
    streams = value.get('streams', [])
    frames = value.get('frames', [])
    if not streams or not frames:
        raise ValueError(f'No video frames: {path.name}')
    stream = streams[0]
    numerator, denominator = map(float, stream.get('avg_frame_rate', '30/1').split('/'))
    fps = numerator / denominator if denominator and numerator > 0 else 30.
    pts = [float(frame['best_effort_timestamp_time']) for frame in frames]
    first = pts[0]
    pts = [round(t - first, 6) for t in pts]
    if any(not math.isfinite(t) for t in pts) or any(b <= a for a, b in zip(pts, pts[1:])):
        raise ValueError(f'Invalid presentation timestamps: {path.name}')
    tail = float(frames[-1].get('duration_time', 1 / fps))
    return {'pts': pts, 'fps': fps, 'duration': pts[-1] + max(tail, 1 / fps),
            'width': int(stream['width']), 'height': int(stream['height'])}


def find_file(episode: Path, modality: str, filename='data.csv') -> Path | None:
    for parent in (modality, modality.replace('.', '/')):
        p = episode / parent / filename
        if p.is_file():
            return p
    return None


def number(value) -> float:
    n = float(value)
    if not math.isfinite(n):
        raise ValueError('Non-finite number')
    return n


def read_csv(path: Path | None) -> tuple[list[str], list[dict]]:
    if path is None:
        return [], []
    with path.open(encoding='utf-8-sig', newline='') as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        return reader.fieldnames or [], rows


def axes6(values: list[float]) -> list[list[float]]:
    def norm(v):
        length = math.sqrt(sum(x*x for x in v))
        if length < 1e-8:
            raise ValueError('Degenerate rotation')
        return [x / length for x in v]
    a = norm(values[:3])
    dot = sum(x*y for x, y in zip(a, values[3:]))
    b = norm([values[i+3] - dot*a[i] for i in range(3)])
    c = [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
    return [a, b, c]


def pose_matrix(pose: dict) -> list[list[float]]:
    w, x, y, z = [number(pose[f'tcp.q{k}']) for k in 'wxyz']
    length = math.sqrt(w*w + x*x + y*y + z*z)
    if length < 1e-8:
        raise ValueError('Invalid quaternion')
    w, x, y, z = [n / length for n in (w, x, y, z)]
    return [
        [1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w), number(pose['tcp.x'])],
        [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w), number(pose['tcp.y'])],
        [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y), number(pose['tcp.z'])],
        [0., 0., 0., 1.],
    ]


def visual_transforms(metadata: dict) -> dict:
    reference = metadata.get('coordinate_reference', {})
    if not isinstance(reference, dict) or reference.get('type') != 'umi_episode_start_relative_pose':
        return {}
    sides = reference.get('sides', {})
    if not isinstance(sides, dict):
        return {}
    matrices = {}
    try:
        for side in ('left', 'right'):
            ref = sides.get(side, {})
            matrices[side] = pose_matrix(ref.get('reference_pose') or ref['pose'])
    except (KeyError, TypeError, ValueError, OverflowError):
        return {}
    anchor = matrices['left']
    inv = [[anchor[j][i] for j in range(3)] + [-sum(anchor[j][i]*anchor[j][3] for j in range(3))] for i in range(3)] + [[0., 0., 0., 1.]]
    return {side: [[sum(inv[i][k]*matrix[k][j] for k in range(4)) for j in range(4)] for i in range(4)] for side, matrix in matrices.items()}


def trajectories(path: Path | None, metadata: dict, issues: list) -> list[dict]:
    columns, rows = read_csv(path)
    result = []
    transforms = visual_transforms(metadata)
    for side, prefix in [('left', 'left_'), ('right', 'right_'), ('single', '')]:
        if not all(prefix+k in columns for k in ('x', 'y', 'z')):
            continue
        points = []
        invalid = 0
        invalid_rotations = 0
        for row in rows:
            try:
                t = number(row['timestamp_ms'])
                p = [number(row[prefix+k]) for k in 'xyz']
                if t < 0:
                    raise ValueError('Negative timestamp')
            except (ValueError, TypeError, KeyError, OverflowError):
                invalid += 1
                continue
            try:
                axes = axes6([number(row[prefix+f'r{i}']) for i in range(1, 7)])
            except (ValueError, TypeError, KeyError, OverflowError):
                axes = None
                invalid_rotations += 1
            try:
                g = number(row[prefix+'gripper'])
            except (ValueError, TypeError, KeyError, OverflowError):
                g = None
            matrix = transforms.get(side)
            if matrix:
                p = [sum(matrix[i][j]*p[j] for j in range(3)) + matrix[i][3] for i in range(3)]
                if axes:
                    axes = [[sum(matrix[i][j]*a[j] for j in range(3)) for i in range(3)] for a in axes]
            points.append({'t': t, 'p': p, 'axes': axes, 'g': g})
        if points:
            if any(b['t'] < a['t'] for a, b in zip(points, points[1:])):
                issues.append({'code': 'reordered_samples', 'channel': side})
            points.sort(key=lambda p: p['t'])
            result.append({'side': side, 'frame': 'shared' if transforms else 'recorded', 'points': points})
        if invalid:
            issues.append({'code': 'invalid_samples', 'channel': side, 'count': invalid})
        if invalid_rotations:
            issues.append({'code': 'invalid_rotations', 'channel': side, 'count': invalid_rotations})
    if not result:
        issues.append({'code': 'missing_trajectory'})
    return result


def signals(episode: Path, issues: list) -> list[dict]:
    result = []
    modalities = ['eef_pose', 'gripper', 'joint_position', 'joint_velocity'] + [v for v in CAMERAS.values() if 'tactile' in v]
    for name in modalities:
        path = find_file(episode, 'observation.state.' + name)
        columns, rows = read_csv(path)
        if path and not rows:
            issues.append({'code': 'empty_signal', 'channel': name})
        invalid_rows = set()
        for column in columns:
            if column == 'timestamp_ms' or (name == 'eef_pose' and not column.endswith(('_x', '_y', '_z')) and column not in ('x','y','z')):
                continue
            samples = []
            for index, row in enumerate(rows):
                try:
                    timestamp, value = number(row['timestamp_ms']), number(row[column])
                    if timestamp < 0:
                        raise ValueError('Negative timestamp')
                    samples.append((timestamp, value))
                except (ValueError, TypeError, KeyError, OverflowError):
                    invalid_rows.add(index)
            samples.sort(key=lambda p: p[0])
            if samples:
                unit = None if 'tactile' in name else 'm' if name in ('eef_pose', 'gripper') or 'gripper' in column else 'rad/s' if name == 'joint_velocity' else 'rad'
                result.append({'id': f'{name}.{column}', 'name': column, 'unit': unit,
                    't': [p[0] for p in samples], 'values': [p[1] for p in samples]})
        if invalid_rows:
            issues.append({'code': 'invalid_samples', 'channel': name, 'count': len(invalid_rows)})
    return result


def make_timing(pts: list[float], rows: list[dict]) -> dict:
    captured = []
    valid = True
    for row in rows:
        try:
            n = number(row['timestamp_ms'])
            if n < 0:
                raise ValueError('Negative timestamp')
            captured.append(n)
        except (KeyError, ValueError, TypeError, OverflowError):
            valid = False
    precise = valid and len(captured) == len(pts) and all(b >= a for a, b in zip(captured, captured[1:])) and (len(captured) == 1 or captured[-1] > captured[0])
    offset = captured[0] if captured else 0
    return {'media': pts, 'episode': captured if precise else [round(offset + t*1000, 6) for t in pts], 'estimated': not precise}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as f:
        while chunk := f.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def prepare_episode(source: Path, target: Path, index: int) -> dict:
    source = source.resolve()
    source_name = source.name
    if not source.is_dir() or not (source / 'metadata.json').is_file():
        raise ValueError(f'Episode must be a folder containing metadata.json: {source}')
    if any(p.is_symlink() for p in source.rglob('*')):
        raise ValueError(f'Episode contains symbolic links; provide a self-contained copy: {source.name}')
    metadata = json.loads((source / 'metadata.json').read_text(encoding='utf-8-sig'))
    if not isinstance(metadata, dict):
        raise ValueError('metadata.json must contain an object')
    eid = f'sample-{index:03d}'
    original = target / 'originals' / eid
    shutil.copytree(source, original)
    hashes = {}
    for src in sorted(source.rglob('*')):
        if not src.is_file():
            continue
        rel = src.relative_to(source)
        digest = sha256(src)
        if sha256(original / rel) != digest:
            raise ValueError(f'Source changed during copying: {rel}')
        hashes[(Path('originals') / eid / rel).as_posix()] = digest
    # Derive every preview and signal from the verified snapshot, not a live recording folder.
    source = original
    metadata = json.loads((source / 'metadata.json').read_text(encoding='utf-8-sig'))
    data_dir = target / 'samples' / eid
    data_dir.mkdir(parents=True)
    issues = []
    motion = trajectories(find_file(source, 'observation.state.eef_pose'), metadata, issues)
    recorded_signals = signals(source, issues)
    timings = {}
    media = []
    end_times = [p['t'] for trajectory in motion for p in trajectory['points'][-1:]]
    end_times += [s['t'][-1] for s in recorded_signals if s['t']]
    for cid, name in CAMERAS.items():
        video = find_file(source, 'observation.image.' + name, 'video.mp4')
        if video is None:
            continue
        print(f'  {eid}: preparing {name}', flush=True)
        info = probe(video)
        output = data_dir / f'{cid}.mp4'
        # Passthrough frame scheduling: no FPS filter, frame drops, resizing, or temporal resampling.
        # Even dimensions are required by browser-compatible 4:2:0; reject rather than crop/pad.
        if info['width'] % 2 or info['height'] % 2:
            raise ValueError(f'Unsupported odd video dimensions: {video}')
        run(['ffmpeg', '-nostdin', '-v', 'error', '-copyts', '-start_at_zero', '-i', str(video), '-map', '0:v:0', '-an',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '15', '-pix_fmt', 'yuv420p',
            '-fps_mode', 'passthrough', '-enc_time_base', 'demux', '-movflags', '+faststart',
            '-threads', '2', str(output)])
        preview = probe(output)
        if len(info['pts']) != len(preview['pts']) or any(abs(a-b) > .002 for a, b in zip(info['pts'], preview['pts'])):
            raise ValueError(f'Preview frame/timing verification failed: {name}')
        _, rows = read_csv(find_file(source, 'observation.image.'+name, 'timestamps.csv'))
        timing = make_timing(preview['pts'], rows)
        timings[cid] = timing
        if timing['estimated']:
            issues.append({'code': 'estimated_alignment', 'channel': cid})
        end_times.append(timing['episode'][-1] + (preview['duration'] - preview['pts'][-1])*1000)
        media.append({'id': cid, 'kind': 'tactile' if 'tactile' in name else 'rgb',
            'path': output.relative_to(target).as_posix(),
            'original': (original / video.relative_to(source)).relative_to(target).as_posix(),
            **{k: preview[k] for k in ('width','height','fps','duration')}, 'frames': len(preview['pts'])})
    if not media and not motion and not recorded_signals:
        raise ValueError(f'No viewable recordings found: {source.name}')
    data = {'timings': timings, 'trajectories': motion, 'signals': recorded_signals}
    (data_dir / 'data.json').write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':'), allow_nan=False), encoding='utf-8')
    (data_dir / 'original-checksums.json').write_text(json.dumps(hashes, indent=2), encoding='utf-8')
    title = metadata.get('task_title') or metadata.get('language_instruction') or metadata.get('task_key') or source.name
    if not isinstance(title, str):
        title = source.name
    return {'id': eid, 'title': title.replace('_', ' '), 'robot': str(metadata.get('robot') or 'robot'),
        'durationMs': max(end_times + [1.]), 'data': f'samples/{eid}/data.json',
        'media': media, 'issues': issues, 'sourceName': source_name}


def build_package(episodes: list[Path], output: Path, viewer: Path | None = None):
    viewer = viewer or ROOT / 'dist' / 'viewer.html'
    output = output.expanduser().resolve()
    if output.exists():
        raise ValueError(f'Output already exists: {output}')
    if output.suffix.lower() != '.zip':
        raise ValueError('Output must end in .zip')
    if not episodes or not viewer.is_file():
        raise ValueError('Run npm run build first and select at least one episode')
    if len({p.resolve() for p in episodes}) != len(episodes):
        raise ValueError('Duplicate episode selections')
    for executable in ('ffmpeg', 'ffprobe'):
        if not shutil.which(executable):
            raise ValueError(f'{executable} is required on the preparation computer')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.robot-viewer-', dir=output.parent) as tmp:
        tmp_path = Path(tmp)
        package = tmp_path / 'RobotDataViewer'
        package.mkdir()
        shutil.copyfile(viewer, package / 'viewer.html')
        shutil.copyfile(ROOT / 'THIRD_PARTY_NOTICES.md', package / 'THIRD_PARTY_NOTICES.md')
        for doc in ('QUICKSTART_EN.md', 'QUICKSTART_ZH.md'):
            shutil.copyfile(ROOT / 'docs' / doc, package / doc)
        entries = [prepare_episode(p, package, i+1) for i, p in enumerate(episodes)]
        manifest = {'format': 'robot-data-viewer', 'version': 1, 'episodes': entries}
        (package / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False, allow_nan=False), encoding='utf-8')
        archive_path = tmp_path / 'package.zip'
        with zipfile.ZipFile(archive_path, 'w', allowZip64=True) as archive:
            for file in sorted(package.rglob('*')):
                if file.is_file():
                    compression = zipfile.ZIP_STORED if file.suffix.lower() in ('.mp4','.jpg','.png') else zipfile.ZIP_DEFLATED
                    archive.write(file, file.relative_to(tmp_path), compress_type=compression)
        # Exclusive creation also protects against a concurrent creator of the output.
        try:
            with output.open('xb') as dest, archive_path.open('rb') as src:
                shutil.copyfileobj(src, dest)
        except FileExistsError:
            raise ValueError(f'Output already exists: {output}') from None
        except BaseException:
            output.unlink(missing_ok=True)
            raise
    print(f'Created {output} ({output.stat().st_size / 1024**2:.1f} MiB)', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--episode', type=Path, action='append', required=True, help='Episode folder; repeat for several recordings')
    parser.add_argument('--output', type=Path, required=True, help='New customer ZIP file')
    args = parser.parse_args()
    try:
        build_package(args.episode, args.output)
    except (ValueError, OSError, csv.Error, json.JSONDecodeError) as exc:
        parser.exit(1, f'Package creation failed: {exc}\n')


if __name__ == '__main__':
    main()
