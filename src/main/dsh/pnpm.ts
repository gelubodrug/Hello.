import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * The package manager Hello ships (pnpm, the same major DSH Desktop bundles),
 * run by Electron itself as Node, so installing dsh or a plugin never depends
 * on whatever Node or pnpm the Mac happens to have.
 */
export interface PnpmInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Variables a child process of ours may inherit. Everything else — above all
 * any key or token in Hello's own environment — stays in main. The proxy and
 * locale variables are the person's network and language, which an install
 * and a host both need to behave as the rest of the Mac does.
 */
const INHERITED = /^(?:PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_[A-Z]+|TZ|http_proxy|https_proxy|no_proxy|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY|all_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/;

export function inheritedEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source))
    if (typeof value === 'string' && INHERITED.test(key)) env[key] = value;
  return env;
}

/** Hello's pnpm, as a command Electron runs as Node. */
export function bundledPnpm(execPath: string = process.execPath): PnpmInvocation {
  const require = createRequire(import.meta.url);
  // pnpm exports exactly one path, "." → its package.json: that is the package root.
  const script = join(dirname(require.resolve('pnpm')), 'bin', 'pnpm.cjs');
  return {
    command: execPath,
    args: [script],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      // A folder with a packageManager field must not make pnpm fetch another pnpm.
      npm_config_manage_package_manager_versions: 'false',
      npm_config_update_notifier: 'false',
    },
  };
}

export interface InstallProgress {
  resolved: number;
  reused: number;
  downloaded: number;
  added: number;
  done: boolean;
}

/** One `--reporter=append-only` progress line, or undefined for any other line. */
export function parseProgress(line: string): InstallProgress | undefined {
  const match = /Progress: resolved (\d+), reused (\d+), downloaded (\d+), added (\d+)(, done)?/.exec(line);
  if (!match) return undefined;
  return {
    resolved: Number(match[1]),
    reused: Number(match[2]),
    downloaded: Number(match[3]),
    added: Number(match[4]),
    done: Boolean(match[5]),
  };
}

export interface PnpmRun {
  code: number;
  /** The tail of what pnpm printed, for an error the person can read. */
  output: string;
}

const OUTPUT_LIMIT = 16 * 1024;
/** pnpm's last line, once a command has finished. */
const DONE = /^Done in [\d.]+\s*m?s\b/;
/** How long pnpm may linger after saying Done. */
export const PNPM_DONE_GRACE_MS = 20_000;
/** How long pnpm may print nothing before it counts as stuck: its own fetches give up well before. */
export const PNPM_QUIET_LIMIT_MS = 5 * 60_000;

/**
 * Runs one pnpm command in a folder of ours. Never rejects for a failed
 * install: the exit code and pnpm's own words come back to the caller.
 *
 * pnpm can say "Done" and not exit: after installing dsh 0.2.0-rc.2 it went
 * on retrying tarballs for other platforms and hung there for hours, with
 * the install finished (user, 01.10: "e blocat? se reia? verifică
 * conexiunea?"). Done is taken at its word after a grace period; and a pnpm
 * that prints nothing for minutes is stopped, with the reason.
 */
