"""Isolated Firefox/WebDriver playback check; never uses a personal profile."""
import argparse
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--viewer', default=str(Path(__file__).resolve().parents[1] / 'dist' / 'viewer.html'))
parser.add_argument('--source', default='/home/tianyu/Downloads/task-e7244f5d-part-01-of-01.tar')
parser.add_argument('--task', choices=['sorting','capping'], default='sorting')
parser.add_argument('--seconds', type=int, default=45)
parser.add_argument('--label', default='baseline-tar')
parser.add_argument('--software', action='store_true')
parser.add_argument('--headed', action='store_true')
parser.add_argument('--headcam', action='store_true', help='Check eight-camera head companion layout and controls')
parser.add_argument('--tactile-clean-check', action='store_true', help='Check native cleanup, fixed-reference contact display, and the unfiltered switch on the ARX5 sample')
parser.add_argument('--expect-capture-timing', action='store_true', help='Require recorded timestamp alignment after opening')
parser.add_argument('--jank', type=int, default=0, help='Periodic UI delay in milliseconds to test clock recovery')
parser.add_argument('--profile-root', default=str(Path(__file__).resolve().parents[1] / 'artifacts' / 'firefox-profiles'))
parser.add_argument('--check', action='store_true', help='Fail on repeated buffering, lost playback time, or runtime errors')
parser.add_argument('--driver', default=os.environ.get('GECKODRIVER', '/snap/bin/geckodriver'))
args = parser.parse_args()
Path(args.profile_root).mkdir(parents=True, exist_ok=True)
out = Path(__file__).resolve().parents[1] / 'artifacts' / 'firefox'
out.mkdir(parents=True, exist_ok=True)
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
log = (out / (args.label + '.log')).open('w')
driver = subprocess.Popen([args.driver, '--port', str(port), '--profile-root', args.profile_root], stdout=log, stderr=log)
session = None

