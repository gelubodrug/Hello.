import ExcelJS from 'exceljs';
import { mkdtemp, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toolDefinitions } from '../src/main/chat/tools';
import { groupsByIntent, helloToolGroups, withBrought } from '../src/main/chat/tool-groups';
import { csvCell, parseCsv, toCsv } from '../src/main/sheets/csv';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { executeSheetTool, sheetToolDefinitions, sheetWrites, type SheetToolContext } from '../src/main/sheets/tools';
import { Workbooks } from '../src/main/sheets/workbooks';

let root: string;
let folder: string;
let approvals: boolean[];
let saved: string[];
let context: SheetToolContext;
const run = (name: string, input: Record<string, unknown> = {}) => executeSheetTool(name, input, context) as Promise<any>;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'hello-sheet-tools-')));
  folder = join(root, 'folder');
  await mkdir(folder);
  approvals = [];
  saved = [];
  const inFolder = (path: string) => {
    const absolute = resolve(folder, path);
    if (relative(folder, absolute).startsWith('..')) throw new Error('The path is outside this chat’s folder.');
    return absolute;
  };
  context = {
    books: new Workbooks({ dataDir: join(root, 'data'), resolveFile: async (_id, path) => ({ absolute: inFolder(path), relative: relative(folder, inFolder(path)) }) }),
    conversationId: 'chat', signal: new AbortController().signal,
    approve: async () => approvals.shift() ?? true,
    writable: async path => inFolder(path),
    saved: target => { saved.push(target); },
    folder: () => folder,
  };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('sheet tools', () => {
  it('are offered only where the app keeps workbooks, and open a file only with a folder', () => {
    const names = (folderAttached: boolean, sheets: boolean) =>
      toolDefinitions(folderAttached, false, { skills: [], mcp: [] }, false, false, { runbook: false, tasks: false }, sheets).map(item => item.function.name).filter(name => name.startsWith('sheet_'));
    expect(names(false, false)).toEqual([]);
    expect(names(false, true)).toEqual(['sheet_list', 'sheet_new', 'sheet_read', 'sheet_group', 'sheet_write', 'sheet_chart', 'sheet_script', 'sheet_save']);
    expect(names(true, true)).toContain('sheet_open');
    expect(sheetToolDefinitions(false).find(item => item.function.name === 'sheet_save')!.function.parameters).not.toHaveProperty('properties.path');
  });

  it('are every one of them reachable through the chat\u2019s tool call, not only defined', async () => {
    const { executeTool } = await import('../src/main/chat/tools');
    const store = { getConversation: () => ({ id: 'chat', folder }), dataDir: join(root, 'data') };
    for (const definition of sheetToolDefinitions(true)) {
      const outcome = await executeTool(definition.function.name, {}, { store: store as never, conversationId: 'chat', signal: new AbortController().signal, approve: async () => true, sheets: context.books })
        .then(result => result, error => String((error as Error).message));
      expect(outcome, definition.function.name).not.toMatch(/Unknown tool/);
    }
  });

  it('call the shell bash, the name a coding model reaches for, and still answer to the old one', async () => {
    const { executeTool, toolName } = await import('../src/main/chat/tools');
    const names = toolDefinitions(true, false).map(item => item.function.name);
    expect(names.filter(name => name === 'bash')).toEqual(['bash']);
    expect(names).not.toContain('command_run');
    expect(toolDefinitions(false, false).map(item => item.function.name)).not.toContain('bash');
    expect([toolName('bash'), toolName('command_run'), toolName('file_read')]).toEqual(['bash', 'bash', 'file_read']);
    // Always there: never a tool that has to be loaded first.
    const groups = helloToolGroups(toolDefinitions(true, false), { notebooks: { runbook: false, tasks: false }, planning: false, mcp: [] });
    expect(groups.find(group => group.id === 'core')!.tools).toContain('bash');
    expect(groups.find(group => group.id === 'coding')!.tools).not.toContain('bash');
    // Under either name it is the approved shell: the same refusal when the human says no.
    const store = { getConversation: () => ({ id: 'chat', folder }), dataDir: join(root, 'data') };
    for (const name of ['bash', 'command_run'])
      await expect(executeTool(name, { command: 'echo hi' }, { store: store as never, conversationId: 'chat', signal: new AbortController().signal, approve: async () => false }))
        .rejects.toThrow(/declined this command/);
  });

  it('form a group of their own that words about spreadsheets find', () => {
    const groups = helloToolGroups(toolDefinitions(true, true, { skills: [], mcp: [] }, false, true, { runbook: true, tasks: true }, true),
      { notebooks: { runbook: true, tasks: true }, planning: false, mcp: [] });
    const sheets = groups.find(group => group.id === 'sheets')!;
    expect(sheets.core).toBe(false);
    expect(sheets.tools).toEqual(['sheet_list', 'sheet_new', 'sheet_open', 'sheet_read', 'sheet_group', 'sheet_write', 'sheet_chart', 'sheet_script', 'sheet_save']);
    expect(sheets.manual).toContain('never a total you computed yourself');
    // What the xlsx skill asks of any workbook and holds in this app is here; what is LibreOffice's is not.
    for (const rule of ['used exactly as spelled', 'its conventions come before every rule below', 'hold no typed-in numbers', 'gets its number format', 'a short legend and one example row',
      'come back under alike: that is a question for the human, not a choice of yours', 'you put to the human at the end, as a question', 'data_only=True', 'top-left cell only', 'chart.roundedCorners = False', 'never pip install', 'typed inputs #0666EB', 'formulas #111827', 'links to another sheet #16A34A', 'a #F59E0B fill', 'no skill and no web search'])
      expect(sheets.manual).toContain(rule);
    expect(sheets.manual).not.toMatch(/recalc\.py|LibreOffice|soffice|XLOOKUP is not/);
    // Each section is said once.
    const sections = sheets.manual.split('\n').map(line => /^([A-Z][A-Z ]+)\./.exec(line)?.[1]).filter(Boolean);
    expect(new Set(sections).size).toBe(sections.length);
    expect(sheets.manual.length).toBeLessThan(10000);
    for (const said of [{ group: 'sheets' }, { need: 'excel' }, { name: 'sheet_write' }, { need: 'make a spreadsheet budget' }])
      expect(groupsByIntent(groups, said).chosen.map(group => group.id)).toEqual(['sheets']);
    // Spreadsheet work is coder work, and the shell and file tools are in view in every chat: nothing is loaded twice.
    expect(groups.find(group => group.id === 'coding')!.core).toBe(true);
    expect(withBrought(groups, [sheets]).map(group => group.id)).toEqual(['sheets']);
    // Words another group owns still mean that group.
    expect(groupsByIntent(groups, { need: 'browser' }).chosen.map(group => group.id)).toEqual(['browser']);
  });

  it('reads a write as cells: a block, single cells, a look for a range, widths', () => {
    const { cells, widths } = sheetWrites({
      start: 'B2', values: [['a', 1], [null, '=B2*2']],
      cells: [{ cell: 'A1', value: 'Titlu', bold: true }, { cell: 'D4', format: '0%' }, { cell: 'E5', formula: 'SUM(A1:A3)' }],
      format: { range: 'A1:B1', fill: '#EEEEEE' }, widths: { A: 28, c: 12 },
    });
    expect(cells.slice(0, 4)).toEqual([
      { row: 2, column: 2, input: 'a' }, { row: 2, column: 3, input: 1 },
      { row: 3, column: 2, input: null }, { row: 3, column: 3, input: '=B2*2' },
    ]);
    expect(cells.slice(4, 7)).toEqual([
      { row: 1, column: 1, input: 'Titlu', style: { bold: true } },
      { row: 4, column: 4, style: { format: '0%' } },
      { row: 5, column: 5, input: '=SUM(A1:A3)' },
    ]);
    expect(cells.slice(7)).toEqual([{ row: 1, column: 1, style: { fill: '#EEEEEE' } }, { row: 1, column: 2, style: { fill: '#EEEEEE' } }]);
    expect(widths).toEqual({ 1: 28, 3: 12 });
    expect(() => sheetWrites({})).toThrow(/Nothing to write/);
    expect(() => sheetWrites({ values: [[{ a: 1 }]] })).toThrow(/cell holds/);
    expect(() => sheetWrites({ values: 'x' })).toThrow(/rows of cells/);
    expect(() => sheetWrites({ format: { range: 'A1' } })).toThrow(/needs a look/);
  });

  it('reads a table or a list that arrived as its JSON text as that table or list, never as one cell of text', () => {
    const table = [['Sibiu', '=COUNTIFS(Magazine!$J$2:$J$1795,$F$443)'], ['Cluj', 3]];
    const asCells = [{ row: 1, column: 1, input: 'Sibiu' }, { row: 1, column: 2, input: '=COUNTIFS(Magazine!$J$2:$J$1795,$F$443)' }, { row: 2, column: 1, input: 'Cluj' }, { row: 2, column: 2, input: 3 }];
    for (const values of [JSON.stringify(table), [[JSON.stringify(table)]], [JSON.stringify(table)]])
      expect(sheetWrites({ values }).cells).toEqual(asCells);
    // Text that only looks a little like JSON is text.
    expect(sheetWrites({ values: [['[draft] not a table']] }).cells).toEqual([{ row: 1, column: 1, input: '[draft] not a table' }]);
    // The same for cells, for one entry of cells, and for a look given among them or as a list of looks.
    expect(sheetWrites({ cells: JSON.stringify([{ cell: 'A1', value: 1 }]) }).cells).toEqual([{ row: 1, column: 1, input: 1 }]);
    expect(sheetWrites({ cells: [JSON.stringify({ cell: 'B2', value: 'x' })] }).cells).toEqual([{ row: 2, column: 2, input: 'x' }]);
    expect(sheetWrites({ cells: [{ range: 'A1:B1', bold: true }, { cell: 'A2', value: 5 }] }).cells).toEqual([
      { row: 1, column: 1, style: { bold: true } }, { row: 1, column: 2, style: { bold: true } }, { row: 2, column: 1, input: 5 }]);
    expect(sheetWrites({ format: [{ range: 'A1', bold: true }, { range: 'B1', italic: true }] }).cells).toEqual([
      { row: 1, column: 1, style: { bold: true } }, { row: 1, column: 2, style: { italic: true } }]);
    expect(() => sheetWrites({ cells: ['{"cell":"A1", value: broken'] })).toThrow(/Each entry of cells is an object.*a quote out of place/);
    expect(() => sheetWrites({ cells: [{ value: 1 }] })).toThrow(/names a cell .* or a range/);
  });

  it('names the one formula a circle starts at, ahead of the cells that only depend on it', async () => {
    const { refersToItself } = await import('../src/main/sheets/engine');
    expect(refersToItself('=B13-SUM(B2:B12)', 'B13')).toBe(true);
    expect(refersToItself('=SUM($B$2:$B$13)', 'B13')).toBe(true);
    expect(refersToItself('=SUM(B2:B12)', 'B13')).toBe(false);
    // Another sheet's B13, a name that contains it, or the letters in a text are not this cell.
    expect(refersToItself("=Magazine!B13+AB13+LOG10(2)", 'B13')).toBe(false);
    expect(refersToItself('="B13"&A1', 'B13')).toBe(false);
    const made = await run('sheet_new', { title: 'cerc' });
    const written = await run('sheet_write', { workbook: made.workbook, values: [[1], [2], ['=A3-SUM(A1:A2)'], ['=A3*2'], ['=A4+1']] });
    expect(written.errors.map((error: { cell: string; cause?: string }) => [error.cell, error.cause])).toEqual([['A3', 'refers to itself'], ['A4', undefined], ['A5', undefined]]);
    expect(written.note).toMatch(/^Sheet1!A3 \(=A3-SUM\(A1:A2\)\) refers to itself: that is the circle\. The other 2 #CIRC! cells only depend on it/);
  });

  it('makes a workbook, fills it, says what the formulas came to and which failed', async () => {
    const made = await run('sheet_new', { title: 'Buget', sheets: ['Costuri'] });
    expect(made).toMatchObject({ title: 'Buget', sheets: ['Costuri'], keptIn: 'Hello' });
    const written = await run('sheet_write', { workbook: made.workbook, values: [['Item', 'Cost'], ['a', 10], ['b', 5], ['Total', '=SUM(B2:B3)'], ['Rău', '=B2/0']] });
    expect(written).toMatchObject({ sheet: 'Costuri', cellsWritten: 10, recalculated: true, formulasInWorkbook: 2, computed: { B4: 15, B5: '#DIV/0!' } });
    expect(written.errors).toEqual([{ sheet: 'Costuri', cell: 'B5', formula: '=B2/0', error: '#DIV/0!' }]);
    expect(written.note).toMatch(/1 formula ended in an error/);
    const fixed = await run('sheet_write', { workbook: made.workbook, cells: [{ cell: 'B5', value: null }] });
    expect(fixed.errors).toEqual([]);
    const read = await run('sheet_read', { workbook: made.workbook, range: 'A4:B4' });
    // The cells asked for, where they are and how far the sheet goes — not the workbook described again.
    expect(read).toEqual({ workbook: made.workbook, sheet: 'Costuri', range: 'A4:B4', used: 'A1:B5', rows: [['Total', 15]], formulas: { B4: '=SUM(B2:B3)' } });
    expect(await run('sheet_list')).toMatchObject({ workbooks: [{ workbook: made.workbook, title: 'Buget' }], scriptFolder: expect.stringMatching(/sheets\/[a-f0-9]{64}\/exchange$/) });
  });

  it('writes a file only through a save the human allowed, and only as .xlsx', async () => {
    const made = await run('sheet_new', { title: 'x' });
    await run('sheet_write', { workbook: made.workbook, values: [[1, '=A1+1']] });
    expect(await run('sheet_save', { workbook: made.workbook })).toMatch(/kept as it changes/);
    await expect(run('sheet_save', { workbook: made.workbook, path: 'out.csv' })).rejects.toThrow(/\.xlsx/);
    await expect(run('sheet_save', { workbook: made.workbook, path: '../afara.xlsx' })).rejects.toThrow(/outside/);
    approvals = [false];
    await expect(run('sheet_save', { workbook: made.workbook, path: 'out.xlsx' })).rejects.toThrow(/declined/);
    await expect(stat(join(folder, 'out.xlsx'))).rejects.toThrow();
    expect(await run('sheet_save', { workbook: made.workbook, path: 'out.xlsx' })).toMatch(/^Wrote out\.xlsx/);
    expect(saved).toEqual([join(folder, 'out.xlsx')]);
    const onDisk = new ExcelJS.Workbook();
    await onDisk.xlsx.readFile(join(folder, 'out.xlsx'));
    expect(onDisk.worksheets[0].getCell('B1').value).toEqual({ formula: 'A1+1', result: 2 });
  });

  it('will not guess a sheet, keeps the work in one workbook, and sums a table up by column', async () => {
    const made = await run('sheet_new', { title: 'Magazine', sheets: ['Date', 'Alta'] });
    await expect(run('sheet_write', { workbook: made.workbook, values: [[1]] })).rejects.toThrow(/2 sheets \(Date, Alta\)\. Name the sheet/);
    await run('sheet_write', { workbook: made.workbook, sheet: 'Date', values: [['Magazin', 'Judet'], [701, 'Arad'], [703, 'Timis'], [714, 'Arad'], [715, null]] });
    const columns = await run('sheet_read', { workbook: made.workbook, sheet: 'Date', summary: true });
    expect(columns).toMatchObject({ sheet: 'Date', used: 'A1:B5', dataRows: 4 });
    expect(columns.columns).toEqual([
      { column: 'A', header: 'Magazin', filled: 4, blank: 0, numbers: 4, formulas: 0, distinct: 4, top: [[701, 1], [703, 1], [714, 1], [715, 1]] },
      { column: 'B', header: 'Judet', filled: 3, blank: 1, numbers: 0, formulas: 0, distinct: 2, top: [['Arad', 2], ['Timis', 1]] },
    ]);
    // No sheet named: every sheet at once; and a column with no header and no values is left out.
    await run('sheet_write', { workbook: made.workbook, sheet: 'Date', cells: [{ cell: 'D1', value: null, bold: true }] });
    const all = await run('sheet_read', { workbook: made.workbook, summary: true });
    expect(all.sheetSummaries.map((sheet: { sheet: string; columns: unknown[] }) => [sheet.sheet, sheet.columns.length])).toEqual([['Date', 2], ['Alta', 0]]);
    // The same workbook is not made twice, and a different one says the data lives elsewhere.
    await expect(run('sheet_new', { title: ' magazine ' })).rejects.toThrow(new RegExp(`already has a workbook named "Magazine" \\(${made.workbook}\\)`));
    expect((await run('sheet_new', { title: 'Altceva' })).note).toMatch(/already had 1 workbook \(Magazine\).*new sheet there/);
    // The result is a new sheet of the workbook that holds the data.
    const analysed = await run('sheet_write', { workbook: made.workbook, sheet: 'Analiza', values: [['Arad', '=COUNTIF(Date!B:B,A1)']] });
    expect(analysed).toMatchObject({ sheetAdded: true, computed: { B1: 2 }, errors: [] });
  });

  it('removes a sheet the model added, never one the workbook came with', async () => {
    const source = new ExcelJS.Workbook();
    source.addWorksheet('Date').getCell('A1').value = 1;
    await source.xlsx.writeFile(join(folder, 'date.xlsx'));
    const opened = await run('sheet_open', { path: 'date.xlsx' });
    await run('sheet_write', { workbook: opened.workbook, sheet: 'Proba', values: [['=Date!A1+1']] });
    // With one sheet of its own, a write that names none goes there, never into the data.
    expect(await run('sheet_write', { workbook: opened.workbook, cells: [{ cell: 'B1', value: 'x' }] })).toMatchObject({ sheet: 'Proba' });
    await expect(run('sheet_write', { workbook: opened.workbook, sheet: 'Date', removeSheet: true })).rejects.toThrow(/came with the workbook.*Proba/);
    expect(await run('sheet_write', { workbook: opened.workbook, sheet: 'Proba', removeSheet: true })).toEqual({ workbook: opened.workbook, removed: true, sheets: ['Date'] });
    await expect(run('sheet_write', { workbook: opened.workbook, sheet: 'Proba', removeSheet: true })).rejects.toThrow(/no sheet "Proba"/);
  });

  it('groups a table into a new sheet in one call, with counts that follow the data', async () => {
    const made = await run('sheet_new', { title: 'Retea', sheets: ['Magazine'] });
    await run('sheet_write', { workbook: made.workbook, sheet: 'Magazine', values: [
      ['Magazin', 'Oras', 'Judet'], [1, 'Arad', 'Arad'], [2, 'Timisoara', 'Timis'], [3, 'Lugoj', 'Timis'], [4, 'Timisoara', 'Timis'], [5, 'Ineu', 'Arad'], [6, 'Cluj', 'Cluj'], [7, 'X', null],
    ] });
    const one = await run('sheet_group', { workbook: made.workbook, sheet: 'Magazine', by: ['judet'], into: 'Pe judete' });
    expect(one).toMatchObject({ sheet: 'Pe judete', range: 'A1:C6', groups: 3, rowsCounted: 6, rowsWithoutFirstKey: 1, columns: ['Judet', 'Count', '% of total'], errors: [] });
    expect(one.firstRows).toEqual([['Timis', 3], ['Arad', 2], ['Cluj', 1]]);
    expect(one.note).toMatch(/1 row has nothing in the first column/);
    const sheet = await run('sheet_read', { workbook: made.workbook, sheet: 'Pe judete' });
    expect(sheet.rows[4]).toEqual(['Total', 6, 1]);
    expect(sheet.rows[5]).toEqual(['Rows without Judet', 1]);
    expect(sheet.formulas.B2).toBe("=COUNTIFS('Magazine'!$C$2:$C$8,$A2)");
    // Two columns: the largest county first, its towns under it; a top keeps the largest and sums the rest.
    const two = await run('sheet_group', { workbook: made.workbook, sheet: 'Magazine', by: ['Judet', 'B'], into: 'Judet si oras', top: 2 });
    // Two columns, one call, both levels: the detail whole, and beside it the first column alone — which is what `top` cuts.
    expect(two.firstRows).toEqual([['Timis', 'Timisoara', 2], ['Timis', 'Lugoj', 1], ['Arad', 'Arad', 1], ['Arad', 'Ineu', 1], ['Cluj', 'Cluj', 1]]);
    expect(two.firstLevel).toEqual({ range: 'G1:I5', labels: 'G2:G4', counts: 'H2:H4', columns: ['Judet', 'Count', '% of total'], groups: 2, preview: [['Timis', 3], ['Arad', 2], ['Other', 1]] });
    expect(two.note).toMatch(/Beside it at G1:I5 is Judet alone, the largest and the rest as one; firstLevel has the ranges a chart of it takes\./);
    expect((await run('sheet_read', { workbook: made.workbook, sheet: 'Judet si oras', range: 'G5:I5' })).rows).toEqual([['Total', 6, 1]]);
    // With two columns, each row also says what part of its county it is, as a pivot does.
    expect(two.columns).toEqual(['Judet', 'Oras', 'Count', '% of total', '% of Judet']);
    expect((await run('sheet_read', { workbook: made.workbook, sheet: 'Judet si oras', range: 'A2:E3' })).rows).toEqual([['Timis', 'Timisoara', 2, 2 / 6, 2 / 3], ['Timis', 'Lugoj', 1, 1 / 6, 1 / 3]]);
    expect(one.note).toBe('Written to "Pe judete": labels as values, counts as COUNTIFS on Magazine, largest first, a total row and the rows with nothing in the first column. 1 row has nothing in the first column and is in no group (Magazine row 8): say so, and ask the human whether it belongs in the table (includeBlank: true).');
    // A rule of the manual is said there, once, and not again in every result.
    expect(one.note).not.toMatch(/do not read|say so if you see/);
    expect((await run('sheet_read', { workbook: made.workbook, sheet: 'Judet si oras', range: 'A6:C7' })).rows).toEqual([['Cluj', 'Cluj', 1], ['Total', null, 6]]);
    // Unnamed, the sheet is called after its columns; asked to, the rows with no county are a group inside the total.
    const blanks = await run('sheet_group', { workbook: made.workbook, sheet: 'Magazine', by: ['Judet'], includeBlank: true });
    expect(blanks).toMatchObject({ sheet: 'By Judet', range: 'A1:C6', rowsWithoutFirstKey: 1 });
    expect(blanks.note).not.toMatch(/not in any group/);
    expect((await run('sheet_read', { workbook: made.workbook, sheet: 'By Judet', range: 'A5:B6' })).rows).toEqual([['(blank)', 1], ['Total', 7]]);
    expect((await run('sheet_group', { workbook: made.workbook, sheet: 'Magazine', by: ['Judet'] })).sheet).toBe('By Judet 2');
    for (const name of ['By Judet', 'By Judet 2']) await run('sheet_write', { workbook: made.workbook, sheet: name, removeSheet: true });
    // The counts are formulas: change the data and they follow.
    await run('sheet_write', { workbook: made.workbook, sheet: 'Magazine', cells: [{ cell: 'C2', value: 'Timis' }] });
    expect((await run('sheet_read', { workbook: made.workbook, sheet: 'Pe judete', range: 'A2:B3' })).rows).toEqual([['Timis', 4], ['Arad', 1]]);
    await expect(run('sheet_group', { workbook: made.workbook, sheet: 'Magazine', by: ['Judet'], into: 'Pe judete' })).rejects.toThrow(/already a sheet/);
    await expect(run('sheet_group', { workbook: made.workbook, sheet: 'Magazine', by: ['Regiune'], into: 'Alta' })).rejects.toThrow(/not a column of Magazine\. Its headers are: magazin, oras, judet/);
    // A chart that lives in the sheet: a bar per row, the largest 30 blocks wide, following the counts.
    const charted = await run('sheet_group', { workbook: made.workbook, sheet: 'Magazine', by: ['Judet'], into: 'Top', top: 2, bars: true });
    expect(charted).toMatchObject({ range: 'A1:D6', columns: ['Judet', 'Count', '% of total', 'Chart'], errors: [] });
    const bars = (await run('sheet_read', { workbook: made.workbook, sheet: 'Top', range: 'A2:D4' })).rows;
    expect(bars.map((row: unknown[]) => [row[0], row[1], String(row[3]).length])).toEqual([['Timis', 4, 30], ['Arad', 1, 8], ['Other', 1, 8]]);
    await run('sheet_write', { workbook: made.workbook, sheet: 'Top', removeSheet: true });
    // No sheet named: the only sheet with that header is the one meant; two with it must be told apart.
    expect(await run('sheet_group', { workbook: made.workbook, by: ['Oras'], into: 'Pe orase' })).toMatchObject({ groupedFrom: 'Magazine', groups: 6 });
    await expect(run('sheet_group', { workbook: made.workbook, by: ['Regiune'], into: 'Alta' })).rejects.toThrow(/None of them has a header named Regiune/);
    await run('sheet_write', { workbook: made.workbook, sheet: 'Pe orase', removeSheet: true });
    // Its sheets are the model's own, so it may remove them.
    expect((await run('sheet_write', { workbook: made.workbook, sheet: 'Judet si oras', removeSheet: true })).sheets).toEqual(['Magazine', 'Pe judete']);
  });

  it('counts a label once however it is written, exactly its rows, and says when it cannot', async () => {
    const made = await run('sheet_new', { title: 'Orase', sheets: ['Date'] });
    await run('sheet_write', { workbook: made.workbook, sheet: 'Date', values: [['Oras', 'Cod', 'Cod'],
      ['Cluj', 1, 'a'], ['CLUJ', 2, 'a'], ['cluj ', 3, 'b'], ['Cluj', 4, 'b'], ['Iasi', 5, 'a'], [' Iasi', 6, 'a'], ['A*', 7, 'a'], ['Abc', 8, 'a'], ['>5', 9, 'a'], [null, 10, 'a']] });
    const grouped = await run('sheet_group', { workbook: made.workbook, sheet: 'Date', by: ['Oras'], into: 'Pe oras',
      labels: { count: 'Număr', share: '% din total', total: 'Total general', without: 'Rânduri fără oraș' } });
    // "Cluj", "CLUJ" and "cluj " are one town, shown as it is most often written; a COUNTIFS of its own would count each of them three times, or miss the one with a space.
    expect(grouped.firstRows).toEqual([['Cluj', 4], ['Iasi', 2], ['>5', 1], ['A*', 1], ['Abc', 1]]);
    expect(grouped).toMatchObject({ groups: 5, rowsCounted: 9, rowsWithoutFirstKey: 1, columns: ['Oras', 'Număr', '% din total'] });
    expect(grouped.merged).toEqual([{ label: 'Cluj', spellings: ['Cluj', 'CLUJ', 'cluj'] }]);
    expect(grouped.note).toMatch(/1 label is written several ways \(capitals, spaces around\) and counted as one group each — merged lists them/);
    expect(grouped.note).not.toMatch(/The total came to/);
    const sheet = await run('sheet_read', { workbook: made.workbook, sheet: 'Pe oras' });
    expect(sheet.rows[6]).toEqual(['Total general', 9, 1]);
    expect(sheet.rows[7]).toEqual(['Rânduri fără oraș', 1]);
    // One way of writing it: counted through its own cell. Several, or a character COUNTIFS reads as a pattern: by each exact text.
    expect(sheet.formulas.B6).toBe("=COUNTIFS('Date'!$A$2:$A$11,$A6)");
    expect(sheet.formulas.B2).toBe(`=COUNTIFS('Date'!$A$2:$A$11,"=Cluj")+COUNTIFS('Date'!$A$2:$A$11,"=cluj ")`);
    expect(sheet.formulas.B3).toBe(`=COUNTIFS('Date'!$A$2:$A$11,"=Iasi")+COUNTIFS('Date'!$A$2:$A$11,"= Iasi")`);
    expect([sheet.formulas.B4, sheet.formulas.B5]).toEqual([`=COUNTIFS('Date'!$A$2:$A$11,"=>5")`, `=COUNTIFS('Date'!$A$2:$A$11,"=A~*")`]);
    // A header two columns share names neither of them: the letter does.
    await expect(run('sheet_group', { workbook: made.workbook, sheet: 'Date', by: ['Cod'] })).rejects.toThrow(/"Cod" is the header of 2 columns of Date \(B, C\)\. Name the one you mean by its letter\./);
    const byLetter = await run('sheet_group', { workbook: made.workbook, sheet: 'Date', by: ['Oras', 'C'], into: 'Pe oras si cod' });
    expect(byLetter.firstRows.slice(0, 2)).toEqual([['Cluj', 'a', 2], ['Cluj', 'b', 2]]);
    expect(byLetter.firstLevel.preview[0]).toEqual(['Cluj', 4]);
    // The table's words are the caller's in both tables of the sheet, and the result names them as the cells have them.
    const worded = await run('sheet_group', { workbook: made.workbook, sheet: 'Date', by: ['Oras', 'C'], into: 'Cu vorbe', labels: { count: 'Număr magazine', share: '% din total', ofParent: '% din oraș', total: 'Total general' } });
    expect(worded.columns).toEqual(['Oras', 'Cod', 'Număr magazine', '% din total', '% din oraș']);
    expect(worded.firstLevel.columns).toEqual(['Oras', 'Număr magazine', '% din total']);
    const wide = (await run('sheet_read', { workbook: made.workbook, sheet: 'Cu vorbe', range: 'A1:I1' })).rows[0];
    expect(wide).toEqual(['Oras', 'Cod', 'Număr magazine', '% din total', '% din oraș', null, 'Oras', 'Număr magazine', '% din total']);
    expect((await run('sheet_read', { workbook: made.workbook, sheet: 'Cu vorbe', range: `G${worded.firstLevel.groups + 2}:G${worded.firstLevel.groups + 2}` })).rows).toEqual([['Total general']]);
    expect(worded.note).toMatch(/the largest Oras first with its rows under it, largest first/);
    expect((await run('sheet_read', { workbook: made.workbook, sheet: 'Pe oras si cod', range: 'C2:E2' })).rows).toEqual([[2, 2 / 9, 0.5]]);
    // Beside the count: a column summed, averaged, its least and most — live formulas — and its values listed; by label when asked.
    const sales = await run('sheet_new', { title: 'Vanzari', sheets: ['Date'] });
    await run('sheet_write', { workbook: sales.workbook, sheet: 'Date', values: [['Judet', 'Magazin', 'Vanzari'],
      ['Timis', 'M1', 10], ['Timis', 'M2', 30], ['TIMIS', 'M3', 20], ['Cluj', 'M4', 5], ['Cluj', 'M5', 7], ['Arad', 'M6', 100], [null, 'M7', 1], [null, 'M8', 2]] });
    const summed = await run('sheet_group', { workbook: sales.workbook, sheet: 'Date', by: ['Judet'], into: 'Pe judet', order: 'label',
      also: [{ column: 'Vanzari', as: 'sum', label: 'Total vânzări' }, { column: 'C', as: 'average' }, { column: 'Vanzari', as: 'min' }, { column: 'Vanzari', as: 'max' }, { column: 'Magazin', as: 'list', label: 'Magazine' }] });
    expect(summed.columns).toEqual(['Judet', 'Count', '% of total', 'Total vânzări', 'Average of Vanzari', 'Least Vanzari', 'Most Vanzari', 'Magazine']);
    expect(summed.firstRows).toEqual([['Arad', 1, 100, 100, 100, 100, 'M6'], ['Cluj', 2, 12, 6, 5, 7, 'M4, M5'], ['Timis', 3, 60, 20, 10, 30, 'M1, M2, M3']]);
    expect(summed.errors).toEqual([]);
    expect(summed.rowsWithoutFirstKeyAt).toEqual([8, 9]);
    expect(summed.note).toMatch(/by label, a total row.*2 rows have nothing in the first column and are in no group \(Date rows 8, 9\): say so, and ask/);
    const summedSheet = await run('sheet_read', { workbook: sales.workbook, sheet: 'Pe judet' });
    expect(summedSheet.rows[4]).toEqual(['Total', 6, 1, 172, 172 / 6, 5, 100]);
    expect(summedSheet.formulas.D2).toBe("=SUMIFS('Date'!$C$2:$C$9,'Date'!$A$2:$A$9,$A2)");
    expect(summedSheet.formulas.D4).toBe("=SUMIFS('Date'!$C$2:$C$9,'Date'!$A$2:$A$9,$A4)");
    // The list is a formula as well — every value of the column on the group's rows — and Hello computes it like the rest.
    expect(summedSheet.formulas.H4).toBe(`=TEXTJOIN(", ",TRUE,IF(('Date'!$A$2:$A$9=$A4),'Date'!$B$2:$B$9,""))`);
    expect(summedSheet.rows[3][7]).toBe('M1, M2, M3');
    // It follows the data like every other column: a store renamed and a figure changed are both in the table after the write.
    const later = await run('sheet_write', { workbook: sales.workbook, sheet: 'Date', cells: [{ cell: 'C2', value: 11 }, { cell: 'B3', value: 'M2 nou' }] });
    expect(later.errors).toEqual([]);
    expect(later).not.toHaveProperty('notComputed');
    expect((await run('sheet_read', { workbook: sales.workbook, sheet: 'Pe judet', range: 'D4:H4' })).rows).toEqual([[61, 61 / 3, 11, 30, 'M1, M2 nou, M3']]);
    await run('sheet_write', { workbook: sales.workbook, sheet: 'Date', cells: [{ cell: 'C2', value: 10 }, { cell: 'B3', value: 'M2' }] });
    expect(summedSheet.formulas.F2).toBe("=MINIFS('Date'!$C$2:$C$9,'Date'!$A$2:$A$9,$A2)");
    await expect(run('sheet_group', { workbook: sales.workbook, sheet: 'Date', by: ['Judet'], into: 'X', also: [{ column: 'Vanzari', as: 'median' }] })).rejects.toThrow(/as one of sum, average, min, max, list/);
    await expect(run('sheet_group', { workbook: sales.workbook, sheet: 'Date', by: ['Judet'], into: 'X', also: [{ column: 'Lipsa', as: 'sum' }] })).rejects.toThrow(/"Lipsa" is not a column of Date/);
    // Where a text is, without reading the rows: any capitals, any accents, one sheet or all of them.
    const found = await run('sheet_read', { workbook: sales.workbook, find: 'tími' });
    expect(found).toEqual({ workbook: sales.workbook, find: 'tími', found: 4, matches: [
      { sheet: 'Date', cell: 'A2', value: 'Timis' }, { sheet: 'Date', cell: 'A3', value: 'Timis' }, { sheet: 'Date', cell: 'A4', value: 'TIMIS' }, { sheet: 'Pe judet', cell: 'A4', value: 'Timis' }] });
    expect((await run('sheet_read', { workbook: sales.workbook, find: 'M6', sheet: 'Date' })).matches).toEqual([{ sheet: 'Date', cell: 'B7', value: 'M6' }]);
    // "Bacau" and "Bacău", "Cluj-Napoca" and "Cluj Napoca": one place to a person, two texts to Excel. Left apart, and put to the human.
    const places = await run('sheet_new', { title: 'Judete', sheets: ['Date'] });
    await run('sheet_write', { workbook: places.workbook, sheet: 'Date', values: [['Judet'], ['Bacau'], ['Bacau'], ['Bacău'], ['Cluj-Napoca'], ['Cluj Napoca'], ['cluj napoca'], ['Iasi'], ['Iași'], ['Iaşi'], ['Arad']] });
    const apart = await run('sheet_group', { workbook: places.workbook, sheet: 'Date', by: ['Judet'], into: 'Separat' });
    expect(apart.groups).toBe(8);
    expect(apart.alike).toEqual([{ labels: ['Bacau', 'Bacău'], rows: [2, 1] }, { labels: ['Cluj Napoca', 'Cluj-Napoca'], rows: [2, 1] }, { labels: ['Iasi', 'Iași', 'Iaşi'], rows: [1, 1, 1] }]);
    expect(apart.note).toMatch(/3 sets of groups differ only by an accent, a hyphen or a dot \(alike\) and are counted apart\. Whether each is one thing or two is the human’s to say: ask them/);
    // The human said they are the same: one call counts them together, each by every way it is written, and the total still holds.
    const joined = await run('sheet_group', { workbook: places.workbook, sheet: 'Date', by: ['Judet'], into: 'Impreuna', together: true });
    expect(joined.firstRows).toEqual([['Bacau', 3], ['Cluj-Napoca', 3], ['Iasi', 3], ['Arad', 1]]);
    expect(joined).not.toHaveProperty('alike');
    expect(joined.merged.map((item: { label: string }) => item.label)).toEqual(['Bacau', 'Cluj-Napoca', 'Iasi']);
    expect(joined.note).not.toMatch(/The total came to/);
    expect((await run('sheet_read', { workbook: places.workbook, sheet: 'Impreuna', range: 'B2:B2' })).formulas.B2).toBe(`=COUNTIFS('Date'!$A$2:$A$11,"=Bacau")+COUNTIFS('Date'!$A$2:$A$11,"=Bacău")`);
    // A label its own formula cannot match is said, not passed off as checked.
    await run('sheet_write', { workbook: made.workbook, sheet: 'Date', cells: [{ cell: 'A11', value: 'x~y' }] });
    const tilde = await run('sheet_group', { workbook: made.workbook, sheet: 'Date', by: ['A'], into: 'Cu tilda' });
    expect(tilde.note).toMatch(/The total came to 9 but 10 rows were counted: a label is not matched by its own formula/);
  });

  it('reads a merged range as the one cell it is, and a range written with its sheet as that sheet’s cells', async () => {
    const source = new ExcelJS.Workbook();
    const sheet = source.addWorksheet('Raport pe luni');
    sheet.getCell('A1').value = 'Titlu peste cinci coloane';
    sheet.mergeCells('A1:E1');
    sheet.getCell('A2').value = 'x';
    sheet.getCell('B2').value = 7;
    source.addWorksheet('Alta').getCell('A1').value = 'altceva';
    await source.xlsx.writeFile(join(folder, 'imbinat.xlsx'));
    const opened = await run('sheet_open', { path: 'imbinat.xlsx' });
    // ExcelJS answers with the title for every cell of the merge; a read gives it once, and a summary does not count it five times.
    expect((await run('sheet_read', { workbook: opened.workbook, sheet: 'Raport pe luni' })).rows).toEqual([['Titlu peste cinci coloane'], ['x', 7]]);
    expect((await run('sheet_read', { workbook: opened.workbook, find: 'titlu' })).found).toBe(1);
    const snapshot = await context.books.snapshot(context.conversationId, opened.workbook);
    expect(snapshot.grids[0].merges).toEqual(['A1:E1']);
    expect(snapshot.grids[0].cells.filter(([row]) => row === 1).map(([, column, cell]) => [column, cell.v])).toEqual([[1, 'Titlu peste cinci coloane']]);
    // What the grid reports for the rest of the merge — empty cells — does not empty the title.
    await context.books.write(context.conversationId, opened.workbook, 'Raport pe luni', [{ row: 1, column: 3, input: null }, { row: 1, column: 5, input: null }], 'person');
    expect((await run('sheet_read', { workbook: opened.workbook, sheet: 'Raport pe luni', range: 'A1:A1' })).rows).toEqual([['Titlu peste cinci coloane']]);
    // The sheet a range names is the sheet read, with or without $.
    expect(await run('sheet_read', { workbook: opened.workbook, range: "'Raport pe luni'!$A$2:$B$2" })).toMatchObject({ sheet: 'Raport pe luni', range: 'A2:B2', rows: [['x', 7]] });
    expect(await run('sheet_read', { workbook: opened.workbook, range: 'Alta!A1' })).toMatchObject({ sheet: 'Alta', rows: [['altceva']] });
  });

  it('hands a sheet to a script as a CSV and takes the script\u2019s CSV back', async () => {
    expect(parseCsv(toCsv([['a,b', 'spune "da"', 5, null, true], ['doua\nlinii', ' x', '0744', null, null]])))
      .toEqual([['a,b', 'spune "da"', '5', '', 'TRUE'], ['doua\nlinii', ' x', '0744', '', '']]);
    // A phone number or a code keeps its zero; a plain number is a number; = is a formula.
    expect(['0744556956', '12', '-3.5', '', 'TRUE', '=A1+1', '+40', '1e5'].map(csvCell)).toEqual(['0744556956', 12, -3.5, null, true, '=A1+1', '+40', '1e5']);
    expect(() => parseCsv('"deschis')).toThrow(/quoted field/);
    const made = await run('sheet_new', { title: 'Date', sheets: ['Magazine'] });
    await run('sheet_write', { workbook: made.workbook, sheet: 'Magazine', values: [['Magazin', 'Mobil', 'Dublu'], [701, '0744556956', '=A2*2'], [703, '0745, 0746', '=A3*2']] });
    const out = await run('sheet_read', { workbook: made.workbook, sheet: 'Magazine', toFile: true });
    expect(out).toMatchObject({ sheet: 'Magazine', rows: 3, columns: 3, headers: ['Magazin', 'Mobil', 'Dublu'] });
    expect(await readFile(out.file, 'utf8')).toBe('Magazin,Mobil,Dublu\n701,0744556956,1402\n703,"0745, 0746",1406\n');
    // A file name instead of true means the same; only its name is taken, into the same folder.
    const named = await run('sheet_read', { workbook: made.workbook, sheet: 'Magazine', toFile: '../../magazine.csv' });
    expect(named.file).toBe(join(dirname(out.file), 'magazine.csv'));
    // What a script would write beside it.
    const result = join(dirname(out.file), 'rezultat.csv');
    await writeFile(result, 'Magazin,Telefoane\n701,1\n703,2\nTotal,=SUM(B2:B3)\n');
    const back = await run('sheet_write', { workbook: made.workbook, sheet: 'Rezultat', fromFile: result });
    expect(back).toMatchObject({ sheetAdded: true, cellsWritten: 8, computed: { B4: 3 } });
    expect((await run('sheet_read', { workbook: made.workbook, sheet: 'Rezultat' })).rows).toEqual([['Magazin', 'Telefoane'], [701, 1], [703, 2], ['Total', 3]]);
    // A CSV of the chat's folder is read too; anything else on the disk is not.
    await writeFile(join(folder, 'in.csv'), 'x\n1\n');
    expect(await run('sheet_write', { workbook: made.workbook, sheet: 'Rezultat', start: 'D1', fromFile: 'in.csv' })).toMatchObject({ cellsWritten: 2 });
    await expect(run('sheet_write', { workbook: made.workbook, sheet: 'Rezultat', fromFile: join(root, 'afara.csv') })).rejects.toThrow(new RegExp(`in neither\\. Have the script write the file into "${dirname(out.file)}"`));
    await expect(run('sheet_write', { workbook: made.workbook, sheet: 'Rezultat', fromFile: 'in.txt' })).rejects.toThrow(/\.csv or a \.json/);
    // A .json of cells, as a script that builds formulas writes it; and rows; and the whole call.
    await writeFile(join(dirname(out.file), 'cells.json'), JSON.stringify([{ cell: 'C2', value: '=B2/B$4' }, { cell: 'C3', value: '=B3/B$4', format: '0%' }]));
    expect(await run('sheet_write', { workbook: made.workbook, sheet: 'Rezultat', fromFile: join(dirname(out.file), 'cells.json') })).toMatchObject({ cellsWritten: 2, computed: { C3: 2 / 3 } });
    await writeFile(join(dirname(out.file), 'rows.json'), JSON.stringify([['a', 1], ['b', '=C2+1']]));
    expect(await run('sheet_write', { workbook: made.workbook, sheet: 'Alt', fromFile: join(dirname(out.file), 'rows.json'), start: 'B2' })).toMatchObject({ cellsWritten: 4, computed: { C3: 2 } });
    await writeFile(join(dirname(out.file), 'call.json'), JSON.stringify({ values: [['x']], widths: { A: 30 }, removeSheet: true }));
    expect(await run('sheet_write', { workbook: made.workbook, sheet: 'Alt', fromFile: join(dirname(out.file), 'call.json') })).toMatchObject({ cellsWritten: 1 });
    await expect(run('sheet_write', { workbook: made.workbook, sheet: 'Alt', fromFile: 'in.csv', values: [[1]] })).rejects.toThrow(/not both/);
  });

  it('says when a formula returns a range it cannot keep', async () => {
    const made = await run('sheet_new', { title: 'x' });
    await run('sheet_write', { workbook: made.workbook, values: [[3], [1], [2]] });
    const written = await run('sheet_write', { workbook: made.workbook, cells: [{ cell: 'C1', value: '=SORT(A1:A3)' }, { cell: 'D1', value: '=SUM(A1:A3)' }] });
    expect(written.notKept).toEqual([{ sheet: 'Sheet1', cell: 'C1', formula: '=SORT(A1:A3)' }]);
    expect(written.note).toMatch(/keeps one value per formula/);
    expect(written.computed.D1).toBe(6);
  });

  it('names the folder’s workbooks where the work starts, so a file the human named is found without a search', async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet('S').getCell('A1').value = 1;
    await mkdir(join(folder, 'rapoarte', '2026'), { recursive: true });
    await mkdir(join(folder, 'a', 'b', 'c'), { recursive: true });
    for (const file of ['Profi Phone List.xlsx', 'rapoarte/2026/vanzari.xlsx', 'a/b/c/prea-adanc.xlsx', '~$Profi Phone List.xlsx', '.ascuns.xlsx'])
      await book.xlsx.writeFile(join(folder, file));
    await writeFile(join(folder, 'note.txt'), 'x');
    const listed = await run('sheet_list');
    expect(listed.folderFiles).toEqual(['Profi Phone List.xlsx', 'rapoarte/2026/vanzari.xlsx']);
    expect(listed.note).toMatch(/sheet_open takes one of those paths as it is/);
    // Once open it is a workbook of the chat, no longer a file to open.
    const opened = await run('sheet_open', { path: listed.folderFiles[0] });
    const again = await run('sheet_list');
    expect(again.workbooks).toMatchObject([{ workbook: opened.workbook, file: 'Profi Phone List.xlsx' }]);
    expect(again.folderFiles).toEqual(['rapoarte/2026/vanzari.xlsx']);
    // Without a folder there is nothing to name.
    expect(await executeSheetTool('sheet_list', {}, { ...context, folder: () => null })).not.toHaveProperty('folderFiles');
  });

  it('opens a folder file, holds its changes, and saves over it on request', async () => {
    const source = new ExcelJS.Workbook();
    source.addWorksheet('Date').getCell('A1').value = 2;
    await source.xlsx.writeFile(join(folder, 'date.xlsx'));
    const opened = await run('sheet_open', { path: 'date.xlsx' });
    expect(opened).toMatchObject({ file: 'date.xlsx', unsavedChanges: false, sheets: [{ name: 'Date', used: 'A1' }] });
    expect(await run('sheet_save', { workbook: opened.workbook })).toMatch(/nothing to save/);
    const written = await run('sheet_write', { workbook: opened.workbook, cells: [{ cell: 'A2', value: '=A1*3' }] });
    // That the file is behind is a word in the result, not a sentence in every one of them.
    expect(written).toMatchObject({ unsavedChanges: true, note: '' });
    expect(await run('sheet_save', { workbook: opened.workbook })).toMatch(/^Saved date\.xlsx\. The version it replaced is kept at /);
    // Its own file given as the path is that same save, not a copy that leaves the workbook "unsaved" and says the file is unchanged.
    await run('sheet_write', { workbook: opened.workbook, cells: [{ cell: 'A3', value: 7 }] });
    const named = await run('sheet_save', { workbook: opened.workbook, path: './date.xlsx' });
    expect(named).toMatch(/^Saved date\.xlsx\./);
    expect(named).not.toMatch(/unchanged/);
    expect(await run('sheet_list')).toMatchObject({ workbooks: [{ file: 'date.xlsx', unsavedChanges: false }] });
    expect(await run('sheet_save', { workbook: opened.workbook, path: 'date.xlsx' })).toMatch(/nothing to save/);
    await run('sheet_write', { workbook: opened.workbook, cells: [{ cell: 'A3', value: null }] });
    await run('sheet_save', { workbook: opened.workbook });
    // Changes can also be given up: the workbook is the file again, and what the model added is gone with them.
    await run('sheet_write', { workbook: opened.workbook, sheet: 'Proba', values: [['x']] });
    await run('sheet_write', { workbook: opened.workbook, sheet: 'Date', cells: [{ cell: 'A1', value: 99 }] });
    expect(await run('sheet_save', { workbook: opened.workbook, discard: true })).toMatch(/given up: the workbook is date\.xlsx as it is on disk again, with its sheets Date\./);
    expect(await run('sheet_list')).toMatchObject({ workbooks: [{ file: 'date.xlsx', unsavedChanges: false, sheets: ['Date'] }] });
    expect((await run('sheet_read', { workbook: opened.workbook, range: 'A1:A2' })).rows).toEqual([[2], [6]]);
    expect(await run('sheet_save', { workbook: opened.workbook, discard: true })).toMatch(/nothing to give up/);
    // "Save it as a copy and leave the original alone" is one call: the copy is written, then the changes are given up.
    await run('sheet_write', { workbook: opened.workbook, sheet: 'Rezultat', values: [['gata']] });
    const copied = await run('sheet_save', { workbook: opened.workbook, path: 'copie.xlsx', discard: true });
    expect(copied).toMatch(/^Wrote copie\.xlsx .*date\.xlsx is left as it is on disk: the changes held against it are given up/);
    expect(await run('sheet_list')).toMatchObject({ workbooks: [{ file: 'date.xlsx', unsavedChanges: false, sheets: ['Date'] }], folderFiles: ['copie.xlsx'] });
    const copy = new ExcelJS.Workbook();
    await copy.xlsx.readFile(join(folder, 'copie.xlsx'));
    expect(copy.worksheets.map(sheet => sheet.name)).toEqual(['Date', 'Rezultat']);
    // Without discard the copy is written and the changes stay, said in a clause.
    await run('sheet_write', { workbook: opened.workbook, sheet: 'Date', cells: [{ cell: 'A3', value: 1 }] });
    expect(await run('sheet_save', { workbook: opened.workbook, path: 'copie2.xlsx' })).toMatch(/date\.xlsx is unchanged and still has unsaved changes in the chat\./);
    await run('sheet_save', { workbook: opened.workbook, discard: true });
    const kept = await run('sheet_new', { title: 'doar in Hello' });
    await expect(run('sheet_save', { workbook: kept.workbook, discard: true })).rejects.toThrow(/no file to go back to/);
    const onDisk = new ExcelJS.Workbook();
    await onDisk.xlsx.readFile(join(folder, 'date.xlsx'));
    expect(onDisk.worksheets[0].getCell('A2').value).toEqual({ formula: 'A1*3', result: 6 });
  });
});

