import type ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { formulaCells } from './engine';

/**
 * Put computed values beside the formulas of a workbook file a script wrote.
 *
 * openpyxl saves a formula with nothing next to it (`<f>SUM(B2:B4)</f><v />`).
 * Excel computes it on opening, but everything that only reads a file does
 * not: Quick Look and a mail preview show empty cells, a chart drawn from them
 * is empty, and pandas reads None. Hello has just computed the workbook, so it
 * writes each result into the file's own XML — the one change it can make to a
 * file it otherwise must not rewrite, because rewriting it whole would drop
 * the charts the script made.
 */
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescape = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function relationships(xml: string | undefined): Map<string, string> {
  const found = new Map<string, string>();
  for (const [tag] of (xml ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]*)"/.exec(tag)?.[1], target = /\bTarget="([^"]*)"/.exec(tag)?.[1];
    if (id && target) found.set(id, unescape(target));
  }
  return found;
}

export async function withCachedValues(bytes: Uint8Array, workbook: ExcelJS.Workbook): Promise<Uint8Array> {
  const results = new Map<string, Map<string, unknown>>();
  for (const { sheet, cell } of formulaCells(workbook)) {
    const value = (cell.model as { result?: unknown }).result;
    if (value === undefined || value === null) continue;
    let ofSheet = results.get(sheet.name);
    if (!ofSheet) results.set(sheet.name, ofSheet = new Map());
    ofSheet.set(cell.address, value);
  }
  if (!results.size) return bytes;
  const zip = await JSZip.loadAsync(bytes);
  const book = await zip.files['xl/workbook.xml']?.async('string');
  if (!book) return bytes;
  const parts = relationships(await zip.files['xl/_rels/workbook.xml.rels']?.async('string'));
  let changed = false;
  for (const [tag] of book.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(tag)?.[1], rel = /\br:id="([^"]*)"/.exec(tag)?.[1];
    const target = rel && parts.get(rel);
    const ofSheet = name ? results.get(unescape(name)) : undefined;
    if (!target || !ofSheet) continue;
    const part = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const xml = await zip.files[part]?.async('string');
    if (!xml) continue;
    // A formula cell with no value after it: `<v />`, `<v></v>`, or no `<v>` at all.
    const next = xml.replace(/<c\b([^>]*)>(<f\b[^>]*(?:\/>|>[^<]*<\/f>))(?:<v\s*\/>|<v><\/v>)?<\/c>/g, (whole, attributes: string, formula: string) => {
      const address = /\br="([A-Z]+\d+)"/.exec(attributes)?.[1];
      const value = address ? ofSheet.get(address) : undefined;
      if (value === undefined) return whole;
      const plain = attributes.replace(/\s+t="[^"]*"/, '');
      if (typeof value === 'number') return Number.isFinite(value) ? `<c${plain}>${formula}<v>${value}</v></c>` : whole;
      if (typeof value === 'boolean') return `<c${plain} t="b">${formula}<v>${value ? 1 : 0}</v></c>`;
      if (typeof value === 'string') return `<c${plain} t="str">${formula}<v>${escape(value)}</v></c>`;
      const error = (value as { error?: unknown }).error;
      return typeof error === 'string' ? `<c${plain} t="e">${formula}<v>${escape(error)}</v></c>` : whole;
    });
    if (next !== xml) { zip.file(part, next); changed = true; }
  }
  return changed ? zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }) : bytes;
}