def request(method, path, data=None):
    req = urllib.request.Request('http://127.0.0.1:' + str(port) + path, data=json.dumps(data).encode() if data is not None else None, method=method, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            return json.load(response)['value']
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error

def command(path, data=None, method='POST'):
    return request(method, '/session/' + session + path, data)

def evaluate(script):
    return command('/execute/sync', {'script': script, 'args': []})

def wait(script, timeout=60):
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        if evaluate('return ' + script):
            return
        time.sleep(.2)
    raise RuntimeError('Timed out: ' + script + '\n' + evaluate('return document.body.innerText'))

try:
    for _ in range(100):
        try:
            request('GET', '/status')
            break
        except OSError:
            time.sleep(.1)
    created = request('POST', '/session', {'capabilities': {'alwaysMatch': {'browserName': 'firefox', 'moz:firefoxOptions': {'args': [] if args.headed else ['-headless'], 'prefs': {'browser.shell.checkDefaultBrowser': False, 'browser.startup.page': 0, 'media.autoplay.default': 0}}}}})
    session = created['sessionId']
    print('Firefox', created['capabilities']['browserVersion'], flush=True)
    command('/window/rect', {'width': 1366, 'height': 1000})
    command('/url', {'url': Path(args.viewer).as_uri()+('?software=1' if args.software else '')})
    wait("!!document.querySelector('.open-main')")
    evaluate("""
      window.__events=[];for(const event of ['seeking','seeked','waiting','playing','pause','ratechange'])document.addEventListener(event,e=>{const card=e.target.closest?.('.media-card');if(card)window.__events.push({at:performance.now(),type:event,id:card.dataset.channel,time:e.target.currentTime});},true);
      window.__errors=[];window.addEventListener('error',e=>window.__errors.push(String(e.message)));
      window.addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));
      window.__batches=[];const Base=Worker;window.Worker=class extends Base {
        constructor(...args){super(...args);this.sent=new Map();this.addEventListener('message',e=>{const sent=this.sent.get(e.data.id);if(sent?.method==='batch')window.__batches.push({at:performance.now(),ms:performance.now()-sent.at,frames:e.data.result?.frames?.length||0});this.sent.delete(e.data.id);});}
        postMessage(data,...args){this.sent.set(data.id,{at:performance.now(),method:data.method});return super.postMessage(data,...args);}
      };
    """)
    if args.tactile_clean_check:
        evaluate((Path(__file__).resolve().parents[1]/'tools'/'tactile-browser-probe.js').read_text())
    selector = 'input[webkitdirectory]' if Path(args.source).is_dir() else 'input[accept]'
    element = command('/element', {'using': 'css selector', 'value': selector})['element-6066-11e4-a52e-4f735466cecf']
    if Path(args.source).is_dir():
        # Gecko's WebDriver endpoint accepts files, but rejects directory paths.
        # Supply the actual files and emulate only the directory picker's relative paths.
        files = sorted(p for p in Path(args.source).rglob('*') if p.is_file())
        evaluate("document.querySelector('input[webkitdirectory]').addEventListener('change',e=>e.stopImmediatePropagation(),{capture:true,once:true})")
        command('/element/' + element + '/value', {'text': '\n'.join(str(p) for p in files)})
        paths = [str(p.relative_to(Path(args.source).parent)) for p in files]
        evaluate("{const input=document.querySelector('input[webkitdirectory]'),paths="+json.dumps(paths)+";if(input.files.length!==paths.length)throw new Error('Incomplete folder selection');[...input.files].forEach((f,i)=>{if(f.name!==paths[i].split('/').at(-1))throw new Error('File order differs');Object.defineProperty(f,'webkitRelativePath',{value:paths[i]});});input.dispatchEvent(new Event('change',{bubbles:true}));}")
    else:
        command('/element/' + element + '/value', {'text': args.source})
    if args.headcam:
        wait("document.querySelectorAll('.media-card').length===8 && !document.querySelector('.loading-view')", 90)
        evaluate("{const t=document.querySelector('.timeline');t.value=100;t.dispatchEvent(new Event('input',{bubbles:true}));}")
    wait("document.querySelectorAll('.media-card').length>=6 && !document.querySelector('.media-message')", 90)
    alignment=evaluate("return document.querySelector('.alignment-status').textContent")
    if args.expect_capture_timing:
        assert alignment == 'Timestamp alignment', alignment
    print('Opened', args.source, evaluate("return [...document.querySelectorAll('.media-card')].map(c=>c.dataset.mode)"), flush=True)
    if args.headcam:
        assert evaluate("return document.querySelectorAll('.episode-button').length") == 1
        assert evaluate("return document.body.innerText.includes('Head camera · Left eye') && document.body.innerText.includes('Head camera · Right eye')")
        def seek_head(ms):
            evaluate("{const t=document.querySelector('.timeline');t.value="+str(ms)+";t.dispatchEvent(new Event('input',{bubbles:true}));}")
            wait("!document.querySelector('.playback-bar .spin') && !document.querySelector('.media-message')")
            time.sleep(.3)
        def times_head():
            return evaluate("return [...document.querySelectorAll('.media-card')].map(c=>c.dataset.mode==='software'?Number(c.querySelector('.software-video').dataset.presentedTime):c.querySelector('video').currentTime)")
        seek_head(5000);first=times_head();seek_head(1000);seek_head(5000)
        assert all(abs(a-b)<.001 for a,b in zip(first,times_head())), 'Repeated seeks differ'
        evaluate("document.querySelector('[aria-label=\"Next frame\"]').click()")
        time.sleep(.4)
        assert evaluate("return Number(document.querySelector('.timeline').value)") > 5000
        evaluate("document.querySelector('[aria-label=\"Previous frame\"]').click()")
        time.sleep(.4)
        assert evaluate("return Number(document.querySelector('.timeline').value)") < 5030
        evaluate("document.querySelector('[data-channel=ego_left] .icon-button').click()")
        wait("!!document.querySelector('.expanded-panel')")
        assert evaluate("return document.querySelector('.expanded-panel').textContent.includes('Head camera · Left eye')")
        evaluate("document.querySelector('.expanded-close').click();document.querySelector('.language-button').click()")
        assert evaluate("return document.body.innerText.includes('头戴相机 · 左眼') && document.body.innerText.includes('头戴相机 · 右眼')")
        (out / (args.label + '-zh.png')).write_bytes(base64.b64decode(command('/screenshot', method='GET')))
        evaluate("document.querySelector('.language-button').click()")
        assert evaluate("return document.documentElement.scrollWidth<=innerWidth")
        seek_head(1000)
        print('Head camera layout, pause/seek/step, expansion and bilingual labels passed', flush=True)
    if args.tactile_clean_check:
        assert evaluate("return [...document.querySelectorAll('.tactile-card input[type=checkbox]')].every(c=>!c.checked)")
        filter_code=(Path(__file__).resolve().parents[1]/'vendor'/'tactile-filter.js').read_text()
        evaluate("{"+filter_code+";window.__Filter=TactileFilter;}")
        evaluate('window.__installTactileCheck(window.__Filter)')
        def seek_cleanup(ms):
            evaluate("{const t=document.querySelector('.timeline');t.value="+str(ms)+";t.dispatchEvent(new Event('input',{bubbles:true}));}")
            wait("!document.querySelector('.playback-bar .spin') && !document.querySelector('.media-message')")
            wait("window.__check().every(c=>c.errors===0 && c.outside===0 && c.roiStatus==='ready')",10)
        seek_cleanup(2000)
        clean=evaluate("return window.__check()")
        assert all(c['errors']==0 for c in clean), clean
        seek_cleanup(18800 if args.task=='capping' else 10000)
        contact=evaluate("return window.__check()")
        assert all(c['strong']>100 for c in contact if (c['id']=='l_tact_r' if args.task=='capping' else c['id'].startswith('l_'))), contact
        evaluate("document.querySelector('[data-channel=l_tact_r] .icon-button').click()")
        assert evaluate("return getComputedStyle(document.querySelector('.expanded-panel .tactile-source')).display==='none'")
        (out / (args.label + '-contact.png')).write_bytes(base64.b64decode(command('/screenshot', method='GET')))
        evaluate("document.querySelector('.expanded-close').click()")
        evaluate("[...document.querySelectorAll('.tactile-card input[type=checkbox]')].forEach(c=>c.click())")
        wait("window.__check().every(c=>c.errors===0)",10)
        seek_cleanup(2000)
        unfiltered=evaluate("return window.__check()")
        assert all(c['changed']>=clean[i]['changed'] for i,c in enumerate(unfiltered)), unfiltered
        evaluate("[...document.querySelectorAll('.tactile-card input[type=checkbox]')].forEach(c=>c.click())")
        wait("window.__check().every(c=>c.errors===0)",10)
        assert all(c['errors']==0 for c in evaluate("return window.__check()"))
        seek_cleanup(18800 if args.task=='capping' else 10000)
        first=evaluate("return Array.from(window.__pixels(document.querySelector('[data-channel=l_tact_r] .difference-cell canvas')))")
        for gain in (1,16,10):
            evaluate("{const g=document.querySelector('[data-channel=l_tact_r] input[type=range]');g.value="+str(gain)+";g.dispatchEvent(new Event('input',{bubbles:true}));}")
            wait("window.__check().every(c=>c.errors===0)")
        for name in ('Next frame','Previous frame'):
            evaluate("document.querySelector('[aria-label=\""+name+"\"]').click()")
            wait("window.__check().every(c=>c.errors===0)")
        seek_cleanup(20000)
        seek_cleanup(18800 if args.task=='capping' else 10000)
        assert evaluate("return Array.from(window.__pixels(document.querySelector('[data-channel=l_tact_r] .difference-cell canvas')))")==first
        seek_cleanup(0)
        (out / (args.label + '-cleanup.json')).write_text(json.dumps({'clean':clean,'contact':contact,'unfiltered':unfiltered},indent=2))
        print('Native tactile cleanup, unfiltered parity and fixed baseline checks passed', flush=True)
    evaluate("""
      window.__samples=[];window.__batches=[];window.__events=[];window.__capturing=true;
      for(const video of document.querySelectorAll('.media-card video')){const tick=(_,frame)=>{video.dataset.presentedTime=frame.mediaTime;if(window.__capturing)video.requestVideoFrameCallback(tick);};video.requestVideoFrameCallback(tick);}
      const tick=()=>{if(!window.__capturing)return;const views=[...document.querySelectorAll('.media-card')].map(c=>({id:c.dataset.channel,t:c.dataset.mode==='software'?Number(c.querySelector('.software-video').dataset.presentedTime):Number(c.querySelector('video').dataset.presentedTime||0)}));window.__samples.push({at:performance.now(),timeline:Number(document.querySelector('.timeline').value),busy:document.querySelector('.playback-status').textContent.includes('Synchronizing'),views});window.__raf=requestAnimationFrame(tick);};window.__raf=requestAnimationFrame(tick);
      document.querySelector('.play-button').click();
    """)
    if args.jank:
        evaluate('window.__jank=setInterval(()=>{const end=performance.now()+'+str(args.jank)+';while(performance.now()<end){};},2500)')
    for second in range(args.seconds):
        time.sleep(1)
        if (second+1) % 5 == 0:
            print(second+1, evaluate("return {timeline:document.querySelector('.timeline').value,status:document.querySelector('.playback-status').textContent}"), flush=True)
    evaluate("document.querySelector('.play-button').click();window.__capturing=false;cancelAnimationFrame(window.__raf);clearInterval(window.__jank);")
    raw = evaluate("return {samples:window.__samples,batches:window.__batches,errors:window.__errors,events:window.__events,quality:[...document.querySelectorAll('.media-card video')].map(v=>({id:v.closest('.media-card').dataset.channel,...v.getVideoPlaybackQuality().toJSON?.(),total:v.getVideoPlaybackQuality().totalVideoFrames,dropped:v.getVideoPlaybackQuality().droppedVideoFrames}))}")
    (out / (args.label + '-raw.json')).write_text(json.dumps(raw))
    samples = raw['samples']
    percentile = lambda values, p: sorted(values)[min(len(values)-1, int(len(values)*p))] if values else 0
    channels = {}
    for sample in samples:
        for view in sample['views']:
            channel = channels.setdefault(view['id'], {'gaps': [], 'steps': [], 'count': 0, 'last': None})
            last = channel['last']
            if last is None or abs(view['t'] - last[1]) > .001:
                if last:
                    channel['gaps'].append(sample['at']-last[0])
                    channel['steps'].append(view['t']-last[1])
                channel['count'] += 1
                channel['last'] = (sample['at'], view['t'])
    report = {'browser': created['capabilities']['browserVersion'], 'alignment': alignment, 'source': args.source, 'wallMs': samples[-1]['at']-samples[0]['at'], 'advancedMs': samples[-1]['timeline']-samples[0]['timeline'], 'busyFrames': sum(s['busy'] for s in samples), 'statusChanges': sum(samples[i]['busy'] != samples[i-1]['busy'] for i in range(1, len(samples))), 'events': {e: sum(item['type']==e for item in raw['events']) for e in set(item['type'] for item in raw['events'])}, 'quality': raw['quality'], 'batchP95Ms': percentile([b['ms'] for b in raw['batches']], .95), 'errors': raw['errors'], 'channels': {key: {'displayed': c['count'], 'p95Gap': percentile(c['gaps'], .95), 'maxGap': max(c['gaps'], default=0), 'skipped': sum(max(0, round(step*30)-1) for step in c['steps'])} for key,c in channels.items()}}
    (out / (args.label + '.json')).write_text(json.dumps(report, indent=2))
    (out / (args.label + '.png')).write_bytes(base64.b64decode(command('/screenshot', method='GET')))
    print(json.dumps(report, indent=2), flush=True)
    if args.check:
        steady=[s for s in samples if s['at']>samples[0]['at']+1000]
        assert not any(s['busy'] for s in steady), 'Playback repeatedly buffers after startup'
        assert report['advancedMs']>=report['wallMs']*.98, 'Playback lost real time'
        assert not report['errors'], report['errors']
finally:
    if session:
        try:
            command('', method='DELETE')
        except Exception:
            pass
    driver.terminate()
    driver.wait(timeout=10)
    log.close()
