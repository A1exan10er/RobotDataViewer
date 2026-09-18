"""Create the portable viewer release with notices and decoder sources."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import tarfile

root = Path(__file__).resolve().parents[1]
output = root / 'dist' / 'RobotDataViewer.zip'
# Supply app source and library build inputs so recipients can replace/relink the decoder.
with tarfile.open(root / 'sources' / 'RobotDataViewer-source.tar.gz', 'w:gz') as source:
    for name in ('src', 'vendor', 'package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.ts', 'THIRD_PARTY_NOTICES.md'):
        path = root / name
        source.add(path, arcname=f'RobotDataViewer/{name}', filter=lambda info: None if info.name.endswith(('decoder-worker.js', 'decoder.wasm.b64')) else info)
    for name in ('build-html.mjs', 'prepare-decoder.mjs', 'decoder-worker.js', 'tactile-worker.js'):
        source.add(root / 'tools' / name, arcname=f'RobotDataViewer/tools/{name}')
with ZipFile(output, 'w', compression=ZIP_DEFLATED) as archive:
    archive.write(root / 'dist' / 'viewer.html', 'RobotDataViewer/viewer.html')
    archive.write(root / 'THIRD_PARTY_NOTICES.md', 'RobotDataViewer/THIRD_PARTY_NOTICES.md')
    for doc in ('QUICKSTART_EN.md', 'QUICKSTART_ZH.md', 'FORMAT.md'):
        archive.write(root / 'docs' / doc, f'RobotDataViewer/{doc}')
    archive.write(root / 'vendor' / 'BUILD.md', 'RobotDataViewer/vendor/BUILD.md')
    archive.write(root / 'vendor' / 'SHA256.json', 'RobotDataViewer/vendor/SHA256.json')
    for source in sorted((root / 'sources').glob('*')):
        archive.write(source, f'RobotDataViewer/sources/{source.name}')
print(output)
