/**
 * OpenJev on this Mac — the classifier Unclutter asks.
 *
 * OpenJev (huggingface.co/openjev/openjev — weights CC BY-NC 4.0, helper
 * Apache 2.0) is an independent open decision model, not TypeSafe's Jev. Its
 * helper serves the hosted Jev API's shapes at `/v1/systemone`, which is the
 * door Unclutter's TypeSafe provider knocks on. The person already has it:
 * the MLX weights in `~/Models/MLX/openjev-MLX` (or wherever oMLX keeps
 * models) and the helper's Python environment — its `mlx` and `api` folders,
 * which `openjev/` in Hello's data folder holds or links to.
 *
 * Hello reuses all of it and writes none of it:
 *  - a helper that already answers (another app's, or one started by hand) is
 *    used as it is, and never stopped from here;
 *  - otherwise Hello starts one from that environment, after checking both
 *    helper files against their pinned SHA-256, on 127.0.0.1 only, logging to
 *    its own data folder; it stops that one — and only that one — with the app;
 *  - nothing is installed or downloaded: a missing environment is said, not fixed.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BATCH_SIZE } from './model';

/** The frozen helper and its MLX stand-in as the model card pins them. */
export const HELPER_FILES: ReadonlyArray<readonly [string, string]> = [
  ['helper/shim.py', '81a22f1b1b8912a465059207ef9f60b7c6c16b4de6372305d867efbe38a1987a'],
  ['helper/shim_mlx.py', 'fa80dd5b1ae4b3077380669ef9bd22e74e552ac314e50b343c6bfd88658718d4'],
];
/** The card's fixed calibration: keep it to reproduce its numbers. */
export const CALIBRATION: Readonly<Record<string, string>> = {
  READOUT_T: '0.85', READOUT_NOUL_T: '1.829074', READOUT_NOUL_BIAS: '0',
  READOUT_TARGETED: '1', READOUT_INSTR_STYLE: 'pyrepr', SHIM_STAGGER: '1',
};
export const DEFAULT_PORT = 3000;
/** Loading about 27 GB of weights takes a while. */
const READY_MS = 300_000;
/** One request: a batch of questions, answered one after another on this Mac. */
const REQUEST_MS = 900_000;

export type OpenJevState = 'ready' | 'starting' | 'stopped' | 'missing';
export interface OpenJevStatus { state: OpenJevState; detail: string; endpoint?: string; ownHelper: boolean }

interface Options {
  /** Hello's data folder: its own port and log live in `openjev/` there. */
  dataDir: string;
  home?: string;
  fetch?: typeof fetch;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** Whether a local port is free; injectable for tests. */
  portFree?: (port: number) => Promise<boolean>;
  log?: (line: string) => void;
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const readJSON = (path: string): unknown => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

/** PURE. The OpenJev folder among a model folder's entries: the first named like openjev, MLX first. */
export function pickOpenJev(names: string[]): string | null {
  const named = names.filter(name => name.toLowerCase().includes('openjev'));
  named.sort((a, b) => Number(!a.toLowerCase().includes('mlx')) - Number(!b.toLowerCase().includes('mlx')) || a.length - b.length);
  return named[0] ?? null;
}

/** PURE. How the helper runs: the environment's Python, the MLX stand-in over the frozen helper, this machine only, the card's calibration. */
export function launchSpec(helperHome: string, model: string, port: number): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: join(helperHome, 'mlx', 'bin', 'python'),
    args: [
      join(helperHome, 'api', 'helper', 'shim_mlx.py'),
      '--helper', join(helperHome, 'api', 'helper', 'shim.py'),
      '--model', model,
      '--host', '127.0.0.1',
      '--port', String(port),
    ],
    env: { TOKENIZER: model, SHIM_MODEL: model, ...CALIBRATION },
  };
}

const defaultPortFree = (port: number) => new Promise<boolean>(resolve => {
  const server = createServer();
  server.once('error', () => resolve(false));
  server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});

export class OpenJev {
  readonly name = 'OpenJev';
  readonly model = 'openjev';
  /** Small: OpenJev answers one question at a time and re-reads the state for each. */
  readonly batchSize = BATCH_SIZE;
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private starting: Promise<string> | null = null;
  private readonly home: string;
  private readonly fetch: typeof fetch;
  private readonly own: string;

  constructor(private readonly options: Options) {
    this.home = options.home ?? homedir();
    this.fetch = options.fetch ?? fetch;
    this.own = join(options.dataDir, 'openjev');
  }

  /** The helper environment: `openjev/` in Hello's data folder, whose `mlx` and `api` may be links to one set up elsewhere. */
  helperHome(): string | null {
    const dir = this.own;
    return existsSync(join(dir, 'mlx', 'bin', 'python')) && HELPER_FILES.every(([file]) => existsSync(join(dir, 'api', file))) ? dir : null;
  }

  /** The openjev-MLX folder: in oMLX's model folders, else `~/Models/MLX`. */
  modelDir(): string | null {
    const settings = record(readJSON(join(this.home, '.omlx', 'settings.json')));
    const model = record(settings.model);
    const dirs = [...(Array.isArray(model.model_dirs) ? model.model_dirs.filter((d): d is string => typeof d === 'string') : [])];
    if (typeof model.model_dir === 'string' && !dirs.includes(model.model_dir)) dirs.push(model.model_dir);
    dirs.push(join(this.home, 'Models', 'MLX'));
    for (const dir of dirs) {
      let names: string[];
      try { names = readdirSync(dir).filter(name => { try { return statSync(join(dir, name, 'config.json')).isFile(); } catch { return false; } }); } catch { continue; }
      const name = pickOpenJev(names);
      if (name) return join(dir, name);
    }
    return null;
  }

