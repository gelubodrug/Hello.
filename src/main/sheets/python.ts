import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../atomic-write';

/** One approved shell command: its combined output and how it ended. */
export type SheetShell = (command: string, cwd: string, signal: AbortSignal, timeoutSeconds: number) => Promise<{ exitCode: number | null; output: string }>;

export interface SheetPythonStatus { openpyxl: string; pandas: string | null; python: string }

export const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The model's script is a file of its own, and this is what runs it.
 *
 * It compiles the whole script BEFORE a line of it executes, so a typo is
 * caught at once and reported at the line the model wrote — not after half the
 * work has been done, and not three lines off, which is where it landed when
 * these two names sat above the model's own code (a run, 18.11: a SyntaxError
 * on the model's line 19 came back as line 22, where its code has a comment,
 * so there was nothing to fix where it was told to look).
 *
 * `your script` is the name Python then puts in every frame: the real path is
 * inside the app's data, carries the chat's hash, and is nothing the model can
 * open anyway.
 */
const RUNNER = [
  'import os',
  "WORKBOOK = os.environ['HELLO_WORKBOOK']  # the .xlsx to load and save, e.g. openpyxl.load_workbook(WORKBOOK)",
  "OUT = os.environ['HELLO_OUT']  # a folder for files this script writes",
  "with open(os.environ['HELLO_SCRIPT'], encoding='utf-8') as _f:",
  "    _code = compile(_f.read(), 'your script', 'exec')",
  'exec(_code)',
  '',
].join('\n');

/**
 * The Python a chat's spreadsheet scripts run in: a virtual environment in the
 * app's own data with openpyxl, and pandas where it installs. Nothing is added
 * to the system's Python and nothing is downloaded until a person allowed the
 * first script. openpyxl is what creates what Hello's own writer cannot —
 * charts, merged cells, conditional formats — as Claude's Excel skill does.
 */
/** Where Hello keeps the Python a chat's scripts run in, and the interpreter itself. */
export const sheetPythonRoot = (dataDir: string) => join(dataDir, 'sheets', 'python');
export const sheetPythonInterpreter = (dataDir: string) => join(sheetPythonRoot(dataDir), 'venv', 'bin', 'python');

export class SheetPython {
  private readonly venv: string;
  private readonly receipt: string;
  private preparing?: Promise<SheetPythonStatus>;

  constructor(private readonly root: string, private readonly shell: SheetShell) {
    this.venv = join(root, 'venv');
    this.receipt = join(root, 'ready.json');
  }

  get interpreter(): string { return join(this.venv, 'bin', 'python'); }

  async status(): Promise<SheetPythonStatus | null> {
    try {
      const status = JSON.parse(await readFile(this.receipt, 'utf8')) as SheetPythonStatus;
      if (typeof status?.openpyxl !== 'string' || !(await stat(this.interpreter)).isFile()) return null;
      return status;
    } catch { return null; }
  }

  /** Builds the environment once. openpyxl must install; pandas may not have a build for this Python, and is then left out. */
  prepare(signal: AbortSignal): Promise<SheetPythonStatus> {
    return this.preparing ??= (async () => {
      try {
        const ready = await this.status();
        if (ready) return ready;
        await rm(this.venv, { recursive: true, force: true });
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const made = await this.shell(`python3 -m venv ${quote(this.venv)}`, this.root, signal, 120);
        if (made.exitCode !== 0) throw new Error(`Python 3 is needed for spreadsheet scripts and could not make its environment: ${made.output.slice(-400) || 'python3 was not found.'}`);
        const pip = `${quote(this.interpreter)} -m pip install --disable-pip-version-check --no-input`;
        const core = await this.shell(`${pip} openpyxl`, this.root, signal, 300);
        if (core.exitCode !== 0) throw new Error(`openpyxl could not be installed (is this Mac online?): ${core.output.slice(-400)}`);
        // Only a ready-made build: compiling pandas from source takes many minutes and usually fails.
        await this.shell(`${pip} --only-binary=:all: pandas`, this.root, signal, 300).catch(() => undefined);
        const versions = await this.shell(`${quote(this.interpreter)} -c ${quote([
          'import json, platform, openpyxl',
          'try:\n    import pandas\n    p = pandas.__version__\nexcept Exception:\n    p = None',
          'print(json.dumps({"openpyxl": openpyxl.__version__, "pandas": p, "python": platform.python_version()}))',
        ].join('\n'))}`, this.root, signal, 60);
        const line = versions.output.trim().split('\n').at(-1) ?? '';
        let status: SheetPythonStatus;
        try { status = JSON.parse(line) as SheetPythonStatus; } catch { throw new Error(`The Python environment was made but does not run: ${versions.output.slice(-300)}`); }
        atomicWriteFileSync(this.receipt, JSON.stringify(status), { mode: 0o600 });
        return status;
      } finally { this.preparing = undefined; }
    })();
  }

  /** Runs one script on one workbook file. The script's own files go to `folder`. */
  async run(code: string, paths: { workbook: string; folder: string }, signal: AbortSignal, timeoutSeconds: number): Promise<{ exitCode: number | null; output: string }> {
    await mkdir(paths.folder, { recursive: true, mode: 0o700 });
    const script = join(paths.folder, 'script.py');
    const runner = join(paths.folder, 'run-script.py');
    atomicWriteFileSync(script, code, { mode: 0o600 });
    atomicWriteFileSync(runner, RUNNER, { mode: 0o600 });
    const ran = await this.shell(
      `HELLO_WORKBOOK=${quote(paths.workbook)} HELLO_OUT=${quote(paths.folder)} HELLO_SCRIPT=${quote(script)} PYTHONDONTWRITEBYTECODE=1 ${quote(this.interpreter)} ${quote(runner)}`,
      paths.folder, signal, timeoutSeconds);
    // The frames left that are Hello's, not the model's: the runner's own line, and the source line Python
    // echoes under it. Both go, so a traceback holds only what the model wrote.
    const lines = ran.output.split('\n');
    const kept: string[] = [];
    for (let at = 0; at < lines.length; at++) {
      if (!lines[at].includes(runner)) { kept.push(lines[at]); continue; }
      if (/^\s/.test(lines[at + 1] ?? '')) at++;
    }
    return { ...ran, output: kept.join('\n').replaceAll(script, 'your script') };
  }
}
