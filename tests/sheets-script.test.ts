import ExcelJS from 'exceljs';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SheetPython, quote, type SheetShell } from '../src/main/sheets/python';
import { chartsIn, repeatedCharts } from '../src/main/sheets/charts';
import { withCachedValues } from '../src/main/sheets/cached';
import { withCharts } from '../src/main/sheets/carried';
import JSZip from 'jszip';
import { executeSheetTool, type SheetToolContext } from '../src/main/sheets/tools';
import { Workbooks } from '../src/main/sheets/workbooks';

let root: string;
let folder: string;
let books: Workbooks;
const chat = 'chat';
/** A Python that has openpyxl, when the machine running the tests has one: the real thing is then run too. */
const realPython = process.env.HELLO_TEST_PYTHON;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'hello-sheet-script-')));
  folder = join(root, 'folder');
  await mkdir(folder);
  books = new Workbooks({ dataDir: join(root, 'data'), resolveFile: async (_id, path) => {
    const absolute = resolve(folder, path);
    if (relative(folder, absolute).startsWith('..')) throw new Error('The path is outside this chat’s folder.');
    return { absolute, relative: relative(folder, absolute) };
  } });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** What a script does to the file, done here with ExcelJS so the test needs no Python. */
const edit = (change: (workbook: ExcelJS.Workbook) => void, tail = '') => async ({ workbook: file }: { workbook: string }) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  change(workbook);
  await workbook.xlsx.writeFile(file);
  // A part of the package Hello's writer does not carry, as a real entry of it.
  if (tail) { const zip = await JSZip.loadAsync(await readFile(file)); zip.file(tail, '<chartSpace/>'); await writeFile(file, await zip.generateAsync({ type: 'nodebuffer' })); }
  return { exitCode: 0, output: 'done\n' };
};

/** A chart put into a workbook file the way a package holds one: the sheet names a drawing, the drawing a chart. */
async function chartOn(bytes: Uint8Array | Buffer, sheetFile: string, cells: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes);
  const sheet = `xl/worksheets/${sheetFile}`;
  zip.file(sheet, (await zip.files[sheet].async('string')).replace('</worksheet>', '<drawing r:id="rId9"/></worksheet>'));
  const rels = `xl/worksheets/_rels/${sheetFile}.rels`;
  const line = '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>';
  const had = await zip.files[rels]?.async('string');
  zip.file(rels, had ? had.replace('</Relationships>', `${line}</Relationships>`) : `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${line}</Relationships>`);
  zip.file('xl/drawings/drawing1.xml', '<xdr:wsDr xmlns:xdr="x" xmlns:a="a" xmlns:c="c" xmlns:r="r"><xdr:oneCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row></xdr:from><xdr:graphicFrame><a:graphic><a:graphicData><c:chart r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame></xdr:oneCellAnchor></xdr:wsDr>');
  zip.file('xl/drawings/_rels/drawing1.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="/xl/charts/chart1.xml"/></Relationships>');
  zip.file('xl/charts/chart1.xml', `<c:chartSpace xmlns:c="c"><c:chart><c:plotArea><c:barChart><c:ser><c:val><c:numRef><c:f>${cells}</c:f></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`);
  zip.file('[Content_Types].xml', (await zip.files['[Content_Types].xml'].async('string')).replace('</Types>',
    '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>'));
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('the charts of a workbook Hello’s own writer changes', () => {
  const plain = async (sheets: string[]) => {
    const workbook = new ExcelJS.Workbook();
    for (const name of sheets) workbook.addWorksheet(name).getCell('A1').value = 1;
    return new Uint8Array(await workbook.xlsx.writeBuffer());
  };

  it('come across from the file that had them, by sheet name, as parts of the package', async () => {
    const carrier = await chartOn(await plain(['Date', 'Grafic']), 'sheet2.xml', 'Date!$A$1:$A$4');
    // The same workbook as Hello writes it next: a sheet more, in another order, and no chart.
    const carried = await withCharts(await plain(['Nou', 'Grafic', 'Date']), carrier);
    expect(carried?.charts).toBe(1);
    expect(await chartsIn(carried!.bytes)).toEqual([{ sheet: 'Grafic', type: 'bar', anchor: 'D2', values: ['Date!$A$1:$A$4'], categories: [], cached: false }]);
    const zip = await JSZip.loadAsync(carried!.bytes);
    expect(await zip.files['xl/worksheets/sheet2.xml'].async('string')).toMatch(/<drawing r:id="rId\d+"\/><\/worksheet>$/);
    expect(await zip.files['xl/worksheets/sheet1.xml'].async('string')).not.toContain('<drawing');
    expect(await zip.files['xl/worksheets/_rels/sheet2.xml.rels'].async('string')).toContain('Target="../drawings/drawing1.xml"');
    const types = await zip.files['[Content_Types].xml'].async('string');
    expect(types).toContain('PartName="/xl/drawings/drawing1.xml"');
    expect(types).toContain('PartName="/xl/charts/chart1.xml"');
    // The sheet that held the chart is gone: the chart goes with it, and that is not a failure.
    expect(await withCharts(await plain(['Date']), carrier)).toMatchObject({ charts: 0 });
    // A chart no sheet places, or a file with drawings of its own: not guessed at.
    const orphan = await JSZip.loadAsync(await plain(['Date']));
    orphan.file('xl/charts/chart1.xml', '<chartSpace/>');
    expect(await withCharts(await plain(['Date']), await orphan.generateAsync({ type: 'uint8array' }))).toBeNull();
    expect(await withCharts(carrier, carrier)).toBeNull();
  });

  it('stay through a write, a grouped table and typing in the pane, and leave with their sheet', async () => {
    const source = new ExcelJS.Workbook();
    const data = source.addWorksheet('Date');
    [['Judet'], ['Timis'], ['Cluj'], ['Timis']].forEach((row, index) => { data.getCell(index + 1, 1).value = row[0]; });
    await source.xlsx.writeFile(join(folder, 'date.xlsx'));
    const opened = await books.openFile(chat, 'date.xlsx');
    // What a chart script leaves: a sheet for the chart, and the chart on it.
    const ran = await books.runScript(chat, opened.id, async ({ workbook: file }) => {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(file);
      workbook.addWorksheet('Grafic');
      await writeFile(file, await chartOn(Buffer.from(await workbook.xlsx.writeBuffer()), 'sheet2.xml', 'Date!$A$2:$A$4'));
      return { exitCode: 0, output: '' };
    });
    expect(ran.info).toMatchObject({ scripted: ['charts'], sheets: ['Date', 'Grafic'] });
    expect(ran.charts).toHaveLength(1);
    // The tools that make tables go on working, and so does typing.
    await books.write(chat, opened.id, 'Date', [{ row: 5, column: 1, input: 'Cluj' }], 'model');
    const grouped = await books.group(chat, opened.id, { sheet: 'Date', by: ['Judet'], into: 'Pe judet' });
    expect(grouped.preview).toEqual([['Cluj', 2], ['Timis', 2]]);
    await books.write(chat, opened.id, 'Date', [{ row: 6, column: 1, input: 'Arad' }], 'person');
    const now = await books.describe(chat, opened.id);
    expect(now.info).toMatchObject({ scripted: ['charts'], sheets: ['Date', 'Grafic', 'Pe judet'], dirty: true });
    expect(now.charts).toEqual([{ sheet: 'Grafic', type: 'bar', anchor: 'D2', values: ['Date!$A$2:$A$4'], categories: [], cached: false }]);
    // Saved over the file, the file has the table and the chart; a restart reads the same.
    await books.save(chat, opened.id);
    expect(await chartsIn(new Uint8Array(await readFile(join(folder, 'date.xlsx'))))).toHaveLength(1);
    const again = new Workbooks({ dataDir: join(root, 'data'), resolveFile: async (_id, path) => ({ absolute: resolve(folder, path), relative: path }) });
    expect((await again.describe(chat, opened.id)).charts).toHaveLength(1);
    expect((await again.read(chat, opened.id, 'Pe judet', { top: 2, left: 1, bottom: 3, right: 2 })).rows).toEqual([['Cluj', 2], ['Timis', 2]]);
    // The sheet a script made is the model's to remove, and its chart goes with it.
    const left = await again.removeSheet(chat, opened.id, 'Grafic');
    expect(left.scripted).toBeUndefined();
    expect((await again.describe(chat, opened.id)).charts).toEqual([]);
  });
});

