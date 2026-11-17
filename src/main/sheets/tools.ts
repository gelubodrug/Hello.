import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { cellName, columnName, columnNumber, parseCell, parseRange, rangeName, sheetName, type SheetFormulaError, type SheetRange, type SheetStyle, type SheetValue, type SheetWorkbookInfo } from '../../shared/sheets';
import type { ToolDefinition } from '../chat/tools';
import { MAX_WRITE_CELLS, type SheetCellWrite, type Workbooks } from './workbooks';
import type { SheetPython } from './python';
import { chartScript, chartsIn, repeatedCharts } from './charts';

/** What a sheet tool needs from the chat it runs in. Paths and approvals stay main's decisions. */
export interface SheetToolContext {
  books: Workbooks;
  conversationId: string;
  signal: AbortSignal;
  approve(): Promise<boolean>;
  /** Where a path of the chat's folder may be written; throws outside the folder. */
  writable(path: string): Promise<string>;
  /** A file of the folder was written. */
  saved?(absolute: string): void | Promise<void>;
  /** The Python environment scripts run in; absent where the app cannot run one. */
  python?: SheetPython;
  /** The chat's attached folder, when it has one: its .xlsx files are named in sheet_list. */
  folder?(): string | null;
}

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDefinition => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});
const string = (description: string) => ({ type: 'string', description });
const WORKBOOK = string('The workbook’s id, from sheet_new, sheet_open or sheet_list.');
const SHEET = string('Sheet name. Omit for the first sheet.');
const VALUE = { type: ['string', 'number', 'boolean', 'null'] };
const STYLE = {
  bold: { type: 'boolean' }, italic: { type: 'boolean' },
  format: string('Excel number format: 0.00, #,##0, 0%, yyyy-mm-dd, "€"#,##0.00.'),
  fill: string('Background, #RRGGBB.'), color: string('Text colour, #RRGGBB.'),
  align: { type: 'string', enum: ['left', 'center', 'right'] },
};

export const SHEET_TOOLS = ['sheet_list', 'sheet_new', 'sheet_open', 'sheet_read', 'sheet_group', 'sheet_write', 'sheet_chart', 'sheet_script', 'sheet_save'] as const;

