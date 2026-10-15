/**
 * Small, strict CSV reader (RFC 4180 style): quoted fields, doubled quotes, CRLF or LF, an optional byte-order
 * mark. It refuses a file with an unterminated quote instead of guessing. No external dependency.
 */
export class CsvError extends Error {}

export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); if (!(row.length === 1 && row[0] === '')) rows.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue; }
    if (ch === ',') { endField(); i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { endRow(); i++; continue; }
    field += ch; i++;
  }
  if (quoted) throw new CsvError('The file has a quoted value that never closes. Check for a missing " in the data.');
  if (field !== '' || row.length) endRow();
  return rows;
}

/** First row is the header. Header names are lower-cased with spaces turned into underscores. */
export function csvToObjects(input: string): { columns: string[]; rows: Record<string, string>[] } {
  const grid = parseCsv(input);
  if (!grid.length) throw new CsvError('The file is empty.');
  const columns = grid[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const rows = grid.slice(1).map((cells) => {
    const o: Record<string, string> = {};
    columns.forEach((c, idx) => { if (c) o[c] = (cells[idx] ?? '').trim(); });
    return o;
  });
  return { columns, rows };
}