describe('a script on a workbook', () => {
  it('works on the workbook’s own file, and what it wrote is read back and computed', async () => {
    const made = await books.create(chat, 'x');
    await books.write(chat, made.id, undefined, [{ row: 1, column: 1, input: 2 }], 'model');
    // As openpyxl leaves it: a formula with no value beside it.
    const ran = await books.runScript(chat, made.id, edit(workbook => { workbook.worksheets[0].getCell('A2').value = { formula: 'A1*21' }; workbook.addWorksheet('Nou'); }));
    expect(ran).toMatchObject({ exitCode: 0, output: 'done\n', changed: true, restored: false, recalc: { recalculated: true, formulas: 1, errors: [] } });
    expect(ran.info).toMatchObject({ sheets: ['Sheet1', 'Nou'], revision: made.revision + 2 });
    expect(ran.info.scripted).toBeUndefined();
    expect((await books.read(chat, made.id, 'Sheet1')).rows).toEqual([[2], [42]]);
    // Nothing it cannot carry was added, so Hello's own tools go on working, and a restart finds the same.
    await books.write(chat, made.id, 'Sheet1', [{ row: 3, column: 1, input: '=A2+1' }], 'model');
    const again = new Workbooks({ dataDir: join(root, 'data'), resolveFile: async () => { throw new Error('unused'); } });
    expect((await again.read(chat, made.id, 'Sheet1')).rows).toEqual([[2], [42], [43]]);
  });

  it('is undone when it leaves something that is not a workbook, and changes nothing when it saves nothing', async () => {
    const made = await books.create(chat, 'x');
    await books.write(chat, made.id, undefined, [{ row: 1, column: 1, input: 'intact' }], 'model');
    const broken = await books.runScript(chat, made.id, async ({ workbook }) => { await writeFile(workbook, 'not a zip'); return { exitCode: 1, output: 'Traceback' }; });
    expect(broken).toMatchObject({ exitCode: 1, changed: false, restored: true });
    expect((await books.read(chat, made.id)).rows).toEqual([['intact']]);
    const idle = await books.runScript(chat, made.id, async () => ({ exitCode: 0, output: 'printed only' }));
    expect(idle).toMatchObject({ changed: false, restored: false, output: 'printed only' });
    const thrown = await books.runScript(chat, made.id, async () => { throw new Error('timed out'); });
    expect(thrown).toMatchObject({ exitCode: null, output: 'timed out', changed: false });
  });

  it('keeps a chart it cannot carry: Hello’s own writer is refused, nothing changes, and the file is handed over as it is', async () => {
    const source = new ExcelJS.Workbook();
    source.addWorksheet('Date').getCell('A1').value = 5;
    await source.xlsx.writeFile(join(folder, 'date.xlsx'));
    const opened = await books.openFile(chat, 'date.xlsx');
    const original = await readFile(join(folder, 'date.xlsx'));
    const ran = await books.runScript(chat, opened.id, edit(workbook => { workbook.worksheets[0].getCell('B1').value = { formula: 'A1*2' }; }, 'xl/charts/chart1.xml'));
    expect(ran.info).toMatchObject({ scripted: ['charts'], dirty: true });
    // The person's file is untouched until a save.
    expect((await readFile(join(folder, 'date.xlsx'))).equals(original)).toBe(true);
    // Values are computed for reading even though the file holds none.
    expect((await books.read(chat, opened.id)).rows).toEqual([[5, 10]]);
    await expect(books.write(chat, opened.id, 'Date', [{ row: 2, column: 1, input: 1 }], 'model')).rejects.toThrow(/holds charts that a script made.*sheet_script/);
    await expect(books.write(chat, opened.id, 'Date', [{ row: 2, column: 1, input: 1 }], 'person')).rejects.toThrow(/holds charts/);
    await expect(books.write(chat, opened.id, 'Alta', [{ row: 1, column: 1, input: 1 }], 'model')).rejects.toThrow(/holds charts/);
    // A refused change left nothing behind: no cell, no sheet.
    expect((await books.read(chat, opened.id)).rows).toEqual([[5, 10]]);
    expect((await books.get(chat, opened.id)).sheets).toEqual(['Date']);
    // A copy and a save carry the script's bytes, chart included; a restart still knows.
    await books.exportTo(chat, opened.id, join(folder, 'copie.xlsx'));
    expect((await readFile(join(folder, 'copie.xlsx'))).includes('xl/charts/chart1.xml')).toBe(true);
    const again = new Workbooks({ dataDir: join(root, 'data'), resolveFile: async (_id, path) => ({ absolute: resolve(folder, path), relative: path }) });
    expect((await again.list(chat))[0]).toMatchObject({ scripted: ['charts'], dirty: true });
    expect((await again.read(chat, opened.id)).rows).toEqual([[5, 10]]);
    await again.save(chat, opened.id);
    expect((await readFile(join(folder, 'date.xlsx'))).includes('xl/charts/chart1.xml')).toBe(true);
    // The next script that saves without the chart gives the workbook back to Hello's tools.
    const cleared = await again.runScript(chat, opened.id, edit(() => {}));
    expect(cleared.info.scripted).toBeUndefined();
    await again.write(chat, opened.id, 'Date', [{ row: 2, column: 1, input: 1 }], 'model');
  });
});

