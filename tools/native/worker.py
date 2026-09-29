"""One job process and one inference session; JSON lines carry bounded progress."""
import json
import os
import shutil
import threading
from pathlib import Path
import sys
import time


def emit(value):print(json.dumps(value,separators=(',',':'),allow_nan=False),flush=True)

def run(job_dir,model_dir,provider='auto'):
    from engine import Engine
    directory=Path(job_dir)
    parent=int(os.environ.get('RDV_FORCE_PARENT_PID','0'))
    if parent:
        def watch_parent():
            import psutil
            while psutil.pid_exists(parent):time.sleep(.5)
            for child in psutil.Process().children(recursive=True):
                try:child.kill()
                except psutil.Error:pass
            shutil.rmtree(directory,ignore_errors=True)
            os._exit(0)
        threading.Thread(target=watch_parent,daemon=True).start()
    items=json.loads((directory/'request.json').read_text())
    started=time.perf_counter();processing_started=started;completed=0;processed=0;total=sum(i['video']['frames'] for i in items)
    def progress(value):
        value['overallFrame']=completed+value['frame'];value['overallFrames']=total
        value['elapsed']=time.perf_counter()-started
        value['remaining']=(time.perf_counter()-processing_started)*(total-value['overallFrame'])/max(1,processed+value['frame'])
        emit({'progress':value})
    engine=Engine(model_dir,provider=provider,progress=progress,total_frames=total)
    processing_started=time.perf_counter()
    for index,item in enumerate(items):
        try:
            track,diagnostics=engine.estimate(directory/f'{index}.mp4',item['sensor'],cancel=lambda:not (directory/'request.json').exists())
            if track['video']!=item['video'] or len(track['time'])!=len(item['time']) or any(abs(a-b)>.002 for a,b in zip(track['time'],item['time'])):
                raise ValueError('Decoded video does not match requested identity/timing')
            if track['model']!=item['model']:raise ValueError('Model version differs')
            # Use the viewer's exact normalized PTS for persistent cache identity.
            track['time']=item['time'];track['reference']=item['reference']
            (directory/f'{index}.json').write_text(json.dumps(track,separators=(',',':'),allow_nan=False))
            emit({'complete':index,'diagnostics':diagnostics});processed+=item['video']['frames']
        except Exception as error:emit({'failed':index,'error':str(error)})
        finally:(directory/f'{index}.mp4').unlink(missing_ok=True)
        completed+=item['video']['frames']
    emit({'done':True,'elapsed':time.perf_counter()-started})
