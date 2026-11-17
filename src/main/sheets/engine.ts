import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { cellName, parseCell, parseRange, type SheetFormulaError, type SheetRecalc, type SheetValue } from '../../shared/sheets';
import { listFormula, listValue } from './listed';

// IronCalc's Node binding is a prebuilt N-API addon: one binary for Node and
// Electron alike, loaded through require because that is what it ships as.
type IronCalc = typeof import('@ironcalc/nodejs');
let binding: IronCalc | undefined;
const ironcalc = (): IronCalc => (binding ??= createRequire(import.meta.url)('@ironcalc/nodejs') as IronCalc);

/** IronCalc's CellType.ErrorValue. */
const ERROR_VALUE = 16;
const MAX_ERRORS = 200;
/** Functions whose result is a range of cells. The engine computes it; the file keeps one cell per formula. */
const SPILLS = /(?:^|[^A-Z0-9_.])(SORT|SORTBY|UNIQUE|FILTER|SEQUENCE|RANDARRAY|TEXTSPLIT|VSTACK|HSTACK|TOCOL|TOROW|WRAPROWS|WRAPCOLS|TAKE|DROP|CHOOSECOLS|CHOOSEROWS|EXPAND)\s*\(/i;

const setResult = (cell: ExcelJS.Cell, result: unknown) => { (cell.model as { result?: unknown }).result = result; };
const getResult = (cell: ExcelJS.Cell) => (cell.model as { result?: unknown }).result;

/** Every formula cell of a workbook, in sheet order. */
export function formulaCells(workbook: ExcelJS.Workbook): Array<{ sheet: ExcelJS.Worksheet; cell: ExcelJS.Cell }> {
  const found: Array<{ sheet: ExcelJS.Worksheet; cell: ExcelJS.Cell }> = [];
  workbook.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => {
    if (cell.type === ExcelJS.ValueType.Formula) found.push({ sheet, cell });
  })));
  return found;
}

/** A cell's formula as written, without `=`. A copy of a shared formula is read through its origin. */
export function formulaOf(cell: ExcelJS.Cell): string {
  try { return cell.formula ?? ''; } catch { return ''; }
}

/**
 * Compute every formula and put each result beside its formula, so the saved
 * file opens with values and anything that reads cached values sees them.
 *
 * ExcelJS writes formulas without results; IronCalc reads that file, evaluates
 * it and hands the values back. The workbook goes through a private scratch
 * file because the binding loads xlsx by path; the file is gone when this
 * returns. When the engine cannot load the workbook nothing is changed: the
 * results that were in the file stay, and the answer says they may be old.
 */
/**
 * Whether a formula compares a whole range cell by cell — `IF(A2:A90="x",…)`,
 * `SUM((A2:A90="x")*B2:B90)` — outside the functions that take that in every
 * Excel. Excel 365 computes such a formula over every row; this engine, like
 * an older Excel, reads the one row the formula stands on and gives a number
 * with no error: a SUM over IF came to 2003 here where Excel shows 3001 (a
 * probe, 16.11). It cannot be computed right here, so it is said.
 */
export function comparesRange(formula: string): boolean {
  const bare = formula.replace(/"(?:[^"]|"")*"/g, '""');
  if (/(?:^|[^A-Z0-9_.])SUMPRODUCT\s*\(/i.test(bare)) return false;
  const range = String.raw`(?:'[^']+'!|[A-Za-z_][\w.]*!)?\$?[A-Za-z]{1,3}\$?\d+:\$?[A-Za-z]{1,3}\$?\d+`;
  return new RegExp(`${range}\\s*(?:<>|>=|<=|=|<|>)|(?:<>|>=|<=|=|<|>)\\s*${range}`).test(bare.replace(/^=/, ''));
}

