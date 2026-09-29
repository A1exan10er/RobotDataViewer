"""Build a portable native package on its target OS; never cross-label binaries."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import zipfile

ROOT=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--nvidia',action='store_true');p.add_argument('--ffmpeg',type=Path,default=ROOT/'artifacts/native-ffmpeg/install/bin');a=p.parse_args()
version=json.loads((ROOT/'package.json').read_text())['version'];system={'Linux':'linux','Windows':'windows','Darwin':'macos'}[platform.system()]
arch={'AMD64':'x64','x86_64':'x64','arm64':'arm64','aarch64':'arm64'}[platform.machine()]
label=f'{system}-{arch}'+('-nvidia' if a.nvidia else '')
if a.nvidia and (system=='macos' or arch!='x64'):raise SystemExit('NVIDIA add-ons support Windows/Linux x64 only')
work=ROOT/'artifacts/native-build'/label;work.mkdir(parents=True,exist_ok=True)
name='RobotDataViewerEngine' if a.nvidia else 'RobotDataViewer';extension='.exe' if os.name=='nt' else ''
args=[sys.executable,'-m','PyInstaller','--noconfirm','--clean','--onedir','--name',name,'--distpath',str(work/'output'),
 '--workpath',str(work/'work'),'--specpath',str(work),'--paths',str(ROOT/'tools/force'),'--paths',str(ROOT/'tools/native'),
 '--hidden-import','worker','--hidden-import','engine','--hidden-import','model','--hidden-import','psutil','--collect-all','onnxruntime',
 '--exclude-module','torch','--exclude-module','torchvision','--exclude-module','onnx','--exclude-module','matplotlib','--exclude-module','scipy']
if a.nvidia:
    for module in ('nvidia.cuda_runtime','nvidia.cublas','nvidia.cudnn','nvidia.cufft','nvidia.curand','nvidia.nvjitlink'):
        args+=['--collect-all',module]
args.append(str(ROOT/'tools/native/launcher.py'));subprocess.run(args,cwd=ROOT,check=True)
output=work/'output'/name
if not a.nvidia:
    for file in ('viewer.html','force-runtime.js'):shutil.copy2(ROOT/'dist'/file,output/file)
    (output/'model').mkdir(exist_ok=True)
    for file in ('force.onnx','model.json','validation.npz'):shutil.copy2(ROOT/'vendor/force'/file,output/'model'/file)
    (output/'ffmpeg').mkdir(exist_ok=True)
    for file in ('ffmpeg','ffprobe'):shutil.copy2(a.ffmpeg/(file+extension),output/'ffmpeg'/(file+extension))
    shutil.copy2(a.ffmpeg.parent/'BUILD.json',output/'ffmpeg/BUILD.json')
    if system=='macos':
        start=output/'Start Viewer.command';start.write_text('#!/bin/sh\ncd "$(dirname "$0")"\nexec ./RobotDataViewer\n');start.chmod(0o755)
for doc in ('THIRD_PARTY_NOTICES.md','docs/QUICKSTART_EN.md','docs/QUICKSTART_ZH.md','docs/NATIVE_FORCE.md'):shutil.copy2(ROOT/doc,output/Path(doc).name)
(output/'sources').mkdir(exist_ok=True)
for file in (ROOT/'sources').iterdir():
    if file.is_file():shutil.copy2(file,output/'sources'/file.name)
licenses=output/'licenses';licenses.mkdir(exist_ok=True)
packages=['numpy','opencv-contrib-python-headless','psutil','pyinstaller', 'onnxruntime-gpu' if a.nvidia else 'onnxruntime-directml' if system=='windows' else 'onnxruntime']
if a.nvidia:packages+=[d.metadata['Name'] for d in importlib.metadata.distributions() if d.metadata['Name'].startswith('nvidia-')]
versions={}
for package in packages:
    dist=importlib.metadata.distribution(package);versions[package]=dist.version
    for file in dist.files or []:
        if any(word in file.name.lower() for word in ('license','copying','notice')) and ('.dist-info' in str(file) or package.startswith('nvidia-')):
            source=Path(dist.locate_file(file))
            if source.is_file():shutil.copy2(source,licenses/(package+'-'+str(file).replace('/','_').replace('\\','_')))
shutil.copytree(ROOT/'vendor/force/licenses',licenses/'force',dirs_exist_ok=True)
(output/'BUILD.json').write_text(json.dumps({'version':version,'platform':label,'python':platform.python_version(),'dependencies':versions},indent=2)+'\n')
(output/'START_HERE.txt').write_text('Extract completely. Run '+name+extension+' (macOS: Start Viewer.command).\nKeep the launcher open while viewing. No Python installation is required.\n首次使用请完整解压，运行启动器并保持其开启；无需安装 Python。\n'+('Install this directory as nvidia beside the base launcher.\n将此文件夹重命名为 nvidia，放在主启动器旁。\n' if a.nvidia else ''),encoding='utf-8')
archive=ROOT/'dist'/f'RobotDataViewer-{version}-{label}.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for file in sorted(output.rglob('*')):
        if file.is_file():z.write(file,Path('nvidia' if a.nvidia else 'RobotDataViewer')/file.relative_to(output))
archive.with_suffix('.zip.sha256').write_text(hashlib.sha256(archive.read_bytes()).hexdigest()+'  '+archive.name+'\n')
print(archive)