export function runPnpm(invocation: PnpmInvocation, args: readonly string[], options: {
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
  doneGraceMs?: number;
  quietLimitMs?: number;
}): Promise<PnpmRun> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new Error('Cancelled.'));
      return;
    }
    const doneGrace = options.doneGraceMs ?? PNPM_DONE_GRACE_MS;
    const quietLimit = options.quietLimitMs ?? PNPM_QUIET_LIMIT_MS;
    let ended: 'done' | 'quiet' | undefined;
    let doneTimer: ReturnType<typeof setTimeout> | undefined;
    let lastOutput = Date.now();
    const child = spawn(invocation.command, [...invocation.args, ...args, '--reporter=append-only'], {
      cwd: options.cwd,
      env: { ...inheritedEnv(), ...invocation.env, ...options.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let pending = '';
    const take = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      lastOutput = Date.now();
      output = (output + text).slice(-OUTPUT_LIMIT);
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        options.onLine?.(line);
        if (!doneTimer && DONE.test(line.trim()))
          doneTimer = setTimeout(() => { ended ??= 'done'; child.kill('SIGTERM'); }, doneGrace);
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const watchdog = setInterval(() => {
      if (Date.now() - lastOutput < quietLimit) return;
      ended ??= 'quiet';
      child.kill('SIGTERM');
    }, Math.min(1_000, quietLimit));
    const stopTimers = () => { clearInterval(watchdog); if (doneTimer) clearTimeout(doneTimer); };
    const abort = () => child.kill('SIGTERM');
    options.signal?.addEventListener('abort', abort, { once: true });
    child.on('error', error => {
      stopTimers();
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', code => {
      stopTimers();
      options.signal?.removeEventListener('abort', abort);
      if (pending.trim()) options.onLine?.(pending);
      if (options.signal?.aborted) reject(options.signal.reason ?? new Error('Cancelled.'));
      else if (ended === 'done') resolve({ code: 0, output: `${output}\npnpm said Done but did not exit; Hello. stopped it after ${Math.round(doneGrace / 1000)} s.` });
      else if (ended === 'quiet') resolve({ code: 1, output: `${output}\npnpm printed nothing for ${Math.round(quietLimit / 60_000)} minutes and was stopped. Check the connection, then try again.` });
      else resolve({ code: code ?? 1, output });
    });
  });
}

/** The package a registry tarball URL is of: `…/@img/sharp-linux-arm/-/sharp-linux-arm-0.35.5.tgz` → `@img/sharp-linux-arm`. */
function packageOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/-/')[0].replace(/^\//, '')) || url;
  } catch {
    return url;
  }
}

/** How many packages pnpm is about to add, from its `Packages: +315 -85` line. */
export function packagesToAdd(line: string): number | undefined {
  const match = /^Packages: \+(\d+)/.exec(line.trim());
  return match ? Number(match[1]) : undefined;
}

/**
 * What one line of pnpm's output says it is doing, in the person's words, or
 * nothing for chatter the counters already carry. Shown live while dsh
 * installs, so a slow download, a retry or a build reads as what it is.
 */
export function pnpmActivity(line: string): string | undefined {
  const text = line.trim();
  if (!text || parseProgress(text) || /^[+-]+$/.test(text) || packagesToAdd(text) !== undefined) return undefined;
  let match = /GET (\S+) error \(([^)]*)\)\. Will retry in (.+?)\. (\d+) retries left/.exec(text);
  if (match) return `Retrying ${packageOf(match[1])} in ${match[3]} (${match[4]} ${match[4] === '1' ? 'try' : 'tries'} left, error ${match[2]}). If this keeps repeating, check the connection.`;
  match = /Tarball download average speed ([\d.]+ \w+\/s).*?: (\S+)/.exec(text);
  if (match) return `Slow download, ${match[1]}: ${packageOf(match[2])}`;
  match = /^(?:\.\.\.\/)?(?:node_modules\/)?(\S+?) (?:pre|post)?install\$/.exec(text);
  if (match) return `Building ${match[1]}…`;
  match = /^(?:\.\.\.\/)?(?:node_modules\/)?(\S+?) (?:pre|post)?install: Done$/.exec(text);
  if (match) return `Built ${match[1]}.`;
  match = DONE.exec(text);
  if (match) return `${match[0].replace(/^Done in/, 'Packages in place in')}. Finishing…`;
  if (/^\[WARN\]/.test(text)) return text.replace(/^\[WARN\]\s*/, '').slice(0, 200);
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** The last lines pnpm printed, stripped of its progress chatter. */
export function pnpmFailure(output: string): string {
  const lines = output.split(/\r?\n/).filter(line => line.trim() && !parseProgress(line));
  return lines.slice(-8).join('\n') || 'pnpm stopped without saying why.';
}
