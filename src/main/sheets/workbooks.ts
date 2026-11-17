import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, sep } from 'node:path';
import { atomicWriteFileSync } from '../atomic-write';
import {
  cellName, columnName, columnNumber, parseRange, rangeName, sheetName, MAX_SHEET_COLUMNS, MAX_SHEET_ROWS,
  type SheetCell, type SheetChange, type SheetChart, type SheetView, type SheetGrid, type SheetRange, type SheetRecalc, type SheetSnapshot,
  type SheetStyle, type SheetValue, type SheetWorkbookInfo,
} from '../../shared/sheets';
import { formulaOf, recalculate } from './engine';
import { csvCell, parseCsv, toCsv } from './csv';
import { chartsIn } from './charts';
import { withCachedValues } from './cached';
import { withCharts } from './carried';
import { plainFormulas, usesFuture, withFuturePrefixes } from './future';

export const MAX_WORKBOOK_BYTES = 20 * 1024 * 1024;
/** Cells one write or one format call may touch. */
export const MAX_WRITE_CELLS = 20_000;
/** Cells one read hands the model. */
export const MAX_READ_CELLS = 5_000;
/** Characters of rows one read hands the model: well inside what a tool result may carry, so a read is never cut mid-row. */
export const MAX_READ_CHARS = 24_000;
/** Cells of one sheet a snapshot carries to the grid. */
const MAX_SNAPSHOT_CELLS = 100_000;
const MAX_WORKBOOKS = 40;
const KEPT_VERSIONS = 10;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
/** Parts of an xlsx this app does not carry through a save, by where they live in the package. */
const NOT_CARRIED: Array<[marker: string, name: string]> = [
  ['xl/charts/', 'charts'], ['xl/pivotTables/', 'pivot tables'], ['vbaProject.bin', 'macros'],
  ['xl/slicers/', 'slicers'], ['xl/externalLinks/', 'links to other workbooks'],
];

export interface WorkbooksOptions {
  /** The app's own user-data directory. */
  dataDir: string;
  /** A file of the chat's folder: where it is, and its path inside the folder. Throws outside it. */
  resolveFile(conversationId: string, path: string, writing: boolean): Promise<{ absolute: string; relative: string }>;
  changed?(event: SheetChange): void;
}

/** One cell to change: `input` sets what it holds (a string starting with `=` is a formula), `style` how it looks. */
export interface SheetCellWrite { row: number; column: number; input?: SheetValue; style?: SheetStyle }
export interface SheetWriteResult {
  sheet: string;
  written: number;
  /** The sheet did not exist and was added. */
  created: boolean;
  recalc: SheetRecalc;
  /** What the formulas written by this call came to, by cell. */
  computed: Record<string, SheetValue>;
  info: SheetWorkbookInfo;
}
export interface SheetReadResult {
  sheet: string;
  range: string;
  /** When the range was cut by rows: the range that holds the rest. */
  next?: string;
  /** The used part of the sheet, or null when it is empty. */
  used: string | null;
  rows: SheetValue[][];
  /** Formulas in the range, by cell, with their `=`. */
  formulas: Record<string, string>;
  /** The range was cut to what one read may carry. */
  truncated: boolean;
}

interface Meta {
  id: string; title: string; source: 'hello' | 'file'; path?: string; lossy?: string[]; sheets: string[]; createdAt: number;
  /** Sheets the model added, by name: the ones it may remove again. */
  added?: string[];
  /** Of those, the grouped tables sheet_group wrote: results, never the data to group. */
  grouped?: string[];
  /**
   * The parts of this workbook's working file that Hello's own writer does not
   * write itself (charts…), possibly none: what a script put there, or the
   * charts a file came with once they were carried through a first change.
   * Charts are carried through every change; anything else makes the file the
   * script's, which Hello only reads.
   */
  scripted?: string[];
  /** The charts the file came with could not be carried into what Hello wrote: the version held is without them. */
  uncarried?: boolean;
}
interface Book { meta: Meta; workbook: ExcelJS.Workbook; revision: number; dirty: boolean }

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const argb = (colour: string) => {
  if (!/^#[0-9a-f]{6}$/i.test(colour)) throw new Error(`"${String(colour).slice(0, 20)}" is not a colour such as #1F6FEB.`);
  return `FF${colour.slice(1).toUpperCase()}`;
};
const hex = (value: string | undefined) => value && /^[0-9a-f]{8}$/i.test(value) ? `#${value.slice(2).toUpperCase()}` : undefined;
/** A date as the serial number a spreadsheet keeps (1900 system). */
const serial = (date: Date) => date.getTime() / 86_400_000 + 25_569;

/** What a cell holds, as a plain value. A date is its serial number; its format says how it reads. */
function plain(value: unknown): SheetValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : serial(value);
  if (typeof value === 'object') {
    const item = value as { error?: unknown; richText?: Array<{ text?: unknown }>; text?: unknown; result?: unknown; formula?: unknown; sharedFormula?: unknown };
    if (typeof item.error === 'string') return item.error;
    if (Array.isArray(item.richText)) return item.richText.map(part => typeof part.text === 'string' ? part.text : '').join('');
    if ('formula' in item || 'sharedFormula' in item) return plain(item.result);
    if ('text' in item) return plain(item.text);
  }
  return null;
}
/** The same, as the model reads it: a date as a date. */
function shown(cell: ExcelJS.Cell): SheetValue {
  // A merged range holds one value, in its top-left cell. ExcelJS answers with it for every cell of the range:
  // read that way a title merged across five columns is five titles — in the pane, in a read, in a count.
  if (cell.type === ExcelJS.ValueType.Merge) return null;
  const value = cell.type === ExcelJS.ValueType.Formula ? (cell.model as { result?: unknown }).result : cell.value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  return plain(value);
}
function styleOf(cell: ExcelJS.Cell): SheetStyle {
  const style: SheetStyle = {};
  if (cell.font?.bold) style.bold = true;
  if (cell.font?.italic) style.italic = true;
  const colour = hex(cell.font?.color?.argb);
  if (colour) style.color = colour;
  if (cell.numFmt && cell.numFmt !== 'General') style.format = cell.numFmt;
  const fill = cell.fill;
  if (fill && fill.type === 'pattern' && fill.pattern === 'solid') { const paint = hex(fill.fgColor?.argb); if (paint) style.fill = paint; }
  const align = cell.alignment?.horizontal;
  if (align === 'left' || align === 'center' || align === 'right') style.align = align;
  return style;
}
function cellOf(cell: ExcelJS.Cell): SheetCell | undefined {
  // The rest of a merged range is the top-left cell drawn wide, not cells of their own.
  if (cell.type === ExcelJS.ValueType.Merge) return undefined;
  const style = styleOf(cell);
  if (cell.type === ExcelJS.ValueType.Formula)
    return { f: formulaOf(cell), v: plain((cell.model as { result?: unknown }).result), ...style };
  const value = plain(cell.value);
  if (value === null && !Object.keys(style).length) return undefined;
  return { ...(value === null ? {} : { v: value }), ...style };
}
function applyStyle(cell: ExcelJS.Cell, style: SheetStyle): void {
  if (style.bold !== undefined || style.italic !== undefined || style.color !== undefined)
    cell.font = {
      ...cell.font,
      ...(style.bold !== undefined ? { bold: style.bold } : {}),
      ...(style.italic !== undefined ? { italic: style.italic } : {}),
      ...(style.color !== undefined ? { color: { argb: argb(style.color) } } : {}),
    };
  if (style.format !== undefined) {
    if (typeof style.format !== 'string' || style.format.length > 255) throw new Error('A number format is text of up to 255 characters.');
    cell.numFmt = style.format || 'General';
  }
  if (style.fill !== undefined) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(style.fill) } };
  if (style.align !== undefined) {
    if (!['left', 'center', 'right'].includes(style.align)) throw new Error('align is left, center or right.');
    cell.alignment = { ...cell.alignment, horizontal: style.align };
  }
}
/** What goes into a cell: a formula for text that starts with `=`, else the value itself. */
function cellInput(input: SheetValue): ExcelJS.CellValue {
  if (input === null || input === undefined) return null;
  if (typeof input === 'boolean') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('A cell number must be finite.');
    return input;
  }
  if (typeof input !== 'string') throw new Error('A cell holds text, a number, true/false or null.');
  if (input.length > 32_767) throw new Error('A cell holds at most 32,767 characters.');
  if (input.startsWith('=') && input.length > 1) {
    if (input.length > 8_192) throw new Error('A formula holds at most 8,192 characters.');
    return { formula: input.slice(1) };
  }
  return input;
}
/** What a cell holds now, as the text that would have been typed into it. */
function currentInput(cell: ExcelJS.Cell): SheetValue {
  return cell.type === ExcelJS.ValueType.Formula ? `=${formulaOf(cell)}` : plain(cell.value);
}
/**
  * How far a sheet goes, read ONCE.
  *
  * ExcelJS's `columnCount` is a getter that walks every row of the sheet to
  * find the widest, and `rowCount` reads back over the row array. In a loop
  * condition either one turns a single pass over the cells into a quadratic:
  * exporting this chat's 29,426 x 14 sheet to CSV took 237,553 ms, and 49 ms
  * with the counts read once (a probe, 17.11). Those four minutes were spent
  * inside the main process with nothing yielding, so the window, the IPC and
  * the Pi tool bridge all stopped with it, and the person saw the app and
  * their model server freeze together — twice, on the same call.
  *
  * So: never a count in a loop condition, or inside one. Take the extent
  * first, and loop on the numbers.
  */
function extentOf(sheet: ExcelJS.Worksheet): { rows: number; columns: number } {
  return { rows: sheet.rowCount, columns: sheet.columnCount };
}
function usedRange(sheet: ExcelJS.Worksheet): SheetRange | null {
  const { rows, columns } = extentOf(sheet);
  return rows && columns ? { top: 1, left: 1, bottom: rows, right: columns } : null;
}

/**
 * The workbooks of each chat, in the app's own data. A workbook Hello made is
 * kept there whole; a file of the chat's folder is only pointed at, with the
 * changes not yet saved to it held beside the pointer — so nothing reaches a
 * file of the person's until a save says so, and nothing is lost to a restart.
 */
