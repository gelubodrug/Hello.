import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { ToolDefinition } from '../chat/tools';
import { MAX_TOOL_IMAGES, MAX_TOOL_IMAGE_CHARS, type ToolImage } from '../chat/tool-output';
import { quote, type SheetShell } from '../sheets/python';
import type { PdfPython } from './python';

/** What a PDF tool needs from the chat it runs in. Paths and approvals stay main's decisions. */
export interface PdfToolContext {
  signal: AbortSignal;
  approve(): Promise<boolean>;
  /** A file of the chat's folder to read — or, by its name alone, one Hello keeps for the chat; throws for anything else. */
  readable(path: string): Promise<string>;
  /** Where a path of the chat's folder may be written; throws outside the folder. */
  writable(path: string): Promise<string>;
  /** A file of the folder was written. */
  saved?(absolute: string): void | Promise<void>;
  python: PdfPython;
  /** One command of Hello's own, run as an approved shell command is: poppler's programs are the Mac's, found on its PATH. */
  shell: SheetShell;
  /** A folder in the app's data for what a read makes on the way: the text file, the page pictures. */
  work: string;
}

/** A read that came to pictures: the pages of a scan, for a model that sees. */
export interface PdfPictures { text: string; pictures: ToolImage[] }

export const PDF_TOOLS = ['pdf_read', 'pdf_inspect', 'pdf_compress'] as const;

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition => ({
  type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});
const string = (description: string) => ({ type: 'string', description });

const PATH = 'Path of the .pdf inside the chat’s folder — or the name alone of one the human dropped from elsewhere, which Hello keeps for the chat.';

