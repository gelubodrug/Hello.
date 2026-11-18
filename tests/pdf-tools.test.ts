import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { helloToolGroups, pdfWork } from '../src/main/chat/tool-groups';
import { toolDefinitions } from '../src/main/chat/tools';
import { PdfPython } from '../src/main/pdf/python';
import { PDF_PROGRAM } from '../src/main/pdf/program';
import { executePdfTool, pdfToolDefinitions, PDF_TOOLS, type PdfToolContext } from '../src/main/pdf/tools';
import type { SheetShell } from '../src/main/sheets/python';

let root: string;
let folder: string;
/** A Python that has pikepdf and Pillow, when the machine running the tests has one: the real program is then run too. */
const realPython = process.env.HELLO_TEST_PYTHON;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'hello-pdf-')));
  folder = join(root, 'folder');
  await mkdir(folder);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const inFolder = async (path: string) => {
  const absolute = resolve(folder, path);
  if (relative(folder, absolute).startsWith('..')) throw new Error('The path is outside this chat’s folder.');
  return absolute;
};
const answers = (result: unknown): PdfPython => ({
  status: async () => ({ pikepdf: '10', pillow: '13', python: '3.14' }), prepare: async () => ({ pikepdf: '10', pillow: '13', python: '3.14' }),
  run: async (job: { output?: string }) => { if (job.output) await writeFile(job.output, 'pdf'); return { exitCode: 0, output: 'level 0 ...\ndone\n', result: JSON.stringify(result) }; },
}) as unknown as PdfPython;
const noShell: SheetShell = async () => ({ exitCode: 127, output: 'sh: pdfinfo: command not found' });
const context = (python: PdfPython, approve = true, saved: string[] = [], shell: SheetShell = noShell): PdfToolContext =>
  ({ signal: new AbortController().signal, approve: async () => approve, readable: inFolder, writable: inFolder, saved: target => { saved.push(target); }, python, shell, work: join(root, 'work') });
const input = { bytes: 17_079_594, pages: 5, imageBytes: 229_953, drawingBytes: 16_831_488, fontBytes: 0, graphicsStates: 4, dominatedBy: 'drawing' };
const levels = [{ level: 0, name: 'lossless', bytes: 16_912_759 }, { level: 1, name: 'two decimals', bytes: 12_987_438 }, { level: 2, name: 'one decimal', bytes: 10_881_418 }, { level: 3, name: 'whole points', bytes: 7_805_344 }];