export class Workbooks {
  private readonly open = new Map<string, Book>();
  private readonly pending = new Map<string, Promise<void>>();
  /** What each chat's pane shows now, as the pane last said. Memory only: a view is of the moment. */
  private readonly views = new Map<string, SheetView>();
  /** The charts in the file each loaded workbook was read from. */
  private readonly charts = new WeakMap<ExcelJS.Workbook, SheetChart[]>();
  private readonly root: string;

  constructor(private readonly options: WorkbooksOptions) {
    if (!options.dataDir || !isAbsolute(options.dataDir)) throw new Error('Workbooks require an absolute app data directory.');
    this.root = join(options.dataDir, 'sheets');
  }

  async list(conversationId: string): Promise<SheetWorkbookInfo[]> {
    const key = this.key(conversationId);
    return this.queue(key, async () => {
      const metas = await this.metas(key);
      return Promise.all(metas.map(meta => this.infoOf(conversationId, key, meta)));
    });
  }

  async create(conversationId: string, title: string, sheets: string[] = ['Sheet1']): Promise<SheetWorkbookInfo> {
    const key = this.key(conversationId);
    const names = (sheets.length ? sheets : ['Sheet1']).map(sheetName);
    if (names.length > 50) throw new Error('A new workbook starts with at most 50 sheets.');
    if (new Set(names.map(name => name.toLowerCase())).size !== names.length) throw new Error('Sheet names must differ.');
    return this.queue(key, async () => {
      await this.room(key);
      const workbook = new ExcelJS.Workbook();
      for (const name of names) workbook.addWorksheet(name);
      const book = this.adopt(key, { id: randomUUID(), title: this.title(title), source: 'hello', sheets: names, createdAt: Date.now(), added: names }, workbook);
      await this.persist(key, book);
      return this.announce(conversationId, book, 'model', true);
    });
  }

  /** Point at an .xlsx of the chat's folder. Opening the same file again gives the same workbook. */
  async openFile(conversationId: string, path: string, by: SheetChange['by'] = 'model'): Promise<SheetWorkbookInfo> {
    const key = this.key(conversationId);
    return this.queue(key, async () => {
      const target = await this.options.resolveFile(conversationId, path, false);
      const known = (await this.metas(key)).find(meta => meta.source === 'file' && meta.path === target.relative);
      if (known) return this.info(conversationId, await this.load(conversationId, key, known.id));
      await this.room(key);
      const { workbook, lossy } = await this.readWorkbook(target.absolute);
      const book = this.adopt(key, {
        id: randomUUID(), title: basename(target.relative), source: 'file', path: target.relative,
        ...(lossy.length ? { lossy } : {}), sheets: workbook.worksheets.map(sheet => sheet.name), createdAt: Date.now(),
      }, workbook);
      await this.writeMeta(key, book.meta);
      return this.announce(conversationId, book, by, true);
    });
  }

  /** Bring the pane up on a workbook that came in from outside it. */
  reveal(conversationId: string, info: SheetWorkbookInfo): void {
    this.options.changed?.({ conversationId, id: info.id, revision: Math.max(1, info.revision), by: 'person', list: true, show: true });
  }

  /** Take a copy of any .xlsx into the chat: the original is never touched again. */
  async importCopy(conversationId: string, absolute: string): Promise<SheetWorkbookInfo> {
    const key = this.key(conversationId);
    if (!isAbsolute(absolute)) throw new Error('Choose a workbook file.');
    return this.queue(key, async () => {
      await this.room(key);
      const { workbook, lossy } = await this.readWorkbook(absolute);
      const book = this.adopt(key, {
        id: randomUUID(), title: this.title(basename(absolute, extname(absolute))), source: 'hello',
        ...(lossy.length ? { lossy } : {}), sheets: workbook.worksheets.map(sheet => sheet.name), createdAt: Date.now(),
      }, workbook);
      await this.persist(key, book);
      return this.announce(conversationId, book, 'person', true);
    });
  }

  /**
   * Take out a sheet the model added. Only those: the sheets a workbook came
   * with are the person's data, and no tool call removes them.
   */
  async removeSheet(conversationId: string, id: string, sheet: string): Promise<SheetWorkbookInfo> {
    const key = this.key(conversationId);
    return this.queue(key, async () => {
      const book = await this.load(conversationId, key, id);
      this.writable(book);
      const worksheet = this.sheet(book, sheet);
      if (!(book.meta.added ?? []).includes(worksheet.name))
        throw new Error(`"${worksheet.name}" came with the workbook, so it is not removed here. Only a sheet you added can be removed${book.meta.added?.length ? `: ${book.meta.added.join(', ')}` : ''}.`);
      if (book.workbook.worksheets.length < 2) throw new Error('A workbook keeps at least one sheet.');
      book.workbook.removeWorksheet(worksheet.id);
      book.meta.added = book.meta.added!.filter(name => name !== worksheet.name);
      await recalculate(book.workbook, join(this.root, 'scratch'));
      book.revision++;
      if (book.meta.source === 'file') book.dirty = true;
      await this.persist(key, book, conversationId);
      return this.announce(conversationId, book, 'model');
    });
  }

