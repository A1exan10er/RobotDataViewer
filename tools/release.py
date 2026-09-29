"""Create the portable viewer release with notices and decoder sources."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
from hashlib import sha256
import json
import tarfile

root = Path(__file__).resolve().parents[1]
output = root / 'dist' / 'RobotDataViewer.zip'
version = json.loads((root / 'package.json').read_text())['version']
viewer = (root / 'dist' / 'viewer.html').read_bytes()
if f'name="application-version" content="{version}"'.encode() not in viewer:
    raise SystemExit('Run npm run build before creating this release (viewer version differs).')
start = f'''Robot Data Viewer {version} — Portable / 便携版

1. Extract this ZIP completely, then open viewer.html in Firefox, Chrome or Edge.
2. Choose Open folder or Open TAR and select your original recordings.
3. Select an episode and press Play once. RGB and tactile start together when ready.

No installation, server, Python, external codecs or internet connection is required.
Optional force calculation requires the included force-runtime.js beside viewer.html.
Prepared force tracks can be imported without running the model. Calculation pauses
playback until complete; then press Play for synchronized force and video display.
The viewer reads your files locally and never modifies or uploads recordings.
Recordings are not included: share the relevant data folders or uncompressed TAR
files separately. Keep the complete viewer package, including notices and sources,
when distributing it. See QUICKSTART_EN.md for controls and display information.

1. 请先完整解压 ZIP，再用 Firefox、Chrome 或 Edge 打开 viewer.html。
2. 点击“打开文件夹”或“打开 TAR”，选择原始录制数据。
3. 选择片段后点击一次播放，准备完成后 RGB 和触觉将同步开始。

无需安装、服务器、Python、外部解码器或网络。数据仅在本地读取，不会修改或上传。
可选力估算需要将 force-runtime.js 与 viewer.html 放在一起；也可直接导入已准备的
力数据。计算期间播放暂停，完成后点击播放，即可同步查看力数据和视频。
此包不包含录制数据，请单独提供相应数据文件夹或未压缩的 TAR 文件。
分发时请保留完整查看器包，包括许可声明和源码材料。详细操作见 QUICKSTART_ZH.md。
'''
# Supply app source and library build inputs so recipients can replace/relink the decoder.
with tarfile.open(root / 'sources' / 'RobotDataViewer-source.tar.gz', 'w:gz') as source:
    for name in ('src', 'vendor', 'package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.ts', 'THIRD_PARTY_NOTICES.md'):
        path = root / name
        source.add(path, arcname=f'RobotDataViewer/{name}', filter=lambda info: None if info.name.endswith(('decoder-worker.js', 'decoder.wasm.b64', 'force.onnx', 'deepflow.wasm')) else info)
    for name in ('build-html.mjs', 'prepare-decoder.mjs', 'decoder-worker.js', 'tactile-worker.js'):
        source.add(root / 'tools' / name, arcname=f'RobotDataViewer/tools/{name}')
    source.add(root / 'tools' / 'reference', arcname='RobotDataViewer/tools/reference', filter=lambda info: None if '__pycache__' in info.name or info.name.endswith('.zip') else info)
    source.add(root / 'tools' / 'native', arcname='RobotDataViewer/tools/native', filter=lambda info: None if '__pycache__' in info.name else info)
    source.add(root / 'tools' / 'force', arcname='RobotDataViewer/tools/force', filter=lambda info: None if '__pycache__' in info.name else info)
with ZipFile(output, 'w', compression=ZIP_DEFLATED) as archive:
    archive.writestr('RobotDataViewer/START_HERE.txt', start)
    archive.writestr('RobotDataViewer/VERSION.txt', f'{version}\nviewer.html SHA-256: {sha256(viewer).hexdigest()}\n')
    archive.write(root / 'dist' / 'viewer.html', 'RobotDataViewer/viewer.html')
    archive.write(root / 'dist' / 'force-runtime.js', 'RobotDataViewer/force-runtime.js')
    for notice in sorted((root/'vendor/force/licenses').glob('*.txt')):
        archive.write(notice, 'RobotDataViewer/vendor/force/licenses/'+notice.name)
    archive.write(root / 'THIRD_PARTY_NOTICES.md', 'RobotDataViewer/THIRD_PARTY_NOTICES.md')
    for doc in ('QUICKSTART_EN.md', 'QUICKSTART_ZH.md', 'FORMAT.md', 'NATIVE_FORCE.md'):
        archive.write(root / 'docs' / doc, f'RobotDataViewer/{doc}')
    archive.write(root / 'vendor' / 'BUILD.md', 'RobotDataViewer/vendor/BUILD.md')
    archive.write(root / 'vendor' / 'SHA256.json', 'RobotDataViewer/vendor/SHA256.json')
    for source in sorted((root / 'sources').glob('*')):
        archive.write(source, f'RobotDataViewer/sources/{source.name}')
with ZipFile(output) as archive:
    if archive.testzip() is not None:
        raise SystemExit('Release ZIP integrity check failed')
output.with_suffix('.zip.sha256').write_text(f'{sha256(output.read_bytes()).hexdigest()}  {output.name}\n')
print(output)
