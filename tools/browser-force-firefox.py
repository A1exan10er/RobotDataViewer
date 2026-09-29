"""Optional force preparation/import and playback in one isolated Firefox."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser()
p.add_argument('--source', required=True)
p.add_argument('--panels', type=int, required=True)
p.add_argument('--label', required=True)
p.add_argument('--viewer', default=str(ROOT / 'dist/viewer.html'))
p.add_argument('--driver', default=os.environ.get('GECKODRIVER', '/snap/bin/geckodriver'))
p.add_argument('--software', action='store_true')
p.add_argument('--compat', action='store_true')
p.add_argument('--native',action='store_true')
p.add_argument('--seconds', type=float, default=0)
p.add_argument('--import-tracks',default='')
p.add_argument('--budget-ms', type=float, default=3000)
a = p.parse_args()
source = Path(a.source).resolve()
output = ROOT / 'artifacts/firefox'
output.mkdir(parents=True, exist_ok=True)
profile = ROOT / 'artifacts/firefox-profiles'
profile.mkdir(parents=True, exist_ok=True)
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
log = (output / (a.label + '.log')).open('w')
driver = subprocess.Popen([a.driver, '--port', str(port), '--profile-root', str(profile)], stdout=log, stderr=log)
session = None
report = {'source':str(source), 'viewer':a.viewer.split('#',1)[0], 'hostBefore':{}}

def host():
    return {'memory':Path('/proc/meminfo').read_text(), 'pressure':Path('/proc/pressure/memory').read_text()}

def request(method, path, data=None):
    req = urllib.request.Request('http://127.0.0.1:'+str(port)+path, data=None if data is None else json.dumps(data).encode(), method=method, headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            return json.load(response)['value']
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error

def command(path, data=None, method='POST'):
    return request(method, '/session/'+session+path, data)

def evaluate(script):
    return command('/execute/sync', {'script':script, 'args':[]})

def wait(expression, timeout=35):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        if evaluate('return '+expression):return
        time.sleep(.05)
    raise RuntimeError('Readiness timed out: '+evaluate('return document.body.innerText'))

def open_source():
    selector='input[webkitdirectory]' if source.is_dir() else 'input[accept]'
    element=command('/element', {'using':'css selector','value':selector})['element-6066-11e4-a52e-4f735466cecf']
    if source.is_dir():
        files=sorted(f for f in source.rglob('*') if f.is_file())
        evaluate("document.querySelector('input[webkitdirectory]').addEventListener('change',e=>e.stopImmediatePropagation(),{capture:true,once:true})")
        command('/element/'+element+'/value', {'text':'\n'.join(str(f) for f in files)})
        paths=[str(f.relative_to(source.parent)) for f in files]
        evaluate("{const input=document.querySelector('input[webkitdirectory]'),paths="+json.dumps(paths)+";if(input.files.length!==paths.length)throw new Error('Incomplete selection');[...input.files].forEach((f,i)=>{if(f.name!==paths[i].split('/').at(-1))throw new Error('File order');Object.defineProperty(f,'webkitRelativePath',{value:paths[i]});});input.dispatchEvent(new Event('change',{bubbles:true}));}")
    else:command('/element/'+element+'/value', {'text':str(source)})


try:
    report['hostBefore']=host()
    for _ in range(100):
        try:request('GET','/status');break
        except OSError:time.sleep(.1)
    created=request('POST','/session',{'capabilities':{'alwaysMatch':{'browserName':'firefox','moz:firefoxOptions':{'args':['-headless'],'prefs':{'media.autoplay.default':0,'browser.shell.checkDefaultBrowser':False}}}}})
    session=created['sessionId'];report['browser']=created['capabilities']['browserVersion']
    command('/window/rect',{'width':1366,'height':1000})
    from urllib.parse import urlsplit,urlunsplit
    url=a.viewer if a.viewer.startswith('http://127.0.0.1:') else Path(a.viewer).resolve().as_uri()
    parts=urlsplit(url);url=urlunsplit((parts.scheme,parts.netloc,parts.path,'software=1' if a.software else parts.query,parts.fragment))
    command('/url',{'url':url})
    wait("!!document.querySelector('.open-main')")
    evaluate("""
      window.__workers=0;window.__forceTracks=0;window.__paints=0;window.__errors=[];
      const mark=performance.mark.bind(performance);performance.mark=function(name,options){if(name==='rdv:tactile-paint')window.__paints++;return mark(name,options);};
      addEventListener('error',e=>window.__errors.push(e.message));addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));
      const Base=Worker;window.Worker=class extends Base{constructor(...args){super(...args);this.dead=false;window.__workers++;this.addEventListener('message',e=>{if(e.data.result?.track)window.__forceTracks++;});}terminate(){if(!this.dead){this.dead=true;window.__workers--;}return super.terminate();}};
    """)
    if a.compat:evaluate('window.OffscreenCanvas=undefined;window.createImageBitmap=undefined;')
    started=time.monotonic();open_source()
    ready="document.querySelectorAll('.media-card').length==="+str(a.panels)+" && [...document.querySelectorAll('.media-card')].every(c=>c.dataset.revealed==='true'&&c.dataset.preparation==='ready'&&c.dataset.generation===c.dataset.readyGeneration)"
    wait(ready);report['startupMs']=(time.monotonic()-started)*1000
    assert report['startupMs']<=a.budget_ms,report['startupMs']
    assert evaluate("return !document.querySelector('.force-toolbar input[type=checkbox]').checked && !performance.getEntriesByType('resource').some(r=>r.name.includes('force-runtime'))")
    workers=evaluate('return window.__workers')
    if a.import_tracks:
        element=command('/element',{'using':'css selector','value':'.force-toolbar input[type=file]'})['element-6066-11e4-a52e-4f735466cecf']
        command('/element/'+element+'/value',{'text':str(Path(a.import_tracks).resolve())});time.sleep(.2)
    started=time.monotonic();evaluate("document.querySelector('.force-toolbar input[type=checkbox]').click()")
    wait("document.querySelectorAll('.force-readout svg').length===4 && !document.querySelector('.force-progress')",240)
    report['forceReadyMs']=(time.monotonic()-started)*1000
    assert evaluate("return Number(document.querySelector('.timeline').value)===0 && [...document.querySelectorAll('.force-readout')].every(r=>r.dataset.forceFrame==='0'||(r.dataset.forceFrame==='-1'&&r.closest('.media-card').classList.contains('inactive')))")
    assert evaluate('return window.__workers')==workers
    report['calculatedTracks']=evaluate('return window.__forceTracks');assert report['calculatedTracks']==(0 if a.import_tracks or a.native else 4)
    if a.import_tracks or a.native:assert evaluate("return !performance.getEntriesByType('resource').some(r=>r.name.includes('force-runtime'))")
    target=min(4000,evaluate("return Number(document.querySelector('.timeline').max)*.7"))
    evaluate("{const s=document.querySelector('.timeline');s.value="+str(target)+";s.dispatchEvent(new Event('input',{bubbles:true}));}")
    wait(ready)
    assert evaluate("return [...document.querySelectorAll('.tactile-card')].every(c=>Number(c.querySelector('.force-readout').dataset.forceTime)<=Number(c.querySelector('.difference-cell canvas').dataset.presentedTime)+.000001)")
    evaluate("document.querySelector('.force-toolbar').scrollIntoView({block:'start'});")
    import base64
    (output/(a.label+'-normal-en.png')).write_bytes(base64.b64decode(command('/screenshot',method='GET')))
    evaluate("document.querySelector('.language-button').click();document.querySelector('[data-channel=l_tact_l] .icon-button').click();")
    (output/(a.label+'-expanded-zh.png')).write_bytes(base64.b64decode(command('/screenshot',method='GET')))
    evaluate("document.querySelector('.expanded-close').click();document.querySelector('.language-button').click();")
    evaluate("{const s=document.querySelector('.timeline');s.value=0;s.dispatchEvent(new Event('input',{bubbles:true}));}");wait(ready)
    before=evaluate('return window.__paints');start=time.monotonic();evaluate("document.querySelector('.play-button').click()")
    time.sleep(a.seconds or 2)
    evaluate("document.querySelector('.play-button').click()")
    report['playback']={'wallMs':(time.monotonic()-start)*1000,'clockMs':evaluate("return Number(document.querySelector('.timeline').value)"),'paints':evaluate('return window.__paints')-before}
    assert report['playback']['paints']>4
    count=evaluate('return window.__forceTracks')
    evaluate("document.querySelector('.force-toolbar input[type=checkbox]').click()");time.sleep(.05)
    started=time.monotonic();evaluate("document.querySelector('.force-toolbar input[type=checkbox]').click()")
    wait("document.querySelectorAll('.force-readout svg').length===4 && !document.querySelector('.force-progress')")
    report['cachedForceMs']=(time.monotonic()-started)*1000
    assert evaluate('return window.__forceTracks')==count
    assert not evaluate('return window.__errors')
    report['checks']=['optional inference','all-frame preparation paused','actual displayed-frame values','source offsets','continued paints','cache without inference','worker cleanup','normal English and expanded Chinese']
except Exception as error:
    report['failure']=str(error)
    if session:
        try:report['diagnostic']=evaluate("return {body:document.body.innerText,errors:window.__errors,workers:window.__workers}")
        except Exception:pass
    raise
finally:
    report['hostAfter']=host();(output/(a.label+'.json')).write_text(json.dumps(report,indent=2))
    if session:
        try:command('',method='DELETE')
        except Exception:pass
    driver.terminate();driver.wait(timeout=10);log.close()