  /**
   * A grouped table — what a person asks a pivot for — written as a new sheet:
   * each distinct combination of the `by` columns once, as values, with a
   * COUNTIFS beside it that reads the source, so the counts follow the data.
   * Main finds the distinct values; a model asked to do that reads the whole
   * table to do it, and gets it wrong.
   */
  async group(conversationId: string, id: string, options: { sheet?: string; by: string[]; into?: string; top?: number; bars?: boolean; includeBlank?: boolean;
    /** Count labels that differ only by an accent, a hyphen or a dot as one group: the person's call, never the default. */
    together?: boolean;
    /** Beside the count: another column of the data summed, averaged, its least or most, or its values listed, per group. */
    also?: Array<{ column: string; as: 'sum' | 'average' | 'min' | 'max' | 'list'; label?: string }>;
    /** Largest first (the default), or by label. */
    order?: 'count' | 'label';
    /** The table's own words, in the person's language. */
    words?: Partial<Record<'count' | 'share' | 'total' | 'other' | 'blank' | 'without' | 'ofParent', string>> }): Promise<{
    info: SheetWorkbookInfo; sheet: string; range: string; source: string; groups: number; rowsCounted: number; rowsWithoutFirstKey: number;
    columns: string[]; preview: SheetValue[][]; recalc: SheetRecalc;
    /** What the Total row came to once computed, and whether that is the number of rows counted: it is not when a label is not matched by its own formula. */
    total: SheetValue; totalMatches: boolean;
    /** Labels written several ways (case, spaces around; with `together`, accents and punctuation too) that were counted as one group. */
    merged: Array<{ label: string; spellings: string[] }>;
    /** Groups left apart whose labels differ only by an accent, a hyphen or a dot — "Bacau" and "Bacău": one place or two is the person's to say. */
    alike: Array<{ labels: string[]; rows: number[] }>; alikeCount: number;
    /** The first rows of the source with nothing in the first column, by their row number there. */
    rowsWithoutFirstKeyAt: number[];
    /** With several columns: the table of the first column alone, beside the detailed one. */
    firstLevel?: { range: string; labels: string; counts: string; columns: string[]; groups: number; preview: SheetValue[][] };
  }> {
    const key = this.key(conversationId);
    return this.queue(key, async () => {
      const book = await this.load(conversationId, key, id);
      this.writable(book);
      // No sheet named: the one sheet whose headers are these columns is the one meant.
      let chosen = options.sheet;
      if (chosen === undefined && book.workbook.worksheets.length > 1) {
        const wanted = (Array.isArray(options.by) ? options.by : []).map(name => String(name ?? '').trim().toLowerCase());
        // A grouped table it made earlier has the same headers; the data is in a sheet the workbook came with.
        const own = new Set(book.meta.grouped ?? []);
        const data = book.workbook.worksheets.filter(item => !own.has(item.name));
        const having = (data.length ? data : book.workbook.worksheets).filter(item => {
          const found = new Set<string>();
          const width = extentOf(item).columns;
          for (let column = 1; column <= width; column++) { const header = item.findCell(1, column); if (header) found.add(String(shown(header) ?? '').trim().toLowerCase()); }
          return wanted.length > 0 && wanted.every(name => found.has(name));
        });
        if (having.length !== 1)
          throw new Error(having.length
            ? `${having.map(item => item.name).join(' and ')} both have ${wanted.length === 1 ? 'that header' : 'those headers'}. Name the sheet that holds the data with sheet.`
            : `Name the sheet that holds the data with sheet: ${book.workbook.worksheets.map(item => item.name).join(', ')}. None of them has ${wanted.length === 1 ? 'a header' : 'headers'} named ${options.by.join(', ')} in row 1.`);
        chosen = having[0].name;
      }
      const source = this.sheet(book, chosen);
      const named = options.into === undefined ? undefined : sheetName(options.into);
      if (named && this.find(book, named)) throw new Error(`There is already a sheet "${named}". Remove it first (sheet_write removeSheet: true, if you added it) or give another name.`);
      if (!Array.isArray(options.by) || options.by.length < 1 || options.by.length > 3) throw new Error('Group by one, two or three columns.');
      const extent = extentOf(source);
      const last = extent.rows;
      if (last < 2) throw new Error(`"${source.name}" has no data rows under its headers.`);
      const headers = new Map<string, number>();
      const repeated = new Map<string, number[]>();
      for (let column = 1; column <= extent.columns; column++) {
        const header = source.findCell(1, column);
        const text = header ? String(shown(header) ?? '').trim().toLowerCase() : '';
        if (!text) continue;
        if (headers.has(text)) repeated.set(text, [...(repeated.get(text) ?? [headers.get(text)!]), column]);
        else headers.set(text, column);
      }
      // A column is named by its header, or by its letter. A header two columns share names neither: taking the first is a guess.
      const columnOf = (name: unknown) => {
        const wanted = String(name ?? '').trim();
        const twice = repeated.get(wanted.toLowerCase());
        if (twice) throw new Error(`"${wanted.slice(0, 40)}" is the header of ${twice.length} columns of ${source.name} (${twice.map(columnName).join(', ')}). Name the one you mean by its letter.`);
        const found = headers.get(wanted.toLowerCase()) ?? (/^[A-Za-z]{1,3}$/.test(wanted) ? columnNumber(wanted) : undefined);
        if (!found || found > extent.columns) throw new Error(`"${wanted.slice(0, 40)}" is not a column of ${source.name}. Its headers are: ${[...headers.keys()].join(', ')}. A column letter works too.`);
        return found;
      };
      const columns = options.by.map(columnOf);
      if (new Set(columns).size !== columns.length) throw new Error('Group by different columns.');
      const titled = (column: number) => { const header = source.findCell(1, column); return (header ? shown(header) : null) ?? columnName(column); };
      const titles = columns.map(titled);
      // What else is said of each group: another column summed, averaged, its least or most, or its values listed.
      const HOW = { sum: 'Sum of', average: 'Average of', min: 'Least', max: 'Most', list: '' } as const;
      if (options.also !== undefined && (!Array.isArray(options.also) || options.also.length > 6)) throw new Error('also is a list of at most six {column, as}.');
      const extras = (options.also ?? []).map(extra => {
        if (!extra || typeof extra !== 'object' || !(extra.as in HOW)) throw new Error('Each entry of also is {column, as}, with as one of sum, average, min, max, list.');
        const column = columnOf(extra.column);
        const given = typeof extra.label === 'string' && extra.label.trim() ? extra.label.trim().slice(0, 60) : undefined;
        return { column, as: extra.as, label: given ?? (extra.as === 'list' ? `${String(titled(column))} (list)` : `${HOW[extra.as]} ${String(titled(column))}`) };
      });
      const listed = extras.map(() => new Map<string, string[]>());
      // Unnamed, the sheet is called after what it groups by.
      let into = named;
      if (!into) {
        const base = `By ${titles.join(', ')}`.replace(/[[\]:*?/\\]/g, ' ').slice(0, 28).trim() || 'Groups';
        into = base;
        for (let n = 2; this.find(book, into); n++) into = `${base} ${n}`;
      }
      // One group is what a person reads as one label: "Cluj", "CLUJ" and "Cluj " are the same town. A COUNTIFS
      // already counts without regard to case, so three groups for them counted every row three times; and it
      // does not trim, so a label shown trimmed counted none of the rows written with a space (found by a probe,
      // 16.11). Each group remembers every way it is written and its formula counts exactly those.
      type Variants = Map<string, SheetValue[]>;
      interface Group { keys: SheetValue[]; first: string; count: number; variants: Variants; spellings: Map<string, { keys: SheetValue[]; rows: number }> }
      // Closer than that is a judgement: "Bacau" and "Bacău" are one county to a person and two texts to Excel.
      // They stay two groups unless the person says otherwise (`together`), and are reported so the model can ask.
      const plain = (value: SheetValue) => typeof value === 'string'
        ? value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[-_.,;:'’`/]+/g, ' ').replace(/\s+/g, ' ').trim() : value;
      const fold = options.together ? plain : (value: SheetValue) => typeof value === 'string' ? value.trim().toLowerCase() : value;
      const lower = (value: SheetValue) => typeof value === 'string' ? value.toLowerCase() : value;
      const groups = new Map<string, Group>();
      const firsts = new Map<string, { count: number; variants: Variants; spellings: Map<string, { keys: SheetValue[]; rows: number }> }>();
      const spelled = (spellings: Map<string, { keys: SheetValue[]; rows: number }>) => [...spellings.values()].sort((a, b) => b.rows - a.rows)[0].keys;
      const note = (spellings: Map<string, { keys: SheetValue[]; rows: number }>, keys: SheetValue[]) => {
        const name = JSON.stringify(keys);
        const seen = spellings.get(name) ?? { keys, rows: 0 };
        seen.rows++;
        spellings.set(name, seen);
      };
      let without = 0;
      const withoutAt: number[] = [];
      for (let row = 2; row <= last; row++) {
        const raw = columns.map(column => { const cell = source.findCell(row, column); return cell ? shown(cell) : null; });
        const folded = raw.map(fold);
        if (folded[0] === null || folded[0] === '') { without++; if (withoutAt.length < 20) withoutAt.push(row); continue; }
        const trimmed = raw.map(value => typeof value === 'string' ? value.trim() : value);
        const name = JSON.stringify(folded), first = JSON.stringify(folded[0]);
        extras.forEach((extra, at) => {
          if (extra.as !== 'list') return;
          const cell = source.findCell(row, extra.column);
          const value = cell ? shown(cell) : null;
          if (value === null || value === '') return;
          const of = listed[at].get(name) ?? [];
          of.push(typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value));
          listed[at].set(name, of);
        });
        const group = groups.get(name) ?? { keys: trimmed, first, count: 0, variants: new Map(), spellings: new Map() };
        group.count++;
        if (!group.variants.has(JSON.stringify(raw.map(lower)))) group.variants.set(JSON.stringify(raw.map(lower)), raw);
        note(group.spellings, trimmed);
        groups.set(name, group);
        const parent = firsts.get(first) ?? { count: 0, variants: new Map(), spellings: new Map() };
        parent.count++;
        if (!parent.variants.has(JSON.stringify(lower(raw[0])))) parent.variants.set(JSON.stringify(lower(raw[0])), [raw[0]]);
        note(parent.spellings, [trimmed[0]]);
        firsts.set(first, parent);
      }
      if (!groups.size) throw new Error(`Column ${columnName(columns[0])} of ${source.name} is empty.`);
      // A group is shown the way it is most often written; its first column the way that one is.
      for (const group of groups.values()) group.keys = [spelled(firsts.get(group.first)!.spellings)[0], ...spelled(group.spellings).slice(1)];
      const merged = [...groups.values()].filter(group => group.spellings.size > 1)
        .map(group => ({ label: group.keys.map(key => String(key ?? '')).join(' / '), spellings: [...group.spellings.values()].map(item => item.keys.map(key => String(key ?? '')).join(' / ')) }));
      const lookalikes = new Map<string, Group[]>();
      if (!options.together) for (const group of groups.values()) {
        const name = JSON.stringify(group.keys.map(plain));
        lookalikes.set(name, [...(lookalikes.get(name) ?? []), group]);
      }
      const alike = [...lookalikes.values()].filter(same => same.length > 1).sort((a, b) => b.reduce((sum, group) => sum + group.count, 0) - a.reduce((sum, group) => sum + group.count, 0))
        .map(same => [...same].sort((a, b) => b.count - a.count))
        .map(same => ({ labels: same.map(group => group.keys.map(key => String(key ?? '')).join(' / ')), rows: same.map(group => group.count) }));
      // Largest first; with several columns, the largest first group first and its parts under it.
      const firstTotals = { get: (key: string) => firsts.get(key)!.count };
      let ordered = [...groups.values()].sort((a, b) =>
        (firstTotals.get(b.first) - firstTotals.get(a.first)) || String(a.keys[0]).localeCompare(String(b.keys[0])) || (b.count - a.count) || String(a.keys[1] ?? '').localeCompare(String(b.keys[1] ?? '')));
      // Text counted for what it is: "=" before it keeps a leading > or = from reading as a comparison, ~ keeps * and ? from matching anything.
      const special = (value: SheetValue) => typeof value === 'string' && (/[*?~]/.test(value) || /^[=<>]/.test(value));
      const literal = (value: SheetValue) => value === null || value === '' ? '""'
        : typeof value === 'string' ? `"=${value.replace(/~/g, '~~').replace(/([*?])/g, '~$1').replace(/"/g, '""')}"`
        : typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);
      /** Whether one cell reference per column counts the group: one way of writing it, the one shown, nothing COUNTIFS reads as a pattern. */
      const byReference = (variants: Variants, keys: SheetValue[]) => variants.size === 1 && [...variants.values()][0].every((value, at) => value === keys[at] && !special(value));
      const top = options.top === undefined ? undefined : Math.floor(options.top);
      if (top !== undefined && (!(top >= 1) || top > 5000)) throw new Error('top is a number of rows from 1 to 5000.');
      // With several columns `top` is about the first one — "the top 10 counties" — and cuts that table, below; the detail stays whole.
      const cut = columns.length === 1 && top !== undefined && ordered.length > top;
      const blankInTable = Boolean(options.includeBlank) && columns.length === 1;
      if (cut) ordered = ordered.slice(0, top);
      // By label when asked: what is kept is still the largest, only shown in the order of a list.
      if (options.order !== undefined && options.order !== 'count' && options.order !== 'label') throw new Error('order is count (largest first) or label.');
      const byLabel = options.order === 'label';
      const alphabetical = (a: SheetValue, b: SheetValue) => String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' });
      if (byLabel) ordered.sort((a, b) => a.keys.reduce<number>((result, key, at) => result || alphabetical(key, b.keys[at]), 0));
      if (ordered.length > 5000) throw new Error(`That gives ${ordered.length.toLocaleString('en')} groups, more than one sheet of groups holds. Group by fewer columns, or give top.`);
      const target = book.workbook.addWorksheet(into);
      book.meta.added = [...(book.meta.added ?? []), target.name];
      book.meta.grouped = [...(book.meta.grouped ?? []), target.name];
      const quoted = `'${source.name.replace(/'/g, "''")}'`;
      const span = (column: number) => `${quoted}!$${columnName(column)}$2:$${columnName(column)}$${last}`;
      const width = columns.length;
      const countColumn = width + 1, shareColumn = width + 2;
      // With several columns a pivot also says what part of its parent each row is: Lugoj of Timis, not only of everything.
      const parentColumn = width > 1 ? width + 3 : 0;
      const word = (name: keyof NonNullable<typeof options.words>, fallback: string) => { const given = options.words?.[name]; return typeof given === 'string' && given.trim() ? given.trim().slice(0, 60) : fallback; };
      const words = { count: word('count', 'Count'), share: word('share', '% of total'), total: word('total', 'Total'), other: word('other', 'Other'), blank: word('blank', '(blank)'),
        without: word('without', `Rows without ${titles[0]}`), ofParent: word('ofParent', `% of ${titles[0]}`) };
      /** How many rows have this first-column label, however it is written. */
      const firstCount = (first: string, reference: string) => {
        const parent = firsts.get(first)!;
        return byReference(parent.variants, [spelled(parent.spellings)[0]]) ? `COUNTIF(${span(columns[0])},${reference})`
          : [...parent.variants.values()].map(raw => `COUNTIF(${span(columns[0])},${literal(raw[0])})`).join('+');
      };
      const parentShare = (row: number, first: string) => ({ formula: `IF((${firstCount(first, `$A${row}`)})=0,0,${columnName(countColumn)}${row}/(${firstCount(first, `$A${row}`)}))` });
      const extraColumn = (parentColumn || shareColumn) + 1;
      [...titles, words.count, words.share, ...(parentColumn ? [words.ofParent] : []), ...extras.map(extra => extra.label)].forEach((title, index) => { const cell = target.getCell(1, index + 1); cell.value = title as ExcelJS.CellValue; cell.font = { bold: true }; });
      const totalRow = ordered.length + 2 + (cut ? 1 : 0) + (blankInTable ? 1 : 0);
      const share = (row: number) => ({ formula: `IF($${columnName(countColumn)}$${totalRow}=0,0,${columnName(countColumn)}${row}/$${columnName(countColumn)}$${totalRow})` });
      ordered.forEach((group, index) => {
        const row = index + 2;
        group.keys.forEach((value, at) => { target.getCell(row, at + 1).value = value as ExcelJS.CellValue; });
        // A blank in a later column is counted as a blank, not as "anything". A label written one way is counted
        // through its own cell, so the count follows an edit of the label; one written several ways, by each of them.
        const criteria = byReference(group.variants, group.keys)
          ? [columns.map((column, at) => `${span(column)},${group.keys[at] === null || group.keys[at] === '' ? '""' : `$${columnName(at + 1)}${row}`}`).join(',')]
          : [...group.variants.values()].map(raw => columns.map((column, at) => `${span(column)},${literal(raw[at])}`).join(','));
        target.getCell(row, countColumn).value = { formula: criteria.map(one => `COUNTIFS(${one})`).join('+') };
        extras.forEach((extra, at) => {
          const cell = target.getCell(row, extraColumn + at), of = span(extra.column);
          const sum = criteria.map(one => `SUMIFS(${of},${one})`).join('+');
          if (extra.as === 'list') {
            // A list is a formula too: every value of the column on the group's rows, joined. It is an array formula —
            // a comparison over a whole range — which Excel computes and Hello's engine does not, so the list as it is
            // now is written beside it and stays what Hello shows until Excel opens the file.
            const values = listed[at].get(JSON.stringify(group.keys.map(fold))) ?? [];
            const now = values.join(', ');
            if (now.length > 30_000) { cell.value = `${now.slice(0, 3000)}, … (${values.length} values)`; return; }
            const same = (value: SheetValue) => value === null || value === '' ? '""' : typeof value === 'string' ? `"${value.replace(/"/g, '""')}"` : typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);
            const rows = byReference(group.variants, group.keys)
              ? columns.map((column, key) => `(${span(column)}=${group.keys[key] === null || group.keys[key] === '' ? '""' : `$${columnName(key + 1)}${row}`})`).join('*')
              : [...group.variants.values()].map(raw => columns.map((column, key) => `(${span(column)}=${same(raw[key])})`).join('*')).join('+');
            cell.value = { formula: `TEXTJOIN(", ",TRUE,IF(${rows},${of},""))`, result: now, shareType: 'array', ref: cell.address } as ExcelJS.CellValue;
            return;
          }
          cell.value = { formula: extra.as === 'sum' ? sum
            : extra.as === 'average' ? (criteria.length === 1 ? `IFERROR(AVERAGEIFS(${of},${criteria[0]}),"")` : `IFERROR((${sum})/(${criteria.map(one => `COUNTIFS(${one},${of},"<>")`).join('+')}),"")`)
            : criteria.length === 1 ? `${extra.as === 'min' ? 'MINIFS' : 'MAXIFS'}(${of},${criteria[0]})`
            : `${extra.as === 'min' ? 'MIN' : 'MAX'}(${criteria.map(one => `${extra.as === 'min' ? 'MINIFS' : 'MAXIFS'}(${of},${one})`).join(',')})` };
          cell.numFmt = '#,##0.##';
        });
        target.getCell(row, shareColumn).value = share(row);
        target.getCell(row, shareColumn).numFmt = '0.0%';
        if (parentColumn) { target.getCell(row, parentColumn).value = parentShare(row, group.first); target.getCell(row, parentColumn).numFmt = '0.0%'; }
      });
      const counts = `${columnName(countColumn)}2:${columnName(countColumn)}${ordered.length + 1}`;
      if (cut) {
        const row = ordered.length + 2;
        target.getCell(row, 1).value = words.other;
        target.getCell(row, countColumn).value = { formula: `COUNTA(${span(columns[0])})-SUM(${counts})` };
        target.getCell(row, shareColumn).value = share(row);
        target.getCell(row, shareColumn).numFmt = '0.0%';
        extras.forEach((extra, at) => {
          if (extra.as !== 'sum') return;
          const letter = columnName(extraColumn + at);
          target.getCell(row, extraColumn + at).value = { formula: `SUMIFS(${span(extra.column)},${span(columns[0])},"<>")-SUM(${letter}2:${letter}${ordered.length + 1})` };
          target.getCell(row, extraColumn + at).numFmt = '#,##0.##';
        });
      }
      // Asked for, the rows with nothing in the column are a group like the others, and in the total.
      if (blankInTable) {
        const row = totalRow - 1;
        target.getCell(row, 1).value = words.blank;
        target.getCell(row, countColumn).value = { formula: `COUNTBLANK(${span(columns[0])})` };
        target.getCell(row, shareColumn).value = share(row);
        target.getCell(row, shareColumn).numFmt = '0.0%';
      }
      // A chart a sheet can hold with these tools: a bar per row, drawn in its cell by a formula, so it follows the counts.
      const barColumn = extraColumn + extras.length;
      if (options.bars) {
        const header = target.getCell(1, barColumn);
        header.value = 'Chart';
        header.font = { bold: true };
        const lastBar = totalRow - 1;
        const scale = `MAX($${columnName(countColumn)}$2:$${columnName(countColumn)}$${ordered.length + 1})`;
        for (let row = 2; row <= lastBar; row++) {
          const cell = target.getCell(row, barColumn);
          cell.value = { formula: `REPT("\u2588",ROUND(30*${columnName(countColumn)}${row}/${scale},0))` };
          cell.font = { color: { argb: 'FF2F6FED' } };
        }
        target.getColumn(barColumn).width = 34;
      }
      target.getCell(totalRow, 1).value = words.total;
      target.getCell(totalRow, countColumn).value = { formula: `SUM(${columnName(countColumn)}2:${columnName(countColumn)}${totalRow - 1})` };
      target.getCell(totalRow, shareColumn).value = share(totalRow);
      target.getCell(totalRow, shareColumn).numFmt = '0.0%';
      extras.forEach((extra, at) => {
        if (extra.as === 'list') return;
        const letter = columnName(extraColumn + at), above = `${letter}2:${letter}${totalRow - 1}`;
        const cell = target.getCell(totalRow, extraColumn + at);
        cell.value = { formula: extra.as === 'sum' ? `SUM(${above})` : extra.as === 'average' ? `IFERROR(AVERAGEIFS(${span(extra.column)},${span(columns[0])},"<>"),"")` : `${extra.as === 'min' ? 'MIN' : 'MAX'}(${above})` };
        cell.numFmt = '#,##0.##';
        target.getColumn(extraColumn + at).width = 16;
      });
      extras.forEach((extra, at) => { if (extra.as === 'list') target.getColumn(extraColumn + at).width = 60; });
      for (let column = 1; column < barColumn; column++) target.getCell(totalRow, column).font = { bold: true };
      if (!blankInTable) {
        target.getCell(totalRow + 1, 1).value = words.without;
        target.getCell(totalRow + 1, countColumn).value = { formula: `COUNTBLANK(${span(columns[0])})` };
      }
      // Several columns: the first one alone as well, beside the detail — the
      // two tables a person means by "per county and town", from one call, and
      // a block of contiguous cells a chart can be drawn from.
      let firstLevel: { left: number; rows: number; cut: boolean; blank: boolean; total: number } | undefined;
      if (width > 1) {
        const left = (options.bars ? barColumn : barColumn - 1) + 2;
        const label = columnName(left), count = columnName(left + 1);
        let leading = [...firsts].map(([first, parent]) => ({ first, label: spelled(parent.spellings)[0], count: parent.count }))
          .sort((a, b) => (b.count - a.count) || String(a.label).localeCompare(String(b.label)));
        const cutFirst = top !== undefined && leading.length > top;
        if (cutFirst) leading = leading.slice(0, top);
        if (byLabel) leading.sort((a, b) => alphabetical(a.label, b.label));
        const blank = Boolean(options.includeBlank);
        const total = leading.length + 2 + (cutFirst ? 1 : 0) + (blank ? 1 : 0);
        [titles[0], words.count, words.share].forEach((title, index) => { const cell = target.getCell(1, left + index); cell.value = title as ExcelJS.CellValue; cell.font = { bold: true }; });
        const part = (row: number) => { const cell = target.getCell(row, left + 2); cell.value = { formula: `IF($${count}$${total}=0,0,${count}${row}/$${count}$${total})` }; cell.numFmt = '0.0%'; };
        leading.forEach((item, index) => {
          const row = index + 2;
          target.getCell(row, left).value = item.label as ExcelJS.CellValue;
          target.getCell(row, left + 1).value = { formula: firstCount(item.first, `$${label}${row}`) };
          part(row);
        });
        let row = leading.length + 2;
        if (cutFirst) {
          target.getCell(row, left).value = words.other;
          target.getCell(row, left + 1).value = { formula: `COUNTA(${span(columns[0])})-SUM(${count}2:${count}${leading.length + 1})` };
          part(row++);
        }
        if (blank) {
          target.getCell(row, left).value = words.blank;
          target.getCell(row, left + 1).value = { formula: `COUNTBLANK(${span(columns[0])})` };
          part(row++);
        }
        target.getCell(total, left).value = words.total;
        target.getCell(total, left + 1).value = { formula: `SUM(${count}2:${count}${total - 1})` };
        part(total);
        for (let column = left; column <= left + 2; column++) target.getCell(total, column).font = { bold: true };
        target.getColumn(left).width = 24;
        target.getColumn(left + 1).width = 10;
        target.getColumn(left + 2).width = 12;
        firstLevel = { left, rows: leading.length, cut: cutFirst, blank, total };
      }
      titles.forEach((_title, index) => { target.getColumn(index + 1).width = 24; });
      target.getColumn(countColumn).width = 10;
      target.getColumn(shareColumn).width = 12;
      if (parentColumn) target.getColumn(parentColumn).width = 14;
      target.views = [{ state: 'frozen', ySplit: 1 }];
      const recalc = await recalculate(book.workbook, join(this.root, 'scratch'));
      book.revision++;
      if (book.meta.source === 'file') book.dirty = true;
      await this.persist(key, book, conversationId);
      const preview: SheetValue[][] = [];
      for (let row = 2; row <= Math.min(ordered.length + 1, 21); row++)
        preview.push([...Array.from({ length: countColumn }, (_item, index) => index + 1), ...extras.map((_extra, at) => extraColumn + at)].map(column => {
          const cell = target.findCell(row, column);
          const value = cell ? shown(cell) : null;
          return typeof value === 'string' && value.length > 160 ? `${value.slice(0, 160)}…` : value;
        }));
      return {
        info: this.announce(conversationId, book, 'model'), sheet: target.name, range: rangeName({ top: 1, left: 1, bottom: totalRow + (blankInTable ? 0 : 1), right: options.bars ? barColumn : barColumn - 1 }),
        source: source.name, groups: ordered.length, rowsCounted: last - 1 - without, rowsWithoutFirstKey: without,
        columns: [...titles.map(String), words.count, words.share, ...(parentColumn ? [words.ofParent] : []), ...extras.map(extra => extra.label), ...(options.bars ? ['Chart'] : [])], preview, recalc,
        rowsWithoutFirstKeyAt: withoutAt,
        total: shown(target.getCell(totalRow, countColumn)), merged: merged.slice(0, 20), alike: alike.slice(0, 12), alikeCount: alike.length,
        totalMatches: shown(target.getCell(totalRow, countColumn)) === last - 1 - without + (blankInTable ? without : 0),
        ...(firstLevel ? { firstLevel: (() => {
          const { left, rows, total } = firstLevel;
          const lastShown = total - 1;
          const rowsOut: SheetValue[][] = [];
          for (let row = 2; row <= Math.min(lastShown, 21); row++)
            rowsOut.push([0, 1].map(offset => { const cell = target.findCell(row, left + offset); return cell ? shown(cell) : null; }));
          return {
            range: rangeName({ top: 1, left, bottom: total, right: left + 2 }),
            // The cells a chart of this table draws: every row above the Total.
            labels: rangeName({ top: 2, left, bottom: lastShown, right: left }), counts: rangeName({ top: 2, left: left + 1, bottom: lastShown, right: left + 1 }),
            columns: [String(titles[0]), words.count, words.share], groups: rows, preview: rowsOut,
          };
        })() } : {}),
      };
    });
  }

  /**
   * A sheet's values as a CSV file in the app's data, for a script to read:
   * the way a large table reaches a program without passing through the model.
   * Formulas go as what they came to, dates as dates. The same name each time,
   * so the folder does not fill.
   */
  async exportCsv(conversationId: string, id: string, sheet?: string, named?: string): Promise<{ file: string; folder: string; sheet: string; rows: number; columns: number; headers: SheetValue[] }> {
    const key = this.key(conversationId);
    return this.queue(key, async () => {
      const book = await this.load(conversationId, key, id);
      const worksheet = this.sheet(book, sheet);
      const { rows: lastRow, columns: lastColumn } = extentOf(worksheet);
      const rows: SheetValue[][] = [];
      for (let row = 1; row <= lastRow; row++) {
        const line: SheetValue[] = [];
        for (let column = 1; column <= lastColumn; column++) { const cell = worksheet.findCell(row, column); line.push(cell ? shown(cell) : null); }
        rows.push(line);
      }
      const folder = join(this.root, key, 'exchange');
      await mkdir(folder, { recursive: true, mode: 0o700 });
      // Only the name of a name it was given: the folder is this chat's, never the caller's choice.
      const wanted = named ? basename(named.trim()).replace(/\.csv$/i, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) : '';
      const file = join(folder, `${wanted && wanted !== 'true' ? wanted : `${worksheet.name.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) || 'sheet'}-${id.slice(0, 8)}`}.csv`);
      atomicWriteFileSync(file, toCsv(rows), { mode: 0o600 });
      return { file, folder, sheet: worksheet.name, rows: lastRow, columns: lastColumn, headers: rows[0] ?? [] };
    });
  }

  /**
   * The rows of a CSV a script wrote, as cell values. Only from this chat's
   * exchange folder or from the chat's own folder: a path is the model's word,
   * and nothing else on the disk is its to read through this door.
   */
  async readExchange(conversationId: string, path: string): Promise<{ values?: SheetValue[][]; json?: unknown }> {
    const key = this.key(conversationId);
    if (typeof path !== 'string' || !path.trim() || path.includes('\0')) throw new Error('Give the path of a .csv or .json file.');
    const kind = extname(path).toLowerCase();
    if (kind !== '.csv' && kind !== '.json') throw new Error('fromFile reads a .csv or a .json file.');
    const folder = join(this.root, key, 'exchange');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    let absolute: string | undefined;
    if (isAbsolute(path)) {
      const exchange = await realpath(folder);
      const real = await realpath(path).catch(() => undefined);
      if (real && real.startsWith(exchange + sep)) absolute = real;
    }
    try { absolute ??= (await this.options.resolveFile(conversationId, path, false)).absolute; }
    catch {
      // Said with the place that works: a script's habit is /tmp, and "outside" alone sends it round again.
      throw new Error(`fromFile reads only from this chat's script folder or from the chat's folder, and ${path.slice(0, 200)} is in neither. Have the script write the file into "${folder}" and give that path.`);
    }
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error('That is not a file.');
    if (info.size > 5 * 1024 * 1024) throw new Error('The file is larger than the 5 MB one write reads.');
    const content = await readFile(absolute, 'utf8');
    if (kind === '.csv') return { values: parseCsv(content).map(row => row.map(csvCell)) };
    try { return { json: JSON.parse(content) }; } catch { throw new Error('That .json file is not valid JSON.'); }
  }

  /**
   * Let a script work on the workbook's own file — the way openpyxl makes what
   * Hello's writer cannot (a chart, a merged title, a conditional format).
   * The file is the working copy in the app's data, never the person's file;
   * a copy is taken first and put back if the script leaves something that is
   * no longer a workbook. Afterwards the workbook is read again from the file
   * and computed, so reads and the pane show what the script made.
   */
  async runScript(conversationId: string, id: string, work: (paths: { workbook: string; folder: string }) => Promise<{ exitCode: number | null; output: string }>): Promise<{
    info: SheetWorkbookInfo; exitCode: number | null; output: string; changed: boolean; restored: boolean; recalc: SheetRecalc; charts: SheetChart[];
    /** The sheets the script made, with how many numbers and how many formulas each holds: a table of numbers and no formula is a table that does not follow its data. */
    made?: Array<{ sheet: string; numbers: number; formulas: number }>;
  }> {
    const key = this.key(conversationId);
    return this.queue(key, async () => {
      const book = await this.load(conversationId, key, id);
      const working = this.working(key, id);
      const folder = join(this.root, key, 'exchange');
      await mkdir(folder, { recursive: true, mode: 0o700 });
      // A file of the folder not changed yet has no working copy: the script gets the file's own bytes, with whatever a script put in it before.
      if (!(await stat(working).then(info => info.isFile(), () => false)))
        atomicWriteFileSync(working, await this.bytes(conversationId, key, book), { mode: 0o600 });
      const before = await readFile(working);
      const backup = join(folder, `before-script-${id.slice(0, 8)}.xlsx`);
      atomicWriteFileSync(backup, before, { mode: 0o600 });
      let ran: { exitCode: number | null; output: string };
      try { ran = await work({ workbook: working, folder }); }
      catch (error) { ran = { exitCode: null, output: error instanceof Error ? error.message : String(error) }; }
      const after = await readFile(working).catch(() => undefined);
      const changed = !after || !after.equals(before);
      let restored = false;
      let recalc: SheetRecalc = { recalculated: true, formulas: 0, errors: [] };
      if (changed) {
        try {
          const { workbook, lossy } = await this.readWorkbook(working);
          this.open.delete(`${key}/${id}`);
          const fresh = this.adopt(key, { ...book.meta, scripted: lossy }, workbook);
          fresh.revision = book.revision + 1;
          fresh.dirty = book.meta.source === 'file';
          // Sheets the script removed are no longer the model's to name.
          // And the ones it made are: a sheet a chart was put on can be removed like any other the model added.
          const names = new Set(workbook.worksheets.map(sheet => sheet.name));
          const had = new Set(book.workbook.worksheets.map(sheet => sheet.name));
          fresh.meta.added = [...(fresh.meta.added ?? []).filter(name => names.has(name)), ...[...names].filter(name => !had.has(name) && !(fresh.meta.added ?? []).includes(name))];
          fresh.meta.grouped = (fresh.meta.grouped ?? []).filter(name => names.has(name));
          recalc = await recalculate(fresh.workbook, join(this.root, 'scratch'));
          // With nothing Hello cannot carry, the file is rewritten with the computed values in it.
          await this.persist(key, fresh, conversationId, true);
          // With charts in it the file stays the script's, and only gains the values its formulas came to:
          // without them it opens empty everywhere but in Excel.
          if (lossy.length && recalc.recalculated)
            atomicWriteFileSync(working, await withCachedValues(new Uint8Array(after!), fresh.workbook).then(withFuturePrefixes).catch(() => new Uint8Array(after!)), { mode: 0o600 });
          await rm(backup, { force: true });
          const made = workbook.worksheets.filter(sheet => !had.has(sheet.name)).map(sheet => {
            let numbers = 0, formulas = 0;
            sheet.eachRow(row => row.eachCell(cell => { if (cell.type === ExcelJS.ValueType.Formula) formulas++; else if (cell.type === ExcelJS.ValueType.Number) numbers++; }));
            return { sheet: sheet.name, numbers, formulas };
          });
          return { info: this.announce(conversationId, fresh, 'model'), ...ran, changed, restored, recalc, charts: this.charts.get(workbook) ?? [], ...(made.length ? { made } : {}) };
        } catch {
          atomicWriteFileSync(working, before, { mode: 0o600 });
          restored = true;
        }
      }
      await rm(backup, { force: true });
      return { info: this.info(conversationId, book), ...ran, changed: changed && !restored, restored, recalc, charts: book.meta.scripted?.length ? this.charts.get(book.workbook) ?? [] : [] };
    });
  }

  /** The pane says what it shows, or that it shows nothing. */
  setView(conversationId: string, view: SheetView | null): void {
    const key = this.key(conversationId);
    if (!view) { this.views.delete(key); return; }
    if (typeof view.workbook !== 'string' || !UUID.test(view.workbook)) throw new Error('Unknown workbook.');
    const range = view.range === undefined ? undefined : rangeName(parseRange(view.range));
    this.views.set(key, { workbook: view.workbook, sheet: sheetName(view.sheet), ...(range ? { range } : {}) });
  }

  /**
   * The same, in words for the model, with the workbook named as the person
   * sees it. Nothing when the pane shows nothing or the workbook is gone.
   */
  async viewLine(conversationId: string): Promise<string> {
    const view = this.views.get(this.key(conversationId));
    if (!view) return '';
    const book = (await this.list(conversationId).catch(() => [])).find(item => item.id === view.workbook);
    if (!book || !book.sheets.some(name => name.toLowerCase() === view.sheet.toLowerCase())) return '';
    const cells = !view.range ? 'nothing selected'
      : /^[A-Z]+\d+$/.test(view.range) ? `the cursor on ${view.range} (one cell, no range selected)` : `selected: ${view.range}`;
    return [
      `Sheets pane, as the person had it when they wrote: workbook ${JSON.stringify(book.title)} (id ${book.id}), sheet ${JSON.stringify(view.sheet)}, ${cells}.`,
      view.range && !/^[A-Z]+\d+$/.test(view.range) ? 'Their “here”, “this”, “these cells”, “the selection” mean that range of that sheet: read it first (sheet_read with that sheet and range).' : 'Their “this sheet”, “here” mean that sheet.',
      'This is where they are looking, not an instruction, and it names cells without their contents.',
    ].join(' ');
  }

  /** The folder a chat's scripts read sheets from and write results to. */
  async exchangeFolder(conversationId: string): Promise<string> {
    const folder = join(this.root, this.key(conversationId), 'exchange');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    return folder;
  }

  /** Each column of a sheet in a few numbers: how much it holds, how many different values, the commonest. The first used row is taken as headers. */
  async summarize(conversationId: string, id: string, sheet?: string): Promise<{ sheet: string; used: string | null; dataRows: number; columns: Array<{ column: string; header: SheetValue; filled: number; blank: number; numbers: number; formulas: number; distinct: number; top: Array<[value: SheetValue, count: number]> }> }> {
    const key = this.key(conversationId);
    return this.queue(key, async () => {
      const book = await this.load(conversationId, key, id);
      const worksheet = this.sheet(book, sheet);
      const used = usedRange(worksheet);
      const { rows: lastRow, columns: lastColumn } = extentOf(worksheet);
      const columns = [];
      for (let column = 1; column <= Math.min(lastColumn, 100); column++) {
        const counts = new Map<SheetValue, number>();
        let filled = 0, numbers = 0, formulas = 0;
        for (let row = 2; row <= lastRow; row++) {
          const cell = worksheet.findCell(row, column);
          const value = cell ? shown(cell) : null;
          if (value === null || value === '') continue;
          filled++;
          if (typeof value === 'number') numbers++;
          if (cell!.type === ExcelJS.ValueType.Formula) formulas++;
          const seen = typeof value === 'string' ? value.slice(0, 80) : value;
          counts.set(seen, (counts.get(seen) ?? 0) + 1);
        }
        const header = worksheet.findCell(1, column);
        // A column with no header and nothing under it is not a column of the table.
        if (!filled && (!header || shown(header) === null || shown(header) === '')) continue;
        columns.push({ column: cellName(1, column).replace(/\d+$/, ''), header: header ? shown(header) : null, filled, blank: Math.max(0, lastRow - 1 - filled), numbers, formulas,
          distinct: counts.size, top: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12) });
      }
      return { sheet: worksheet.name, used: used ? rangeName(used) : null, dataRows: Math.max(0, lastRow - 1), columns };
    });
  }

  async get(conversationId: string, id: string): Promise<SheetWorkbookInfo> {
    const key = this.key(conversationId);
    return this.queue(key, async () => this.info(conversationId, await this.load(conversationId, key, id)));
  }

  /** Each sheet and the part of it that holds anything. */
  async describe(conversationId: string, id: string): Promise<{ info: SheetWorkbookInfo; charts: SheetChart[]; sheets: Array<{ name: string; used: string | null; rows: number; columns: number }> }> {
    const key = this.key(conversationId);
    return this.queue(key, async () => {
      const book = await this.load(conversationId, key, id);
      // Only while the file still holds them: a workbook Hello has rewritten since has none.
      const charts = book.meta.scripted?.length || (book.meta.lossy?.length && !book.dirty) ? this.charts.get(book.workbook) ?? [] : [];
      return { info: this.info(conversationId, book), charts, sheets: book.workbook.worksheets.map(sheet => {
        const used = usedRange(sheet);
        const extent = extentOf(sheet);
        return { name: sheet.name, used: used ? rangeName(used) : null, rows: extent.rows, columns: extent.columns };
      }) };
    });
  }

  /**
   * Where a text occurs in a workbook: the cells whose value contains it, by
   * sheet and address, without regard to case or accents. What a person does
   * with Find, and what a model otherwise does by reading every row.
   */
  async search(conversationId: string, id: string, text: string, sheet?: string): Promise<{ matches: Array<{ sheet: string; cell: string; value: SheetValue }>; total: number }> {
    const key = this.key(conversationId);
    const fold = (value: string) => value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
    const wanted = fold(String(text ?? '').trim());
    if (!wanted) throw new Error('Give the text to find.');
    return this.queue(key, async () => {
      const book = await this.load(conversationId, key, id);
      const matches: Array<{ sheet: string; cell: string; value: SheetValue }> = [];
      let total = 0;
      for (const worksheet of sheet === undefined ? book.workbook.worksheets : [this.sheet(book, sheet)])
        worksheet.eachRow(row => row.eachCell(cell => {
          const value = shown(cell);
          if (value === null || !fold(String(value)).includes(wanted)) return;
          total++;
          if (matches.length < 50) matches.push({ sheet: worksheet.name, cell: cell.address, value: typeof value === 'string' && value.length > 200 ? `${value.slice(0, 200)}…` : value });
        }));
      return { matches, total };
    });
  }

  async read(conversationId: string, id: string, sheet?: string, range?: SheetRange): Promise<SheetReadResult> {
    const key = this.key(conversationId);
    return this.queue(key, async () => {
      const book = await this.load(conversationId, key, id);
      const worksheet = this.sheet(book, sheet);
      const used = usedRange(worksheet);
      const wanted = range ?? used ?? { top: 1, left: 1, bottom: 1, right: 1 };
      // Rows are cut first: a wide table read whole is worth more than a corner of it.
      const width = Math.min(wanted.right - wanted.left + 1, 200);
      const height = Math.min(wanted.bottom - wanted.top + 1, Math.max(1, Math.floor(MAX_READ_CELLS / width)));
      const cut: SheetRange = { top: wanted.top, left: wanted.left, bottom: wanted.top + height - 1, right: wanted.left + width - 1 };
      const rows: SheetValue[][] = [];
      const formulas: Record<string, string> = {};
      let size = 0;
      for (let row = cut.top; row <= cut.bottom; row++) {
        // Whole rows only, and no more of them than a result carries: the range returned says where it stopped.
        if (size > MAX_READ_CHARS && rows.length) { cut.bottom = row - 1; break; }
        const line: SheetValue[] = [];
        for (let column = cut.left; column <= cut.right; column++) {
          const cell = worksheet.findCell(row, column);
          line.push(cell ? shown(cell) : null);
          if (cell && cell.type === ExcelJS.ValueType.Formula) formulas[cellName(row, column)] = `=${formulaOf(cell)}`;
        }
        // Empty cells at a row's end say nothing; inside a row they keep the columns in place.
        while (line.length && line[line.length - 1] === null) line.pop();
        size += JSON.stringify(line).length;
        rows.push(line);
      }
      return { sheet: worksheet.name, range: rangeName(cut), used: used ? rangeName(used) : null, rows, formulas,
        ...(cut.bottom < wanted.bottom ? { next: rangeName({ top: cut.bottom + 1, left: cut.left, bottom: wanted.bottom, right: cut.right }) } : {}),
        truncated: cut.bottom < wanted.bottom || cut.right < wanted.right };
    });
  }

  /**
   * Change cells, compute, keep. A sheet that does not exist yet is added. A
   * person's edit that changes nothing is not a change: the grid reports what
   * it shows, and most of what it shows is what main already holds.
   */
  async write(conversationId: string, id: string, sheet: string | undefined, cells: SheetCellWrite[], by: SheetChange['by'], options: { widths?: Record<number, number> } = {}): Promise<SheetWriteResult> {
    const key = this.key(conversationId);
    if (!Array.isArray(cells) || cells.length > MAX_WRITE_CELLS) throw new Error(`One call changes at most ${MAX_WRITE_CELLS.toLocaleString('en')} cells.`);
    return this.queue(key, async () => {
      const book = await this.load(conversationId, key, id);
      this.writable(book);
      // "The first sheet" of a workbook with several is a guess, and a wrong one lands in the person's data.
      // Its own one sheet is not a guess: that is where it has been writing.
      const own = (book.meta.added ?? []).filter(name => this.find(book, name));
      if (sheet === undefined && by === 'model' && own.length === 1 && book.workbook.worksheets.length > 1) sheet = own[0];
      if (sheet === undefined && by === 'model' && book.workbook.worksheets.length > 1)
        throw new Error(`This workbook has ${book.workbook.worksheets.length} sheets (${book.workbook.worksheets.map(item => item.name).join(', ')}). Name the sheet to write to; a name that is not there yet adds a sheet.`);
      let worksheet = sheet === undefined ? this.sheet(book) : this.find(book, sheet);
      const created = !worksheet;
      if (!worksheet) {
        if (by !== 'model') throw new Error('That sheet is no longer in this workbook.');
        worksheet = book.workbook.addWorksheet(sheetName(sheet));
        book.meta.added = [...(book.meta.added ?? []), worksheet.name];
      }
      const written: ExcelJS.Cell[] = [];
      let changed = created;
      for (const write of cells) {
        if (!Number.isInteger(write.row) || !Number.isInteger(write.column) || write.row < 1 || write.column < 1 ||
            write.row > MAX_SHEET_ROWS || write.column > MAX_SHEET_COLUMNS) throw new Error('A cell is outside the sheet.');
        const cell = worksheet.getCell(write.row, write.column);
        // The grid reports the rest of a merged range as empty cells; written, that would empty the cell they are merged into.
        if (by === 'person' && cell.type === ExcelJS.ValueType.Merge) continue;
        if (write.input !== undefined) {
          const next = cellInput(write.input);
          if (by === 'person' && currentInput(cell) === (typeof next === 'object' && next ? write.input : next)) { /* what main already holds */ }
          else { cell.value = next; changed = true; written.push(cell); }
        }
        if (write.style && Object.keys(write.style).length) { applyStyle(cell, write.style); changed = true; if (!written.includes(cell) && write.input === undefined) written.push(cell); }
      }
      for (const [column, width] of Object.entries(options.widths ?? {})) {
        const number = Number(column);
        if (!Number.isInteger(number) || number < 1 || number > MAX_SHEET_COLUMNS || !(width >= 1 && width <= 255)) throw new Error('A column width is 1 to 255 characters.');
        worksheet.getColumn(number).width = width;
        changed = true;
      }
      if (!changed)
        return { sheet: worksheet.name, written: 0, created: false, recalc: { recalculated: true, formulas: 0, errors: [] }, computed: {}, info: this.info(conversationId, book) };
      const recalc = await recalculate(book.workbook, join(this.root, 'scratch'));
      book.revision++;
      if (book.meta.source === 'file') book.dirty = true;
      await this.persist(key, book, conversationId);
      const computed: Record<string, SheetValue> = {};
      for (const cell of written) {
        if (cell.type !== ExcelJS.ValueType.Formula || Object.keys(computed).length >= 100) continue;
        computed[cell.address] = recalc.recalculated ? shown(cell) : null;
      }
      return { sheet: worksheet.name, written: written.length, created, recalc, computed, info: this.announce(conversationId, book, by) };
    });
  }

  /** Write a file workbook's changes to its file. The version it replaces is kept in the app's data. */
  async save(conversationId: string, id: string, by: SheetChange['by'] = 'model'): Promise<{ info: SheetWorkbookInfo; path: string; kept?: string }> {
    const key = this.key(conversationId);
    return this.queue(key, async () => {
      const book = await this.load(conversationId, key, id);
      if (book.meta.source !== 'file' || !book.meta.path)
        throw new Error('This workbook lives in Hello and is kept as it changes. To put a copy in the chat’s folder, save it with a path.');
      // What the file came with and the workbook no longer has. A script works on the file's own bytes and keeps them.
      const lost = (book.meta.lossy ?? []).filter(part => !(book.meta.scripted ?? []).includes(part));
      if (lost.length)
        throw new Error(`${book.meta.path} holds ${lost.join(', ')}, which this app does not carry: saving over it would remove them. Save to a new path instead.`);
      const target = await this.options.resolveFile(conversationId, book.meta.path, true);
      const kept = await this.replace(conversationId, key, target.absolute, book);
      book.dirty = false;
      await rm(this.working(key, book.meta.id), { force: true });
      return { info: this.announce(conversationId, book, by), path: target.relative, ...(kept ? { kept } : {}) };
    });
  }

  /**
   * Give up what was changed since the file was opened or last saved: the
   * workbook is the file again. Only a file has something to go back to.
   */
  async revert(conversationId: string, id: string): Promise<SheetWorkbookInfo> {
    const key = this.key(conversationId);
    return this.queue(key, async () => {
      const book = await this.load(conversationId, key, id);
      if (book.meta.source !== 'file' || !book.meta.path)
        throw new Error('This workbook is kept only in Hello: there is no file to go back to. Remove the sheets you added instead (sheet_write removeSheet: true).');
      await rm(this.working(key, id), { force: true });
      this.open.delete(`${key}/${id}`);
      const { scripted: _scripted, added: _added, grouped: _grouped, uncarried: _uncarried, ...meta } = book.meta;
      await this.writeMeta(key, meta);
      const fresh = await this.load(conversationId, key, id);
      fresh.revision = book.revision + 1;
      return this.announce(conversationId, fresh, 'model');
    });
  }

  /** Write a copy to a place main already decided is allowed. */
  async exportTo(conversationId: string, id: string, absolute: string): Promise<{ bytes: number; kept?: string }> {
    const key = this.key(conversationId);
    if (!isAbsolute(absolute) || extname(absolute).toLowerCase() !== '.xlsx') throw new Error('A workbook is saved as an .xlsx file.');
    return this.queue(key, async () => {
      const book = await this.load(conversationId, key, id);
      const kept = await this.replace(conversationId, key, absolute, book);
      return { bytes: (await stat(absolute)).size, ...(kept ? { kept } : {}) };
    });
  }

  async snapshot(conversationId: string, id: string): Promise<SheetSnapshot> {
    const key = this.key(conversationId);
    return this.queue(key, async () => {
      const book = await this.load(conversationId, key, id);
      const grids: SheetGrid[] = book.workbook.worksheets.map(sheet => {
        const extent = extentOf(sheet);
        const cells: SheetGrid['cells'] = [];
        let limited = false;
        sheet.eachRow(row => {
          if (limited) return;
          row.eachCell(cell => {
            if (cells.length >= MAX_SNAPSHOT_CELLS) { limited = true; return; }
            const data = cellOf(cell);
            if (data) cells.push([Number(cell.row), Number(cell.col), data]);
          });
        });
        const widths: Record<number, number> = {};
        for (let column = 1; column <= Math.min(extent.columns, 500); column++) {
          const width = sheet.getColumn(column).width;
          if (typeof width === 'number' && width > 0) widths[column] = width;
        }
        const view = sheet.views?.[0];
        const frozen = view && view.state === 'frozen' ? view : undefined;
        const merges = ((sheet.model as { merges?: unknown }).merges as unknown[] | undefined ?? []).filter((range): range is string => typeof range === 'string').slice(0, 2000);
        return {
          name: sheet.name, rows: extent.rows, columns: extent.columns, cells,
          ...(merges.length ? { merges } : {}),
          ...(Object.keys(widths).length ? { widths } : {}),
          ...(frozen?.ySplit ? { frozenRows: frozen.ySplit } : {}), ...(frozen?.xSplit ? { frozenColumns: frozen.xSplit } : {}),
          ...(limited ? { limited } : {}),
        };
      });
      return { ...this.info(conversationId, book), grids };
    });
  }

  /** Take a workbook out of the chat. One Hello made is deleted; a file is only no longer pointed at. */
  async remove(conversationId: string, id: string): Promise<void> {
    const key = this.key(conversationId);
    if (!UUID.test(id)) throw new Error('Unknown workbook.');
    return this.queue(key, async () => {
      this.open.delete(`${key}/${id}`);
      await rm(this.working(key, id), { force: true });
      await rm(join(this.root, key, `${id}.json`), { force: true });
      this.options.changed?.({ conversationId, id, revision: 0, by: 'person', list: true });
    });
  }

  async removeConversation(conversationId: string): Promise<void> {
    const key = this.key(conversationId);
    return this.queue(key, async () => {
      for (const name of [...this.open.keys()]) if (name.startsWith(`${key}/`)) this.open.delete(name);
      await rm(join(this.root, key), { recursive: true, force: true });
    });
  }

  private key(conversationId: string): string {
    if (typeof conversationId !== 'string' || !conversationId.trim()) throw new Error('A conversation is required for workbooks.');
    return createHash('sha256').update(conversationId).digest('hex');
  }
  private title(value: unknown): string {
    const title = typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120) : '';
    return title || 'Workbook';
  }
  private working(key: string, id: string): string { return join(this.root, key, `${id}.xlsx`); }

  private queue<T>(key: string, work: () => Promise<T>): Promise<T> {
    const result = (this.pending.get(key) ?? Promise.resolve()).then(work);
    const settled = result.then(() => {}, () => {});
    this.pending.set(key, settled);
    void settled.then(() => { if (this.pending.get(key) === settled) this.pending.delete(key); });
    return result;
  }

  private async metas(key: string): Promise<Meta[]> {
    let names: string[];
    try { names = await readdir(join(this.root, key)); }
    catch (error) { if (missing(error)) return []; throw error; }
    const metas: Meta[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || !UUID.test(name.slice(0, -5))) continue;
      try {
        const meta = JSON.parse(await readFile(join(this.root, key, name), 'utf8')) as Meta;
        if (meta && meta.id === name.slice(0, -5) && (meta.source === 'hello' || (meta.source === 'file' && typeof meta.path === 'string')))
          metas.push({ ...meta, title: this.title(meta.title), sheets: Array.isArray(meta.sheets) ? meta.sheets.filter(item => typeof item === 'string') : [] });
      } catch { /* A record that cannot be read is not a workbook. */ }
    }
    return metas.sort((a, b) => a.createdAt - b.createdAt);
  }
  private async room(key: string): Promise<void> {
    if ((await this.metas(key)).length >= MAX_WORKBOOKS) throw new Error(`A chat holds at most ${MAX_WORKBOOKS} workbooks. Remove one first.`);
  }
  private async writeMeta(key: string, meta: Meta): Promise<void> {
    await mkdir(join(this.root, key), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(join(this.root, key, `${meta.id}.json`), JSON.stringify(meta), { mode: 0o600 });
  }
  private adopt(key: string, meta: Meta, workbook: ExcelJS.Workbook): Book {
    const book: Book = { meta, workbook, revision: 1, dirty: false };
    this.open.set(`${key}/${meta.id}`, book);
    return book;
  }
  /** The workbook as it stands, into the app's data: the whole of one Hello made, the unsaved state of a file. */
  private async persist(key: string, book: Book, conversationId = '', asTheScriptLeftIt = false): Promise<void> {
    book.meta.sheets = book.workbook.worksheets.map(sheet => sheet.name);
    // A script's file is the script's: only the record changes.
    if (book.meta.scripted?.length && asTheScriptLeftIt) { await this.writeMeta(key, book.meta); return; }
    let bytes = await this.written(book);
    // The charts a file came with, on the first change Hello makes to it: they are in the file itself.
    const fromFile = !book.meta.scripted?.length && !book.meta.uncarried && book.meta.source === 'file' && Boolean(book.meta.path) && Boolean(book.meta.lossy?.includes('charts'));
    if (book.meta.scripted?.length || fromFile) {
      // Hello's writer changed a workbook that holds charts: what it wrote takes them from the file that had them,
      // so a table can still be changed with the tools that make tables after a chart is in.
      const carrier = fromFile
        ? readFile((await this.options.resolveFile(conversationId, book.meta.path!, false)).absolute).then(read => new Uint8Array(read))
        : this.bytes(conversationId, key, book);
      const whole = await carrier.then(from => withCharts(bytes, from)).catch(() => null);
      if (!whole && fromFile) {
        // As before charts were carried at all: the version held is without them, and it is saved only to a new path.
        book.meta.uncarried = true;
      } else if (!whole) {
        // Nothing was kept: the workbook is read again from its file, as it was before this change.
        this.open.delete(`${key}/${book.meta.id}`);
        throw new Error(`This workbook holds ${book.meta.scripted!.join(', ')} that a script made, and they could not be carried through this change, so it was not made. Change it with sheet_script instead: openpyxl keeps what the file already holds.`);
      } else {
        bytes = whole.bytes;
        if (whole.charts) { book.meta.scripted = ['charts']; this.charts.set(book.workbook, await chartsIn(bytes)); }
        else if (fromFile) book.meta.uncarried = true;
        else { delete book.meta.scripted; this.charts.delete(book.workbook); }
      }
    }
    await this.writeMeta(key, book.meta);
    atomicWriteFileSync(this.working(key, book.meta.id), bytes, { mode: 0o600 });
  }
  /** Charts are carried through Hello's own writer; anything else a script made is not, and that is said before anything is changed. */
  private writable(book: Book): void {
    const lost = (book.meta.scripted ?? []).filter(part => part !== 'charts');
    if (lost.length)
      throw new Error(`This workbook holds ${lost.join(', ')} that a script made, and this change would remove them. Change it with sheet_script instead: openpyxl keeps what the file already holds.`);
  }
  private async readWorkbook(absolute: string): Promise<{ workbook: ExcelJS.Workbook; lossy: string[] }> {
    if (extname(absolute).toLowerCase() !== '.xlsx') throw new Error('Only .xlsx workbooks open here. Save an .xls, .xlsm, .ods or .csv file as .xlsx first.');
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error('That is not a file.');
    if (info.size > MAX_WORKBOOK_BYTES) throw new Error('The workbook is larger than the 20 MB this app opens.');
    const bytes = await readFile(absolute);
    let workbook = new ExcelJS.Workbook();
    try { await workbook.xlsx.load(bytes as unknown as ArrayBuffer); }
    catch {
      // ExcelJS stops on a sheet that carries a chart (openpyxl's, Excel's own).
      // Hello only reads cells from such a file, so it reads a copy with the
      // sheets' pointers to their drawings taken out; the file is not changed.
      try {
        const zip = await JSZip.loadAsync(bytes);
        let stripped = false;
        for (const name of Object.keys(zip.files)) {
          // The drawings and charts themselves, the sheets' pointers to them, and the relationships that name them.
          if (/^xl\/(?:drawings|charts)\//.test(name)) { zip.remove(name); stripped = true; continue; }
          const sheet = /^xl\/worksheets\/[^/]+\.xml$/.test(name), rels = /^xl\/worksheets\/_rels\/[^/]+\.rels$/.test(name);
          if (!sheet && !rels) continue;
          const xml = await zip.files[name].async('string');
          const without = sheet
            ? xml.replace(/<(?:legacyDrawing|drawing)\b[^>]*\/>/g, '')
            : xml.replace(/<Relationship\b[^>]*relationships\/(?:drawing|vmlDrawing)"[^>]*\/>/g, '');
          if (without !== xml) { zip.file(name, without); stripped = true; }
        }
        if (!stripped) throw new Error('nothing to take out');
        workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(await zip.generateAsync({ type: 'nodebuffer' }) as unknown as ArrayBuffer);
      } catch { throw new Error('This file could not be read as an .xlsx workbook. It may be damaged or protected with a password.'); }
    }
    if (!workbook.worksheets.length) throw new Error('This workbook has no sheets this app can read.');
    // Newer functions are prefixed in a file; here they are read as they are typed.
    plainFormulas(workbook);
    // Entry names sit uncompressed in a zip's directory, so a part that is there can be seen without unpacking.
    const lossy = NOT_CARRIED.filter(([marker]) => bytes.includes(marker)).map(([, name]) => name);
    if (lossy.includes('charts')) this.charts.set(workbook, await chartsIn(bytes));
    return { workbook, lossy };
  }
  private async load(conversationId: string, key: string, id: string): Promise<Book> {
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Unknown workbook. Use an id from sheet_list.');
    const held = this.open.get(`${key}/${id}`);
    if (held) return held;
    const meta = (await this.metas(key)).find(item => item.id === id);
    if (!meta) throw new Error('That workbook is not in this chat. Use an id from sheet_list.');
    const working = this.working(key, id);
    const unsaved = await stat(working).then(info => info.isFile(), () => false);
    if (meta.source === 'hello' && !unsaved) throw new Error('This workbook’s file is missing from the app’s data.');
    const from = unsaved ? working : (await this.options.resolveFile(conversationId, meta.path!, false)).absolute;
    const { workbook } = await this.readWorkbook(from);
    const book = this.adopt(key, meta, workbook);
    book.dirty = meta.source === 'file' && unsaved;
    // openpyxl writes formulas without their values; they are computed here, for reading and for the pane.
    if (meta.scripted) await recalculate(book.workbook, join(this.root, 'scratch'));
    return book;
  }
  private find(book: Book, name: string): ExcelJS.Worksheet | undefined {
    const wanted = typeof name === 'string' ? name.trim().toLowerCase() : '';
    return book.workbook.worksheets.find(sheet => sheet.name.toLowerCase() === wanted);
  }
  private sheet(book: Book, name?: string): ExcelJS.Worksheet {
    if (name === undefined) return book.workbook.worksheets[0];
    const found = this.find(book, name);
    if (!found) throw new Error(`There is no sheet "${String(name).slice(0, 40)}". The sheets are: ${book.workbook.worksheets.map(sheet => sheet.name).join(', ')}.`);
    return found;
  }
  private info(conversationId: string, book: Book): SheetWorkbookInfo {
    const { meta } = book;
    return {
      id: meta.id, conversationId, title: meta.title, source: meta.source, ...(meta.path ? { path: meta.path } : {}),
      dirty: book.dirty, revision: book.revision, ...(meta.lossy?.length ? { lossy: meta.lossy } : {}), ...(meta.scripted?.length ? { scripted: meta.scripted } : {}),
      sheets: book.workbook.worksheets.map(sheet => sheet.name),
    };
  }
  /** A workbook not loaded yet, from its record alone. */
  private async infoOf(conversationId: string, key: string, meta: Meta): Promise<SheetWorkbookInfo> {
    const held = this.open.get(`${key}/${meta.id}`);
    if (held) return this.info(conversationId, held);
    const unsaved = meta.source === 'file' && await stat(this.working(key, meta.id)).then(info => info.isFile(), () => false);
    return {
      id: meta.id, conversationId, title: meta.title, source: meta.source, ...(meta.path ? { path: meta.path } : {}),
      dirty: unsaved, revision: 0, ...(meta.lossy?.length ? { lossy: meta.lossy } : {}), ...(meta.scripted?.length ? { scripted: meta.scripted } : {}), sheets: meta.sheets,
    };
  }
  private announce(conversationId: string, book: Book, by: SheetChange['by'], list = false): SheetWorkbookInfo {
    this.options.changed?.({ conversationId, id: book.meta.id, revision: book.revision, by, ...(list ? { list } : {}) });
    return this.info(conversationId, book);
  }
  /** Put the workbook at a path; what was there is kept first, the oldest of those dropped. */
  /**
   * The workbook as a file. One a script gave charts to is handed over as the
   * script left it — the working copy, or once saved the file itself — because
   * rewriting it would drop them; any other is written from what Hello holds,
   * with the computed values in it.
   */
  private async bytes(conversationId: string, key: string, book: Book): Promise<Uint8Array> {
    if (book.meta.scripted?.length) {
      const working = await readFile(this.working(key, book.meta.id)).catch(() => undefined);
      if (working) return new Uint8Array(working);
      if (book.meta.source === 'file' && book.meta.path)
        return new Uint8Array(await readFile((await this.options.resolveFile(conversationId, book.meta.path, false)).absolute));
    }
    return this.written(book);
  }
  /** The workbook as Hello writes it: what it holds, with newer functions named as a file must name them for Excel. */
  private async written(book: Book): Promise<Uint8Array> {
    const bytes = new Uint8Array(await book.workbook.xlsx.writeBuffer());
    return usesFuture(book.workbook) ? withFuturePrefixes(bytes) : bytes;
  }
  private async replace(conversationId: string, key: string, absolute: string, book: Book): Promise<string | undefined> {
    const bytes = await this.bytes(conversationId, key, book);
    let kept: string | undefined;
    if (await stat(absolute).then(info => info.isFile(), () => false)) {
      const history = join(this.root, key, 'history');
      await mkdir(history, { recursive: true, mode: 0o700 });
      kept = join(history, `${new Date().toISOString().replace(/[:.]/g, '-')}-${basename(absolute).replace(/[^\w.-]/g, '_')}`);
      await copyFile(absolute, kept);
      const all = (await readdir(history)).sort();
      for (const old of all.slice(0, Math.max(0, all.length - KEPT_VERSIONS))) await rm(join(history, old), { force: true });
    }
    atomicWriteFileSync(absolute, bytes, { mode: 0o644 });
    return kept;
  }
}

