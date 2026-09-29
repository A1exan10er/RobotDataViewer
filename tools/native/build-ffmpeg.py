"""Build the bundled FFmpeg source on the target OS (MSYS2 shell on Windows)."""
import hashlib,json,os,subprocess,tarfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];work=ROOT/'artifacts/native-ffmpeg';work.mkdir(parents=True,exist_ok=True)
source=ROOT/'sources/ffmpeg-8.1.tar.xz'
# This same reviewed source archive is already shipped for the browser decoder.
with tarfile.open(source) as archive:
    for member in archive.getmembers():
        if Path(member.name).is_absolute() or '..' in Path(member.name).parts:raise ValueError('Unsafe source archive')
    archive.extractall(work)
directory=work/'ffmpeg-8.1';prefix=work/'install';prefix.mkdir(exist_ok=True)
configure_prefix=subprocess.check_output(['cygpath','-u',str(prefix)],text=True).strip() if os.name=='nt' else str(prefix)
flags=['--disable-autodetect','--disable-doc','--disable-debug','--disable-network','--disable-shared','--enable-static',
 '--disable-everything','--enable-ffmpeg','--enable-ffprobe','--enable-protocol=file,pipe',
 '--enable-demuxer=mov,matroska,avi','--enable-decoder=h264,hevc,mjpeg,mpeg4,vp8,vp9,rawvideo',
 '--enable-parser=h264,hevc,mjpeg,mpeg4video,vp8,vp9','--enable-encoder=rawvideo',
 '--enable-muxer=rawvideo','--enable-filter=scale,format,null,buffer,buffersink', '--disable-x86asm',f'--prefix={configure_prefix}']
if os.name=='nt':flags+=['--extra-ldflags=-static']
subprocess.run(['sh','configure',*flags],cwd=directory,check=True)
subprocess.run(['make','-j2'],cwd=directory,check=True);subprocess.run(['make','install'],cwd=directory,check=True)
(prefix/'BUILD.json').write_text(json.dumps({'source':source.name,'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'flags':flags},indent=2)+'\n')
print(prefix/'bin')
