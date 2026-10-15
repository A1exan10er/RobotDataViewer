"""Create the portable viewer release with notices and decoder sources."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
from hashlib import sha256
import json
import tarfile
import gzip
from build_metadata import build_metadata, git

root = Path(__file__).resolve().parents[1]
output = root / 'dist' / 'RobotDataViewer.zip'
version = json.loads((root / 'package.json').read_text())['version']
viewer = (root / 'dist' / 'viewer.html').read_bytes()
if f'name="application-version" content="{version}"'.encode() not in viewer:
    raise SystemExit('Run npm run build before creating this release (viewer version differs).')
metadata = build_metadata(root)
(root / 'dist/BUILD.json').write_text(json.dumps(metadata, indent=2) + '\n')
start = f'''Robot Data Viewer {version} — Portable / 便携版

This is the HTML-only package. For automatic localhost startup, use the native
ZIP for your operating system and its included Start Viewer file:
Windows: Start Viewer.cmd; Linux: Start Viewer.sh; macOS: Start Viewer.command.
Those packages include the runtime: no Python, Node.js or command-line setup.

1. Extract this ZIP completely, then open viewer.html in Firefox, Chrome or Edge.
2. Choose Open folder or Open TAR and select your original recordings.
3. Select an episode and press Play once. RGB and tactile start together when ready.
4. For USB cameras, the native desktop package and its Start Viewer entry point
   are recommended. This HTML-only ZIP does not contain an executable or launcher.
   Direct file camera access depends on the browser. If Start all is disabled,
   download the native package from either release page and use its local URL:
   https://github.com/A1exan10er/RobotDataViewer/releases/tag/v{version}
   https://git.neoteai.com/yangtianyu/RobotDataViewer/releases/tag/v{version}
   Choose Live cameras, Start all, and allow camera access.
   Choose wrist/environment (640x480/30 Hz) or tactile (640x360/30 Hz) on each card.
   Use the pencil button to name cameras; Capture settings accepts custom values.
   Remove contact before clicking Calibrate for each tactile response map.
   See LIVE_CAMERAS.md for camera permissions, controls and validation status.

No installation, server, Python, external codecs or internet connection is required.
Optional force calculation requires the included force-runtime.js beside viewer.html.
Prepared force tracks can be imported without running the model. Calculation pauses
playback until complete; then press Play for synchronized force and video display.
The viewer reads your files locally and never modifies or uploads recordings.
Recordings are not included: share the relevant data folders or uncompressed TAR
files separately. Keep the complete viewer package, including notices and sources,
when distributing it. See QUICKSTART_EN.md for controls and display information.

此包为纯 HTML 版。需要自动启动本机服务时，请使用对应系统的原生便携 ZIP，
运行包内 Start Viewer 文件（Windows: .cmd；Linux: .sh；macOS: .command）。
原生包包含运行环境，无需安装 Python、Node.js 或配置命令行。

1. 请先完整解压 ZIP，再用 Firefox、Chrome 或 Edge 打开 viewer.html。
2. 点击“打开文件夹”或“打开 TAR”，选择原始录制数据。
3. 选择片段后点击一次播放，准备完成后 RGB 和触觉将同步开始。
4. 检查 USB 相机推荐使用对应系统的原生便携包和 Start Viewer 启动文件。
   此纯 HTML 包不包含可执行文件或启动器。如果“全部启动”不可用，请从上述
   发布页下载原生便携包，通过启动器的本机地址打开，再允许相机权限。
   选择腕部/环境或触觉用途；铅笔按钮可命名相机，“采集设置”可自定义规格。
   移除接触后点击“标定”以查看触觉响应。
   详情及验证状态见 LIVE_CAMERAS.md。

无需安装、服务器、Python、外部解码器或网络。数据仅在本地读取，不会修改或上传。
可选力估算需要将 force-runtime.js 与 viewer.html 放在一起；也可直接导入已准备的
力数据。计算期间播放暂停，完成后点击播放，即可同步查看力数据和视频。
此包不包含录制数据，请单独提供相应数据文件夹或未压缩的 TAR 文件。
分发时请保留完整查看器包，包括许可声明和源码材料。详细操作见 QUICKSTART_ZH.md。
'''
# Reproducible source archives allow independently built platform packages to agree.
epoch = int(git(root, 'show', '-s', '--format=%ct', 'HEAD'))
def source_filter(info):
    if '__pycache__' in info.name or info.name.endswith(('.pyc', '.pyo', '/vendor/decoder-worker.js', 'decoder.wasm.b64', 'force.onnx', 'deepflow.wasm')):
        return None
    info.uid = info.gid = 0
    info.uname = info.gname = ''
    info.mtime = epoch
    info.mode = 0o755 if info.isdir() else 0o644
    info.pax_headers = {}
    return info

with (root / 'sources/RobotDataViewer-source.tar.gz').open('wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=epoch) as compressed, tarfile.open(fileobj=compressed, mode='w') as source:
    for name in ('src', 'vendor', 'docs', 'tests', '.gitattributes', '.gitignore', 'README.md', 'package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.ts', 'THIRD_PARTY_NOTICES.md'):
        path = root / name
        source.add(path, arcname=f'RobotDataViewer/{name}', filter=source_filter)
    for path in sorted((root / 'tools').iterdir()):
        if path.is_file():
            # The decoder input is necessary even though the generated vendor copy is excluded.
            source.add(path, arcname=f'RobotDataViewer/tools/{path.name}', filter=source_filter)
    source.add(root / 'tools/reference', arcname='RobotDataViewer/tools/reference', filter=lambda info: None if info.name.endswith('.zip') else source_filter(info))
    for name in ('native', 'force'):
        source.add(root / 'tools' / name, arcname=f'RobotDataViewer/tools/{name}', filter=source_filter)
    source.add(root / '.github', arcname='RobotDataViewer/.github', filter=source_filter)
    source.add(root / 'dist/BUILD.json', arcname='RobotDataViewer/BUILD.json', filter=source_filter)
with ZipFile(output, 'w', compression=ZIP_DEFLATED) as archive:
    archive.writestr('RobotDataViewer/START_HERE.txt', start)
    archive.writestr('RobotDataViewer/VERSION.txt', f'{version}\nviewer.html SHA-256: {sha256(viewer).hexdigest()}\n')
    archive.write(root / 'dist/BUILD.json', 'RobotDataViewer/BUILD.json')
    archive.write(root / 'dist' / 'viewer.html', 'RobotDataViewer/viewer.html')
    archive.write(root / 'dist' / 'force-runtime.js', 'RobotDataViewer/force-runtime.js')
    for notice in sorted((root/'vendor/force/licenses').glob('*.txt')):
        archive.write(notice, 'RobotDataViewer/vendor/force/licenses/'+notice.name)
    archive.write(root / 'THIRD_PARTY_NOTICES.md', 'RobotDataViewer/THIRD_PARTY_NOTICES.md')
    for doc in ('QUICKSTART_EN.md', 'QUICKSTART_ZH.md', 'FORMAT.md', 'NATIVE_FORCE.md', 'LIVE_CAMERAS.md'):
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
