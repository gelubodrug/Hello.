import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { augmentedPath } from './terminal/env';

export const SHELL_ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'] as const;
export const CHILD_PLATFORM_KEYS = ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'TZ',
  'SystemRoot', 'WINDIR', 'USERPROFILE', ...SHELL_ENV_KEYS] as const;

type ShellReader = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
const execute: ShellReader = (file, args, env) => new Promise((resolve, reject) => {
  execFile(file, args, { env, cwd: env.HOME || homedir(), timeout: 5000, maxBuffer: 256 * 1024,
    killSignal: 'SIGKILL', encoding: 'utf8', windowsHide: true }, (error, stdout) => {
    // Shell startup output and errors may contain private values: never log them.
    if (error) reject(new Error('Login shell environment unavailable.'));
    else resolve(stdout);
  });
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Capture only launch variables, framed so shell greetings cannot become data. */
export async function readLoginShellEnv(source: NodeJS.ProcessEnv = process.env, run: ShellReader = execute): Promise<NodeJS.ProcessEnv> {
  const fallback = { PATH: augmentedPath(source) };
  if (process.platform === 'win32') return fallback;
  const shell = source.SHELL && isAbsolute(source.SHELL) ? source.SHELL : process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  const marker = `HELLO_ENV_${randomUUID()}`;
  const script = `process.stdout.write(${JSON.stringify(marker)}+JSON.stringify(Object.fromEntries(${JSON.stringify(SHELL_ENV_KEYS)}.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]])))+${JSON.stringify(marker)})`;
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1', TERM: 'dumb' };
  for (const name of [...CHILD_PLATFORM_KEYS, 'SHELL']) if (source[name] !== undefined) env[name] = source[name];
  try {
    const output = await run(shell, ['-l', '-i', '-c', `${quote(process.execPath)} -e ${quote(script)}`], env);
    const start = output.indexOf(marker);
    const end = output.indexOf(marker, start + marker.length);
    if (start < 0 || end < 0) return fallback;
    const parsed: unknown = JSON.parse(output.slice(start + marker.length, end));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    const picked: NodeJS.ProcessEnv = {};
    for (const name of SHELL_ENV_KEYS) {
      const value = (parsed as Record<string, unknown>)[name];
      if (typeof value === 'string' && !value.includes('\0') && value.length <= 32 * 1024) picked[name] = value;
    }
    return { ...picked, PATH: augmentedPath({ ...source, ...picked }) };
  } catch { return fallback; }
}

let captured: NodeJS.ProcessEnv = {};
let loading: Promise<void> | undefined;
/** Called once before main creates services. Does not change the app/OS environment. */
export function initializeShellEnv(): Promise<void> {
  return loading ??= readLoginShellEnv().then(env => { captured = env; });
}
export function shellEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...source, ...captured, PATH: captured.PATH ?? augmentedPath(source) };
}