describe('the PDF tools', () => {
  it('are offered where there is a folder, in a group of their own that a request to shrink a PDF loads', () => {
    expect(pdfToolDefinitions().map(tool => tool.function.name)).toEqual([...PDF_TOOLS]);
    const names = (hasFolder: boolean) => toolDefinitions(hasFolder, false, { skills: [], mcp: [] }).map(tool => tool.function.name).filter(name => name.startsWith('pdf_'));
    expect(names(true)).toEqual(['pdf_read', 'pdf_inspect', 'pdf_compress']);
    expect(names(false)).toEqual([]);
    const group = helloToolGroups(toolDefinitions(true, false, { skills: [], mcp: [] }), { notebooks: { runbook: false, tasks: false }, planning: false, mcp: [] }).find(item => item.id === 'pdf')!;
    expect(group).toMatchObject({ core: false, tools: ['pdf_read', 'pdf_inspect', 'pdf_compress'] });
    // The manual said "everything this needs is in these tools". A model asked tools_find for "read and edit a
    // PDF", believed it, and spent six steps discovering that nothing here edits one (a run, 18.11).
    expect(group.manual).toContain('nothing here CHANGES what a PDF says');
    expect(group.manual).toContain('done in the shell, with a library you bring yourself');
    expect(group.manual).not.toContain('Everything this needs is in these tools');
    for (const rule of ['next names the pages still to read', 'read them as you see them', 'never fill in what you could not make out', 'without turning it into pictures', 'never shrink one by rasterising', 'The original is never changed', 'never rounded toward what was asked', 'not verified', 'Making images smaller loses quality', 'no skill and no web search'])
      expect(group.manual).toContain(rule);
    for (const text of ['comprimă planul.pdf sub 8 MB', 'fă PDF-ul mai mic', 'Compress 01 PROFI ENHANCED U PLAN.pdf to 6 mb', 'pdf-ul e prea mare pentru mail', 'reduce the size of the pdf', 'micșorează plansa.PDF',
      'rezumă raport.pdf', 'ce scrie în pdf?', 'citește pdf-ul scanat', 'find the clause about penalties in the PDF', 'contract.pdf'])
      expect([text, pdfWork(text)]).toEqual([text, true]);
    for (const text of ['comprimă pozele', 'fă un pdf din pagina asta', 'export.pdf.bak e mare', 'exportă raportul ca pdf', 'citește fișierul'])
      expect([text, pdfWork(text)]).toEqual([text, false]);
  });

  it('says what a PDF is made of, and whether compressing it is the right thing', async () => {
    await writeFile(join(folder, 'plan.pdf'), 'x');
    const drawing = await executePdfTool('pdf_inspect', { path: 'plan.pdf' }, context(answers({ input }))) as Record<string, unknown>;
    expect(drawing).toMatchObject({ file: 'plan.pdf', size: '17.08 MB', pages: 5, images: '0.23 MB', drawing: '16.83 MB', mostly: 'drawing' });
    expect(drawing.note).toMatch(/pdf_compress is the right tool/);
    const scan = await executePdfTool('pdf_inspect', { path: 'plan.pdf' }, context(answers({ input: { ...input, imageBytes: 16_000_000, drawingBytes: 900_000, dominatedBy: 'images' } }))) as { note: string };
    expect(scan.note).toMatch(/Most of this file is images.*the human’s to decide/);
    await expect(executePdfTool('pdf_inspect', { path: 'lipsa.pdf' }, context(answers({ input })))).rejects.toThrow(/no file lipsa\.pdf/);
    await expect(executePdfTool('pdf_inspect', { path: 'plan.docx' }, context(answers({ input })))).rejects.toThrow(/a \.pdf file/);
    await expect(executePdfTool('pdf_inspect', { path: '../afara.pdf' }, context(answers({ input })))).rejects.toThrow(/outside/);
  });

  it('compresses into a new file, and reports the real figures and what the comparison found', async () => {
    await writeFile(join(folder, 'plan.pdf'), 'original');
    const saved: string[] = [];
    const good = { input, levels, chosen: levels[3], targetBytes: 8_000_000, reachedTarget: true,
      verification: { done: true, ok: true, pages: [1, 2, 3, 4, 5].map(page => ({ page, differentPixels: 5000, share: 0.002, ok: true })), pagesChecked: 5, pagesInFile: 5, threshold: 0.005 } };
    const done = await executePdfTool('pdf_compress', { path: 'plan.pdf', targetMb: 8 }, context(answers(good), true, saved)) as Record<string, unknown>;
    expect(done).toMatchObject({ file: 'plan.pdf', output: 'plan-compressed.pdf', size: '7.81 MB', smallerBy: '54%', level: 3, target: '8.00 MB', reachedTarget: true, verified: 'the two files render alike', pagesCompared: 5 });
    expect(done.tried).toHaveLength(4);
    expect(done.note).toBe('plan.pdf is unchanged; the result is plan-compressed.pdf, still vector.');
    expect(saved).toEqual([join(folder, 'plan-compressed.pdf')]);
    expect(await readFile(join(folder, 'plan.pdf'), 'utf8')).toBe('original');
    // A target that could not be reached is said as the size reached.
    const short = await executePdfTool('pdf_compress', { path: 'plan.pdf', targetMb: 6, out: 'plan_compresat.pdf' }, context(answers({ ...good, targetBytes: 6_000_000, reachedTarget: false }))) as { output: string; reachedTarget: boolean; note: string };
    expect(short).toMatchObject({ output: 'plan_compresat.pdf', reachedTarget: false });
    expect(short.note).toMatch(/The target of 6\.00 MB was not reached: 7\.81 MB is the smallest this method gives\. Tell the human that figure, not the target\./);
    // Not compared, or compared and different: said, not passed over.
    const unchecked = await executePdfTool('pdf_compress', { path: 'plan.pdf', targetMb: 8 }, context(answers({ ...good, verification: { done: false, reason: 'pdftoppm is not installed (it comes with poppler: brew install poppler)' } }))) as { verified: string; note: string };
    expect(unchecked.verified).toBe('not verified');
    expect(unchecked.note).toMatch(/was not compared with the original: pdftoppm is not installed .*Say that it is unverified\./);
    const differs = await executePdfTool('pdf_compress', { path: 'plan.pdf', targetMb: 8 }, context(answers({ ...good, verification: { done: true, ok: false, pages: [{ page: 1, share: 0.001, ok: true }, { page: 2, share: 0.04, ok: false }], pagesChecked: 2, pagesInFile: 2 } }))) as { verified: string; pagesThatDiffer: unknown[]; note: string };
    expect(differs).toMatchObject({ verified: 'the two files render differently', pagesThatDiffer: [{ page: 2 }] });
    expect(differs.note).toMatch(/differences above its threshold on 1 page \(2\)\. Do not hand this over as equivalent/);
    // No size asked for: only the lossless level, and that is said; a file of images, too.
    const lossless = await executePdfTool('pdf_compress', { path: 'plan.pdf' }, context(answers({ input: { ...input, dominatedBy: 'images' }, levels: [levels[0]], chosen: levels[0], targetBytes: null, reachedTarget: null, verification: good.verification }))) as { note: string; level: number };
    expect(lossless.level).toBe(0);
    expect(lossless.note).toMatch(/Only the lossless level ran.*With a size to reach \(targetMb\).*Most of this file is images/);
    expect(lossless).not.toHaveProperty('target');
  });

  it('never writes over the original, asks first, and says what went wrong in its own words', async () => {
    await writeFile(join(folder, 'plan.pdf'), 'original');
    const python = answers({ input, levels, chosen: levels[0] });
    await expect(executePdfTool('pdf_compress', { path: 'plan.pdf', out: './plan.pdf' }, context(python))).rejects.toThrow(/out cannot be the original/);
    await expect(executePdfTool('pdf_compress', { path: 'plan.pdf', out: 'mic.txt' }, context(python))).rejects.toThrow(/ending in \.pdf/);
    await expect(executePdfTool('pdf_compress', { path: 'plan.pdf', out: '../mic.pdf' }, context(python))).rejects.toThrow(/outside/);
    await expect(executePdfTool('pdf_compress', { path: 'plan.pdf', targetMb: 0 }, context(python))).rejects.toThrow(/targetMb is a size/);
    await expect(executePdfTool('pdf_compress', { path: 'plan.pdf', maxLevel: 7 }, context(python))).rejects.toThrow(/maxLevel is 0, 1, 2 or 3/);
    await expect(executePdfTool('pdf_compress', { path: 'plan.pdf' }, context(python, false))).rejects.toThrow(/declined/);
    expect(await stat(join(folder, 'plan-compressed.pdf')).then(() => true, () => false)).toBe(false);
    const failing = { ...python, run: async () => ({ exitCode: 1, output: 'Traceback (most recent call last):\npikepdf._core.PasswordError: plan.pdf: invalid password' }) } as unknown as PdfPython;
    await expect(executePdfTool('pdf_inspect', { path: 'plan.pdf' }, context(failing))).rejects.toThrow(/protected with a password/);
    const broken = { ...python, run: async () => ({ exitCode: 1, output: 'pikepdf._core.PdfError: not a PDF' }) } as unknown as PdfPython;
    await expect(executePdfTool('pdf_inspect', { path: 'plan.pdf' }, context(broken))).rejects.toThrow(/could not be processed: pikepdf\._core\.PdfError: not a PDF/);
  });
});