/** The sheet tools. Without a folder there is no file to open: a workbook is made in Hello and stays there. */
export function sheetToolDefinitions(hasFolder: boolean): ToolDefinition[] {
  return [
    tool('sheet_list', 'Where to start: the workbooks of this chat (id, title, sheets, whether it is a file of the folder, unsaved changes) and the .xlsx files of the chat’s folder that are not open yet, by the path sheet_open takes. No arguments.', {}),
    tool('sheet_new',
      'Make a new, empty Excel workbook — only for a spreadsheet that starts from nothing. Work on data that is already in a workbook of this chat goes into a new sheet of that workbook (sheet_write with a new sheet name), never into another workbook: check sheet_list first. Kept in Hello as it changes and shown in the Sheets pane; no folder is needed. Returns its id.',
      { title: string('What the workbook is, in a few words.'),
        sheets: { type: 'array', items: { type: 'string' }, maxItems: 50, description: 'Sheet names, in order. Default: one sheet, Sheet1.' } },
      ['title']),
    ...(hasFolder ? [tool('sheet_open',
      'Open an .xlsx file of the chat’s folder as a workbook. The file itself is not changed until sheet_save. Returns its id, its sheets and the used range of each. Opening the same file again returns the same workbook.',
      { path: string('Path of the .xlsx inside the chat’s folder.') }, ['path'])] : []),
    tool('sheet_read',
      'Read a workbook: its sheets with their used ranges, and the values of one range — the computed value of a formula, with the formulas themselves listed by cell. Omit range for the whole used part of the sheet; a large range is cut and says so. For a large table, start with summary: true — per column, its header, how many cells are filled or blank, how many different values and the commonest ones — instead of reading every row; with no sheet named it covers every sheet at once.',
      { workbook: WORKBOOK, sheet: SHEET, range: string('A1 notation, such as A1:F40. Omit for everything used.'),
        summary: { type: 'boolean', description: 'Give each column in a few numbers instead of the rows.' },
        find: string('Instead of a range: a text to look for. Returns the cells whose value contains it — sheet, address, value — without regard to capitals or accents, in the named sheet or in every sheet.'),
        toFile: { type: ['boolean', 'string'], description: 'true — or a file name such as "magazine.csv" — writes the whole sheet as a CSV file for a script to read, and returns its full path instead of the rows. The way to work on a large table: with bash, not through your context. The file goes to a folder Hello chooses; use the path returned.' } }, ['workbook']),
    tool('sheet_group',
      'Make a grouped table — a simple pivot — as a new sheet of the workbook, in one call: every distinct value of a column (or combination of two or three columns) once, with how many rows have it, its share of the total, a total row, largest first. The counts are COUNTIFS formulas on the source sheet, so they follow the data. Rows with nothing in the first column are left out of the groups and counted apart (rowsWithoutFirstKey), unless includeBlank. With two or three columns one call gives both levels: the detailed table, and beside it in the same sheet the table of the first column alone (firstLevel in the result, with the ranges a chart of it needs) — `top` and Other apply to that one, the detail stays whole. Use this for any “how many per …”, “group by”, “pivot” or “top N” request instead of reading the rows and counting yourself. The result returns the first rows with their counts, enough to answer or to draw a chart from.',
      {
        workbook: WORKBOOK,
        sheet: string('The sheet that holds the data, headers in row 1.'),
        by: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' }, description: 'The columns to group by, outermost first: header names such as ["Judet","Oras"], or column letters.' },
        into: string('Name for the new sheet. Default: named after the columns, such as “By Judet, Oras”.'),
        top: { type: 'integer', minimum: 1, maximum: 5000, description: 'Keep only the largest N groups and put the rest in one Other row.' },
        bars: { type: 'boolean', description: 'Add a Chart column: a bar in each row, drawn in the cell by a formula and following the counts. This is the chart that can live inside the sheet: use it, with top, when the human asks for a chart or graph of the groups.' },
        includeBlank: { type: 'boolean', description: 'Count the rows with nothing in the first column as a group of their own, “(blank)”, inside the total. Default: they are left out and counted on a line apart.' },
        also: { type: 'array', maxItems: 6, description: 'Beside the count, another column of the data per group: summed, averaged, its least or most (live SUMIFS / AVERAGEIFS / MINIFS / MAXIFS), or its values listed in one cell (a TEXTJOIN array formula) — [{"column":"Vanzari","as":"sum"},{"column":"Nr. magazin","as":"list","label":"Magazine"}]. All of them are formulas on the data.',
          items: { type: 'object', additionalProperties: false, required: ['column', 'as'], properties: { column: string('Header or column letter.'), as: { type: 'string', enum: ['sum', 'average', 'min', 'max', 'list'] }, label: string('The column\u2019s header in the table.') } } },
        order: { type: 'string', enum: ['count', 'label'], description: 'count: the largest first — with two columns the largest first-column group first and its rows under it, largest first (default). label: alphabetical.' },
        together: { type: 'boolean', description: 'Count labels that differ only by an accent, a hyphen or a dot as one group (“Bacau” and “Bacău”, “Cluj-Napoca” and “Cluj Napoca”). Only when the human said they are the same: by default they stay apart and the result lists them under alike.' },
        labels: { type: 'object', additionalProperties: false, description: 'The table’s own words in the human’s language, any of them: {"count":"Număr","share":"% din total","total":"Total","other":"Altele","blank":"(necompletat)","without":"Rânduri fără județ","ofParent":"% din județ"}. Default: English.',
          properties: Object.fromEntries(['count', 'share', 'total', 'other', 'blank', 'without', 'ofParent'].map(name => [name, { type: 'string' }])) },
      }, ['workbook', 'by']),
    tool('sheet_write',
      [
        'Write into a workbook, then compute it. Give a block of rows with `values` (placed at `start`), single cells with `cells`, or both. Text that starts with = is a formula: write formulas, never the totals you worked out yourself, so the sheet recalculates when its inputs change. null clears a cell. A sheet that does not exist yet is added.',
        'The result carries what each formula you wrote came to and every formula in the workbook that ended in an error (#DIV/0!, #REF!, #NAME?…): fix those before saying the workbook is ready.',
      ].join(' '),
      {
        workbook: WORKBOOK, sheet: string('Sheet name. Required when the workbook has more than one sheet; a new name adds a sheet.'),
        start: string('Top-left cell for `values`. Default A1.'),
        values: { type: 'array', description: 'Rows of cells, top to bottom.', items: { type: 'array', items: VALUE } },
        fromFile: string('Path of a file a script wrote, instead of putting its contents in this call — never paste a large values or cells list yourself. A .csv: its rows are placed at `start` as `values` would be (a field starting with = is a formula, a plain number a number). A .json: rows [[…]], a list of cells [{"cell":"E2","value":"=C2/C$834"}], or {values, cells, format, widths}. The file must be in the chat\u2019s script folder (sheet_read toFile and sheet_list give it) or in the chat\u2019s folder, not in /tmp.'),
        cells: { type: 'array', description: 'Single cells: what they hold and how they look. A cell given only a look keeps what it holds.',
          items: { type: 'object', additionalProperties: false,
            properties: { cell: string('Such as B4.'), range: string('Instead of cell: a whole range such as A1:F1, to give it one look.'), value: VALUE, ...STYLE } } },
        format: { type: 'object', additionalProperties: false, required: ['range'],
          description: 'One look for a whole range, such as a bold header row.',
          properties: { range: string('Such as A1:F1.'), ...STYLE } },
        widths: { type: 'object', description: 'Column widths in characters, by column letter: {"A": 28, "B": 12}.', additionalProperties: { type: 'number' } },
        removeSheet: { type: 'boolean', description: 'Remove the named sheet instead of writing. Only a sheet you added can be removed; use it to start a result over or to clear up after yourself.' },
      }, ['workbook']),
    tool('sheet_chart',
      [
        'Put a real Excel chart in a workbook — no script to write. Two ways. From cells that hold the numbers: the kind, the range of labels and the range of values; the chart follows the cells, anchored beside them or on another sheet when `into` names one. Or straight from the data, “a chart of how many per …”: `by` names a column of `sheet`, and this counts it into a small table on a new sheet (as sheet_group does, live COUNTIFS), draws the chart beside it and returns the counts — one call, no ranges to give.',
        'A pie\u2019s slices are labelled with their share, in percent, with no option to set; bars, columns and lines show their axes. A chart already at the same anchor is replaced, so calling this again to change a chart never leaves two. A pie reads with up to about eight slices, so a pie of more groups than that is drawn as the largest eight and the rest as Other, by itself, from a small table it writes beside the chart; `top` asks for another cut, for any kind of chart.',
        'For anything this does not cover (several series, axes, colours, combined charts) use sheet_script. The first chart in an app installs openpyxl into Hello\u2019s own data (a download, once), after the human is asked.',
      ].join(' '),
      {
        workbook: WORKBOOK,
        sheet: string('The sheet that holds the cells to chart.'),
        into: string('The sheet the chart goes on, when it is not that one: “a chart on a sheet of its own”. Made if it is not there. Default: the sheet that holds the cells.'),
        type: { type: 'string', enum: ['bar', 'column', 'pie', 'line'], description: 'bar is horizontal bars, column vertical.' },
        categories: string('Range of the labels, one column or one row: A2:A11.'),
        values: string('Range of the numbers, the same size: B2:B11.'),
        by: string('Instead of categories and values: the column to count, by its header or letter. The table and the chart go on a new sheet, named by `into`.'),
        labels: { type: 'object', description: 'The words of the table the chart is drawn from, in the human’s language. With by, as in sheet_group: {"count":"Număr","total":"Total","share":"% din total"}. With ranges, for the table of the largest groups: {"group":"Județ","count":"Număr"} — by default it takes the headers over the cells charted.', additionalProperties: { type: 'string' } },
        title: string('Chart title.'),
        other: string('The word for the rest when the chart is cut to the largest groups, in the human’s language. Default: Other.'),
        top: { type: 'integer', minimum: 1, maximum: 500, description: 'Draw only the largest N groups and the rest as one, Other. Default: 8 for a pie of more than nine groups, everything otherwise. Give the number of groups to draw them all.' },
        anchor: string('Top-left cell of the chart. Default: beside the used cells, at row 2; A1 on a sheet of its own.'),
      }, ['workbook', 'sheet', 'type']),
    tool('sheet_script',
      [
        'Run a Python script on a workbook with openpyxl (and pandas where it is installed): the way to do what the other sheet tools cannot — merged cells, conditional formatting, frozen panes, a chart of several series, inserting or deleting rows and sheets, restructuring a table, heavy data work. Not for a table of counts, totals or lists per group, and not for a chart of two ranges: sheet_group and sheet_chart make those in one call, with formulas, and a script then only dresses what they made.',
        'The script starts with two names already set: WORKBOOK, the path of the .xlsx to load and save (wb = openpyxl.load_workbook(WORKBOOK) … wb.save(WORKBOOK)), and OUT, a folder for other files it writes. Print what you need to see; the output comes back.',
        'After it runs, Hello reads the file again, computes every formula and returns the errors, and the Sheets pane shows the result. A script that leaves a file that is not a workbook is undone.',
        'The first script in an app installs openpyxl into Hello\u2019s own data (a download, once); the human is asked before any script runs.',
      ].join(' '),
      {
        workbook: WORKBOOK,
        code: string('The Python source. Do not pass a path: write the whole script here.'),
        timeoutSeconds: { type: 'integer', minimum: 5, maximum: 600, description: 'Default 120.' },
      }, ['workbook', 'code']),
    tool('sheet_save',
      hasFolder
        ? 'Write a workbook to the chat’s folder as .xlsx. For a workbook opened from a file, omit path to save over that file (the version it replaces is kept). Give a path to save a copy — the way to hand over a workbook made with sheet_new, and the only way to save one whose file holds charts, pivot tables or macros, which Hello does not carry.'
        : 'A workbook made in Hello is kept as it changes, so there is nothing to save. Writing it to a file needs a folder attached to this chat; the human can also export it from the Sheets pane.',
      { workbook: WORKBOOK, ...(hasFolder ? { path: string('Path of the .xlsx to write inside the chat’s folder.'),
        discard: { type: 'boolean', description: 'Give up every change made since the file was opened or last saved, so the workbook is the file again. With a path: the copy is written first — “save it as a copy and leave the original alone”, in one call. Alone: nothing is saved.' } } : {}) }, ['workbook']),
  ];
}

