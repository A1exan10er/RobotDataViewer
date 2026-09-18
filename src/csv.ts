export type Csv = { columns: string[]; rows: Record<string,string>[] };
export function parseCsv(text: string): Csv {
  text = text.replace(/^\uFEFF/, '');
  const records: string[][] = []; let row: string[] = [], value = '', quoted = false;
  for (let i=0;i<text.length;i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i+1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
      row.push(value); value = '';
      if (c !== ',') { if (row.some(v=>v.trim())) records.push(row); row=[]; if(c==='\r' && text[i+1]==='\n')i++; }
    } else value += c;
  }
  if (quoted) throw new Error('invalidRecording');
  if (value || row.length) { row.push(value); records.push(row); }
  const columns = (records.shift() || []).map(c=>c.trim());
  return { columns, rows: records.map(r=>Object.fromEntries(columns.map((c,i)=>[c,r[i] ?? '']))) };
}
export function finite(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
}