describe('reading a PDF', () => {
  /** poppler, stood in for: three pages, the second of them a picture. */
  const fake = (pages: string[], recorded: string[] = []): SheetShell => async command => {
    recorded.push(command);
    if (command.startsWith('pdfinfo ')) return { exitCode: 0, output: `Title: x\nPages:           ${pages.length}\nEncrypted: no\n` };
    const numbers = (flag: string) => Number(new RegExp(`${flag} (\\d+)`).exec(command)![1]);
    const target = /'([^']+)'$/.exec(command)![1];
    if (command.startsWith('pdftotext ')) { await writeFile(target, pages.slice(numbers('-f') - 1, numbers('-l')).map(page => `${page}\f`).join('')); return { exitCode: 0, output: '' }; }
    if (command.startsWith('pdftoppm ')) { for (let page = numbers('-f'); page <= numbers('-l'); page++) await writeFile(`${target}-${page}.jpg`, `jpeg of page ${page}`); return { exitCode: 0, output: '' }; }
    return { exitCode: 1, output: 'unexpected' };
  };
  const reading = (shell: SheetShell) => context(answers({ input }), true, [], shell);

  it('gives the text page by page, names the pages that have none, and stops where a result is full', async () => {
    await writeFile(join(folder, 'contract.pdf'), 'x');
    const recorded: string[] = [];
    const pages = ['Contract de închiriere\nArt. 1  Părțile', '', 'Art. 7  Penalități de întârziere: 0,1% pe zi'];
    const read = await executePdfTool('pdf_read', { path: 'contract.pdf' }, reading(fake(pages, recorded))) as Record<string, unknown>;
    expect(read).toMatchObject({ file: 'contract.pdf', pages: 3, read: '1-3', pagesWithoutText: [2],
      text: [{ page: 1, text: 'Contract de închiriere\nArt. 1  Părțile' }, { page: 2, text: '' }, { page: 3, text: 'Art. 7  Penalități de întârziere: 0,1% pe zi' }] });
    expect(read.note).toMatch(/Page 2 has no text — a picture, a scan, a drawing\. To see it: pdf_read with those pages and as: "images"\./);
    expect(recorded[1]).toMatch(/^pdftotext -enc UTF-8 -f 1 -l 3 '.*contract\.pdf' '.*text\.txt'$/);
    // One page, a range, the layout kept when asked.
    expect(await executePdfTool('pdf_read', { path: 'contract.pdf', pages: '3', layout: true }, reading(fake(pages, recorded)))).toMatchObject({ read: '3', text: [{ page: 3 }] });
    expect(recorded.at(-1)).toContain('-layout -f 3 -l 3');
    await expect(executePdfTool('pdf_read', { path: 'contract.pdf', pages: '9' }, reading(fake(pages)))).rejects.toThrow(/has 3 pages: 9 is not among them/);
    await expect(executePdfTool('pdf_read', { path: 'contract.pdf', pages: 'toate' }, reading(fake(pages)))).rejects.toThrow(/"3", "2-6", "10-"/);
    // A long file comes in whole pages, with what is left named.
    const long = Array.from({ length: 6 }, (_item, index) => `pagina ${index + 1} ${'text '.repeat(2400)}`);
    const first = await executePdfTool('pdf_read', { path: 'contract.pdf' }, reading(fake(long))) as { read: string; next: string; text: unknown[] };
    expect(first).toMatchObject({ read: '1-2', next: '3-6' });
    expect(first.text).toHaveLength(2);
    // Nothing is left behind in the app's data.
    expect(await stat(join(root, 'work')).then(async () => (await import('node:fs/promises')).readdir(join(root, 'work')), () => [])).toEqual([]);
  });

  it('gives the pages of a scan as pictures, four a call, and says they are pictures', async () => {
    await writeFile(join(folder, 'scan.pdf'), 'x');
    const scanned = await executePdfTool('pdf_read', { path: 'scan.pdf' }, reading(fake(['', ' ', '', '', '', '']))) as { text: string; pictures: Array<{ mimeType: string; data: string }> };
    expect(scanned.pictures.map(picture => Buffer.from(picture.data, 'base64').toString())).toEqual([1, 2, 3, 4].map(page => `jpeg of page ${page}`));
    expect(scanned.pictures[0].mimeType).toBe('image/jpeg');
    expect(scanned.text).toMatch(/^scan\.pdf, pages 1–4 of 6, as pictures, in page order\. These pages have no text in the file — a scan or a drawing — so read them as you see them, and say that what you report was read from a picture\. Next: pdf_read with pages "5-6"\./);
    // Asked for, a page with text is given as a picture too: its look is what was wanted.
    const looked = await executePdfTool('pdf_read', { path: 'scan.pdf', pages: '2', as: 'images' }, reading(fake(['text', 'un tabel', 'text']))) as { text: string; pictures: unknown[] };
    expect(looked.pictures).toHaveLength(1);
    expect(looked.text).toBe('scan.pdf, page 2 of 3, as pictures, in page order. If you were given no picture, this model does not see images: say so — a scan needs a model that does.');
    // Text only, of a scan: the empty pages, said to be empty.
    expect(await executePdfTool('pdf_read', { path: 'scan.pdf', as: 'text' }, reading(fake(['', ''])))).toMatchObject({ pagesWithoutText: [1, 2] });
  });

  it.skipIf(!realPython)('reads a real PDF with the Mac’s own poppler: text where there is text, a picture where there is none', async () => {
    const run = (command: string, args: string[]) => new Promise<{ exitCode: number | null; output: string }>(done =>
      execFile(command, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => done({ exitCode: error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 127) : 0, output: stdout + stderr })));
    if ((await run('/bin/sh', ['-c', 'command -v pdftotext && command -v pdftoppm && command -v pdfinfo'])).exitCode !== 0) return;
    const made = await run(realPython!, ['-c', [
      'import sys, pikepdf',
      'pdf = pikepdf.new()',
      'font = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))',
      'def page(content): pdf.pages.append(pikepdf.Page(pikepdf.Dictionary(Type=pikepdf.Name.Page, MediaBox=[0, 0, 595, 842], Resources=pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font)), Contents=pdf.make_stream(content))))',
      'page(b"BT /F1 14 Tf 72 760 Td (Contract de inchiriere) Tj 0 -24 Td (Art. 7 Penalitati de intarziere: 0,1% pe zi) Tj ET")',
      'page(b"2 w 100 100 m 500 700 l S 100 700 m 500 100 l S")',
      'pdf.save(sys.argv[1])',
    ].join('\n'), join(folder, 'real.pdf')]);
    expect(made).toMatchObject({ exitCode: 0 });
    const shell: SheetShell = (command, cwd) => new Promise(done =>
      execFile('/bin/sh', ['-c', command], { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => done({ exitCode: error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0, output: stdout + stderr })));
    const read = await executePdfTool('pdf_read', { path: 'real.pdf' }, reading(shell)) as { pages: number; text: Array<{ page: number; text: string }>; pagesWithoutText: number[] };
    expect(read).toMatchObject({ pages: 2, pagesWithoutText: [2] });
    expect(read.text[0].text).toBe('Contract de inchiriere\nArt. 7 Penalitati de intarziere: 0,1% pe zi');
    expect(await executePdfTool('pdf_read', { path: 'real.pdf', find: 'PENALITĂȚI' }, reading(shell))).toMatchObject({ onPages: 1, matches: [{ page: 1, line: 'Art. 7 Penalitati de intarziere: 0,1% pe zi' }] });
    // The page that is only a drawing, on its own: a real JPEG of it, small enough to send.
    const drawn = await executePdfTool('pdf_read', { path: 'real.pdf', pages: '2' }, reading(shell)) as { text: string; pictures: Array<{ mimeType: string; data: string }> };
    expect(drawn.pictures).toHaveLength(1);
    expect(Buffer.from(drawn.pictures[0].data, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(drawn.pictures[0].data.length).toBeLessThan(2 * 1024 * 1024);
    expect(drawn.text).toMatch(/^real\.pdf, page 2 of 2, as pictures.*This page has no text in the file/);
  }, 60_000);

  it('says on which pages a text is, and what to do when there is no text or no poppler', async () => {
    await writeFile(join(folder, 'contract.pdf'), 'x');
    const pages = ['Contract\nArt. 1  Părțile', 'Art. 7  PENALITĂȚI de întârziere: 0,1% pe zi\nalt rând\nPenalitati maxime: 10%', 'Semnături'];
    expect(await executePdfTool('pdf_read', { path: 'contract.pdf', find: 'penalități' }, reading(fake(pages)))).toEqual({ file: 'contract.pdf', pages: 3, find: 'penalități', onPages: 1,
      matches: [{ page: 2, line: 'Art. 7  PENALITĂȚI de întârziere: 0,1% pe zi' }, { page: 2, line: 'Penalitati maxime: 10%' }] });
    expect(await executePdfTool('pdf_read', { path: 'contract.pdf', find: 'x' }, reading(fake(['', ''])))).toMatchObject({ onPages: 0, note: 'This PDF has no text to search: its pages are pictures. Read them with as: "images".' });
    await expect(executePdfTool('pdf_read', { path: 'contract.pdf' }, context(answers({ input })))).rejects.toThrow(/needs poppler.*brew install poppler.*Hello does not install programs/);
    await expect(executePdfTool('pdf_read', { path: 'contract.pdf' }, reading(async () => ({ exitCode: 1, output: 'Command Line Error: Incorrect password' })))).rejects.toThrow(/protected with a password/);
  });
});

