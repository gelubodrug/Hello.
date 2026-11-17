import type ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { formulaCells, formulaOf } from './engine';

/**
 * Functions Excel added after the file format was fixed. In a file they are
 * written with a prefix — `_xlfn.IFS(…)` — and one written without it opens in
 * Excel as #NAME? until someone retypes the cell, although every engine that
 * only reads the name computes it. Hello's own engine does, so a formula the
 * model wrote passed every check here and failed in the one program the file
 * was made for.
 *
 * So the prefix is the file's business, not the model's: formulas are kept
 * and shown plain (`=IFS(…)`), the prefix is added as a file is written and
 * taken off as one is read. Only names known to need it are touched — a
 * prefix on an old function is an error of its own — and only functions that
 * give one value: those that spill (SORT, FILTER, UNIQUE…) need more than a
 * prefix and are reported apart.
 */
const FUTURE = [
  'IFS', 'SWITCH', 'TEXTJOIN', 'CONCAT', 'MAXIFS', 'MINIFS', 'XLOOKUP', 'XMATCH', 'IFNA', 'XOR', 'DAYS', 'ISOWEEKNUM', 'NUMBERVALUE',
  'STDEV.S', 'STDEV.P', 'VAR.S', 'VAR.P', 'PERCENTILE.INC', 'PERCENTILE.EXC', 'QUARTILE.INC', 'QUARTILE.EXC', 'RANK.EQ', 'RANK.AVG',
  'MODE.SNGL', 'COVARIANCE.P', 'COVARIANCE.S', 'NORM.DIST', 'NORM.INV', 'NORM.S.DIST', 'NORM.S.INV', 'CEILING.MATH', 'FLOOR.MATH',
  'FORECAST.LINEAR', 'TEXTBEFORE', 'TEXTAFTER', 'ISFORMULA', 'FORMULATEXT', 'SHEET', 'SHEETS', 'UNICHAR', 'UNICODE', 'AGGREGATE',
  'PDURATION', 'RRI', 'BASE', 'DECIMAL', 'ARABIC',
];
const NAMES = FUTURE.map(name => name.replace(/\./g, '\\.')).sort((a, b) => b.length - a.length).join('|');
const UNPREFIXED = new RegExp(`(?<![A-Za-z0-9_.])(${NAMES})(?=\\s*\\()`, 'gi');
const PREFIXED = /_xlfn\.(?:_xlws\.)?(?=[A-Za-z])/g;
/** Text between quotes is the formula's data, never a function name: only what is outside it is changed. */
const outsideStrings = (formula: string, change: (code: string) => string) =>
  formula.split(/("(?:[^"]|"")*"|&quot;(?:(?!&quot;)[^])*&quot;)/).map((piece, index) => index % 2 ? piece : change(piece)).join('');

/** A formula as a file holds it for Excel. */
export const forExcel = (formula: string): string => outsideStrings(formula, code => code.replace(UNPREFIXED, '_xlfn.$1'));
/** A formula as it is typed and read. */
export const plainFormula = (formula: string): string => formula.includes('_xlfn.') ? outsideStrings(formula, code => code.replace(PREFIXED, '')) : formula;

/** Take the prefixes off a workbook just read, so reads, the pane and the model see the names as they are typed. */
export function plainFormulas(workbook: ExcelJS.Workbook): void {
  for (const { cell } of formulaCells(workbook)) {
    const model = cell.model as { formula?: unknown };
    if (typeof model.formula === 'string' && model.formula.includes('_xlfn.')) model.formula = plainFormula(model.formula);
  }
}

/** Whether a workbook has a formula a file must write with the prefix. */
export function usesFuture(workbook: ExcelJS.Workbook): boolean {
  for (const { cell } of formulaCells(workbook)) { UNPREFIXED.lastIndex = 0; if (UNPREFIXED.test(formulaOf(cell))) return true; }
  return false;
}

/** A workbook file with the prefix on every formula that needs it. Any other part is left as it is. */
export async function withFuturePrefixes(bytes: Uint8Array): Promise<Uint8Array> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); } catch { return bytes; }
  let changed = false;
  for (const name of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(name)) continue;
    const xml = await zip.files[name].async('string');
    const next = xml.replace(/(<f\b[^>]*>)([^<]+)(<\/f>)/g, (_whole, open: string, formula: string, close: string) => `${open}${forExcel(formula)}${close}`);
    if (next !== xml) { zip.file(name, next); changed = true; }
  }
  return changed ? zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }) : bytes;
}
