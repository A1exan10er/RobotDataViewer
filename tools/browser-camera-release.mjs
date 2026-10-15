// Actual browser media APIs against extracted packages. Uses synthetic cameras only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  url: { type: 'string' }, file: { type: 'string' }, output: { type: 'string' },
  'archive-sha256': { type: 'string' },
} });
assert(values.url && values.file && values.output, 'Supply --url, --file and --output');
const executable = process.env.ROBOT_VIEWER_CHROME || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/google/chrome/chrome');
const profile = await mkdtemp(join(tmpdir(), 'rdv-release-camera-'));
const chrome = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--use-fake-device-for-media-stream', '--disable-background-networking', '--no-first-run',
  '--disable-component-update', '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank'],
{ stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let counter = 0, buffer = '', stderr = '';
const pending = new Map(), errors = [], checks = [];
chrome.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
chrome.on('error', error => { for (const p of pending.values()) p.reject(error); });
chrome.stdio[4].on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\0')) >= 0) {
    const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!raw) continue;
    const message = JSON.parse(raw), call = pending.get(message.id);
    if (call) { clearTimeout(call.timer); pending.delete(message.id); message.error ? call.reject(new Error(JSON.stringify(message.error))) : call.resolve(message.result); }
    else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  }
});
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++counter;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr}`)); }, 20000);
  pending.set(id, { resolve, reject, timer });
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function page(url, initialize) {
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp(method, params, sessionId);
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const wait = async expression => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(100); }
    throw new Error(`Condition timed out: ${expression}; ${await evaluate('document.body.innerText')}`);
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await send('Page.enable'); await send('Runtime.enable');
  if (initialize) await send('Page.addScriptToEvaluateOnNewDocument', { source: initialize });
  await send('Page.navigate', { url });
  await wait("!!document.querySelector('.mode-switch')");
  await click('.mode-switch button:nth-child(2)');
  await wait("!!document.querySelector('.live-workspace')");
  return { evaluate, wait, click, close: () => cdp('Target.closeTarget', { targetId }) };
}
let passed = false;
let browser;
try {
  browser = (await cdp('Browser.getVersion')).product;
  await cdp('Browser.grantPermissions', { permissions: ['videoCapture'] });
  for (const url of [values.url, pathToFileURL(values.file).href]) {
    const p = await page(url);
    try {
      assert.equal(await p.evaluate('window.isSecureContext'), true);
      assert.equal(await p.evaluate("document.querySelector('.live-actions .primary').disabled"), false);
      assert.equal(await p.evaluate("!!document.querySelector('.live-startup-help')"), url.startsWith('file:'));
      await p.click('.live-actions .primary');
      await p.wait("!!document.querySelector('[data-status=streaming] video')?.videoWidth");
      await p.evaluate("window.__releaseTrack=document.querySelector('[data-status=streaming] video').srcObject.getVideoTracks()[0]; window.__releaseTime=document.querySelector('[data-status=streaming] video').currentTime");
      await p.wait("document.querySelector('[data-status=streaming] video').currentTime>window.__releaseTime+.25");
      await p.click('.live-actions button:first-child');
      assert.equal(await p.evaluate("document.querySelector('[data-status=streaming] video').srcObject.getVideoTracks()[0]===window.__releaseTrack"), true);
      await p.click('.mode-switch button:first-child');
      await p.wait("window.__releaseTrack.readyState==='ended'");
      checks.push(`${url.startsWith('file:') ? 'file' : 'localhost'}: real media APIs discover, stream, refresh and release a synthetic camera`);
    } finally { await p.close(); }
  }
  await cdp('Browser.resetPermissions');
  await cdp('Browser.grantPermissions', { origin: new URL(values.url).origin, permissions: [] });
  const denied = await page(values.url);
  try {
    await denied.click('.live-actions .primary');
    await denied.wait("document.querySelector('.live-error')?.textContent.includes('Camera access denied')");
    assert.equal(await denied.evaluate("document.querySelectorAll('[data-status=streaming]').length"), 0);
    checks.push('Denied camera permission is explained without starting capture');
  } finally { await denied.close(); }
  for (const [source, message] of [
    ["Object.defineProperty(window,'isSecureContext',{value:false})", 'not a secure camera context'],
    ["Object.defineProperty(navigator,'mediaDevices',{value:undefined})", 'does not expose camera access'],
  ]) {
    const p = await page(values.url, source);
    try {
      assert.equal(await p.evaluate("document.querySelector('.live-actions .primary').disabled"), true);
      assert.ok((await p.evaluate("document.querySelector('.live-error').textContent")).includes(message));
      assert.equal(await p.evaluate("document.querySelectorAll('.live-startup-help a').length"), 2);
      await p.click('.language-button');
      assert.ok((await p.evaluate("document.querySelector('.live-startup-help').textContent")).includes('便携'));
      assert.ok((await p.evaluate("document.querySelector('.live-error').textContent")).includes('相机'));
      checks.push(`Unsupported environment: ${message}; launcher recovery links remain available`);
    } finally { await p.close(); }
  }
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  await mkdir(dirname(values.output), { recursive: true });
  const report = { passed, browser, archiveSha256: values['archive-sha256'], checks, errors };
  await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  for (const p of pending.values()) clearTimeout(p.timer);
  const exited = new Promise(resolve => chrome.once('exit', resolve));
  if (chrome.exitCode === null) { chrome.kill(); await Promise.race([exited, delay(3000)]); }
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