describe('the charts a file holds', () => {
  const pack = async (parts: Record<string, string>) => {
    const zip = new JSZip();
    for (const [name, xml] of Object.entries(parts)) zip.file(name, xml);
    return zip.generateAsync({ type: 'uint8array' });
  };
  const chart = (kind: string, title: string, values: string) => `<c:chartSpace xmlns:c="c" xmlns:a="a"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>${title}</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:${kind}Chart><c:ser><c:cat><c:strRef><c:f>Date!$A$2:$A$5</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${values}</c:f></c:numRef></c:val></c:ser></c:${kind}Chart></c:plotArea></c:chart></c:chartSpace>`;
  const anchor = (column: number, row: number, id: string) => `<xdr:twoCellAnchor><xdr:from><xdr:col>${column}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row></xdr:from><xdr:graphicFrame><a:graphic><a:graphicData><c:chart r:id="${id}"/></a:graphicData></a:graphic></xdr:graphicFrame></xdr:twoCellAnchor>`;

  it('are read from the package as Excel writes it: prefixed tags, relative targets, one anchor each', async () => {
    const bytes = await pack({
      'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Sediu" sheetId="1" r:id="rId1"/><sheet name="Date &amp; Grafic" sheetId="2" r:id="rId2"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="t/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="t/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
      'xl/worksheets/_rels/sheet2.xml.rels': '<Relationships><Relationship Id="rId1" Type="http://x/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>',
      'xl/drawings/drawing1.xml': `<xdr:wsDr xmlns:xdr="x">${anchor(5, 1, 'rId1')}${anchor(5, 20, 'rId2')}<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:row>0</xdr:row></xdr:from><xdr:pic/></xdr:twoCellAnchor></xdr:wsDr>`,
      'xl/drawings/_rels/drawing1.xml.rels': '<Relationships><Relationship Id="rId1" Type="t/chart" Target="../charts/chart1.xml"/><Relationship Id="rId2" Type="t/chart" Target="/xl/charts/chart2.xml"/></Relationships>',
      'xl/charts/chart1.xml': chart('pie', 'Top 15', 'Date!$B$2:$B$5'),
      'xl/charts/chart2.xml': chart('pie', 'Top 15', 'Date!$B$2:$B$5'),
    });
    const charts = await chartsIn(bytes);
    expect(charts).toEqual([
      { sheet: 'Date & Grafic', type: 'pie', title: 'Top 15', anchor: 'F2', values: ['Date!$B$2:$B$5'], categories: ['Date!$A$2:$A$5'], labelsAs: 'text', cached: false },
      { sheet: 'Date & Grafic', type: 'pie', title: 'Top 15', anchor: 'F21', values: ['Date!$B$2:$B$5'], categories: ['Date!$A$2:$A$5'], labelsAs: 'text', cached: false },
    ]);
    // The same cells as the same kind of chart, twice on one sheet: the second is the leftover.
    expect(repeatedCharts(charts)).toEqual([charts[1]]);
    expect(repeatedCharts([charts[0], { ...charts[1], type: 'bar' }])).toEqual([]);
    expect(await chartsIn(new Uint8Array([1, 2, 3]))).toEqual([]);
  });
});

describe('the values a script-made file carries', () => {
  it('are written beside each formula that had none, by its kind, and nothing else is touched', async () => {
    const zip = new JSZip();
    zip.file('xl/workbook.xml', '<workbook xmlns:r="r"><sheets><sheet name="Date" sheetId="1" r:id="rId1"/></sheets></workbook>');
    zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Type="t/worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>');
    zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="n"><v>2</v></c><c r="B1" s="3"><f>A1*21</f><v /></c><c r="C1"><f>IF(A1&gt;1,"da","nu")</f><v></v></c><c r="D1"><f>A1&gt;1</f></c><c r="E1"><f>1/0</f><v /></c><c r="F1"><f>A1+1</f><v>9</v></c></row></sheetData></worksheet>');
    zip.file('xl/charts/chart1.xml', '<chartSpace/>');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Date');
    sheet.getCell('A1').value = 2;
    sheet.getCell('B1').value = { formula: 'A1*21', result: 42 };
    sheet.getCell('C1').value = { formula: 'IF(A1>1,"da","nu")', result: 'da & <nu>' };
    sheet.getCell('D1').value = { formula: 'A1>1', result: true };
    sheet.getCell('E1').value = { formula: '1/0', result: { error: '#DIV/0!' } as never };
    sheet.getCell('F1').value = { formula: 'A1+1', result: 3 };
    const out = await JSZip.loadAsync(await withCachedValues(await zip.generateAsync({ type: 'uint8array' }), workbook));
    const xml = await out.files['xl/worksheets/sheet1.xml'].async('string');
    expect(xml).toContain('<c r="B1" s="3"><f>A1*21</f><v>42</v></c>');
    expect(xml).toContain('<c r="C1" t="str"><f>IF(A1&gt;1,"da","nu")</f><v>da &amp; &lt;nu&gt;</v></c>');
    expect(xml).toContain('<c r="D1" t="b"><f>A1&gt;1</f><v>1</v></c>');
    expect(xml).toContain('<c r="E1" t="e"><f>1/0</f><v>#DIV/0!</v></c>');
    // A value the file already had is the file's; a plain number is left alone; so is every other part.
    expect(xml).toContain('<c r="F1"><f>A1+1</f><v>9</v></c>');
    expect(xml).toContain('<c r="A1" t="n"><v>2</v></c>');
    expect(await out.files['xl/charts/chart1.xml'].async('string')).toBe('<chartSpace/>');
  });
});