const text = (input: Record<string, unknown>, key: string, max = 4000): string => {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Tool argument ${key} must be text, at most ${max} characters.`);
  return value;
};
const optional = (input: Record<string, unknown>, key: string, max = 4000): string | undefined =>
  input[key] === undefined || input[key] === null || input[key] === '' ? undefined : text(input, key, max);
const cellValue = (value: unknown): SheetValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new Error('A cell holds text, a number, true/false or null.');
};
function styleFrom(item: Record<string, unknown>): SheetStyle {
  const style: SheetStyle = {};
  if (typeof item.bold === 'boolean') style.bold = item.bold;
  if (typeof item.italic === 'boolean') style.italic = item.italic;
  if (typeof item.format === 'string') style.format = item.format;
  if (typeof item.fill === 'string') style.fill = item.fill;
  if (typeof item.color === 'string') style.color = item.color;
  if (item.align === 'left' || item.align === 'center' || item.align === 'right') style.align = item.align;
  return style;
}
/**
 * A workbook in a result. What its file holds besides cells is a fact, given
 * each time in a word; what that means for the work is said once, when the
 * file is opened — a note repeated in every result was half of what a model
 * read in a five-call task (its own count, 16.11).
 */
const summary = (info: SheetWorkbookInfo, opening = false) => {
  const holds = [...new Set([...(info.lossy ?? []), ...(info.scripted ?? [])])];
  const lost = (info.lossy ?? []).filter(part => part !== 'charts');
  return {
    workbook: info.id, title: info.title, sheets: info.sheets,
    ...(info.source === 'file' ? { file: info.path, unsavedChanges: info.dirty } : { keptIn: 'Hello' }),
    ...(holds.length ? { holds } : {}),
    ...(opening && holds.length ? { note: [
      holds.includes('charts') ? 'Its charts are not drawn or read here — charts lists them — and they stay in the file through every sheet tool.' : '',
      lost.length ? `Hello does not carry ${lost.join(', ')}: what is changed here is saved only to a new path, never over this file.` : '',
    ].filter(Boolean).join(' ') } : {}),
  };
};
/** Whether a file workbook has changes its file does not: a word in the result, not a sentence. */
const unsaved = (info: SheetWorkbookInfo) => info.source === 'file' ? { unsavedChanges: info.dirty } : {};

/**
 * What a file just written holds in charts, read back from the disk: the proof
 * a model otherwise goes looking for by opening the file again or unzipping it.
 */
async function heldCharts(file: string): Promise<string> {
  const charts = await readFile(file).then(bytes => chartsIn(new Uint8Array(bytes)), () => []);
  if (!charts.length) return '';
  return ` Read back from the file on disk, it holds ${charts.length} chart${charts.length === 1 ? '' : 's'}: ${charts.slice(0, 8).map(chart => `${chart.type}${chart.title ? ` “${chart.title}”` : ''} in ${chart.sheet}${chart.anchor ? ` at ${chart.anchor}` : ''}`).join('; ')}.`;
}

/**
 * The workbooks lying in a chat's folder, by the path sheet_open takes: the
 * folder itself and two levels under it, so a named file is found without a
 * search of its own.
 */
export async function folderWorkbooks(folder: string | null | undefined): Promise<string[]> {
  if (!folder) return [];
  const found: string[] = [];
  const look = async (directory: string, prefix: string, depth: number): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= 60) return;
      // Hidden files, and the lock file Excel keeps beside an open workbook.
      if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
      if (entry.isFile() && /\.xlsx$/i.test(entry.name)) found.push(prefix + entry.name);
      else if (entry.isDirectory() && depth < 2 && entry.name !== 'node_modules') await look(join(directory, entry.name), `${prefix}${entry.name}/`, depth + 1);
    }
  };
  await look(folder, '', 0);
  return found;
}

/**
 * A reference as a model writes one when it has just been reading formulas:
 * `'Grafic pe judete'!$A$5:$A$46`. The sheet it names is the sheet; the rest is
 * the cells. A tool that answered "not a cell reference" to that sent a model
 * back to a script for a chart it had asked for by name (a run, 16.11).
 */
function reference(value: unknown): { sheet?: string; cells: string } {
  const written = typeof value === 'string' ? value.trim() : '';
  const qualified = /^(?:'((?:[^']|'')+)'|([^'!]+))!(.+)$/.exec(written);
  return qualified ? { sheet: (qualified[1] ?? qualified[2]).replace(/''/g, "'"), cells: qualified[3] } : { cells: written };
}

/** Many cells in #CIRC! and one formula to blame: say which. */
function circular(errors: SheetFormulaError[]): string {
  const roots = errors.filter(error => error.cause === 'refers to itself');
  if (!roots.length) return '';
  const others = errors.filter(error => /CIRC/i.test(error.error)).length - roots.length;
  return `${roots.map(root => `${root.sheet}!${root.cell} (${root.formula})`).join(', ')} ${roots.length === 1 ? 'refers' : 'refer'} to ${roots.length === 1 ? 'itself' : 'themselves'}: that is the circle.${others > 0 ? ` The other ${others} #CIRC! cell${others === 1 ? '' : 's'} only depend on ${roots.length === 1 ? 'it' : 'them'} — fix ${roots.length === 1 ? 'that one formula' : 'those'} and they follow.` : ''}`;
}

/** A list or a table that arrived as its JSON text is that list or table. */
const unwrapped = (value: unknown): unknown => {
  if (typeof value !== 'string' || !/^\s*[[{]/.test(value)) return value;
  try { return JSON.parse(value); } catch { return value; }
};

/** The cell changes a sheet_write call asks for, in the order it gave them. */
export function sheetWrites(input: Record<string, unknown>): { cells: SheetCellWrite[]; widths: Record<number, number> } {
  const cells: SheetCellWrite[] = [];
  const room = () => { if (cells.length >= MAX_WRITE_CELLS) throw new Error(`One call changes at most ${MAX_WRITE_CELLS.toLocaleString('en')} cells. Write the rest in another call.`); };
  // A model sometimes sends the table as one piece of JSON text; taken literally that is one cell holding
  // "[[…]]" and a write that reports success (user's run, 16.11). It is read as the table it spells.
  let values = unwrapped(input.values);
  if (Array.isArray(values) && values.length === 1) {
    const only = Array.isArray(values[0]) && values[0].length === 1 ? values[0][0] : values[0];
    const inner = unwrapped(only);
    if (typeof only === 'string' && Array.isArray(inner) && inner.length > 0 && inner.every(row => Array.isArray(row))) values = inner;
  }
  if (values !== undefined) input = { ...input, values };
  if (input.cells !== undefined) input = { ...input, cells: unwrapped(input.cells) };
  if (input.format !== undefined) input = { ...input, format: unwrapped(input.format) };
  if (input.values !== undefined) {
    if (!Array.isArray(input.values) || input.values.some(row => !Array.isArray(row))) throw new Error('values is rows of cells: [[…], […]].');
    const start = parseCell(optional(input, 'start', 20) ?? 'A1');
    (input.values as unknown[][]).forEach((row, y) => row.forEach((value, x) => {
      room();
      cells.push({ row: start.row + y, column: start.column + x, input: cellValue(value) });
    }));
  }
  if (input.cells !== undefined) {
    if (!Array.isArray(input.cells)) throw new Error('cells is a list of {cell, value, …}.');
    for (const raw of input.cells as unknown[]) {
      const item = unwrapped(raw) as Record<string, unknown>;
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Each entry of cells is an object such as {"cell":"B4","value":10} — one of them is not, perhaps a quote out of place.');
      // A look for a whole range, given among the cells: the same as `format`.
      if (item.cell === undefined && typeof item.range === 'string') {
        const range = parseRange(item.range);
        const look = styleFrom(item);
        if (!Object.keys(look).length && !('value' in item)) throw new Error('A cells entry with a range needs a look (bold, format, fill…) or a value.');
        if ((range.bottom - range.top + 1) * (range.right - range.left + 1) > MAX_WRITE_CELLS) throw new Error('That range is too large for one call.');
        for (let row = range.top; row <= range.bottom; row++)
          for (let column = range.left; column <= range.right; column++) {
            room();
            cells.push({ row, column, ...('value' in item ? { input: cellValue(item.value) } : {}), ...(Object.keys(look).length ? { style: look } : {}) });
          }
        continue;
      }
      if (item.cell === undefined) throw new Error('Each entry of cells names a cell ("cell":"B4") or a range ("range":"A1:F1").');
      room();
      const at = parseCell(String(item.cell ?? ''));
      const style = styleFrom(item);
      // A model that names the formula apart from the value means the formula.
      const formula = typeof item.formula === 'string' && item.formula.trim() ? `=${item.formula.trim().replace(/^=/, '')}` : undefined;
      cells.push({ row: at.row, column: at.column,
        ...(formula !== undefined ? { input: formula } : 'value' in item ? { input: cellValue(item.value) } : {}),
        ...(Object.keys(style).length ? { style } : {}) });
    }
  }
  for (const format of (input.format === undefined ? [] : Array.isArray(input.format) ? input.format : [input.format]) as Array<Record<string, unknown>>) {
    if (!format || typeof format !== 'object') throw new Error('format is {range, …}.');
    const range = parseRange(String(format.range ?? ''));
    const style = styleFrom(format);
    if (!Object.keys(style).length) throw new Error('format needs a look: bold, italic, format, fill, color or align.');
    if ((range.bottom - range.top + 1) * (range.right - range.left + 1) > MAX_WRITE_CELLS) throw new Error('That range is too large to format in one call.');
    for (let row = range.top; row <= range.bottom; row++)
      for (let column = range.left; column <= range.right; column++) { room(); cells.push({ row, column, style }); }
  }
  const widths: Record<number, number> = {};
  if (input.widths !== undefined) {
    if (!input.widths || typeof input.widths !== 'object' || Array.isArray(input.widths)) throw new Error('widths is {"A": 28}.');
    for (const [column, width] of Object.entries(input.widths as Record<string, unknown>)) {
      if (typeof width !== 'number') throw new Error('A column width is a number of characters.');
      widths[columnNumber(column)] = width;
    }
  }
  if (!cells.length && !Object.keys(widths).length) throw new Error('Nothing to write: give values, cells, format or widths.');
  return { cells, widths };
}

export async function executeSheetTool(name: string, input: Record<string, unknown>, context: SheetToolContext): Promise<unknown> {
  const { books, conversationId, signal } = context;
  switch (name) {
    case 'sheet_list': {
      const open = await books.list(conversationId);
      const files = (await folderWorkbooks(context.folder?.())).filter(path => !open.some(book => book.path === path));
      return { workbooks: open.map(book => summary(book)), ...(files.length ? { folderFiles: files } : {}), scriptFolder: await books.exchangeFolder(conversationId),
        note: [files.length ? 'folderFiles are .xlsx files of the chat’s folder that are not open: sheet_open takes one of those paths as it is.' : '',
          'scriptFolder is where a script writes the .csv or .json that sheet_write fromFile places, and where sheet_read toFile puts a sheet for a script to read.'].filter(Boolean).join(' ') };
    }
    case 'sheet_new': {
      const sheets = input.sheets === undefined ? undefined : Array.isArray(input.sheets) ? input.sheets.map(String) : (() => { throw new Error('sheets is a list of names.'); })();
      const title = text(input, 'title', 120).trim();
      const present = await books.list(conversationId);
      const same = present.find(book => book.title.replace(/\.xlsx$/i, '').trim().toLowerCase() === title.replace(/\.xlsx$/i, '').toLowerCase());
      if (same) throw new Error(`This chat already has a workbook named "${same.title}" (${same.id}). Work in it: read it, and change or remove the sheets you added, rather than making it again.`);
      const info = await books.create(conversationId, text(input, 'title', 120), sheets);
      return { ...summary(info), note: `Made and shown in the Sheets pane. It is empty: fill it with sheet_write.${present.length ? ` This chat already had ${present.length} workbook${present.length === 1 ? '' : 's'} (${present.map(book => book.title).slice(0, 6).join(', ')}): if this work is about data in one of them, it belongs in a new sheet there, not here.` : ''}` };
    }
    case 'sheet_open': {
      const info = await books.openFile(conversationId, text(input, 'path'));
      const described = await books.describe(conversationId, info.id);
      return { ...summary(info, true), sheets: described.sheets.map(sheet => ({ name: sheet.name, used: sheet.used })), ...(described.charts.length ? { charts: described.charts } : {}) };
    }
    case 'sheet_read': {
      const id = text(input, 'workbook', 100);
      const asked = optional(input, 'range', 140);
      const range = asked === undefined ? undefined : reference(asked).cells;
      if (asked !== undefined && reference(asked).sheet !== undefined && optional(input, 'sheet', 100) === undefined) input = { ...input, sheet: reference(asked).sheet };
      const described = await books.describe(conversationId, id);
      // A model that names the file means the same thing as one that says true.
      if (input.toFile === true || (typeof input.toFile === 'string' && input.toFile.trim() && input.toFile.trim().toLowerCase() !== 'false')) {
        const file = await books.exportCsv(conversationId, id, optional(input, 'sheet', 100), typeof input.toFile === 'string' ? input.toFile : undefined);
        return { workbook: id, sheet: file.sheet, file: file.file, rows: file.rows, columns: file.columns, headers: file.headers,
          note: `The sheet\u2019s values are in that CSV (UTF-8, row 1 as in the sheet; formulas as their results): a copy, for a script. What the script produces goes into ${file.folder} as another .csv, for sheet_write fromFile.` };
      }
      if (optional(input, 'find', 200) !== undefined) {
        const found = await books.search(conversationId, id, text(input, 'find', 200), optional(input, 'sheet', 100));
        return { workbook: id, find: text(input, 'find', 200), found: found.total, matches: found.matches,
          ...(found.total > found.matches.length ? { note: `The first ${found.matches.length} of ${found.total} are listed. Name a sheet, or look for something longer.` } : {}) };
      }
      // No sheet named: every sheet in a few numbers, so the one that holds the data is found in this one call.
      if (input.summary === true && optional(input, 'sheet', 100) === undefined && described.sheets.length > 1 && described.sheets.length <= 8) {
        const each = [];
        for (const sheet of described.sheets) each.push(await books.summarize(conversationId, id, sheet.name));
        return { ...summary(described.info), ...(described.charts.length ? { charts: described.charts } : {}), sheetSummaries: each,
          note: 'Each sheet in a few numbers; row 1 is taken as the headers and top lists the commonest values with their counts. Read a range for the rows themselves.' };
      }
      if (input.summary === true) {
        const columns = await books.summarize(conversationId, id, optional(input, 'sheet', 100));
        return { ...summary(described.info), sheets: described.sheets.map(sheet => ({ name: sheet.name, used: sheet.used })), ...columns,
          note: 'Row 1 is taken as the headers. top lists the commonest values with their counts; read a range for the rows themselves.' };
      }
      const read = await books.read(conversationId, id, optional(input, 'sheet', 100), range ? parseRange(range) : undefined);
      // The cells asked for, and nothing the model already has: the workbook's sheets and what its file holds came with sheet_open, sheet_list and the snapshot.
      return {
        workbook: described.info.id, sheet: read.sheet, range: read.range, ...(read.used ? { used: read.used } : {}), rows: read.rows, formulas: read.formulas,
        ...(read.truncated ? { truncated: true, ...(read.next ? { next: read.next } : {}), note: `Only ${read.range} of ${read.used ?? 'the sheet'} is shown: one read carries a limited number of rows.${read.next ? ` The rest is ${read.next}.` : ''} To count or group what a column holds, do not read on: use sheet_group, or summary: true.` } : {}),
      };
    }
    case 'sheet_group': {
      const id = text(input, 'workbook', 100);
      if (!Array.isArray(input.by)) throw new Error('by is a list of column headers, such as ["Judet","Oras"].');
      const made = await books.group(conversationId, id, {
        sheet: optional(input, 'sheet', 100), by: input.by.map(String), ...(optional(input, 'into', 31) ? { into: optional(input, 'into', 31)! } : {}),
        ...(input.top === undefined ? {} : { top: Number(input.top) }), ...(input.bars === true ? { bars: true } : {}), ...(input.includeBlank === true ? { includeBlank: true } : {}),
        ...(input.together === true ? { together: true } : {}),
        ...(input.also !== undefined ? { also: unwrapped(input.also) as Array<{ column: string; as: 'sum' | 'average' | 'min' | 'max' | 'list'; label?: string }> } : {}),
        ...(input.order !== undefined ? { order: input.order as 'count' | 'label' } : {}),
        ...(input.labels && typeof input.labels === 'object' && !Array.isArray(input.labels) ? { words: input.labels as Record<string, string> } : {}),
      });
      return {
        workbook: made.info.id, sheet: made.sheet, range: made.range, groupedFrom: made.source, columns: made.columns,
        groups: made.groups, rowsCounted: made.rowsCounted, rowsWithoutFirstKey: made.rowsWithoutFirstKey,
        ...(made.rowsWithoutFirstKeyAt.length ? { rowsWithoutFirstKeyAt: made.rowsWithoutFirstKeyAt } : {}),
        firstRows: made.preview, ...(made.firstLevel ? { firstLevel: made.firstLevel } : {}), errors: made.recalc.errors,
        ...(made.merged.length ? { merged: made.merged } : {}), ...(made.alike.length ? { alike: made.alike } : {}), ...unsaved(made.info),
        note: [
          `Written to "${made.sheet}": labels as values, counts as COUNTIFS on ${made.source}, ${input.order === 'label' ? 'by label' : made.firstLevel ? `the largest ${made.columns[0]} first with its rows under it, largest first` : 'largest first'}, a total row and the rows with nothing in the first column.`,
          made.totalMatches ? '' : `The total came to ${String(made.total)} but ${made.rowsCounted.toLocaleString('en')} rows were counted: a label is not matched by its own formula (a ~ in it, or a number written as text). Find it and say so.`,
          made.firstLevel ? `Beside it at ${made.firstLevel.range} is ${made.firstLevel.columns[0]} alone${input.top !== undefined ? ', the largest and the rest as one' : ''}; firstLevel has the ranges a chart of it takes.` : '',
          made.merged.length ? `${made.merged.length} label${made.merged.length === 1 ? ' is' : 's are'} written several ways (${input.together === true ? 'capitals, spaces, accents, punctuation' : 'capitals, spaces around'}) and counted as one group each — merged lists them: say so.` : '',
          made.alikeCount ? `${made.alikeCount} set${made.alikeCount === 1 ? '' : 's'} of groups differ only by an accent, a hyphen or a dot (alike${made.alikeCount > made.alike.length ? `, the first ${made.alike.length}` : ''}) and are counted apart. Whether each is one thing or two is the human\u2019s to say: ask them, naming two or three; together: true counts them as one.` : '',
          made.rowsWithoutFirstKey && input.includeBlank !== true ? `${made.rowsWithoutFirstKey} row${made.rowsWithoutFirstKey === 1 ? ' has' : 's have'} nothing in the first column and ${made.rowsWithoutFirstKey === 1 ? 'is' : 'are'} in no group (${made.source} row${made.rowsWithoutFirstKeyAt.length === 1 ? '' : 's'} ${made.rowsWithoutFirstKeyAt.slice(0, 8).join(', ')}${made.rowsWithoutFirstKey > Math.min(8, made.rowsWithoutFirstKeyAt.length) ? '…' : ''}): say so, and ask the human whether ${made.rowsWithoutFirstKey === 1 ? 'it belongs' : 'they belong'} in the table (includeBlank: true).` : '',
        ].filter(Boolean).join(' '),
      };
    }
    case 'sheet_write': {
      const id = text(input, 'workbook', 100);
      if (input.removeSheet === true) {
        const left = await books.removeSheet(conversationId, id, text(input, 'sheet', 100));
        return { workbook: left.id, removed: true, sheets: left.sheets };
      }
      if (input.fromFile !== undefined) {
        if (input.values !== undefined || input.cells !== undefined) throw new Error('Give values and cells in the call, or fromFile — not both.');
        const file = await books.readExchange(conversationId, text(input, 'fromFile'));
        // A .json is what the call itself would carry: rows, a list of cells, or {values, cells, format, widths}.
        const json = file.json;
        const from = file.values ? { values: file.values }
          : Array.isArray(json) ? (json.every(item => Array.isArray(item)) ? { values: json } : { cells: json })
          : json && typeof json === 'object' ? Object.fromEntries(Object.entries(json).filter(([name]) => ['values', 'cells', 'format', 'widths', 'start'].includes(name)))
          : (() => { throw new Error('The .json holds rows [[…]], a list of cells [{cell, value}], or {values, cells, format, widths}.'); })();
        input = { ...input, ...from, ...(input.start !== undefined ? { start: input.start } : {}) };
      }
      const { cells, widths } = sheetWrites(input);
      const result = await books.write(conversationId, id, optional(input, 'sheet', 100), cells, 'model', { widths });
      const { recalc, info } = result;
      return {
        workbook: info.id, sheet: result.sheet, ...(result.created ? { sheetAdded: true } : {}),
        cellsWritten: result.written, formulasInWorkbook: recalc.formulas, recalculated: recalc.recalculated,
        ...(Object.keys(result.computed).length ? { computed: result.computed } : {}),
        errors: recalc.errors,
        ...(recalc.notKept?.length ? { notKept: recalc.notKept } : {}), ...(recalc.notComputed?.length ? { notComputed: recalc.notComputed.slice(0, 10) } : {}), ...(recalc.unsure?.length ? { unsure: recalc.unsure.slice(0, 10) } : {}), ...unsaved(info),
        note: [
          circular(recalc.errors),
          recalc.notKept?.length ? `${recalc.notKept.length} formula${recalc.notKept.length === 1 ? ' returns' : 's return'} a whole range (SORT, UNIQUE, FILTER…). Hello keeps one value per formula, so only the first cell of that result exists: the rest of the range is empty. Replace ${recalc.notKept.length === 1 ? 'it' : 'them'} with one formula per cell (INDEX/MATCH, COUNTIFS, SUMPRODUCT, LARGE) or write the values.` : '',
          recalc.notComputed?.length ? `${recalc.notComputed.length} formula${recalc.notComputed.length === 1 ? '' : 's'} (notComputed) use what Hello\u2019s engine does not compute and Excel does: ${recalc.notComputed.length === 1 ? 'it keeps' : 'they keep'} the value ${recalc.notComputed.length === 1 ? 'it' : 'they'} had until Excel opens the file.` : '',
          recalc.unsure?.length ? `${recalc.unsure.length} formula${recalc.unsure.length === 1 ? ' compares' : 's compare'} a whole range cell by cell (unsure). Excel 365 computes that over every row; here only one row is read, so the value shown may be wrong and no error says so. Write ${recalc.unsure.length === 1 ? 'it' : 'them'} with SUMIFS, COUNTIFS, AVERAGEIFS or SUMPRODUCT — or, for a list of values, as TEXTJOIN over IF.` : '',
          !recalc.recalculated ? recalc.reason : recalc.errors.length
            ? `${recalc.errors.length} formula${recalc.errors.length === 1 ? '' : 's'} ended in an error: they are in errors.` : '',
        ].filter(Boolean).join(' '),
      };
    }
    case 'sheet_chart': {
      const id = text(input, 'workbook', 100);
      const python = context.python;
      if (!python) throw new Error('Charts cannot be made in this app.');
      const kind = text(input, 'type', 20);
      if (!['bar', 'column', 'pie', 'line'].includes(kind)) throw new Error('type is bar, column, pie or line.');
      // "A chart of how many per county", straight from the data: the counting is sheet_group's, onto a sheet of
      // its own, and the chart is drawn from that table. One call where a model had to make the table, read back
      // which ranges it got and hand them over (its own account of where it hesitated, 16.11).
      let counted: Awaited<ReturnType<Workbooks['group']>> | undefined;
      if (input.by !== undefined && input.by !== null && input.by !== '') {
        if (input.categories !== undefined || input.values !== undefined) throw new Error('Give by — the column to count — or categories and values, not both.');
        const column = Array.isArray(input.by) ? input.by.map(String) : [String(input.by)];
        if (column.length !== 1) throw new Error('A chart counts one column: by is one header or one column letter. For two levels use sheet_group, then chart its first level.');
        if (input.top !== undefined && !(Number.isInteger(input.top) && (input.top as number) >= 1 && (input.top as number) <= 500)) throw new Error('top is a whole number of groups, from 1 to 500.');
        if (!(await python.status()) && !(await context.approve())) throw new Error('The human declined installing what charts need.');
        signal.throwIfAborted();
        await python.prepare(signal);
        const rest = optional(input, 'other', 40)?.trim();
        counted = await books.group(conversationId, id, {
          sheet: text(input, 'sheet', 100), by: column, ...(optional(input, 'into', 31) ? { into: optional(input, 'into', 31)! } : {}),
          top: input.top !== undefined ? input.top as number : kind === 'pie' ? 8 : 500,
          words: { ...(input.labels && typeof input.labels === 'object' && !Array.isArray(input.labels) ? input.labels as Record<string, string> : {}), ...(rest ? { other: rest } : {}) },
        });
        // Every row above the total: the groups, and the rest as one where there is a rest.
        const last = parseRange(counted.range).bottom - 2;
        input = { ...input, sheet: counted.sheet, categories: `A2:A${last}`, values: `B2:B${last}`, into: undefined, top: 500 };
      }
      const described = await books.describe(conversationId, id);
      if (input.categories === undefined || input.values === undefined) throw new Error('Give the cells to chart — categories and values, such as A2:A11 and B2:B11 — or by, the column of the data to count.');
      // Ranges written with their sheet name the sheet themselves; `sheet`, when it is another, is then where the chart goes.
      const labelled = reference(text(input, 'categories', 140)), numbered = reference(text(input, 'values', 140));
      if (labelled.sheet !== undefined && numbered.sheet !== undefined && labelled.sheet.toLowerCase() !== numbered.sheet.toLowerCase()) throw new Error('categories and values are cells of one sheet.');
      const named = labelled.sheet ?? numbered.sheet;
      if (named !== undefined && named.trim().toLowerCase() !== text(input, 'sheet', 100).trim().toLowerCase())
        input = { ...input, sheet: named, ...(input.into === undefined || input.into === null || input.into === '' ? { into: input.sheet } : {}) };
      const wanted = text(input, 'sheet', 100).trim().toLowerCase();
      const sheet = described.sheets.find(item => item.name.toLowerCase() === wanted);
      if (!sheet) throw new Error(`There is no sheet "${text(input, 'sheet', 100).slice(0, 40)}". The sheets are: ${described.sheets.map(item => item.name).join(', ')}.`);
      let categories = parseRange(labelled.cells), values = parseRange(numbered.cells);
      const size = (range: SheetRange) => { const rows = range.bottom - range.top + 1, columns = range.right - range.left + 1; return rows === 1 || columns === 1 ? Math.max(rows, columns) : 0; };
      if (!size(categories) || !size(values)) throw new Error('categories and values are each one column or one row of cells, such as A2:A11 and B2:B11.');
      if (size(categories) !== size(values)) throw new Error(`categories has ${size(categories)} cells and values ${size(values)}: they must match, label for number.`);
      if (size(values) > 500) throw new Error('A chart of more than 500 points is not readable. Chart a summary of the data.');
      const into = optional(input, 'into', 31);
      let target = into && into.trim().toLowerCase() !== sheet.name.toLowerCase()
        ? described.sheets.find(item => item.name.toLowerCase() === into.trim().toLowerCase())?.name ?? sheetName(into) : sheet.name;
      const anchor = optional(input, 'anchor', 12);
      const beside = Math.max(sheet.columns, categories.right, values.right) + 2;
      // Hello's own fixed program, not the model's: asked for only while its Python is still to be downloaded.
      if (!(await python.status()) && !(await context.approve())) throw new Error('The human declined installing what charts need.');
      signal.throwIfAborted();
      await python.prepare(signal);
      // What those cells hold now goes into the chart itself, so it draws in any viewer.
      const flat = async (range: SheetRange) => (await books.read(conversationId, id, sheet.name, range)).rows.flatMap(row => row.length ? row : [null]);
      let labels = (await flat(categories)).map(value => value === null ? '' : String(value));
      const held = await flat(values);
      let numbers = held.length === size(values) && held.every(value => typeof value === 'number') ? held as number[] : undefined;
      // A range taken one row too far ends in the table's Total: the sum of the groups is not one of them,
      // and drawn as a slice it is half the pie (a model's run, 16.11).
      let total = '';
      if (numbers && numbers.length > 2 && labels.length === numbers.length) {
        const last = numbers.length - 1, others = numbers.slice(0, last).reduce((sum, value) => sum + value, 0);
        if (/^\s*(?:grand\s+|sub)?total\b|^\s*sum[aă]?\s*$/i.test(labels[last]) && Math.abs(numbers[last] - others) <= 1e-9 * Math.max(1, Math.abs(others))) {
          const shorter = (range: SheetRange): SheetRange => range.bottom > range.top ? { ...range, bottom: range.bottom - 1 } : { ...range, right: range.right - 1 };
          total = labels[last];
          categories = shorter(categories); values = shorter(values);
          labels = labels.slice(0, last); numbers = numbers.slice(0, last);
        }
      }
      // More groups than a chart reads with: the largest, and the rest as one. A pie is cut by itself; any chart when asked.
      if (input.top !== undefined && !(Number.isInteger(input.top) && (input.top as number) >= 1 && (input.top as number) <= 500)) throw new Error('top is a whole number of groups, from 1 to 500.');
      const keep = input.top !== undefined ? input.top as number : kind === 'pie' && size(values) > 9 ? 8 : undefined;
      const cut = keep !== undefined && numbers && labels.length === numbers.length && numbers.length > keep + 1 ? keep : undefined;
      // A chart that needs a table of its own does not write it into the sheet whose cells it draws: that may be the
      // person's data. With no sheet named it gets one, called after the chart — and the same one when asked again.
      if (cut !== undefined && !into) {
        const base = (optional(input, 'title', 200) ?? `${sheet.name} chart`).replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 28) || 'Chart';
        const ours = (name: string) => { const held = described.sheets.find(item => item.name.toLowerCase() === name.toLowerCase()); return !held || held.columns <= 2; };
        target = base;
        for (let n = 2; !ours(target); n++) target = `${base} ${n}`;
        target = described.sheets.find(item => item.name.toLowerCase() === target.toLowerCase())?.name ?? target;
      }
      let table: { row: number; column: number; rows: Array<Array<string | number>>; clear: number } | undefined;
      let drawn = { sheet: sheet.name, categories, values, labels, numbers };
      // The table goes where the chart goes: at the start of a sheet of its own, beside the cells otherwise.
      const onto = described.sheets.find(item => item.name === target);
      const column = target === sheet.name ? beside : !onto || onto.columns <= 2 ? 1 : onto.columns + 2;
      if (cut !== undefined && numbers) {
        const order = numbers.map((_number, index) => index).sort((a, b) => (numbers[b] - numbers[a]) || (a - b)).slice(0, cut);
        const source = `'${sheet.name.replace(/'/g, "''")}'!`;
        const down = categories.bottom > categories.top || values.bottom > values.top;
        const cell = (range: SheetRange, index: number) => { const name = down ? cellName(range.top + index, range.left) : cellName(range.top, range.left + index); return name.replace(/([A-Z]+)(\d+)/, '$$$1$$$2'); };
        const whole = `${source}${rangeName(values).replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}`;
        const count = columnName(column + 1);
        // The table's headers are the ones over the cells charted, where there are any.
        const over = async (range: SheetRange, fallback: string) => {
          const at = down ? (range.top > 1 ? { row: range.top - 1, column: range.left } : null) : (range.left > 1 ? { row: range.top, column: range.left - 1 } : null);
          const held = at ? (await books.read(conversationId, id, sheet.name, { top: at.row, left: at.column, bottom: at.row, right: at.column })).rows[0]?.[0] : null;
          return typeof held === 'string' && held.trim() ? held.trim() : fallback;
        };
        const rest = optional(input, 'other', 40)?.trim() || 'Other';
        // Named by the caller, else as the cells charted are headed.
        const named = input.labels && typeof input.labels === 'object' && !Array.isArray(input.labels) ? input.labels as Record<string, unknown> : {};
        const head = (name: string) => typeof named[name] === 'string' && (named[name] as string).trim() ? (named[name] as string).trim().slice(0, 60) : undefined;
        const rows: Array<Array<string | number>> = [[head('group') ?? await over(categories, 'Group'), head('count') ?? await over(values, 'Count')],
          ...order.map(index => [labels[index], `=${source}${cell(values, index)}`]),
          [rest, `=SUM(${whole})-SUM($${count}$2:$${count}$${cut + 1})`]];
        table = { row: 1, column, rows, clear: target !== sheet.name && onto && onto.columns <= 2 ? Math.max(0, onto.rows - rows.length) : 0 };
        const kept = order.map(index => numbers[index]);
        drawn = { sheet: target, categories: { top: 2, bottom: cut + 2, left: column, right: column }, values: { top: 2, bottom: cut + 2, left: column + 1, right: column + 1 },
          labels: [...order.map(index => labels[index]), rest], numbers: [...kept, numbers.reduce((sum, value) => sum + value, 0) - kept.reduce((sum, value) => sum + value, 0)] };
      }
      const at = anchor ? parseCell(anchor) : table ? { row: 2, column: column + 3 } : target !== sheet.name ? { row: 1, column: 1 } : { row: 2, column: beside };
      // How much of the whole the rest is, where there is a rest: a pie that is mostly "Other" says little.
      const whole = (drawn.numbers ?? []).reduce((sum, value) => sum + value, 0);
      const restShare = whole > 0 && drawn.numbers && (table || (counted && size(values) > counted.groups)) ? drawn.numbers[drawn.numbers.length - 1] / whole : 0;
      const result = await books.runScript(conversationId, id, paths => python.run(chartScript({
        sheet: drawn.sheet, type: kind, categories: rangeName(drawn.categories), values: rangeName(drawn.values),
        title: optional(input, 'title', 200) ?? '', anchor: cellName(at.row, at.column), into: target,
        ...(drawn.labels.length === size(drawn.categories) ? { labels: drawn.labels } : {}), ...(drawn.numbers ? { numbers: drawn.numbers } : {}),
        ...(table ? { table } : {}),
      }), paths, signal, 120));
      if (result.exitCode !== 0 || !result.changed) throw new Error(`The chart could not be made: ${result.output.slice(-600) || 'the workbook was left unchanged.'}`);
      const repeated = repeatedCharts(result.charts);
      return {
        workbook: result.info.id, sheet: target, chart: result.charts.find(chart => chart.sheet === target && chart.anchor === cellName(at.row, at.column)) ?? null,
        charts: result.charts, errors: result.recalc.errors, ...unsaved(result.info),
        ...(table ? { drawn: { top: cut, of: size(values), table: `${target}!${rangeName({ top: 1, left: column, bottom: table.rows.length, right: column + 1 })}` } } : {}),
        ...(counted ? { counted: { from: counted.source, table: `${counted.sheet}!${counted.range}`, groups: counted.groups, rowsCounted: counted.rowsCounted, rowsWithoutFirstKey: counted.rowsWithoutFirstKey, firstRows: counted.preview,
          ...(counted.merged.length ? { merged: counted.merged } : {}), ...(counted.alike.length ? { alike: counted.alike } : {}) } } : {}),
        note: [
          counted ? `Counted from ${counted.source} into the new sheet "${counted.sheet}" (COUNTIFS, largest first); the chart is drawn from that table.${size(values) > counted.groups ? ` It shows the largest ${counted.groups} and the rest as one: say so; a larger top draws more of them.` : ''}` : '',
          counted && !counted.totalMatches ? `Its total came to ${String(counted.total)} but ${counted.rowsCounted.toLocaleString('en')} rows were counted: a label is not matched by its own formula. Find it and say so.` : '',
          counted?.rowsWithoutFirstKey ? `${counted.rowsWithoutFirstKey} row${counted.rowsWithoutFirstKey === 1 ? ' has' : 's have'} nothing in that column and ${counted.rowsWithoutFirstKey === 1 ? 'is' : 'are'} not in the chart: say so, and ask the human whether ${counted.rowsWithoutFirstKey === 1 ? 'it belongs' : 'they belong'} in it.` : '',
          counted?.alikeCount ? `${counted.alikeCount} set${counted.alikeCount === 1 ? '' : 's'} of groups differ only by an accent, a hyphen or a dot (alike) and are counted apart: ask the human whether they are the same.` : '',
          `A ${kind} chart of ${sheet.name}!${rangeName(values)} by ${rangeName(categories)} is in ${target} at ${cellName(at.row, at.column)} and follows those cells; \`charts\` lists every chart the file now holds, read back from it.`,
          table ? `It draws the largest ${cut} of ${size(values)} groups and the rest as one, from the table at ${target}!${rangeName({ top: 1, left: column, bottom: table.rows.length, right: column + 1 })} (formulas on your cells)${into ? '' : ', on a sheet of its own'}: say it is the top ${cut}. For every group: top: ${size(values)}, into: "${target}".` : '',
          restShare > 0.4 ? `The rest is ${Math.round(restShare * 100)}% of the whole, so this ${kind} says little about most of the data: bars of every group (type: bar, top: ${counted ? 500 : size(values)}) read better — offer that.` : '',
          total ? `The last cell of the ranges you gave, “${total}”, is the sum of the others, not a group: it is left out of the chart.` : '',
          numbers ? '' : 'Some of the value cells do not hold a number yet, so the chart carries no values of its own and shows them once the file is opened in Excel.',
          kind === 'pie' && !table && size(values) > 9 ? `${size(values)} slices is too many to read in a pie: bars read better, or call again with a smaller top; the same anchor replaces this one.` : '',
          repeated.length ? `${repeated.length} other chart${repeated.length === 1 ? ' draws' : 's draw'} the same cells on the same sheet (${repeated.map(chart => `${chart.sheet} ${chart.anchor ?? ''}`.trim()).join(', ')}): a leftover to remove with sheet_script.` : '',
        ].filter(Boolean).join(' '),
      };
    }
    case 'sheet_script': {
      const id = text(input, 'workbook', 100);
      const code = text(input, 'code', 100_000);
      const python = context.python;
      if (!python) throw new Error('Scripts cannot run in this app. Use sheet_write and sheet_group.');
      const timeout = typeof input.timeoutSeconds === 'number' && input.timeoutSeconds >= 5 && input.timeoutSeconds <= 600 ? Math.floor(input.timeoutSeconds) : 120;
      const before = JSON.stringify((await books.describe(conversationId, id)).charts);
      // A script is a program with the human's access: asked for like a shell command.
      if (!(await context.approve())) throw new Error('The human declined this script.');
      signal.throwIfAborted();
      const environment = await python.prepare(signal);
      const result = await books.runScript(conversationId, id, paths => python.run(code, paths, signal, timeout));
      const { info, recalc } = result;
      const repeated = repeatedCharts(result.charts);
      return {
        workbook: info.id, exitCode: result.exitCode, output: result.output.slice(-8000), changed: result.changed, sheets: info.sheets,
        ...(result.changed ? { formulasInWorkbook: recalc.formulas, recalculated: recalc.recalculated, errors: recalc.errors } : {}),
        ...(info.scripted?.length ? { holds: info.scripted } : {}),
        // The charts, when this script changed them; which Python, when it failed. Fourteen scripts carried both, the same, fourteen times.
        ...(result.charts.length && JSON.stringify(result.charts) !== before ? { charts: result.charts } : {}),
        ...(result.exitCode !== 0 ? { pythonPath: python.interpreter } : {}), ...unsaved(info),
        ...(result.exitCode !== 0 ? { python: `${environment.python}, openpyxl ${environment.openpyxl}${environment.pandas ? `, pandas ${environment.pandas}` : ', pandas not available'}` } : {}),
        note: [
          result.restored ? 'The script left a file that is not a readable .xlsx, so the workbook was put back as it was. Nothing changed.' : '',
          result.exitCode !== 0 ? `The script ended with an error${result.changed ? ', after it had already saved changes' : ' and changed nothing'}: read the output, fix the script and run it again.` : '',
          result.changed && recalc.errors.length ? `${recalc.errors.length} formula${recalc.errors.length === 1 ? '' : 's'} ended in an error; fix them.` : '',
          // A workbook is expected to compute: a table a script worked out and wrote as numbers is a picture of the data, not a table of it (user, 16.11).
          ...(result.made ?? []).filter(sheet => sheet.numbers >= 4 && sheet.formulas === 0).map(sheet => `"${sheet.sheet}" was written with ${sheet.numbers} numbers and no formula. Where a number is a count, a total, a share or anything else worked out from cells, write the formula instead (ws["B5"] = "=SUM(B2:B4)", "=COUNTIFS(…)") so it follows the data — or make the table with sheet_group; only data that came from outside stays as values.`),
          result.exitCode === 0 && !result.changed ? 'The workbook is unchanged: a script must wb.save(WORKBOOK) to change it.' : '',
          repeated.length ? `${repeated.length} chart${repeated.length === 1 ? ' draws' : 's draw'} the same cells as another chart of the same sheet (${repeated.map(chart => `${chart.sheet} ${chart.anchor ?? ''}`.trim()).join(', ')}): a leftover. openpyxl keeps the charts a workbook already has, so a script that adds a chart again must first take the old ones out — ws._charts = [] for that sheet — then add.` : '',
          info.scripted?.length ? `The workbook holds ${info.scripted.join(', ')}${result.charts.length && JSON.stringify(result.charts) !== before ? '; \`charts\` lists each chart as the file now has it' : ''}.${info.scripted.every(part => part === 'charts') ? '' : ' Hello\u2019s own writer does not carry all of that: from now on change this workbook only with sheet_script.'}` : '',
        ].filter(Boolean).join(' '),
      };
    }
    case 'sheet_save': {
      const id = text(input, 'workbook', 100);
      const info = await books.get(conversationId, id);
      if (input.discard === true && optional(input, 'path') === undefined) {
        if (info.source === 'file' && !info.dirty) return `${info.path} has no unsaved changes in Hello; nothing to give up.`;
        const back = await books.revert(conversationId, id);
        return `The changes held in Hello are given up: the workbook is ${back.path} as it is on disk again, with its sheets ${back.sheets.join(', ')}.`;
      }
      let requested = optional(input, 'path');
      // The file it was opened from, named: that is a save over it, not a copy beside it that leaves "unsaved changes" behind.
      if (requested && info.source === 'file' && info.path
        && await Promise.all([context.writable(requested), context.writable(info.path)]).then(([asked, own]) => asked === own, () => false)) requested = undefined;
      if (!requested) {
        if (info.source !== 'file') return 'This workbook lives in Hello and is kept as it changes. To put it in the chat’s folder, call sheet_save with a path ending in .xlsx.';
        if (!info.dirty) return `${info.path} already holds this workbook; nothing to save.`;
        await context.writable(info.path!);
        if (!(await context.approve())) throw new Error('The human declined this save.');
        signal.throwIfAborted();
        const saved = await books.save(conversationId, id);
        const written = await context.writable(info.path!);
        await context.saved?.(written);
        return `Saved ${saved.path}.${saved.kept ? ` The version it replaced is kept at ${saved.kept}.` : ''}${await heldCharts(written)}`;
      }
      if (extname(requested).toLowerCase() !== '.xlsx') throw new Error('A workbook is saved as an .xlsx file: give a path ending in .xlsx.');
      await context.writable(requested);
      if (!(await context.approve())) throw new Error('The human declined this save.');
      signal.throwIfAborted();
      // Looked at again after the wait for an approval: the folder may have changed under it.
      const target = await context.writable(requested);
      const written = await books.exportTo(conversationId, id, target);
      await context.saved?.(target);
      const held = await heldCharts(target);
      // A copy, and the original left as it is: the changes held against it are given up in the same call.
      const back = input.discard === true && info.source === 'file' && info.dirty ? await books.revert(conversationId, id) : undefined;
      return `Wrote ${requested} (${written.bytes.toLocaleString('en')} bytes).${written.kept ? ` The file it replaced is kept at ${written.kept}.` : ''}${
        back ? ` ${back.path} is left as it is on disk: the changes held against it are given up, and the workbook in the chat is that file again.`
          : info.source === 'file' && info.dirty ? ` ${info.path} is unchanged and still has unsaved changes in the chat.` : ''}${held}`;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

