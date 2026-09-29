import { readFile, writeFile } from 'node:fs/promises';
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const script = (await readFile(new URL('../dist/viewer.js', import.meta.url), 'utf8')).replace(/<\/script/gi, '<\\/script');
const css = await readFile(new URL('../dist/viewer.css', import.meta.url), 'utf8');
const notices = await readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
await writeFile(new URL('../dist/viewer.html', import.meta.url), `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="application-version" content="${version}">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' blob: 'unsafe-inline' 'wasm-unsafe-eval'; worker-src blob:; style-src 'unsafe-inline'; img-src blob: data:; media-src blob:; connect-src blob:; font-src data:; base-uri 'none'; form-action 'none'">
<title>Robot Data Viewer ${version}</title><style>${css}</style></head><body><div id="app"></div><script type="text/plain" id="third-party-notices">${notices.replace(/<\/script/gi, '<\\/script')}</script><script>${script}</script></body></html>`);
console.log('Built self-contained dist/viewer.html');
