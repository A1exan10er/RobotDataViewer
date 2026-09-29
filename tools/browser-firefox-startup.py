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
p.add_argument('--episode', default='')
p.add_argument('--force-region-recovery', action='store_true')
p.add_argument('--software', action='store_true')
p.add_argument('--compat', action='store_true')
p.add_argument('--native-tactile', action='store_true')
p.add_argument('--seconds', type=float, default=0)
p.add_argument('--exercise-recovery', action='store_true', help='Probe cancellation, browsing order and paused controls (requires forced recovery)')
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
 return cards.length===window.__expectedPanels&&touch.length===4&&!!document.querySelector('.episode-button.selected')&&selected&&joint&&joint.startTime>=selected.startTime&&selected.detail.channel.includes(window.__expectedEpisode)&&cards.every(c=>c.dataset.revealed==='true'&&c.dataset.preparation==='ready'&&Number(c.dataset.readyGeneration)===joint.detail.generation&&Number(c.dataset.generation)===joint.detail.generation&&marks.some(m=>m.name==='rdv:channel-ready'&&m.startTime>=selected.startTime&&m.detail.channel===c.dataset.channel&&m.detail.generation===joint.detail.generation))&&touch.every(c=>!c.querySelector('.media-message')&&Number(c.querySelector('.difference-cell canvas').dataset.generation)===joint.detail.generation&&window.__stagedAcks[c.dataset.channel]?.generation===joint.detail.generation&&window.__stagedAcks[c.dataset.channel]?.time>=selected.startTime);
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
        if run==0:command('/url',{'url':Path(a.viewer).resolve().as_uri()+('?'+'software=1' if a.software else '?nativeTactile=1' if a.native_tactile else '')})
        else:command('/refresh',{})
        wait("!!document.querySelector('.open-main')")
        evaluate("window.__expectedPanels="+str(a.panels)+";window.__expectedEpisode="+json.dumps(a.episode or (source.name if source.is_dir() else ''))+";")
        evaluate("""
          window.__workers=0;window.__createdWorkers=0;window.__moduleInits=0;window.__byteInits=0;window.__videos=0;window.__violations=[];window.__errors=[];
          window.__stagedAcks={};window.__paintCount=0;const mark=window.performance.mark.bind(window.performance);window.performance.mark=function(name,options){if(name==='rdv:tactile-paint')window.__paintCount++;if(name==='rdv:tactile-paint'&&options?.detail?.staged)window.__stagedAcks[options.detail.channel]={...options.detail,time:performance.now()};return mark(name,options);};
          addEventListener('error',e=>window.__errors.push(e.message));addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));
          const create=document.createElement.bind(document);document.createElement=function(...args){if(args[0]==='video')window.__videos++;return create(...args);};
          const Base=Worker;window.Worker=class extends Base{constructor(...args){super(...args);window.__workers++;window.__createdWorkers++;this.dead=false;}postMessage(data,...args){if(data.method==='init'){if(data.args.wasmModule)window.__moduleInits++;if(data.args.wasmBinary)window.__byteInits++;}return super.postMessage(data,...args);}terminate(){if(!this.dead){this.dead=true;window.__workers--;}return super.terminate();}};
          let heldKey,heldTime;
          function check(){const cards=[...document.querySelectorAll('.media-card')];if(cards.length){const all=cards.every(c=>c.dataset.revealed==='true'),time=Number(document.querySelector('.timeline')?.value),key=performance.getEntriesByName('rdv:episode-selection').at(-1)?.startTime+':'+cards[0].dataset.generation;if(!all){if(cards.some(c=>c.dataset.revealed==='true')||cards.some(c=>[...c.querySelectorAll('video')].some(v=>!v.paused))||(heldKey===key&&time!==heldTime))window.__violations.push(performance.now());heldKey=key;heldTime=time;}else heldKey=undefined;}requestAnimationFrame(check);}requestAnimationFrame(check);
        """)
        if a.episode:
            evaluate("{const sort=window.Array.prototype.sort;window.Array.prototype.sort=function(...args){const result=sort.apply(this,args);if(this[0]?.media){window.Array.prototype.sort=sort;const i=this.findIndex(e=>e.id?.includes("+json.dumps(a.episode)+"));if(i>0)this.unshift(this.splice(i,1)[0]);}return result;};}")
        if a.compat:evaluate("window.OffscreenCanvas=undefined;window.createImageBitmap=undefined;")
        if a.force_region_recovery:
            evaluate("""
            window.__regionProbes=0;window.__forcedRegions=0;
            {const Base=Worker;window.Worker=class extends Base{
              constructor(...args){super(...args);this.probeIds=new Set();this.probeTimers=new Set();this.addEventListener('message',e=>{
                if(this.probeIds.delete(e.data.id)&&window.__probeDelay){e.stopImmediatePropagation();const timer=setTimeout(()=>{this.probeTimers.delete(timer);if(!this.dead)this.dispatchEvent(new MessageEvent('message',{data:e.data}));},window.__probeDelay);this.probeTimers.add(timer);return;}
                const model=e.data.reference||e.data.result?.reference;
                if(model?.roiStatus==='ready'&&model.roiMethod!=='neighbor'&&this.calibration===e.data.id){
                  model.roiStatus='not-found';model.roiMask.fill(0);window.__forcedRegions++;
                }
              });}
              postMessage(data,...args){if(data.kind==='calibrated'||data.method==='init'&&data.args.isTactile&&!data.args.reference&&!data.args.probeOnly)this.calibration=data.id;if(data.method==='probeRegion'){window.__regionProbes++;this.probeIds.add(data.id);}return super.postMessage(data,...args);}
              terminate(){for(const timer of this.probeTimers)clearTimeout(timer);this.probeTimers.clear();return super.terminate();}
            };}
            """)
        open_source();wait("!!document.querySelector('.timeline')")
        evaluate("document.querySelector('.play-button').click()")
        wait(READY);cold=metrics()
        if a.force_region_recovery:cold['regionProbes']=evaluate('return window.__regionProbes')
        wait("Number(document.querySelector('.timeline').value)>100")
        evaluate("document.querySelector('.play-button').click();document.querySelector('.episode-button.selected').click();")
        wait(READY);cached=metrics()
        for label,m in [('cold',cold),('cached',cached)]:
            if m['jointReadyMs']>a.budget_ms:report['failures'].append(f'Run {run+1} {label}: {m["jointReadyMs"]} ms exceeds {a.budget_ms} ms')
            assert not m['violations'],m['violations']
            assert not m['errors'],m['errors']
            assert m['workers']==(a.panels if a.software else 4),m
        if not a.native_tactile:assert cold['created']==(a.panels if a.software else 4) and cached['created']==2*cold['created']
        assert sum(m['name']=='rdv:calibration-cache-hit' for m in cached['marks'])==4
        assert not any(m['name']=='rdv:calibration-start' for m in cached['marks'])
        assert not any(m.get('rewinds',0)>0 for m in cold['marks'] if m['name']=='rdv:decoder-metrics')
        assert not any(m.get('baselineSamples',0)>0 for m in cached['marks'] if m['name']=='rdv:decoder-metrics')
        if not a.native_tactile:assert cold['videoElements']==(0 if a.software else a.panels-4)
        if a.force_region_recovery:
            recovered=evaluate("return [...document.querySelectorAll('.tactile-card')].map(c=>({method:c.dataset.regionMethod,donor:c.dataset.regionDonor,label:c.querySelector('.region-recovered')?.textContent}))")
            assert len(recovered)==4 and all(c['method']=='neighbor' and c['donor'] and c['label'] for c in recovered),recovered
            assert evaluate('return window.__forcedRegions')==4
            cached['regionProbes']=evaluate('return window.__regionProbes')
            assert cached['regionProbes']==cold['regionProbes'],'Cached return must not sample any donor'
            assert cold['regionProbes']<=16
            assert cold['regionProbes']==4,'Each sensor should use its matching first donor in this fixture'
            if not a.native_tactile:
                for channel in ['l_tact_l','l_tact_r','r_tact_l','r_tact_r']:
                    decoded=[m for m in cold['marks'] if m['name']=='rdv:decoder-metrics' and m['channel']==channel]
                    assert decoded and decoded[-1]['regionProbeFrames']==8,decoded
            cached['recovered']=recovered
        if a.seconds:
            evaluate("document.querySelector('.play-button').click()")
            playback_before=evaluate("return {time:Number(document.querySelector('.timeline').value),wall:performance.now(),marks:window.__paintCount}")
            time.sleep(a.seconds)
            after=evaluate("return {time:Number(document.querySelector('.timeline').value),wall:performance.now(),marks:window.__paintCount,methods:[...document.querySelectorAll('.tactile-card')].map(c=>c.dataset.regionMethod)}")
            assert after['time']-playback_before['time']>=a.seconds*900,(playback_before,after)
            assert after['marks']-playback_before['marks']>=a.seconds*4,(playback_before,after)
            cached['playback']={'before':playback_before,'after':after}
            evaluate("document.querySelector('.play-button').click()")
            shot=command('/screenshot',method='GET');import base64
            (output/(a.label+'-normal-en.png')).write_bytes(base64.b64decode(shot))
            evaluate("document.querySelector('.language-button').click();document.querySelector('.tactile-card .icon-button').click()")
            shot=command('/screenshot',method='GET');import base64
            (output/(a.label+'-expanded-zh.png')).write_bytes(base64.b64decode(shot))
            evaluate("document.querySelector('.expanded-close').click();document.querySelector('.language-button').click()")
        if a.exercise_recovery:
            assert a.force_region_recovery
            evaluate("{const s=document.querySelector('.timeline');s.value=1500;s.dispatchEvent(new Event('input',{bubbles:true}));}")
            evaluate("{const s=document.querySelector('.timeline');s.value=2500;s.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[aria-label=\"Next frame\"]').click();}")
            wait(READY)
            target=evaluate("return Number(document.querySelector('.timeline').value)")
            assert 2500<target<2540,target
            frames=evaluate("return [...document.querySelectorAll('.tactile-card .difference-cell canvas')].map(c=>({time:Number(c.dataset.presentedTime),generation:Number(c.dataset.generation)}))")
            # This charger fixture has identity time mapping and 30 fps sensors.
            assert all(0<=target/1000-f['time']<.035 for f in frames),(target,frames)
            evaluate("{const s=document.querySelector('.playback-extras select');s.value=2;s.dispatchEvent(new Event('change',{bubbles:true}));const g=document.querySelector('.tactile-card input[type=range]');g.value=16;g.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.tactile-card input[type=checkbox]').click();}")
            wait(READY)
            wait("performance.getEntriesByName('rdv:tactile-paint').some(m=>m.detail.channel===document.querySelector('.tactile-card').dataset.channel&&m.detail.gain===16&&m.detail.cleanup===false)")
            evaluate("{const s=document.querySelector('.playback-extras select');s.value=1;s.dispatchEvent(new Event('change',{bubbles:true}));}")
            wait(READY)
            # 0154 and 0156 both have 0155 as their nearest same-session neighbor.
            # Use the fixture's actual capture times, not an assumption about IDs.
            evaluate("window.__expectedEpisode='episode_0154_';[...document.querySelectorAll('.episode-button')].find(b=>b.innerText.includes('0154')).click()")
            wait(READY)
            probes=evaluate('return window.__regionProbes')
            evaluate("window.__expectedEpisode='episode_0156_';[...document.querySelectorAll('.episode-button')].find(b=>b.innerText.includes('0156')).click()")
            wait(READY)
            assert evaluate('return window.__regionProbes')==probes,'Donor geometry should be cached'
            # Source replacement clears both model and geometry caches. Cancel an
            # actual in-flight probe and its delayed reply, then select a new episode.
            evaluate('window.__probeDelay=2500')
            open_source();wait('window.__regionProbes>'+str(probes))
            evaluate("document.querySelector('.play-button').click();document.querySelector('.play-button').click();document.querySelector('.episode-button.selected').click();")
            evaluate("window.__probeDelay=0;window.__expectedEpisode='episode_0158_';[...document.querySelectorAll('.episode-button')].find(b=>b.innerText.includes('0158')).click()")
            wait(READY)
            time.sleep(.3)
            assert evaluate("return Number(document.querySelector('.timeline').value)")==0,'Cancelled Play must stay cancelled'
            assert evaluate('return window.__workers')==(a.panels if a.software else 4)
            evaluate("window.__expectedEpisode='episode_0157_';[...document.querySelectorAll('.episode-button')].find(b=>b.innerText.includes('0157')).click()")
            wait(READY)
            assert not evaluate('return window.__errors')
            assert not evaluate('return window.__violations')
            cached['recoveryControls']={'targetMs':target,'frames':frames,'checks':['rapid seek and step','paused gain and Show all changes','rate reserve','cached donor geometry','source replacement','cancel delayed probe','different browsing order','queued Play cancellation','worker cleanup']}
        report['runs'].append({'run':run+1,'cold':cold,'cached':cached,'hostBefore':before,'hostAfter':host()})
        print(json.dumps({'run':run+1,'coldMs':cold['jointReadyMs'],'cachedMs':cached['jointReadyMs'],'workers':cached['workers']}),flush=True)
        # Refresh the same history entry next time: a cold app cache without
        # retaining earlier viewer documents in Firefox's back/forward history.
    assert not report['failures'],report['failures']
except Exception as error:
    report['failure']=str(error)
    if session:
        try:report['diagnostic']=evaluate("return {episode:document.querySelector('.episode-button.selected')?.innerText, cards:[...document.querySelectorAll('.media-card')].map(c=>({...c.dataset})), errors:window.__errors, marks:performance.getEntriesByType('mark').filter(m=>m.name.startsWith('rdv:')).slice(-60).map(m=>({name:m.name,time:m.startTime,...m.detail}))}")
        except Exception:pass
    raise
finally:
    report['hostAfter']=host()
    (output/(a.label+'.json')).write_text(json.dumps(report,indent=2))
    if session:
        try:command('',method='DELETE')
        except Exception:pass
    driver.terminate();driver.wait(timeout=10);log.close()
