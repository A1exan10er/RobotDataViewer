"""Common provenance for HTML and native packages, including same-version repairs."""
from hashlib import sha256
import json
from pathlib import Path
import subprocess


def git(root, *args):
    return subprocess.check_output(['git', *args], cwd=root, text=True).strip()


def build_metadata(root):
    root = Path(root)
    return {
        'version': json.loads((root / 'package.json').read_text())['version'],
        'commit': git(root, 'rev-parse', 'HEAD'),
        'sourceTree': git(root, 'rev-parse', 'HEAD^{tree}'),
        'dirty': bool(git(root, 'status', '--porcelain', '--untracked-files=normal')),
        'viewerSha256': sha256((root / 'dist/viewer.html').read_bytes()).hexdigest(),
    }


def read_web_metadata(root):
    root = Path(root)
    metadata = json.loads((root / 'dist/BUILD.json').read_text())
    if metadata != build_metadata(root):
        raise ValueError('Web build provenance differs. Run npm run build and python tools/release.py again.')
    return metadata
