"""Cold/cached joint-start budget checks in one isolated Firefox, run serially.
Each cold run reloads the viewer, clearing its model cache and compiled module.
"""
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
p.add_argument('--runs', type=int, default=5)
p.add_argument('--label', required=True)
p.add_argument('--viewer', default=str(ROOT / 'dist/viewer.html'))
p.add_argument('--driver', default=os.environ.get('GECKODRIVER', '/snap/bin/geckodriver'))
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
report = {'source':str(source), 'viewer':a.viewer, 'runs':[], 'hostBefore':{}, 'failures':[]}

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

READY = """(()=>{
 const cards=[...document.querySelectorAll('.media-card')],touch=cards.filter(c=>c.classList.contains('tactile-card'));
 const marks=performance.getEntriesByType('mark'),selected=marks.filter(m=>m.name==='rdv:episode-selection').at(-1),joint=marks.filter(m=>m.name==='rdv:joint-ready').at(-1);
 return cards.length===window.__expectedPanels&&touch.length===4&&!!document.querySelector('.episode-button.selected')&&selected&&joint&&joint.startTime>=selected.startTime&&selected.detail.channel.includes(window.__expectedEpisode)&&cards.every(c=>c.dataset.revealed==='true'&&c.dataset.preparation==='ready'&&Number(c.dataset.readyGeneration)===joint.detail.generation&&Number(c.dataset.generation)===joint.detail.generation&&marks.some(m=>m.name==='rdv:channel-ready'&&m.startTime>=selected.startTime&&m.detail.channel===c.dataset.channel&&m.detail.generation===joint.detail.generation))&&touch.every(c=>!c.querySelector('.media-message')&&Number(c.querySelector('.difference-cell canvas').dataset.generation)===joint.detail.generation&&marks.some(m=>m.name==='rdv:tactile-paint'&&m.startTime>=selected.startTime&&m.detail.channel===c.dataset.channel&&m.detail.staged&&m.detail.generation===joint.detail.generation));
})()"""

def metrics():
    marks=evaluate("return performance.getEntriesByType('mark').filter(m=>m.name.startsWith('rdv:')).map(m=>({name:m.name,time:m.startTime,...m.detail}))")
    selection=next(m for m in reversed(marks) if m['name']=='rdv:episode-selection')
    marks=[m for m in marks if m['time']>=selection['time']]
    joint=next(m for m in marks if m['name']=='rdv:joint-ready')
    counts=evaluate('return {workers:window.__workers,created:window.__createdWorkers,videoElements:window.__videos,violations:window.__violations,errors:window.__errors,modules:window.__moduleInits,bytes:window.__byteInits}')
    return {'jointReadyMs':joint['time']-selection['time'], 'marks':marks, **counts}

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
    for run in range(a.runs):
        before=host()
        if run==0:command('/url',{'url':Path(a.viewer).resolve().as_uri()})
        else:command('/refresh',{})
        wait("!!document.querySelector('.open-main')")
        evaluate("window.__expectedPanels="+str(a.panels)+";window.__expectedEpisode="+json.dumps(source.name if source.is_dir() else '')+";")
        evaluate("""
          window.__workers=0;window.__createdWorkers=0;window.__moduleInits=0;window.__byteInits=0;window.__videos=0;window.__violations=[];window.__errors=[];
          addEventListener('error',e=>window.__errors.push(e.message));addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));
          const create=document.createElement.bind(document);document.createElement=function(...args){if(args[0]==='video')window.__videos++;return create(...args);};
          const Base=Worker;window.Worker=class extends Base{constructor(...args){super(...args);window.__workers++;window.__createdWorkers++;this.dead=false;}postMessage(data,...args){if(data.method==='init'){if(data.args.wasmModule)window.__moduleInits++;if(data.args.wasmBinary)window.__byteInits++;}return super.postMessage(data,...args);}terminate(){if(!this.dead){this.dead=true;window.__workers--;}return super.terminate();}};
          function check(){const cards=[...document.querySelectorAll('.media-card')];if(cards.length){const all=cards.every(c=>c.dataset.revealed==='true');if(!all&&(cards.some(c=>c.dataset.revealed==='true')||cards.some(c=>[...c.querySelectorAll('video')].some(v=>!v.paused))||Number(document.querySelector('.timeline')?.value)>0))window.__violations.push(performance.now());}requestAnimationFrame(check);}requestAnimationFrame(check);
        """)
        open_source();wait("!!document.querySelector('.timeline')")
        evaluate("document.querySelector('.play-button').click()")
        wait(READY);cold=metrics()
        wait("Number(document.querySelector('.timeline').value)>100")
        evaluate("document.querySelector('.play-button').click();document.querySelector('.episode-button.selected').click();")
        wait(READY);cached=metrics()
        for label,m in [('cold',cold),('cached',cached)]:
            if m['jointReadyMs']>a.budget_ms:report['failures'].append(f'Run {run+1} {label}: {m["jointReadyMs"]} ms exceeds {a.budget_ms} ms')
            assert not m['violations'],m['violations']
            assert not m['errors'],m['errors']
            assert m['workers']==4,m
        assert cold['created']==4 and cached['created']==8
        assert sum(m['name']=='rdv:calibration-cache-hit' for m in cached['marks'])==4
        assert not any(m['name']=='rdv:calibration-start' for m in cached['marks'])
        assert not any(m.get('rewinds',0)>0 for m in cold['marks'] if m['name']=='rdv:decoder-metrics')
        assert not any(m.get('baselineSamples',0)>0 for m in cached['marks'] if m['name']=='rdv:decoder-metrics')
        assert cold['videoElements']==a.panels-4
        report['runs'].append({'run':run+1,'cold':cold,'cached':cached,'hostBefore':before,'hostAfter':host()})
        print(json.dumps({'run':run+1,'coldMs':cold['jointReadyMs'],'cachedMs':cached['jointReadyMs'],'workers':cached['workers']}),flush=True)
        # Refresh the same history entry next time: a cold app cache without
        # retaining earlier viewer documents in Firefox's back/forward history.
    assert not report['failures'],report['failures']
except Exception as error:
    report['failure']=str(error)
    raise
finally:
    report['hostAfter']=host()
    (output/(a.label+'.json')).write_text(json.dumps(report,indent=2))
    if session:
        try:command('',method='DELETE')
        except Exception:pass
    driver.terminate();driver.wait(timeout=10);log.close()