export function pdfToolDefinitions(): ToolDefinition[] {
  return [
    tool('pdf_read',
      [
        'Read a PDF of the chat’s folder. Where it has text you get the text, page by page — as much as one result carries, with the pages still to read named. Where it has none — a scan, a photographed page — you get the pages as pictures to read with your own eyes, at most four a call; ask for pictures yourself (as: "images") when the look matters: a drawing, a form, a table whose columns the text loses.',
        'find says on which pages a text occurs, with the line it is on, without reading the rest. Reads only; nothing is changed. Uses poppler on this Mac (pdftotext, pdftoppm).',
      ].join(' '),
      {
        path: string(PATH),
        pages: string('Which pages: "3", "2-6", "10-". Default: from the first page on.'),
        as: { type: 'string', enum: ['auto', 'text', 'images'], description: 'auto: text where there is text, pictures where there is none (default). text: the text only. images: the pages as pictures.' },
        find: string('Instead of reading: a text to look for, in every page. Capitals and accents do not matter.'),
        layout: { type: 'boolean', description: 'Keep the text as it is laid out on the page — columns, tables — instead of in reading order.' },
      }, ['path']),
    tool('pdf_inspect',
      'Say what a PDF of the chat’s folder is made of: its size, its pages, and how much of it is images, vector drawing and fonts — which decides how it can be made smaller. Reads the file; changes nothing.',
      { path: string(PATH) }, ['path']),
    tool('pdf_compress',
      [
        'Make a VECTOR PDF smaller without rasterising it — a plan or a drawing from CorelDRAW, AutoCAD or Illustrator stays a drawing: its numbers are written shorter and what is said twice is said once. The result is a new file beside the original, which is never changed.',
        'Give targetMb when the human named a size or a limit (an e-mail, an upload): the mildest of four levels that reaches it is used, from lossless to coordinates in whole points. Without a target only the lossless level runs.',
        'Afterwards both files are rendered and compared pixel by pixel; the result says what each level came to, whether the target was reached and what the comparison found. A PDF that is mostly images is not made much smaller by this: the result says so.',
        'The first use installs pikepdf into Hello’s own data (a download, once), after the human is asked.',
      ].join(' '),
      {
        path: string(PATH),
        targetMb: { type: 'number', exclusiveMinimum: 0, description: 'The size to get under, in megabytes (1 MB = 1,000,000 bytes).' },
        out: string('Path of the file to write, inside the chat’s folder, ending in .pdf. Default: the original’s name with “-compressed” added. Name it in the human’s language when they would.'),
        maxLevel: { type: 'integer', minimum: 0, maximum: 3, description: 'The most aggressive level allowed: 0 lossless only, 1 two decimals, 2 one decimal, 3 whole points for large coordinates (default).' },
      }, ['path']),
  ];
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(2)} MB`;
const text = (input: Record<string, unknown>, key: string): string => {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw new Error(`Tool argument ${key} must be text.`);
  return value.trim();
};

interface Made {
  input: { bytes: number; pages: number; imageBytes: number; drawingBytes: number; fontBytes: number; graphicsStates: number; dominatedBy: 'images' | 'drawing' };
  levels?: Array<{ level: number; name: string; bytes: number }>;
  chosen?: { level: number; name: string; bytes: number };
  targetBytes?: number | null;
  reachedTarget?: boolean | null;
  verification?: { done: boolean; ok?: boolean; reason?: string; pages?: Array<{ page: number; differentPixels?: number; share?: number; ok: boolean; reason?: string }>; pagesChecked?: number; pagesInFile?: number; threshold?: number };
}

/** The program's answer, from the file it wrote. Without one the run failed, and what it printed says how. */
function answer(ran: { exitCode: number | null; output: string; result?: string }): Made {
  let read: Made | undefined;
  try { read = ran.result === undefined ? undefined : JSON.parse(ran.result) as Made; } catch { read = undefined; }
  if (ran.exitCode !== 0 || !read?.input) {
    const said = ran.output.trim().split('\n').slice(-6).join('\n').slice(-800);
    throw new Error(/PasswordError|password/i.test(said) ? 'This PDF is protected with a password and cannot be read.'
      : `The PDF could not be processed: ${said || 'the program ended without an answer.'}`);
  }
  return read;
}
const made = (input: Made['input']) => ({
  size: megabytes(input.bytes), bytes: input.bytes, pages: input.pages,
  images: megabytes(input.imageBytes), drawing: megabytes(input.drawingBytes), fonts: megabytes(input.fontBytes),
  mostly: input.dominatedBy,
});

async function source(context: PdfToolContext, input: Record<string, unknown>): Promise<{ requested: string; absolute: string }> {
  const requested = text(input, 'path');
  if (extname(requested).toLowerCase() !== '.pdf') throw new Error('Give the path of a .pdf file.');
  const absolute = await context.readable(requested);
  if (!(await stat(absolute).then(info => info.isFile(), () => false))) throw new Error(`There is no file ${requested} in the chat’s folder.`);
  return { requested, absolute };
}

/** Hello's own fixed program, not the model's: asked for only while its Python is still to be downloaded. */
async function ready(context: PdfToolContext): Promise<void> {
  if (!(await context.python.status()) && !(await context.approve())) throw new Error('The human declined installing what PDF work needs.');
  context.signal.throwIfAborted();
  await context.python.prepare(context.signal);
}

/** What poppler is asked, and its answer; without poppler, the one thing to do about it. */
async function poppler(context: PdfToolContext, command: string, timeoutSeconds = 120): Promise<string> {
  const ran = await context.shell(command, context.work, context.signal, timeoutSeconds);
  if (ran.exitCode === 127 || /command not found|not found: pdf/i.test(ran.output))
    throw new Error('Reading a PDF needs poppler, which this Mac does not have: the human installs it with `brew install poppler`. Hello does not install programs on the Mac.');
  if (/Incorrect password/i.test(ran.output)) throw new Error('This PDF is protected with a password and cannot be read.');
  if (ran.exitCode !== 0) throw new Error(`The PDF could not be read: ${ran.output.trim().split('\n').slice(-3).join(' ').slice(-400) || 'poppler ended with an error.'}`);
  return ran.output;
}
const plain = (value: string) => value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
/** "3", "2-6", "10-": the pages meant, inside the file. */
function pageRange(value: unknown, total: number): { first: number; last: number } {
  if (value === undefined || value === null || value === '') return { first: 1, last: total };
  const match = /^\s*(\d{1,6})\s*(?:(-|–|\.\.)\s*(\d{1,6})?)?\s*$/.exec(String(value));
  if (!match) throw new Error('pages is one page or a range: "3", "2-6", "10-".');
  const first = Number(match[1]), last = match[2] === undefined ? first : match[3] === undefined ? total : Number(match[3]);
  if (first < 1 || first > total || last < first) throw new Error(`This PDF has ${total} page${total === 1 ? '' : 's'}: ${String(value).trim()} is not among them.`);
  return { first, last: Math.min(last, total) };
}
/** What one result carries of a PDF's text. */
const MAX_TEXT = 28_000;

async function read(input: Record<string, unknown>, context: PdfToolContext): Promise<unknown> {
  const file = await source(context, input);
  const as = input.as === undefined || input.as === null || input.as === '' ? 'auto' : String(input.as);
  if (!['auto', 'text', 'images'].includes(as)) throw new Error('as is auto, text or images.');
  const work = join(context.work, randomUUID());
  await mkdir(work, { recursive: true, mode: 0o700 });
  try {
    const total = Number(/^Pages:\s+(\d+)/m.exec(await poppler(context, `pdfinfo ${quote(file.absolute)}`))?.[1] ?? 0);
    if (!total) throw new Error('The PDF could not be read: it has no pages poppler can count.');
    /** The text of pages first..last, one entry a page. */
    const pagesText = async (first: number, last: number): Promise<string[]> => {
      const out = join(work, 'text.txt');
      await poppler(context, `pdftotext -enc UTF-8 ${input.layout === true ? '-layout ' : ''}-f ${first} -l ${last} ${quote(file.absolute)} ${quote(out)}`, 300);
      const pages = (await readFile(out, 'utf8')).split('\f');
      return Array.from({ length: last - first + 1 }, (_item, index) => (pages[index] ?? '').replace(/[ \t]+\n/g, '\n').trim());
    };
    const lettered = (text: string) => text.replace(/\s/g, '').length >= 12;
    if (typeof input.find === 'string' && input.find.trim()) {
      const wanted = plain(input.find.trim());
      const pages = await pagesText(1, total);
      const matches: Array<{ page: number; line: string }> = [];
      let onPages = 0;
      pages.forEach((text, index) => {
        const lines = text.split('\n').filter(line => plain(line).includes(wanted));
        if (!lines.length) return;
        onPages++;
        for (const line of lines.slice(0, 3)) if (matches.length < 60) matches.push({ page: index + 1, line: line.trim().slice(0, 240) });
      });
      return { file: file.requested, pages: total, find: input.find.trim(), onPages, matches,
        ...(!pages.some(lettered) ? { note: 'This PDF has no text to search: its pages are pictures. Read them with as: "images".' }
          : matches.length === 60 ? { note: 'The first 60 lines are listed; look for something longer to narrow it.' } : {}) };
    }
    const range = pageRange(input.pages, total);
    if (as !== 'images') {
      const pages = await pagesText(range.first, Math.min(range.last, range.first + 399));
      const blank = pages.flatMap((text, index) => lettered(text) ? [] : [range.first + index]);
      if (!(as === 'auto' && blank.length === pages.length)) {
        const text: Array<{ page: number; text: string }> = [];
        let size = 0;
        for (const [index, page] of pages.entries()) {
          // Whole pages only, and at least one: the page it stopped before is named.
          if (text.length && size + page.length > MAX_TEXT) break;
          text.push({ page: range.first + index, text: page.length > MAX_TEXT ? `${page.slice(0, MAX_TEXT)}…` : page });
          size += page.length;
        }
        const reached = text[text.length - 1].page;
        const without = blank.filter(page => page <= reached);
        return { file: file.requested, pages: total, read: reached === range.first ? String(range.first) : `${range.first}-${reached}`, text,
          ...(without.length ? { pagesWithoutText: without } : {}),
          ...(reached < range.last ? { next: `${reached + 1}-${range.last}` } : {}),
          ...(without.length ? { note: `${without.length === 1 ? 'Page' : 'Pages'} ${without.slice(0, 12).join(', ')} ${without.length === 1 ? 'has' : 'have'} no text — a picture, a scan, a drawing. To see ${without.length === 1 ? 'it' : 'them'}: pdf_read with those pages and as: "images".` } : {}) };
      }
    }
    // No text on these pages, or their look was asked for: the pages themselves, as many as one result carries.
    const last = Math.min(range.last, range.first + MAX_TOOL_IMAGES - 1);
    const render = async (side: number): Promise<ToolImage[]> => {
      for (const old of await readdir(work)) if (old.startsWith('page')) await rm(join(work, old), { force: true });
      await poppler(context, `pdftoppm -jpeg -jpegopt quality=82 -scale-to ${side} -f ${range.first} -l ${last} ${quote(file.absolute)} ${quote(join(work, 'page'))}`, 300);
      const made = (await readdir(work)).filter(name => /^page.*\.jpg$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return Promise.all(made.map(async name => ({ mimeType: 'image/jpeg' as const, data: (await readFile(join(work, name))).toString('base64') })));
    };
    let pictures = await render(1600);
    // A page too heavy for one picture is drawn smaller rather than not at all.
    if (pictures.some(picture => picture.data.length > MAX_TOOL_IMAGE_CHARS)) pictures = await render(1000);
    pictures = pictures.filter(picture => picture.data.length <= MAX_TOOL_IMAGE_CHARS);
    if (!pictures.length) throw new Error('These pages could not be drawn as pictures small enough to send.');
    return { pictures, text: [
      `${file.requested}, ${range.first === last ? `page ${range.first}` : `pages ${range.first}–${last}`} of ${total}, as pictures, in page order.`,
      as === 'images' ? '' : `${range.first === last ? 'This page has' : 'These pages have'} no text in the file — a scan or a drawing — so read ${range.first === last ? 'it' : 'them'} as you see ${range.first === last ? 'it' : 'them'}, and say that what you report was read from a picture.`,
      last < range.last ? `Next: pdf_read with pages "${last + 1}-${range.last}".` : '',
      'If you were given no picture, this model does not see images: say so — a scan needs a model that does.',
    ].filter(Boolean).join(' ') } satisfies PdfPictures;
  } finally { await rm(work, { recursive: true, force: true }).catch(() => {}); }
}

export async function executePdfTool(name: string, input: Record<string, unknown>, context: PdfToolContext): Promise<unknown> {
  switch (name) {
    case 'pdf_read': return read(input, context);
    case 'pdf_inspect': {
      const file = await source(context, input);
      await ready(context);
      const result = answer(await context.python.run({ input: file.absolute, analyze: true }, context.signal, 120));
      return { file: file.requested, ...made(result.input),
        note: result.input.dominatedBy === 'images'
          ? 'Most of this file is images. pdf_compress leaves images as they are, so it will not make it much smaller; making images smaller loses quality, which is the human’s to decide.'
          : 'Most of this file is vector drawing: pdf_compress is the right tool for it.' };
    }
    case 'pdf_compress': {
      const file = await source(context, input);
      const target = input.targetMb === undefined || input.targetMb === null ? undefined : Number(input.targetMb);
      if (target !== undefined && !(target > 0 && target < 100_000)) throw new Error('targetMb is a size in megabytes, such as 8.');
      const level = input.maxLevel === undefined || input.maxLevel === null ? 3 : Number(input.maxLevel);
      if (!Number.isInteger(level) || level < 0 || level > 3) throw new Error('maxLevel is 0, 1, 2 or 3.');
      const wanted = input.out === undefined || input.out === null || input.out === ''
        ? join(dirname(file.requested), `${basename(file.requested, extname(file.requested))}-compressed.pdf`) : text(input, 'out');
      if (extname(wanted).toLowerCase() !== '.pdf') throw new Error('The result is a PDF: give out a path ending in .pdf.');
      if (await context.writable(wanted) === file.absolute) throw new Error('The result is a new file: out cannot be the original, which is never changed.');
      // A file is written into the chat's folder: the same question as any write there.
      if (!(await context.approve())) throw new Error('The human declined this.');
      context.signal.throwIfAborted();
      await context.python.prepare(context.signal);
      // Looked at again after the wait for an approval: the folder may have changed under it.
      const output = await context.writable(wanted);
      const result = answer(await context.python.run({ input: file.absolute, output, maxLevel: level, ...(target !== undefined ? { targetBytes: Math.round(target * 1_000_000) } : {}) }, context.signal, 600));
      await context.saved?.(output);
      const chosen = result.chosen!;
      const checked = result.verification;
      const failing = (checked?.pages ?? []).filter(page => !page.ok);
      return {
        file: file.requested, original: made(result.input),
        output: wanted, size: megabytes(chosen.bytes), bytes: chosen.bytes, smallerBy: `${Math.round((1 - chosen.bytes / result.input.bytes) * 100)}%`,
        level: chosen.level, how: chosen.name,
        tried: (result.levels ?? []).map(item => ({ level: item.level, how: item.name, size: megabytes(item.bytes) })),
        ...(target !== undefined ? { target: megabytes(target * 1_000_000), reachedTarget: result.reachedTarget === true } : {}),
        verified: checked?.done ? (checked.ok ? 'the two files render alike' : 'the two files render differently') : 'not verified',
        ...(checked?.done ? { pagesCompared: checked.pagesChecked, ...(failing.length ? { pagesThatDiffer: failing } : {}) } : {}),
        note: [
          `${file.requested} is unchanged; the result is ${wanted}, still vector.`,
          target !== undefined && result.reachedTarget !== true ? `The target of ${megabytes(target * 1_000_000)} was not reached: ${megabytes(chosen.bytes)} is the smallest this method gives${level < 3 ? ' within the level allowed' : ''}. Tell the human that figure, not the target.` : '',
          target === undefined && chosen.bytes > result.input.bytes * 0.9 ? 'Only the lossless level ran, and it changes little. With a size to reach (targetMb) the stronger levels are tried.' : '',
          result.input.dominatedBy === 'images' ? 'Most of this file is images, which this leaves as they are: that is why it is not much smaller. Making images smaller loses quality — the human’s to decide.' : '',
          !checked?.done ? `The result was not compared with the original: ${checked?.reason ?? 'the comparison did not run'}. Say that it is unverified.`
            : !checked.ok ? `The comparison found differences above its threshold on ${failing.length} page${failing.length === 1 ? '' : 's'} (${failing.map(page => page.page).slice(0, 10).join(', ')}). Do not hand this over as equivalent: say so, or run again with a lower maxLevel.`
            : (checked.pagesInFile ?? 0) > (checked.pagesChecked ?? 0) ? `The first ${checked.pagesChecked} of ${checked.pagesInFile} pages were compared and render alike.` : '',
        ].filter(Boolean).join(' '),
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
