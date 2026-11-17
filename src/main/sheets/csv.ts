import type { SheetValue } from '../../shared/sheets';

/**
 * A sheet as CSV and back, for the scripts a model runs in the shell. A table
 * of thousands of rows is worked on by a program reading a file, not by a
 * model reading the rows: this is the file. RFC 4180, UTF-8, `\n` line ends.
 */
export function toCsv(rows: SheetValue[][]): string {
  const field = (value: SheetValue) => {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);
    return /[",\n\r]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map(row => row.map(field).join(',')).join('\n') + '\n';
}

/** Rows of fields as text; a quoted field keeps its commas, quotes and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, started = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char !== '"') field += char;
      else if (source[index + 1] === '"') { field += '"'; index++; }
      else quoted = false;
    } else if (char === '"' && !field) { quoted = true; started = true; }
    else if (char === ',') { row.push(field); field = ''; started = true; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index++;
      if (started || field || row.length) { row.push(field); rows.push(row); }
      row = []; field = ''; started = false;
    } else field += char;
  }
  if (quoted) throw new Error('The CSV ends inside a quoted field.');
  if (started || field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * What a CSV field means as a cell: empty is nothing, `=…` a formula, a plain
 * number a number (never one with a leading zero or a +: those are codes and
 * phone numbers), TRUE/FALSE a boolean, anything else the text.
 */
export function csvCell(field: string): SheetValue {
  if (field === '') return null;
  if (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(field)) return Number(field);
  if (field === 'TRUE') return true;
  if (field === 'FALSE') return false;
  return field;
}