/** What a cell holds, as a formula reads it: a formula's computed value, text without its formatting, a date as its number. */
function valueOf(cell: ExcelJS.Cell | undefined): SheetValue {
  if (!cell) return null;
  const value = cell.type === ExcelJS.ValueType.Formula ? getResult(cell) : cell.value;
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Date) return (value.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000;
  const object = value as { error?: unknown; richText?: Array<{ text?: string }>; text?: unknown };
  if (typeof object.error === 'string') return object.error;
  if (Array.isArray(object.richText)) return object.richText.map(part => part.text ?? '').join('');
  return typeof object.text === 'string' ? object.text : null;
}

export async function recalculate(workbook: ExcelJS.Workbook, scratch: string): Promise<SheetRecalc> {
  const formulas = formulaCells(workbook);
  if (!formulas.length) return { recalculated: true, formulas: 0, errors: [] };
  // The engine complains about a formula with no cached value at all; a
  // placeholder keeps it quiet and is replaced below — or taken back.
  const placeholders = formulas.filter(({ cell }) => getResult(cell) === undefined);
  // What each formula held before: a formula this engine cannot compute keeps it rather than turning into an error.
  const held = new Map(formulas.filter(item => !placeholders.includes(item)).map(({ cell }) => [cell, getResult(cell)] as const));
  for (const { cell } of placeholders) setResult(cell, 0);
  const takeBack = () => { for (const { cell } of placeholders) setResult(cell, undefined); };
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  /** One pass of the engine over the workbook as it stands: every formula's value, by sheet and cell. */
  const pass = async () => {
    const file = join(scratch, `${randomUUID()}.xlsx`);
    try {
      await workbook.xlsx.writeFile(file);
      const model = ironcalc().Model.fromXlsx(file, 'en', 'UTC', 'en');
      model.evaluate();
      const indexes = new Map(model.getWorksheetsProperties().map((sheet, index) => [sheet.name, index]));
      return (sheet: ExcelJS.Worksheet, cell: ExcelJS.Cell): { value: unknown; error: boolean } | undefined => {
        const index = indexes.get(sheet.name);
        if (index === undefined) return undefined;
        const value = model.getCellValue(index, Number(cell.row), Number(cell.col));
        return { value, error: model.getCellType(index, Number(cell.row), Number(cell.col)) === ERROR_VALUE || (typeof value === 'string' && /^#[A-Z0-9/!?]+$/.test(value)) };
      };
    } finally { await rm(file, { force: true }).catch(() => {}); }
  };
  let read: Awaited<ReturnType<typeof pass>>;
  try { read = await pass(); }
  catch (error) {
    takeBack();
    return { recalculated: false, formulas: formulas.length, errors: [],
      reason: `The formula engine could not load this workbook (${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}). Values are the ones the file held.` };
  }
  const errors: SheetFormulaError[] = [];
  const notKept: NonNullable<SheetRecalc['notKept']> = [];
  const notComputed: NonNullable<SheetRecalc['notComputed']> = [];
  const unsure: NonNullable<SheetRecalc['unsure']> = [];
  /** A formula's value, put beside it; an error is listed, one the engine does not compute keeps what it had. */
  const settle = (sheet: ExcelJS.Worksheet, cell: ExcelJS.Cell, answer: { value: unknown; error: boolean } | undefined) => {
    if (!answer) { if (placeholders.some(item => item.cell === cell)) setResult(cell, undefined); return; }
    const row = Number(cell.row), column = Number(cell.col);
    // Not an error of the formula: this engine has no such evaluation, and Excel has. A value written beside it —
    // the file's own — stays; without one it is reported like any error.
    const before = held.get(cell);
    if (answer.value === '#N/IMPL!' && before !== undefined && before !== null && !(typeof before === 'object' && 'error' in (before as object))) {
      setResult(cell, before);
      if (notComputed.length < 50) notComputed.push({ sheet: sheet.name, cell: cellName(row, column), formula: `=${formulaOf(cell)}` });
    } else if (answer.error) {
      setResult(cell, { error: String(answer.value) });
      if (errors.length < MAX_ERRORS) errors.push({ sheet: sheet.name, cell: cellName(row, column), formula: `=${formulaOf(cell)}`, error: String(answer.value) });
    } else setResult(cell, answer.value ?? '');
  };
  const unimplemented: typeof formulas = [];
  for (const item of formulas) {
    const formula = formulaOf(item.cell);
    // The list of a group is one value, whatever it is built from; what it is computed by is below.
    const list = /TEXTJOIN/i.test(formula) && listFormula(formula) !== null;
    if (!list && notKept.length < 50 && SPILLS.test(formula)) notKept.push({ sheet: item.sheet.name, cell: item.cell.address, formula: `=${formula}` });
    if (!list && unsure.length < 50 && comparesRange(formula)) unsure.push({ sheet: item.sheet.name, cell: item.cell.address, formula: `=${formula}` });
    const answer = read(item.sheet, item.cell);
    if (answer?.value === '#N/IMPL!') unimplemented.push(item); else settle(item.sheet, item.cell, answer);
  }
  // The list of a group's values — TEXTJOIN over IF or FILTER — is computed here, from the values the engine just
  // gave everything else (sheets/listed.ts). Then the formulas that failed only because they read such a list
  // (a LEN of it, a check against a count) are computed by the engine again, with the lists standing as plain text.
  const lists = unimplemented.flatMap(item => { const parsed = listFormula(formulaOf(item.cell)); return parsed ? [{ ...item, parsed }] : []; });
  const others = unimplemented.filter(item => !lists.some(list => list.cell === item.cell));
  for (const { sheet, cell, parsed } of lists) {
    const text = listValue(parsed, (name, row, column) => {
      const from = name === undefined ? sheet : workbook.worksheets.find(item => item.name.toLowerCase() === name.toLowerCase());
      return valueOf(from?.findCell(row, column));
    });
    settle(sheet, cell, { value: text, error: /^#[A-Z0-9/!?]+$/.test(text) });
  }
  if (lists.length && others.length) {
    const formulasOf = lists.map(({ cell }) => [cell, cell.value, getResult(cell)] as const);
    let again: Awaited<ReturnType<typeof pass>> | undefined;
    try {
      for (const [cell, , result] of formulasOf) cell.value = (typeof result === 'string' ? result : '') as ExcelJS.CellValue;
      again = await pass();
    } catch { /* the first pass stands */ }
    finally { for (const [cell, value, result] of formulasOf) { cell.value = value; setResult(cell, result); } }
    for (const item of others) settle(item.sheet, item.cell, again ? again(item.sheet, item.cell) : read(item.sheet, item.cell));
  } else for (const item of others) settle(item.sheet, item.cell, read(item.sheet, item.cell));
  // Many cells show #CIRC! when one refers to itself and the rest only depend on it: name that one, first.
  for (const error of errors) if (/CIRC/i.test(error.error) && refersToItself(error.formula, error.cell)) error.cause = 'refers to itself';
  errors.sort((a, b) => Number(Boolean(b.cause)) - Number(Boolean(a.cause)));
  return { recalculated: true, formulas: formulas.length, errors, ...(notKept.length ? { notKept } : {}), ...(notComputed.length ? { notComputed } : {}), ...(unsure.length ? { unsure } : {}) };
}

/** Whether a formula names its own cell, alone or inside a range, on its own sheet. */
export function refersToItself(formula: string, cell: string): boolean {
  let own: { row: number; column: number };
  try { own = parseCell(cell); } catch { return false; }
  const bare = formula.replace(/"(?:[^"]|"")*"/g, '""');
  for (const match of bare.matchAll(/(^|[^A-Za-z0-9_.'!$])(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)(?![A-Za-z0-9_(!])/g)) {
    try {
      const range = parseRange(match[2].replace(/\$/g, ''));
      if (own.row >= range.top && own.row <= range.bottom && own.column >= range.left && own.column <= range.right) return true;
    } catch { /* Not a reference after all. */ }
  }
  return false;
}
