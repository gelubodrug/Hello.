/**
 * Workbooks a chat works on. Main holds the workbook (ExcelJS), computes it
 * (IronCalc) and decides what is written where; the renderer only shows a
 * snapshot and reports what the person typed. Rows and columns are 1-based
 * here, as in a spreadsheet; the grid that draws them converts.
 */
export type SheetValue = string | number | boolean | null;

export interface SheetStyle {
  bold?: boolean;
  italic?: boolean;
  /** An Excel number format, such as `0.00`, `#,##0`, `0%` or `yyyy-mm-dd`. */
  format?: string;
  /** Cell background, `#RRGGBB`. */
  fill?: string;
  /** Text colour, `#RRGGBB`. */
  color?: string;
  align?: 'left' | 'center' | 'right';
}

/** One cell as it travels: its value, and its formula without the leading `=`. */
export interface SheetCell extends SheetStyle {
  v?: SheetValue;
  f?: string;
}

export interface SheetGrid {
  name: string;
  /** The last row and column that hold anything. */
  rows: number;
  columns: number;
  cells: Array<[row: number, column: number, cell: SheetCell]>;
  /** Column widths in characters, by column number, where one was set. */
  widths?: Record<number, number>;
  frozenRows?: number;
  frozenColumns?: number;
  /** Merged ranges, such as A2:E2: one cell drawn across them, holding what its top-left cell holds. */
  merges?: string[];
  /** The sheet holds more cells than a snapshot carries. */
  limited?: boolean;
}

export interface SheetWorkbookInfo {
  id: string;
  conversationId: string;
  title: string;
  /** `hello`: kept in the app's own data. `file`: a file of the chat's folder. */
  source: 'hello' | 'file';
  /** For `file`: its path relative to the chat's folder. */
  path?: string;
  /** For `file`: changes not yet written to that file. */
  dirty: boolean;
  /** Grows with every change, so a view knows when its picture is old. */
  revision: number;
  /** Parts of the original file this app does not carry: saving over it would drop them. */
  lossy?: string[];
  /** What a script put in this workbook that the pane does not draw and Hello's own writer would drop: charts. */
  scripted?: string[];
  sheets: string[];
}

export interface SheetSnapshot extends SheetWorkbookInfo {
  grids: SheetGrid[];
}

/** A chart a workbook's file holds: where it is and which cells it draws. */
export interface SheetChart { sheet: string; type: string; title?: string; anchor?: string; values: string[]; categories: string[];
  /** Its labels are read as text or as numbers. Text labels read as numbers show as 1, 2, 3 in some viewers. */
  labelsAs?: 'text' | 'numbers';
  /** The file carries the chart's values, so it draws without the workbook being recalculated first. */
  cached?: boolean }

/** What changed, never the data itself. `list` is a workbook added or closed. */
export interface SheetChange {
  conversationId: string;
  id: string;
  revision: number;
  by: 'model' | 'person';
  list?: boolean;
  /** The workbook came in from outside the pane — dropped on the chat — so the pane is brought up to show it. */
  show?: boolean;
}

/** A formula that did not evaluate to a value. */
export interface SheetFormulaError { sheet: string; cell: string; formula: string; error: string;
  /** Why, when it can be told from the formula: the one cell to fix when many show the same error. */
  cause?: string }

export interface SheetRecalc {
  /** False when the engine could not load the workbook: values are the file's own, possibly old. */
  recalculated: boolean;
  formulas: number;
  errors: SheetFormulaError[];
  /** Formulas that return a whole range (SORT, UNIQUE, FILTER…): only their first value is kept. */
  notKept?: Array<{ sheet: string; cell: string; formula: string }>;
  /** Formulas that compare a whole range cell by cell outside the functions made for it: the engine reads one row of the range, Excel all of them, so the value here may not be Excel's. */
  unsure?: Array<{ sheet: string; cell: string; formula: string }>;
  /** Formulas this engine does not compute (#N/IMPL!) that had a value: they keep it, and Excel computes them on opening. */
  notComputed?: Array<{ sheet: string; cell: string; formula: string }>;
  reason?: string;
}

export interface SheetCellEdit { cell: string; input: SheetValue }

/**
 * What the person has in front of them in the Sheets pane: which workbook,
 * which sheet, and the cells selected — an address, never the cells' contents.
 * It goes with their next message, so "check the formulas here" has a here.
 */
export interface SheetView { workbook: string; sheet: string; range?: string }

export interface SheetsTab { id: string; conversationId: string; kind: 'sheets'; title: string }
export const sheetsTabId = (conversationId: string) => `sheets-${conversationId}`;

export const MAX_SHEET_ROWS = 1_048_576;
export const MAX_SHEET_COLUMNS = 16_384;

/** 1 → A, 27 → AA. */
export function columnName(column: number): string {
  if (!Number.isInteger(column) || column < 1 || column > MAX_SHEET_COLUMNS) throw new Error('Column out of range.');
  let name = '';
  for (let rest = column; rest > 0; rest = Math.floor((rest - 1) / 26)) name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
  return name;
}

/** A → 1, AA → 27. */
export function columnNumber(name: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(name)) throw new Error(`"${name}" is not a column.`);
  let column = 0;
  for (const letter of name.toUpperCase()) column = column * 26 + (letter.charCodeAt(0) - 64);
  if (column > MAX_SHEET_COLUMNS) throw new Error(`"${name}" is past the last column (XFD).`);
  return column;
}

export const cellName = (row: number, column: number) => `${columnName(column)}${row}`;

/** `B4` or `$B$4` → row 4, column 2. */
export function parseCell(reference: string): { row: number; column: number } {
  const match = /^\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6})$/.exec(typeof reference === 'string' ? reference.trim() : '');
  if (!match) throw new Error(`"${String(reference).slice(0, 40)}" is not a cell reference such as B4.`);
  const row = Number(match[2]);
  if (row > MAX_SHEET_ROWS) throw new Error(`Row ${row} is past the last row.`);
  return { row, column: columnNumber(match[1]) };
}

export interface SheetRange { top: number; left: number; bottom: number; right: number }

/** `A1:C10`, or one cell. The corners may come in any order. */
export function parseRange(reference: string): SheetRange {
  const parts = (typeof reference === 'string' ? reference.trim() : '').split(':');
  if (parts.length < 1 || parts.length > 2) throw new Error(`"${String(reference).slice(0, 40)}" is not a range such as A1:C10.`);
  const first = parseCell(parts[0]);
  const second = parts[1] === undefined ? first : parseCell(parts[1]);
  return {
    top: Math.min(first.row, second.row), left: Math.min(first.column, second.column),
    bottom: Math.max(first.row, second.row), right: Math.max(first.column, second.column),
  };
}

export const rangeName = (range: SheetRange) => range.top === range.bottom && range.left === range.right
  ? cellName(range.top, range.left)
  : `${cellName(range.top, range.left)}:${cellName(range.bottom, range.right)}`;

/** A sheet name Excel accepts: 1–31 characters, none of `[ ] : * ? / \`, no edge apostrophe. */
export function sheetName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 31 || /[[\]:*?/\\]/.test(name) || name.startsWith("'") || name.endsWith("'"))
    throw new Error('A sheet name is 1–31 characters, without [ ] : * ? / \\ and without an apostrophe at either end.');
  return name;
}
