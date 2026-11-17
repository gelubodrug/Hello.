import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../atomic-write';
import { quote, type SheetShell } from '../sheets/python';
import { PDF_PROGRAM } from './program';

export interface PdfPythonStatus { pikepdf: string; pillow: string | null; python: string }

/**
 * The Python Hello's PDF program runs in: a virtual environment in the app's
 * own data with pikepdf, which rewrites a PDF's content, and Pillow, which
 * compares the two renderings afterwards. Like the one for spreadsheets it
 * adds nothing to the system's Python and downloads nothing until a person
 * allowed the first use. The programs that render a page (pdftoppm) and that
 * squeeze the file once more (qpdf) are the Mac's own, used when they are
 * there and never installed by Hello.
 */
export class PdfPython {
  private readonly venv: string;
  private readonly receipt: string;
  private preparing?: Promise<PdfPythonStatus>;

  constructor(private readonly root: string, private readonly shell: SheetShell) {
    this.venv = join(root, 'venv');
    this.receipt = join(root, 'ready.json');
  }

  get interpreter(): string { return join(this.venv, 'bin', 'python'); }

  async status(): Promise<PdfPythonStatus | null> {
    try {
      const status = JSON.parse(await readFile(this.receipt, 'utf8')) as PdfPythonStatus;
      if (typeof status?.pikepdf !== 'string' || !(await stat(this.interpreter)).isFile()) return null;
      return status;
    } catch { return null; }
  }

  /** Builds the environment once. pikepdf must install; without Pillow the result is made and said to be unverified. */
  prepare(signal: AbortSignal): Promise<PdfPythonStatus> {
    return this.preparing ??= (async () => {
      try {
        const ready = await this.status();
        if (ready) return ready;
        await rm(this.venv, { recursive: true, force: true });
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const made = await this.shell(`python3 -m venv ${quote(this.venv)}`, this.root, signal, 120);
        if (made.exitCode !== 0) throw new Error(`Python 3 is needed to work on a PDF and could not make its environment: ${made.output.slice(-400) || 'python3 was not found.'}`);
        const pip = `${quote(this.interpreter)} -m pip install --disable-pip-version-check --no-input --only-binary=:all:`;
        const core = await this.shell(`${pip} pikepdf`, this.root, signal, 300);
        if (core.exitCode !== 0) throw new Error(`pikepdf could not be installed (is this Mac online?): ${core.output.slice(-400)}`);
        await this.shell(`${pip} pillow`, this.root, signal, 300).catch(() => undefined);
        const versions = await this.shell(`${quote(this.interpreter)} -c ${quote([
          'import json, platform, pikepdf',
          'try:\n    import PIL\n    p = PIL.__version__\nexcept Exception:\n    p = None',
          'print(json.dumps({"pikepdf": pikepdf.__version__, "pillow": p, "python": platform.python_version()}))',
        ].join('\n'))}`, this.root, signal, 60);
        const line = versions.output.trim().split('\n').at(-1) ?? '';
        let status: PdfPythonStatus;
        try { status = JSON.parse(line) as PdfPythonStatus; } catch { throw new Error(`The Python environment was made but does not run: ${versions.output.slice(-300)}`); }
        atomicWriteFileSync(this.receipt, JSON.stringify(status), { mode: 0o600 });
        return status;
      } finally { this.preparing = undefined; }
    })();
  }

  /** Runs Hello's PDF program on one job. What the model chose is the job, as data; the program is always the same. */
  async run(job: Record<string, unknown>, signal: AbortSignal, timeoutSeconds: number): Promise<{ exitCode: number | null; output: string; result?: string }> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = join(this.root, 'program.py');
    atomicWriteFileSync(file, PDF_PROGRAM, { mode: 0o600 });
    // The program's answer is a file, not its output: a command's output is filtered for secrets on its way back,
    // and a filter that hides a short value can hide a digit of a file's size.
    const answer = join(this.root, `result-${randomUUID()}.json`);
    try {
      const ran = await this.shell(`HELLO_PDF_JOB=${quote(JSON.stringify(job))} HELLO_PDF_RESULT=${quote(answer)} PYTHONDONTWRITEBYTECODE=1 ${quote(this.interpreter)} ${quote(file)}`, this.root, signal, timeoutSeconds);
      const result = await readFile(answer, 'utf8').catch(() => undefined);
      return { ...ran, ...(result !== undefined ? { result } : {}) };
    } finally { await rm(answer, { force: true }).catch(() => {}); }
  }
}