describe('the Python scripts run in', () => {
  const recorded: string[] = [];
  const shell = (answers: Record<string, { exitCode: number | null; output: string }>): SheetShell => async command => {
    recorded.push(command);
    const hit = Object.keys(answers).find(part => command.includes(part));
    return hit ? answers[hit] : { exitCode: 0, output: '' };
  };
  beforeEach(() => { recorded.length = 0; });

  it('is made once, in the app’s data, with openpyxl required and pandas optional', async () => {
    const home = join(root, 'python');
    const python = new SheetPython(home, async (command, cwd, signal, timeout) => {
      // Stand in for venv: the interpreter appears where python3 -m venv would put it.
      if (command.startsWith('python3 -m venv')) { await mkdir(join(home, 'venv', 'bin'), { recursive: true }); await writeFile(join(home, 'venv', 'bin', 'python'), ''); }
      return shell({ 'import json': { exitCode: 0, output: '{"openpyxl": "3.1.5", "pandas": null, "python": "3.15.2"}\n' }, 'pandas': { exitCode: 1, output: 'no matching distribution' } })(command, cwd, signal, timeout);
    });
    expect(await python.status()).toBeNull();
    const status = await python.prepare(new AbortController().signal);
    expect(status).toEqual({ openpyxl: '3.1.5', pandas: null, python: '3.15.2' });
    expect(recorded[0]).toBe(`python3 -m venv ${quote(join(home, 'venv'))}`);
    expect(recorded[1]).toContain('-m pip install --disable-pip-version-check --no-input openpyxl');
    expect(recorded[2]).toContain('--only-binary=:all: pandas');
    // The second time nothing is installed.
    recorded.length = 0;
    expect(await python.prepare(new AbortController().signal)).toEqual(status);
    expect(recorded).toEqual([]);
    await python.run('print(WORKBOOK)', { workbook: "/a/it's.xlsx", folder: join(root, 'out') }, new AbortController().signal, 30);
    expect(recorded[0]).toContain(`HELLO_WORKBOOK='/a/it'\\''s.xlsx'`);
    expect(await readFile(join(root, 'out', 'script.py'), 'utf8')).toMatch(/^import os\nWORKBOOK = os\.environ\['HELLO_WORKBOOK'\][^]*\nprint\(WORKBOOK\)$/);
  });

  it('says what is missing when there is no Python or no network', async () => {
    const none = new SheetPython(join(root, 'p1'), shell({ 'python3 -m venv': { exitCode: 127, output: 'sh: python3: command not found' } }));
    await expect(none.prepare(new AbortController().signal)).rejects.toThrow(/Python 3 is needed.*command not found/);
    const home = join(root, 'p2');
    const offline = new SheetPython(home, async (command, ...rest) => {
      if (command.startsWith('python3 -m venv')) { await mkdir(join(home, 'venv', 'bin'), { recursive: true }); await writeFile(join(home, 'venv', 'bin', 'python'), ''); }
      return shell({ 'openpyxl': { exitCode: 1, output: 'Could not fetch URL' } })(command, ...rest);
    });
    await expect(offline.prepare(new AbortController().signal)).rejects.toThrow(/openpyxl could not be installed/);
    expect(await offline.status()).toBeNull();
  });
});