describe('the Python the PDF program runs in', () => {
  it('is made once, in the app’s data, and the program it runs is always Hello’s own', async () => {
    const home = join(root, 'python');
    const recorded: string[] = [];
    const shell: SheetShell = async command => {
      recorded.push(command);
      if (command.startsWith('python3 -m venv')) { await mkdir(join(home, 'venv', 'bin'), { recursive: true }); await writeFile(join(home, 'venv', 'bin', 'python'), ''); }
      return command.includes('import json') ? { exitCode: 0, output: '{"pikepdf": "10.18.2", "pillow": "13.0.0", "python": "3.14.7"}\n' } : { exitCode: 0, output: '' };
    };
    const python = new PdfPython(home, shell);
    expect(await python.status()).toBeNull();
    expect(await python.prepare(new AbortController().signal)).toEqual({ pikepdf: '10.18.2', pillow: '13.0.0', python: '3.14.7' });
    expect(recorded[1]).toMatch(/-m pip install .*--only-binary=:all: pikepdf$/);
    expect(recorded[2]).toMatch(/pillow$/);
    recorded.length = 0;
    await python.prepare(new AbortController().signal);
    expect(recorded).toEqual([]);
    await python.run({ input: "/a/it's.pdf", analyze: true }, new AbortController().signal, 30);
    expect(recorded[0]).toContain(`HELLO_PDF_JOB='{"input":"/a/it'\\''s.pdf","analyze":true}'`);
    // The answer comes back in a file of its own, named in the job's environment and gone afterwards.
    expect(recorded[0]).toMatch(/HELLO_PDF_RESULT='[^']*result-[0-9a-f-]{36}\.json'/);
    expect(await readFile(join(home, 'program.py'), 'utf8')).toBe(PDF_PROGRAM);
    const none = new PdfPython(join(root, 'p2'), async () => ({ exitCode: 127, output: 'sh: python3: command not found' }));
    await expect(none.prepare(new AbortController().signal)).rejects.toThrow(/Python 3 is needed.*command not found/);
  });

  it.skipIf(!realPython)('compresses a real vector PDF: smaller, still a drawing, every page as it was', async () => {
    const run = (args: string[], env: Record<string, string> = {}) => new Promise<{ exitCode: number | null; output: string }>(done =>
      execFile(realPython!, args, { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => done({ exitCode: error ? Number((error as { code?: number }).code ?? 1) : 0, output: stdout + stderr })));
    // Two pages that share one resources table with two graphics states saying the same thing, long decimals, a tiny scale, and a colour set twice.
    const made = await run(['-c', [
      'import sys, random, pikepdf',
      'random.seed(7)',
      'pdf = pikepdf.new()',
      'res = pdf.make_indirect(pikepdf.Dictionary(ExtGState=pikepdf.Dictionary(GSa=pikepdf.Dictionary(LW=1, CA=1), GSb=pikepdf.Dictionary(LW=1, CA=1), GSc=pikepdf.Dictionary(LW=3, CA=1))))',
      'for page in range(2):',
      '    lines = ["q 0.0003 0 0 0.0003 0 0 cm /GSc gs 0.2 0.4 0.6 RG"]',
      '    for i in range(4000):',
      '        x, y = random.uniform(0, 2000000), random.uniform(0, 2800000)',
      '        lines.append("0.2 0.4 0.6 RG /%s gs %.6f %.6f m %.6f %.6f l S" % ("GSa" if i % 2 else "GSb", x, y, x + random.uniform(-90000, 90000), y + random.uniform(-90000, 90000)))',
      '    lines.append("Q")',
      '    pdf.pages.append(pikepdf.Page(pikepdf.Dictionary(Type=pikepdf.Name.Page, MediaBox=[0, 0, 600, 840], Resources=res, Contents=pdf.make_stream("\\n".join(lines).encode()))))',
      'pdf.save(sys.argv[1], compress_streams=True)',
    ].join('\n'), join(folder, 'desen.pdf')]);
    expect(made).toMatchObject({ exitCode: 0 });
    const python = { status: async () => ({ pikepdf: 'real', pillow: 'real', python: 'real' }), prepare: async () => ({ pikepdf: 'real', pillow: 'real', python: 'real' }),
      run: async (job: Record<string, unknown>) => {
        const file = join(root, 'program.py'), answer = join(root, 'answer.json');
        await writeFile(file, PDF_PROGRAM);
        const ran = await run([file], { HELLO_PDF_JOB: JSON.stringify(job), HELLO_PDF_RESULT: answer });
        return { ...ran, result: await readFile(answer, 'utf8').catch(() => undefined) };
      } } as unknown as PdfPython;
    const seen = await executePdfTool('pdf_inspect', { path: 'desen.pdf' }, context(python)) as { pages: number; mostly: string };
    expect(seen).toMatchObject({ pages: 2, mostly: 'drawing' });
    const before = (await stat(join(folder, 'desen.pdf'))).size;
    const result = await executePdfTool('pdf_compress', { path: 'desen.pdf', targetMb: before * 0.7 / 1_000_000, out: 'desen mic.pdf' }, context(python)) as
      { bytes: number; reachedTarget: boolean; level: number; verified: string; tried: unknown[]; note: string };
    expect(result.reachedTarget).toBe(true);
    expect(result.bytes).toBeLessThan(before * 0.7);
    expect(result.level).toBeGreaterThan(0);
    expect(result.tried).toHaveLength(result.level + 1);
    // Rendered and compared where this machine can render; said to be unverified where it cannot.
    expect(['the two files render alike', 'not verified']).toContain(result.verified);
    // Still a drawing, on both pages: no picture in it, the tiny scale as written, the shared states one table with two entries, each page naming them.
    const read = await run(['-c', [
      'import sys, pikepdf',
      'pdf = pikepdf.open(sys.argv[1])',
      'images = sum(1 for o in pdf.objects if isinstance(o, pikepdf.Stream) and o.get("/Subtype") == pikepdf.Name.Image)',
      'for page in pdf.pages:',
      '    data = page.Contents.read_bytes().decode("latin-1")',
      '    states = sorted(str(k) for k in page.Resources.ExtGState.keys())',
      '    used = sorted(set(part for part in data.split() if part.startswith("/G")))',
      '    print(images, "0.0003 0 0 0.0003 0 0 cm" in data, states, used == states, data.count(" RG"), data.count(" l"))',
    ].join('\n'), join(folder, 'desen mic.pdf')]);
    expect(read.output.trim().split('\n')).toEqual(Array(2).fill("0 True ['/G0', '/G1'] True 1 4000"));
    expect((await stat(join(folder, 'desen.pdf'))).size).toBe(before);
  }, 120_000);
});
