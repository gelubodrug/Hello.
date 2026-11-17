import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../atomic-write';

/** One approved shell command: its combined output and how it ended. */
export type SheetShell = (command: string, cwd: string, signal: AbortSignal, timeoutSeconds: number) => Promise<{ exitCode: number | null; output: string }>;

export interface SheetPythonStatus { openpyxl: string; pandas: string | null; python: string }

export const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** What a script starts with: where the workbook is, and where its own files go. */
const PRELUDE = [
  'import os',
  "WORKBOOK = os.environ['HELLO_WORKBOOK']  # the .xlsx to load and save, e.g. openpyxl.load_workbook(WORKBOOK)",
  "OUT = os.environ['HELLO_OUT']  # a folder for files this script writes",
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
    const file = join(paths.folder, 'script.py');
    atomicWriteFileSync(file, PRELUDE + code, { mode: 0o600 });
    return this.shell(
      `HELLO_WORKBOOK=${quote(paths.workbook)} HELLO_OUT=${quote(paths.folder)} PYTHONDONTWRITEBYTECODE=1 ${quote(this.interpreter)} ${quote(file)}`,
      paths.folder, signal, timeoutSeconds);
  }
}
