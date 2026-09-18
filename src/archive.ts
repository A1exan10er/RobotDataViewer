// TAR indexes point into the user's Blob. No extraction or complete archive copy.
const decoder = new TextDecoder();
export function recordingPath(value: string): string {
  const path = value.replace(/^(\.\/)+/, '').replace(/\/$/, '');
  if (!path || path.startsWith('/') || /[\\\0]/.test(path) || path.split('/').some(p => !p || p === '..' || p === '.') || /^[A-Za-z]:/.test(path)) throw new Error('invalidArchive');
  return path;
}
function field(bytes: Uint8Array): string { return decoder.decode(bytes).split('\0')[0].trim(); }
function integer(bytes: Uint8Array): number {
  let n: number;
  if (bytes[0] & 128) { n = bytes[0] & 127; for (const b of bytes.slice(1)) n = n * 256 + b; }
  else { const value = field(bytes); if (value && !/^[0-7]+$/.test(value)) throw new Error('invalidArchive'); n = parseInt(value || '0', 8); }
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalidArchive');
  return n;
}
function pax(bytes: Uint8Array): Record<string, string> {
  const result: Record<string,string> = {};
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset);
    const length = Number(decoder.decode(bytes.slice(offset, space)));
    if (space < offset || !Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > bytes.length || bytes[offset + length - 1] !== 10) throw new Error('invalidArchive');
    const record = decoder.decode(bytes.slice(space + 1, offset + length - 1));
    const equal = record.indexOf('='); if (equal < 1) throw new Error('invalidArchive');
    result[record.slice(0,equal)] = record.slice(equal+1); offset += length;
  }
  return result;
}
export async function readTar(blob: Blob, signal?: AbortSignal): Promise<Map<string, Blob>> {
  const files = new Map<string,Blob>(); let offset = 0, longName = '';
  let local: Record<string,string> = {}, global: Record<string,string> = {};
  while (offset + 512 <= blob.size) {
    signal?.throwIfAborted();
    const bytes = new Uint8Array(await blob.slice(offset, offset + 512).arrayBuffer());
    if (bytes.every(b => b === 0)) break;
    const expected = integer(bytes.slice(148,156));
    const sum = bytes.reduce((s,b,i) => s + (i >= 148 && i < 156 ? 32 : b), 0);
    if (sum !== expected) throw new Error('invalidArchive');
    const type = String.fromCharCode(bytes[156] || 48), ext = type === 'x' || type === 'g' || type === 'L' || type === 'K';
    const attrs = {...global, ...local};
    const size = !ext && attrs.size !== undefined ? Number(attrs.size) : integer(bytes.slice(124,136));
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + Math.ceil(size/512)*512 > blob.size) throw new Error('invalidArchive');
    const content = blob.slice(offset+512, offset+512+size);
    if (ext) {
      if (size > 1024*1024) throw new Error('invalidArchive');
      const body = new Uint8Array(await content.arrayBuffer());
      if (type === 'x') local = {...local,...pax(body)};
      else if (type === 'g') global = {...global,...pax(body)};
      else if (type === 'L') longName = field(body);
    } else {
      const prefix = field(bytes.slice(345,500));
      const name = attrs.path || longName || (prefix ? prefix+'/' : '') + field(bytes.slice(0,100));
      if (type === '0') {
        const path = recordingPath(name);
        if (files.has(path) || files.size >= 100000) throw new Error('invalidArchive');
        files.set(path, content.slice(0, content.size, path.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream'));
      }
      // Links and directories are never followed.
      local = {}; longName = '';
    }
    offset += 512 + Math.ceil(size/512)*512;
  }
  if (!files.size) throw new Error('invalidArchive');
  return files;
}
