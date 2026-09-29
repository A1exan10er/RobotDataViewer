"""Measure complete CLI preparation, including imports/initialization, and owned RSS."""
import argparse,json,subprocess,time
from pathlib import Path
import psutil
p=argparse.ArgumentParser();p.add_argument('--gpu',action='store_true');p.add_argument('--output',type=Path,required=True);p.add_argument('command',nargs=argparse.REMAINDER);a=p.parse_args()
start=time.perf_counter();peak=0;gpu_peak=0;gpu_poll=0;before=dict(psutil.virtual_memory()._asdict());swap=dict(psutil.swap_memory()._asdict())
with a.output.with_suffix('.stdout').open('w') as out,a.output.with_suffix('.stderr').open('w') as err:
 process=subprocess.Popen(a.command,stdout=out,stderr=err);owner=psutil.Process(process.pid)
 while process.poll() is None:
  try:
   total=owner.memory_info().rss
   for child in owner.children(recursive=True):
    try:total+=child.memory_info().rss
    except psutil.Error:pass
   peak=max(peak,total)
  except psutil.Error:pass
  if a.gpu and time.monotonic()-gpu_poll>.5:
   gpu_poll=time.monotonic()
   try:
    values=subprocess.check_output(['nvidia-smi','--query-gpu=memory.used','--format=csv,noheader,nounits'],text=True,timeout=3)
    gpu_peak=max(gpu_peak,sum(int(v) for v in values.splitlines())*1024*1024)
   except (OSError,subprocess.SubprocessError):pass
  time.sleep(.05)
result={'seconds':time.perf_counter()-start,'exitCode':process.returncode,'peakProcessTreeRSS':peak,'peakTotalGPUBytes':gpu_peak,'hostBefore':before,'swapBefore':swap}
a.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result));raise SystemExit(process.returncode)