  /** Ports a helper may already answer on: the one Hello used and the card's default. */
  private ports(): number[] {
    const saved = (path: string) => { const port = record(readJSON(path)).port; return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : null; };
    const list = [this.port, saved(join(this.own, 'config.json')), DEFAULT_PORT];
    return [...new Set(list.filter((port): port is number => port !== null))];
  }

  private async answers(port: number): Promise<boolean> {
    try {
      const response = await this.fetch(`http://127.0.0.1:${port}/v1/version`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) return false;
      return typeof record(await response.json()).model_dir === 'string';
    } catch {
      return false;
    }
  }

  private async answering(): Promise<string | null> {
    for (const port of this.ports()) if (await this.answers(port)) { this.port = port; return `http://127.0.0.1:${port}`; }
    return null;
  }

  private alive(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  async status(): Promise<OpenJevStatus> {
    const endpoint = await this.answering();
    if (endpoint) return { state: 'ready', detail: `OpenJev answers on 127.0.0.1:${this.port}${this.alive() ? '' : ' (started outside Hello.)'}`, endpoint, ownHelper: this.alive() };
    if (this.alive()) return { state: 'starting', detail: 'OpenJev is loading its weights (about 27 GB)…', ownHelper: true };
    const missing = this.missing();
    if (missing) return { state: 'missing', detail: missing, ownHelper: false };
    return { state: 'stopped', detail: 'OpenJev is off. Analysing a page starts it.', ownHelper: false };
  }

  /** Why OpenJev cannot be started here, or null when it can. */
  private missing(): string | null {
    if (!this.modelDir()) return 'No openjev-MLX folder found in ~/Models/MLX or oMLX’s model folders.';
    if (!this.helperHome()) return `OpenJev’s helper environment is not set up (expected in ${this.own}: its mlx and api folders, or links to them).`;
    return null;
  }

  /** An endpoint that answers: one already running, or the helper started now and waited for. */
  ensure(signal?: AbortSignal): Promise<string> {
    if (!this.starting) this.starting = this.start(signal).finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start(signal?: AbortSignal): Promise<string> {
    const running = await this.answering();
    if (running) return running;
    if (!this.alive()) {
      const missing = this.missing();
      if (missing) throw new Error(missing);
      const helperHome = this.helperHome()!;
      const model = this.modelDir()!;
      for (const [file, pin] of HELPER_FILES)
        if (sha256(join(helperHome, 'api', file)) !== pin) throw new Error(`${file} in ${helperHome} is not the pinned OpenJev helper (its SHA-256 differs); it was not run.`);
      const free = this.options.portFree ?? defaultPortFree;
      let port: number | null = null;
      for (let candidate = DEFAULT_PORT; candidate < DEFAULT_PORT + 40 && port === null; candidate++) if (await free(candidate)) port = candidate;
      if (port === null) throw new Error('No free local port for the OpenJev helper.');
      mkdirSync(this.own, { recursive: true });
      writeFileSync(join(this.own, 'config.json'), JSON.stringify({ port }, null, 2));
      const logPath = join(this.own, 'helper.log');
      appendFileSync(logPath, `--- start ${new Date().toISOString()} · ${model} · port ${port}\n`);
      const spec = launchSpec(helperHome, model, port);
      const out = openSync(logPath, 'a');
      try {
        this.child = (this.options.spawn ?? nodeSpawn)(spec.command, spec.args, { env: { ...process.env, ...spec.env }, stdio: ['ignore', out, out], detached: false });
      } finally {
        closeSync(out);
      }
      this.child.once('error', error => this.options.log?.(`OpenJev helper failed: ${error.message}`));
      this.port = port;
    }
    const deadline = Date.now() + READY_MS;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Stopped.');
      if (this.port !== null && await this.answers(this.port)) return `http://127.0.0.1:${this.port}`;
      if (!this.alive()) throw new Error(`The OpenJev helper stopped while loading. See ${join(this.own, 'helper.log')}.`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('The OpenJev helper did not answer within 5 minutes (it loads about 27 GB of weights).');
  }

  /** One request to `/v1/systemone`; the body is already OpenJev's shape. */
  async ask(body: unknown, signal?: AbortSignal): Promise<unknown> {
    const endpoint = await this.ensure(signal);
    const timeout = AbortSignal.timeout(REQUEST_MS);
    const response = await this.fetch(`${endpoint}/v1/systemone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    let json: unknown = null;
    try { json = await response.json(); } catch { /* reported below */ }
    if (!response.ok) {
      const message = record(record(json).error).message;
      throw new Error(`OpenJev refused the request (HTTP ${response.status})${typeof message === 'string' ? `: ${message.slice(0, 200)}` : '.'}`);
    }
    if (json === null) throw new Error('OpenJev returned no JSON.');
    return json;
  }

  /** Stops the helper Hello started. One started elsewhere is not Hello's to stop. */
  stop(): boolean {
    if (!this.alive()) return false;
    this.child!.kill();
    this.child = null;
    return true;
  }

  dispose(): void {
    this.stop();
  }
}
