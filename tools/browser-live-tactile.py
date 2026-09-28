"""Inspect live tactile output without pausing during contact. Isolated Firefox profile."""
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
parser.add_argument('--source', default='/home/tianyu/Downloads/task-e7244f5d-part-01-of-01')
parser.add_argument('--task', choices=['sorting','capping','folding'], default='sorting')
parser.add_argument('--seconds', type=int, default=24)
parser.add_argument('--panels', type=int, default=7, help='Expected number of media panels')
parser.add_argument('--label', default='baseline-tar')
parser.add_argument('--software', action='store_true')
parser.add_argument('--headed', action='store_true')
parser.add_argument('--expect-capture-timing', action='store_true', help='Require recorded timestamp alignment after opening')
parser.add_argument('--profile-root', default=str(Path(__file__).resolve().parents[1] / 'artifacts' / 'firefox-profiles'))
parser.add_argument('--startup-check', action='store_true', help='Measure cold/cached startup and validate cache reuse')
parser.add_argument('--check', action='store_true', help='Require visible live contact, continued updates and smooth playback')
parser.add_argument('--driver', default=os.environ.get('GECKODRIVER', '/snap/bin/geckodriver'))
parser.add_argument('--touch-delay-ms',type=int,default=0,help='Delay only tactile frame replies to reproduce slow rendering')
parser.add_argument('--window-width',type=int,default=1366)
parser.add_argument('--window-height',type=int,default=1000)
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
host_before = {'memory':Path('/proc/meminfo').read_text(),'pressure':Path('/proc/pressure/memory').read_text()}
cold_marks=[]
cached_marks=[]

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
    command('/window/rect', {'width': args.window_width, 'height': args.window_height})
    command('/url', {'url': Path(args.viewer).as_uri()+('?software=1' if args.software else '')})
    wait("!!document.querySelector('.open-main')")
    evaluate("""
      window.__events=[];for(const event of ['seeking','seeked','waiting','playing','pause','ratechange'])document.addEventListener(event,e=>{const card=e.target.closest?.('.media-card');if(card)window.__events.push({at:performance.now(),type:event,id:card.dataset.channel,time:e.target.currentTime});},true);
      window.__errors=[];window.addEventListener('error',e=>window.__errors.push(String(e.message)));
      window.addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));
      window.__touchReplies=[];window.__paintCounts={};window.__lastPaint={};
      const draw=CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage=function(...args){const result=draw.apply(this,args);if(this.canvas.closest?.('.difference-cell')){const id=this.canvas.closest('.media-card').dataset.channel;window.__paintCounts[id]=(window.__paintCounts[id]||0)+1;window.__lastPaint[id]=performance.now();}return result;};
      let workers=0;const Base=Worker;window.Worker=class extends Base {
        constructor(...args){super(...args);this.index=workers++;this.sent=new Map();this.addEventListener('message',e=>{
          const sent=this.sent.get(e.data.id);
          if(sent?.kind==='frame'&&window.__touchDelay&&!e.replayed){e.stopImmediatePropagation();const reply=new MessageEvent('message',{data:e.data});Object.defineProperty(reply,'replayed',{value:true});setTimeout(()=>this.dispatchEvent(reply),window.__touchDelay);return;}
          if(sent?.kind==='frame')window.__touchReplies.push({worker:this.index,at:performance.now(),ms:performance.now()-sent.at});this.sent.delete(e.data.id);
        });}
        postMessage(data,...args){this.sent.set(data.id,{at:performance.now(),kind:data.kind});return super.postMessage(data,...args);}
      };
    """)
    evaluate('window.__touchDelay='+str(args.touch_delay_ms)+';window.__expectedPanels='+str(args.panels))
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
    if args.startup_check:
        wait("!!document.querySelector('.timeline')")
        evaluate("document.querySelector('.play-button').click()")
        wait("Number(document.querySelector('.timeline').value)>0",60)
        evaluate("document.querySelector('.play-button').click();const s=document.querySelector('.timeline');s.value=0;s.dispatchEvent(new Event('input',{bubbles:true}));")
    wait("document.querySelectorAll('.media-card').length===window.__expectedPanels && document.querySelectorAll('.tactile-card').length===4 && [...document.querySelectorAll('.media-card')].every(c=>c.dataset.revealed==='true'&&c.dataset.preparation==='ready'&&c.dataset.readyGeneration===c.dataset.generation) && !document.querySelector('.media-message')", 90)
    assert evaluate("return [...document.querySelectorAll('.tactile-source')].every(c=>getComputedStyle(c).display==='none')")
    cold_marks=evaluate("return performance.getEntriesByType('mark').filter(e=>e.name.startsWith('rdv:')).map(e=>({name:e.name,time:e.startTime,...e.detail}))")
    alignment=evaluate("return document.querySelector('.alignment-status').textContent")
    if args.expect_capture_timing:
        assert alignment == 'Timestamp alignment', alignment
    print('Opened', args.source, evaluate("return [...document.querySelectorAll('.media-card')].map(c=>c.dataset.mode)"), flush=True)
    evaluate("""
      window.__probes=new WeakMap();window.__sampleResponse=canvas=>{
 const width=Math.min(160,canvas.width),height=Math.max(1,Math.round(canvas.height*width/canvas.width));
 let probe=window.__probes.get(canvas);if(!probe){probe=document.createElement('canvas');probe.width=width;probe.height=height;window.__probes.set(canvas,probe);}
 const ctx=probe.getContext('2d',{willReadFrequently:true});ctx.imageSmoothingEnabled=false;ctx.drawImage(canvas,0,0,width,height);
 return ctx.getImageData(0,0,width,height).data;
};
      window.__live=[];window.__paintCounts={};window.__touchReplies=[];
      window.__liveTimer=setInterval(()=>{
        const channels=[...document.querySelectorAll('.tactile-card')].map(c=>{
          const canvas=c.querySelector('.difference-cell canvas'),pixels=window.__sampleResponse(canvas);let changed=0;
          for(let i=0;i<pixels.length;i+=4)if(Math.max(pixels[i],pixels[i+1],pixels[i+2])>60)changed++;
          return {id:c.dataset.channel,changed,paints:window.__paintCounts[c.dataset.channel]||0,age:performance.now()-(window.__lastPaint[c.dataset.channel]||0)};
        });
        window.__live.push({at:performance.now(),timeline:Number(document.querySelector('.timeline').value),busy:!!document.querySelector('.playback-bar .spin'),channels});
      },200);
      document.querySelector('.play-button').click();
    """)
    for second in range(args.seconds):
        time.sleep(1)
        if (second+1)%5==0:
            print(second+1,evaluate("return window.__live.at(-1)"),flush=True)
    raw=evaluate("clearInterval(window.__liveTimer);return {samples:window.__live,replies:window.__touchReplies,errors:window.__errors,events:window.__events}")
    (out/(args.label+'-live-raw.json')).write_text(json.dumps(raw))
    samples=raw['samples']
    contacts=[s for s in samples if (18300<=s['timeline']<=20500 if args.task=='folding' else 18300<=s['timeline']<=19100 if args.task=='capping' else 9500<=s['timeline']<=11000 or 19500<=s['timeline']<=21000)]
    report={'browser':created['capabilities']['browserVersion'],'delayMs':args.touch_delay_ms,'wallMs':samples[-1]['at']-samples[0]['at'],'advancedMs':samples[-1]['timeline']-samples[0]['timeline'],'busySamples':sum(s['busy'] for s in samples),'errors':raw['errors'],'replies':len(raw['replies']),'last':samples[-1],'contact':{id:{'samples':len(contacts),'visible':sum(next(c['changed'] for c in s['channels'] if c['id']==id)>50 for s in contacts)} for id in (['r_tact_l','r_tact_r'] if args.task=='folding' else ['l_tact_r'] if args.task=='capping' else ['l_tact_l','l_tact_r'])}}
    if args.startup_check:
        (out/(args.label+'-live.png')).write_bytes(base64.b64decode(command('/screenshot',method='GET')))
        evaluate("document.querySelector('.play-button').click();document.querySelector('.episode-button.selected').click();window.__cacheAfter=performance.getEntriesByName('rdv:episode-selection').at(-1).startTime")
        wait("document.querySelectorAll('.media-card').length===window.__expectedPanels && document.querySelectorAll('.tactile-card').length===4 && [...document.querySelectorAll('.tactile-card')].every(c=>c.dataset.preparation==='ready'&&c.dataset.revealed==='true'&&c.dataset.readyGeneration===c.dataset.generation&&!c.querySelector('.media-message')&&performance.getEntriesByName('rdv:tactile-first-frame').some(e=>e.startTime>window.__cacheAfter&&e.detail.channel===c.dataset.channel))",45)
        cached_marks=evaluate("return performance.getEntriesByType('mark').filter(e=>e.name.startsWith('rdv:')&&e.startTime>=window.__cacheAfter).map(e=>({name:e.name,time:e.startTime,...e.detail}))")
        assert sum(m['name']=='rdv:calibration-cache-hit' for m in cached_marks)==4, cached_marks
        assert not any(m['name']=='rdv:calibration-start' for m in cached_marks), cached_marks
        evaluate("document.querySelector('.play-button').click()")
        wait("Number(document.querySelector('.timeline').value)>0",10)
        evaluate("document.querySelector('.play-button').click()")
        cached_marks=evaluate("return performance.getEntriesByType('mark').filter(e=>e.name.startsWith('rdv:')&&e.startTime>=window.__cacheAfter).map(e=>({name:e.name,time:e.startTime,...e.detail}))")
        def timing(marks, name, selection):
            return next(m['time'] for m in marks if m['name']==name)-selection
        cold_selection=next(m['time'] for m in cold_marks if m['name']=='rdv:episode-selection')
        cached_selection=next(m['time'] for m in cached_marks if m['name']=='rdv:episode-selection')
        report['startup']={'cold':cold_marks,'cached':cached_marks,'coldJointReadyMs':timing(cold_marks,'rdv:joint-ready',cold_selection),'cachedJointReadyMs':timing(cached_marks,'rdv:joint-ready',cached_selection)}
    report['hostBefore']=host_before
    report['hostAfter']={'memory':Path('/proc/meminfo').read_text(),'pressure':Path('/proc/pressure/memory').read_text()}
    (out/(args.label+'-live.json')).write_text(json.dumps(report,indent=2))
    if not args.startup_check:
        (out/(args.label+'-live.png')).write_bytes(base64.b64decode(command('/screenshot',method='GET')))
    print(json.dumps(report,indent=2),flush=True)
    if not args.startup_check:
        evaluate("document.querySelector('.play-button').click()")
    if args.check:
        assert contacts,'No uninterrupted contact window was observed'
        assert all(c['visible']>=c['samples']*.7 for c in report['contact'].values()), 'Tactile contact remains blank during playback'
        assert all(c['paints']>20 for c in samples[-1]['channels']), 'Live tactile images stopped updating'
        assert not any(s['busy'] for s in samples if s['at']>samples[0]['at']+1000), 'Repeated video buffering'
        assert report['advancedMs']>=report['wallMs']*.98, 'Playback lost real time'
        assert not report['errors'],report['errors']
finally:
    if session:
        try:
            command('', method='DELETE')
        except Exception:
            pass
    driver.terminate()
    driver.wait(timeout=10)
    log.close()