/**
 * A table of real size, read whole. ExcelJS's `columnCount` walks every row of
 * the sheet, so a count left in a loop condition makes one pass over the cells
 * quadratic: the person's 29,426 x 14 sheet took 237,553 ms to export, inside
 * the main process, with the window, the IPC and the Pi tool bridge stopped
 * behind it — the app and the model server looked frozen together, twice, on
 * this same call (user, 17.11). Hoisted, the same pass took 49 ms.
 */
describe('a sheet of thousands of rows', () => {
  const ROWS = 10_000, COLUMNS = 14;
  /** Far above what each of these costs here, and far below the ~30 s the quadratic took at this size. */
  const SOON = 4_000;
  let workbook: string;

  beforeEach(async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('gps');
    sheet.addRow(Array.from({ length: COLUMNS }, (_item, index) => `col${index + 1}`));
    for (let row = 2; row <= ROWS; row++)
      sheet.addRow([`car-${row % 15}`, ...Array.from({ length: COLUMNS - 1 }, (_item, index) => row * (index + 1))]);
    await book.xlsx.writeFile(join(folder, 'big.xlsx'));
    workbook = (await run('sheet_open', { path: 'big.xlsx' })).workbook;
  }, 120_000);

  it('is exported, summarized and grouped without the main process stopping', { timeout: 300_000 }, async () => {
    const took = async (what: () => Promise<unknown>) => { const began = Date.now(); await what(); return Date.now() - began; };

    const csv = await took(() => run('sheet_read', { workbook, sheet: 'gps', toFile: 'big.csv' }));
    const summary = await took(() => run('sheet_read', { workbook, sheet: 'gps', summary: true }));
    const grouped = await took(() => run('sheet_group', { workbook, sheet: 'gps', by: ['col1'] }));
    expect({ csv: csv < SOON, summary: summary < SOON, grouped: grouped < SOON }).toEqual({ csv: true, summary: true, grouped: true });
    console.log(`${ROWS} rows: export ${csv} ms, summary ${summary} ms, group ${grouped} ms (threshold ${SOON})`);

    // And each one answered about the whole sheet, not a corner of it.
    const exported = await run('sheet_read', { workbook, sheet: 'gps', toFile: 'big.csv' });
    expect(exported).toMatchObject({ rows: ROWS, columns: COLUMNS });
    expect(parseCsv(await readFile(exported.file, 'utf8'))).toHaveLength(ROWS);
    expect(await run('sheet_read', { workbook, sheet: 'gps', summary: true })).toMatchObject({ dataRows: ROWS - 1 });
    expect(await run('sheet_group', { workbook, sheet: 'gps', by: ['col1'] })).toMatchObject({ rowsCounted: ROWS - 1, groups: 15 });
  });
});