describe('sheet_script', () => {
  it('asks first, and without an answer runs nothing', async () => {
    const made = await books.create(chat, 'x');
    const ran: string[] = [];
    const python = { prepare: async () => ({ openpyxl: '3.1.5', pandas: null, python: '3.15.2' }), run: async (code: string) => { ran.push(code); return { exitCode: 0, output: 'salut\n' }; } } as unknown as SheetPython;
    const context = (allow: boolean): SheetToolContext => ({ books, conversationId: chat, signal: new AbortController().signal, approve: async () => allow, writable: async path => path, python });
    await expect(executeSheetTool('sheet_script', { workbook: made.id, code: 'print(1)' }, context(false))).rejects.toThrow(/declined this script/);
    expect(ran).toEqual([]);
    const result = await executeSheetTool('sheet_script', { workbook: made.id, code: 'print("salut")' }, context(true)) as Record<string, unknown>;
    expect(result).toMatchObject({ exitCode: 0, output: 'salut\n', changed: false });
    // Which Python, and where, is said when a script fails — not on every one that ran.
    expect(result).not.toHaveProperty('python');
    expect(result).not.toHaveProperty('pythonPath');
    expect(result.note).toMatch(/must wb\.save\(WORKBOOK\)/);
    await expect(executeSheetTool('sheet_script', { workbook: made.id, code: 'x' }, { ...context(true), python: undefined })).rejects.toThrow(/cannot run in this app/);
  });

  it.skipIf(!realPython)('makes a real chart with openpyxl that Hello reads back, keeps and hands over', async () => {
    const run = (file: string, env: Record<string, string>) => new Promise<{ exitCode: number | null; output: string }>(done =>
      execFile(realPython!, [file], { env: { ...process.env, ...env } }, (error, stdout, stderr) => done({ exitCode: error ? Number((error as { code?: number }).code ?? 1) : 0, output: stdout + stderr })));
    const python = { interpreter: realPython, status: async () => ({ openpyxl: 'real', pandas: null, python: 'real' }), prepare: async () => ({ openpyxl: 'real', pandas: null, python: 'real' }),
      run: async (code: string, paths: { workbook: string; folder: string }) => {
        const file = join(paths.folder, 'script.py');
        await writeFile(file, `import os\nWORKBOOK = os.environ['HELLO_WORKBOOK']\nOUT = os.environ['HELLO_OUT']\n${code}`);
        return run(file, { HELLO_WORKBOOK: paths.workbook, HELLO_OUT: paths.folder });
      } } as unknown as SheetPython;
    const context: SheetToolContext = { books, conversationId: chat, signal: new AbortController().signal, approve: async () => true, writable: async path => resolve(folder, path), python };
    const made = await books.create(chat, 'Retea', ['Magazine']);
    await books.write(chat, made.id, 'Magazine', [['Judet', 'Magazine'], ['Timis', 163], ['Bucuresti', 129], ['Cluj', 100]].flatMap((row, y) => row.map((input, x) => ({ row: y + 1, column: x + 1, input }))), 'model');
    const result = await executeSheetTool('sheet_script', { workbook: made.id, code: [
      'import openpyxl',
      'from openpyxl.chart import BarChart, Reference',
      'wb = openpyxl.load_workbook(WORKBOOK)',
      'ws = wb["Magazine"]',
      'ws["A5"] = "Total"; ws["B5"] = "=SUM(B2:B4)"',
      'ws.merge_cells("D1:F1"); ws["D1"] = "Top judete"; ws.freeze_panes = "A2"',
      'chart = BarChart(); chart.title = "Top judete"',
      'chart.add_data(Reference(ws, min_col=2, min_row=1, max_row=4), titles_from_data=True)',
      'chart.set_categories(Reference(ws, min_col=1, min_row=2, max_row=4))',
      'ws.add_chart(chart, "D3")',
      'wb.save(WORKBOOK)',
      'print("rows", ws.max_row)',
    ].join('\n') }, context) as Record<string, unknown>;
    expect(result).toMatchObject({ exitCode: 0, output: 'rows 5\n', changed: true, holds: ['charts'], errors: [], formulasInWorkbook: 1 });
    expect((await books.read(chat, made.id, 'Magazine', { top: 5, left: 1, bottom: 5, right: 2 })).rows).toEqual([['Total', 392]]);
    expect(result.charts).toEqual([{ sheet: 'Magazine', type: 'bar', title: 'Top judete', anchor: 'D3', values: ["'Magazine'!$B$2:$B$4"], categories: ["'Magazine'!$A$2:$A$4"], labelsAs: 'numbers', cached: false }]);
    // A later script that only touches a cell keeps the chart: openpyxl loads what the file holds.
    const kept = await executeSheetTool('sheet_script', { workbook: made.id, code: 'import openpyxl\nwb = openpyxl.load_workbook(WORKBOOK)\nwb["Magazine"]["A6"] = "nota"\nwb.save(WORKBOOK)' }, context) as { charts: unknown[]; note: string };
    // The charts are the same as before the script, so the result does not list them again; they are still there.
    expect(kept).not.toHaveProperty('charts');
    expect((await books.describe(chat, made.id)).charts).toHaveLength(1);
    expect(kept.note).not.toMatch(/leftover/);
    // Adding "the" chart again leaves two, and the result says so and how to redo it.
    const again = ['import openpyxl', 'from openpyxl.chart import BarChart, Reference', 'wb = openpyxl.load_workbook(WORKBOOK)', 'ws = wb["Magazine"]', 'CLEAR',
      'chart = BarChart()', 'chart.add_data(Reference(ws, min_col=2, min_row=1, max_row=4), titles_from_data=True)',
      'chart.set_categories(Reference(ws, min_col=1, min_row=2, max_row=4))', 'ws.add_chart(chart, "D3")', 'wb.save(WORKBOOK)'].join('\n');
    const doubled = await executeSheetTool('sheet_script', { workbook: made.id, code: again.replace('CLEAR', 'pass') }, context) as { charts: unknown[]; note: string };
    expect(doubled.charts).toHaveLength(2);
    expect(doubled.note).toMatch(/1 chart draws the same cells as another chart of the same sheet \(Magazine D3\): a leftover.*ws\._charts = \[\]/);
    const redone = await executeSheetTool('sheet_script', { workbook: made.id, code: again.replace('CLEAR', 'ws._charts = []') }, context) as { charts: unknown[]; note: string };
    expect(redone.charts).toHaveLength(1);
    expect(redone.note).not.toMatch(/leftover/);
    expect((await books.describe(chat, made.id)).charts).toHaveLength(1);
    // sheet_chart: a chart from two ranges, no script from the model; asking again at the same place replaces it.
    const pie = await executeSheetTool('sheet_chart', { workbook: made.id, sheet: 'magazine', type: 'pie', categories: 'A2:A4', values: 'B2:B4', title: 'Pe judete', anchor: 'H2' }, context) as { chart: unknown; charts: unknown[]; note: string };
    expect(pie.chart).toEqual({ sheet: 'Magazine', type: 'pie', title: 'Pe judete', anchor: 'H2', values: ["'Magazine'!$B$2:$B$4"], categories: ["'Magazine'!$A$2:$A$4"], labelsAs: 'text', cached: true });
    expect(pie.note).toMatch(/^A pie chart of Magazine!B2:B4 by A2:A4 is in Magazine at H2 and follows those cells; `charts` lists every chart the file now holds, read back from it\.$/);
    expect(pie.charts).toHaveLength(2);
    const column = await executeSheetTool('sheet_chart', { workbook: made.id, sheet: 'Magazine', type: 'column', categories: 'A2:A4', values: 'B2:B4', anchor: 'H2' }, context) as { chart: { type: string }; charts: unknown[] };
    expect(column.chart).toMatchObject({ type: 'bar', anchor: 'H2' });
    expect(column.charts).toHaveLength(2);
    // Without an anchor it goes beside the used cells.
    const beside = await executeSheetTool('sheet_chart', { workbook: made.id, sheet: 'Magazine', type: 'line', categories: 'A2:A4', values: 'B2:B4' }, context) as { chart: { anchor: string } };
    expect(beside.chart.anchor).toBe('H2');
    // Ranges written as a formula writes them — with their sheet, with $ — are those cells; `sheet`, when it is another, is where the chart goes.
    const qualified = await executeSheetTool('sheet_chart', { workbook: made.id, sheet: 'Magazine', type: 'line', categories: "'Magazine'!$A$2:$A$4", values: 'Magazine!$B$2:$B$4', anchor: 'H2' }, context) as { chart: { anchor: string; values: string[] }; charts: unknown[] };
    expect(qualified.chart).toMatchObject({ anchor: 'H2', values: ["'Magazine'!$B$2:$B$4"] });
    expect(qualified.charts).toHaveLength(2);
    await expect(executeSheetTool('sheet_chart', { workbook: made.id, sheet: 'Magazine', type: 'line', categories: 'Magazine!A2:A4', values: 'Alta!B2:B4' }, context)).rejects.toThrow(/cells of one sheet/);
    // "A pie on a sheet of its own": the chart sits on another sheet, made for it, and draws the first sheet's cells.
    const apart = await executeSheetTool('sheet_chart', { workbook: made.id, sheet: 'Magazine', into: 'Grafic', type: 'pie', categories: 'A2:A4', values: 'B2:B4', title: 'Separat' }, context) as { sheet: string; chart: unknown; charts: unknown[]; note: string };
    expect(apart.sheet).toBe('Grafic');
    expect(apart.chart).toEqual({ sheet: 'Grafic', type: 'pie', title: 'Separat', anchor: 'A1', values: ["'Magazine'!$B$2:$B$4"], categories: ["'Magazine'!$A$2:$A$4"], labelsAs: 'text', cached: true });
    expect(apart.note).toMatch(/A pie chart of Magazine!B2:B4 by A2:A4 is in Grafic at A1/);
    expect((await books.describe(chat, made.id)).info.sheets).toEqual(['Magazine', 'Grafic']);
    await expect(executeSheetTool('sheet_chart', { workbook: made.id, sheet: 'Magazine', type: 'pie', categories: 'A2:A4', values: 'B2:B9' }, context)).rejects.toThrow(/3 cells and values 8/);
    await expect(executeSheetTool('sheet_chart', { workbook: made.id, sheet: 'Lipsa', type: 'pie', categories: 'A2:A4', values: 'B2:B4' }, context)).rejects.toThrow(/no sheet "Lipsa"/);
    // A save says, from the file on disk, which charts went with it: nothing to open again and nothing to unzip.
    const savedAs = await executeSheetTool('sheet_save', { workbook: made.id, path: 'predat.xlsx' }, context) as string;
    expect(savedAs).toMatch(/^Wrote predat\.xlsx .*Read back from the file on disk, it holds 3 charts: bar in Magazine at D3; line in Magazine at H2; pie “Separat” in Grafic at A1\.$/);
    // Opened all the same, the copy says its charts are in it rather than that they were not carried.
    const second = { ...context, books: new Workbooks({ dataDir: join(root, 'data2'), resolveFile: async (_id, path) => ({ absolute: resolve(folder, path), relative: path }) }) };
    const reopened = await executeSheetTool('sheet_open', { path: 'predat.xlsx' }, second) as { workbook: string; holds: string[]; charts: unknown[]; note: string };
    expect(reopened.holds).toEqual(['charts']);
    expect(reopened.charts).toHaveLength(3);
    expect(reopened.note).toBe('Its charts are not drawn or read here — charts lists them — and they stay in the file through every sheet tool.');
    // Said once, at the opening: a read after it is the cells asked for and nothing about the file again.
    const read = await executeSheetTool('sheet_read', { workbook: reopened.workbook, sheet: 'Magazine', range: 'A1:B2' }, second) as Record<string, unknown>;
    expect(Object.keys(read)).toEqual(['workbook', 'sheet', 'range', 'used', 'rows', 'formulas']);
    expect(read.rows).toEqual([['Judet', 'Magazine'], ['Timis', 163]]);
    // And they do stay: a file that came with charts is changed with the table tools and saved over itself, charts and all.
    const changed = await executeSheetTool('sheet_write', { workbook: reopened.workbook, sheet: 'Magazine', cells: [{ cell: 'A7', value: 'după' }] }, second) as { unsavedChanges: boolean };
    expect(changed.unsavedChanges).toBe(true);
    expect((await second.books.describe(chat, reopened.workbook)).charts).toHaveLength(3);
    expect(await executeSheetTool('sheet_save', { workbook: reopened.workbook }, second)).toMatch(/^Saved predat\.xlsx\..*it holds 3 charts/);
    const stayed = await executeSheetTool('sheet_script', { workbook: reopened.workbook, code: 'import openpyxl\nwb = openpyxl.load_workbook(WORKBOOK)\nprint(wb["Magazine"]["A7"].value, sum(len(ws._charts) for ws in wb.worksheets))' }, second) as { output: string };
    expect(stayed.output).toBe('după 3\n');
    await books.exportTo(chat, made.id, join(folder, 'cu-grafic.xlsx'));
    expect((await readFile(join(folder, 'cu-grafic.xlsx'))).includes('xl/charts/chart1.xml')).toBe(true);
    // The file a script left carries what its formulas came to: openpyxl writes none, and without them
    // it opens empty everywhere but in Excel. The chart parts are still there, untouched.
    const handed = await JSZip.loadAsync(await readFile(join(folder, 'cu-grafic.xlsx')));
    const sheetXml = await handed.files['xl/worksheets/sheet1.xml'].async('string');
    expect(sheetXml).toMatch(/<c r="B5"[^>]*><f>SUM\(B2:B4\)<\/f><v>392<\/v><\/c>/);
    expect(Object.keys(handed.files).filter(name => /^xl\/charts\/chart\d+\.xml$/.test(name))).toHaveLength(3);
    // And the chart sheet_chart made carries its own points.
    const chartXml = (await Promise.all(Object.keys(handed.files).filter(name => /^xl\/charts\/chart\d+\.xml$/.test(name)).map(name => handed.files[name].async('string')))).find(xml => xml.includes('lineChart'))!;
    expect(chartXml).toMatch(/<cat><strRef><f>'Magazine'!\$A\$2:\$A\$4<\/f><strCache>/);
    expect(chartXml).toMatch(/<numCache>[\s\S]*<v>163<\/v>/);
    // A pie says only its share on a slice: left unsaid, Excel adds the series name, the value and the legend key.
    const pieXml = (await Promise.all(Object.keys(handed.files).filter(name => /^xl\/charts\/chart\d+\.xml$/.test(name)).map(name => handed.files[name].async('string')))).find(xml => xml.includes('pieChart'))!;
    expect(pieXml).toMatch(/<showVal val="0" ?\/>/);
    expect(pieXml).toMatch(/<showSerName val="0" ?\/>/);
    expect(pieXml).toMatch(/<showPercent val="1" ?\/>/);
    // Left unsaid, Excel rounds the frame and lays legend and title over the plot, and openpyxl leaves the axes out.
    expect(pieXml).toMatch(/<roundedCorners val="0" ?\/>/);
    expect(pieXml).toMatch(/<legend><legendPos val="r" ?\/><overlay val="0" ?\/><\/legend>/);
    expect(pieXml).toMatch(/<\/tx><overlay val="0" ?\/>/);
    expect(chartXml).toMatch(/<roundedCorners val="0" ?\/>/);
    expect(chartXml.match(/<delete val="0" ?\/>/g)).toHaveLength(2);
    // After a chart the table tools still work, and openpyxl reads the file they leave with every chart in place.
    const wrote = await executeSheetTool('sheet_write', { workbook: made.id, sheet: 'Multe', values: [['Judet', 'Magazine'], ...Array.from({ length: 12 }, (_item, index) => [`J${index + 1}`, (index + 1) * 10]), ['Total', '=SUM(B2:B13)']] }, context) as { sheetAdded: boolean; errors: unknown[] };
    expect(wrote).toMatchObject({ sheetAdded: true, errors: [] });
    const counted = await executeSheetTool('sheet_group', { workbook: made.id, sheet: 'Magazine', by: ['Judet'], into: 'Pe judet' }, context) as { groups: number };
    expect(counted.groups).toBeGreaterThan(2);
    expect((await books.describe(chat, made.id)).charts).toHaveLength(3);
    const seen = await executeSheetTool('sheet_script', { workbook: made.id, code: 'import openpyxl\nwb = openpyxl.load_workbook(WORKBOOK)\nprint(sorted((ws.title, len(ws._charts)) for ws in wb.worksheets))' }, context) as { output: string; charts: unknown[] };
    expect(seen.output).toBe("[('Grafic', 1), ('Magazine', 2), ('Multe', 0), ('Pe judet', 0)]\n");
    expect(seen).not.toHaveProperty('charts');
    // A pie of twelve groups is drawn as the largest eight and the rest, from a table of its own, without being asked.
    // The ranges are given one row too far, into the table's Total: the sum of the groups is not drawn as one of them.
    const cut = await executeSheetTool('sheet_chart', { workbook: made.id, sheet: 'Multe', into: 'Grafic mare', type: 'pie', categories: 'A2:A14', values: 'B2:B14' }, context) as { chart: unknown; drawn: unknown; note: string; charts: unknown[] };
    expect(cut.drawn).toEqual({ top: 8, of: 12, table: 'Grafic mare!A1:B10' });
    expect(cut.note).toMatch(/A pie chart of Multe!B2:B13 by A2:A13 .*“Total”, is the sum of the others, not a group: it is left out/);
    expect(cut.chart).toEqual({ sheet: 'Grafic mare', type: 'pie', anchor: 'D2', values: ["'Grafic mare'!$B$2:$B$10"], categories: ["'Grafic mare'!$A$2:$A$10"], labelsAs: 'text', cached: true });
    expect(cut.note).toMatch(/It draws the largest 8 of 12 groups and the rest as one, from the table at Grafic mare!A1:B10 \(formulas on your cells\): say it is the top 8\. For every group: top: 12, into: "Grafic mare"\./);
    expect((await books.read(chat, made.id, 'Grafic mare', { top: 1, left: 1, bottom: 10, right: 2 })).rows).toEqual(
      [['Judet', 'Magazine'], ['J12', 120], ['J11', 110], ['J10', 100], ['J9', 90], ['J8', 80], ['J7', 70], ['J6', 60], ['J5', 50], ['Other', 100]]);
    // Asked for every group, at the same place: every group, the same one chart, and the shorter table's rest cleared.
    const all = await executeSheetTool('sheet_chart', { workbook: made.id, sheet: 'Multe', into: 'Grafic mare', type: 'pie', categories: 'A2:A13', values: 'B2:B13', top: 12, anchor: 'D2' }, context) as { chart: { values: string[] }; drawn?: unknown; charts: unknown[]; note: string };
    expect(all.drawn).toBeUndefined();
    expect(all.chart.values).toEqual(["'Multe'!$B$2:$B$13"]);
    expect(all.charts).toHaveLength(4);
    expect(all.note).toMatch(/12 slices is too many to read in a pie/);
    // The table's headers are the ones over the cells charted, and the rest is called what the human would call it.
    const smaller = await executeSheetTool('sheet_chart', { workbook: made.id, sheet: 'Multe', into: 'Grafic mare', type: 'bar', categories: 'A2:A13', values: 'B2:B13', top: 3, anchor: 'D2', other: 'Altele', labels: { count: 'Număr' } }, context) as { drawn: unknown };
    expect(smaller.drawn).toEqual({ top: 3, of: 12, table: 'Grafic mare!A1:B5' });
    expect((await books.read(chat, made.id, 'Grafic mare', { top: 1, left: 1, bottom: 10, right: 2 })).rows).toEqual([['Judet', 'Număr'], ['J12', 120], ['J11', 110], ['J10', 100], ['Altele', 450], [], [], [], [], []]);
    await expect(executeSheetTool('sheet_chart', { workbook: made.id, sheet: 'Multe', type: 'pie', categories: 'A2:A13', values: 'B2:B13', top: 0 }, context)).rejects.toThrow(/top is a whole number/);
    // "A pie of how many per county", straight from the rows: counted, written and drawn in one call, with nothing to hand over.
    await executeSheetTool('sheet_write', { workbook: made.id, sheet: 'Randuri', values: [['Judet', 'Oras'], ...['Timis', 'Timis', 'TIMIS', 'Cluj', 'Cluj', 'Arad', null].map(name => [name, 'x'])] }, context);
    const direct = await executeSheetTool('sheet_chart', { workbook: made.id, sheet: 'Randuri', by: 'Judet', type: 'pie', into: 'Grafic pe judet', title: 'Pe județe', labels: { count: 'Număr' } }, context) as
      { sheet: string; chart: unknown; counted: Record<string, unknown>; note: string };
    expect(direct.sheet).toBe('Grafic pe judet');
    expect(direct.counted).toMatchObject({ from: 'Randuri', table: 'Grafic pe judet!A1:C6', groups: 3, rowsCounted: 6, rowsWithoutFirstKey: 1, firstRows: [['Timis', 3], ['Cluj', 2], ['Arad', 1]], merged: [{ label: 'Timis', spellings: ['Timis', 'TIMIS'] }] });
    expect(direct.chart).toEqual({ sheet: 'Grafic pe judet', type: 'pie', title: 'Pe județe', anchor: 'E2', values: ["'Grafic pe judet'!$B$2:$B$4"], categories: ["'Grafic pe judet'!$A$2:$A$4"], labelsAs: 'text', cached: true });
    expect(direct.note).toMatch(/^Counted from Randuri into the new sheet "Grafic pe judet" \(COUNTIFS, largest first\); the chart is drawn from that table\. 1 row has nothing in that column and is not in the chart: say so, and ask the human whether it belongs in it\./);
    expect((await books.read(chat, made.id, 'Grafic pe judet', { top: 1, left: 1, bottom: 5, right: 2 })).rows).toEqual([['Judet', 'Număr'], ['Timis', 3], ['Cluj', 2], ['Arad', 1], ['Total', 6]]);
    await expect(executeSheetTool('sheet_chart', { workbook: made.id, sheet: 'Randuri', by: 'Judet', categories: 'A2:A4', values: 'B2:B4', type: 'pie' }, context)).rejects.toThrow(/by — the column to count — or categories and values, not both/);
    await expect(executeSheetTool('sheet_chart', { workbook: made.id, sheet: 'Randuri', type: 'pie' }, context)).rejects.toThrow(/Give the cells to chart .* or by, the column of the data to count/);
    // A chart that needs a table of its own, with no sheet named: a sheet called after the chart, never cells written into the sheet it draws — and the same sheet when asked again.
    const own = await executeSheetTool('sheet_chart', { workbook: made.id, sheet: 'Multe', type: 'pie', categories: 'A2:A13', values: 'B2:B13', title: 'Magazine pe judet' }, context) as { sheet: string; drawn: unknown; note: string; charts: unknown[] };
    expect(own).toMatchObject({ sheet: 'Magazine pe judet', drawn: { top: 8, of: 12, table: 'Magazine pe judet!A1:B10' } });
    expect(own.note).toMatch(/on a sheet of its own: say it is the top 8\. For every group: top: 12, into: "Magazine pe judet"\./);
    expect((await books.describe(chat, made.id)).sheets.find(item => item.name === 'Multe')!.columns).toBe(2);
    const asked = await executeSheetTool('sheet_chart', { workbook: made.id, sheet: 'Multe', type: 'pie', categories: 'A2:A13', values: 'B2:B13', title: 'Magazine pe judet', top: 2 }, context) as { sheet: string; charts: unknown[]; note: string };
    expect(asked.sheet).toBe('Magazine pe judet');
    expect(asked.charts).toHaveLength(own.charts.length);
    // Two slices and a rest that is most of the pie: said, with what reads better.
    expect(asked.note).toMatch(/The rest is 71% of the whole, so this pie says little about most of the data: bars of every group \(type: bar, top: 12\) read better/);
    await executeSheetTool('sheet_write', { workbook: made.id, sheet: 'Magazine pe judet', removeSheet: true }, context);
    await executeSheetTool('sheet_write', { workbook: made.id, sheet: 'Grafic pe judet', removeSheet: true }, context);
    await executeSheetTool('sheet_write', { workbook: made.id, sheet: 'Randuri', removeSheet: true }, context);
    // A table a script worked out and wrote as numbers does not follow its data: said in the result, with what to write instead. One written as formulas is not remarked on.
    const flat = await executeSheetTool('sheet_script', { workbook: made.id, code: 'import openpyxl\nwb = openpyxl.load_workbook(WORKBOOK)\nws = wb.create_sheet("Calculat")\nfor row in [("Judet", "Magazine"), ("Timis", 163), ("Cluj", 100), ("Arad", 51), ("Total", 314), ("Media", 104.7)]: ws.append(row)\nwb.save(WORKBOOK)' }, context) as { note: string };
    expect(flat.note).toMatch(/"Calculat" was written with 5 numbers and no formula\. Where a number is a count, a total, a share .* write the formula instead/);
    const live = await executeSheetTool('sheet_script', { workbook: made.id, code: 'import openpyxl\nwb = openpyxl.load_workbook(WORKBOOK)\nws = wb.create_sheet("Viu")\nfor row in [("Judet", "Magazine"), ("Timis", 163), ("Cluj", 100), ("Arad", 51), ("Total", "=SUM(B2:B4)")]: ws.append(row)\nwb.save(WORKBOOK)' }, context) as { note: string };
    expect(live.note).not.toMatch(/no formula/);
    for (const name of ['Calculat', 'Viu']) await executeSheetTool('sheet_write', { workbook: made.id, sheet: name, removeSheet: true }, context);
    // The sheet the chart was put on is the model's to remove.
    const removed = await executeSheetTool('sheet_write', { workbook: made.id, sheet: 'Grafic mare', removeSheet: true }, context) as { sheets: string[] };
    expect(removed.sheets).toEqual(['Magazine', 'Grafic', 'Multe', 'Pe judet']);
    expect((await books.describe(chat, made.id)).charts).toHaveLength(3);
  });
});
