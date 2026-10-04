import { fork } from 'node:child_process';
import type { HostChild, SpawnHost } from './host';

/**
 * A host as a plain Node child process. The app uses an Electron utility
 * process instead (electron-spawn.ts); this one serves the tests, which run
 * without Electron's main process.
 */
export const forkSpawn: SpawnHost = (entry, args, options) => {
  const child = fork(entry, args, {
    cwd: options.cwd,
    env: options.env,
    execArgv: options.execArgv,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const exits = new Set<(code: number) => void>();
  child.on('exit', code => { for (const listener of [...exits]) listener(code ?? 1); });
  const host: HostChild = {
    get pid() { return child.pid; },
    postMessage(message) { child.send(message as never); },
    onMessage(listener) { child.on('message', listener); },
    onExit(listener) {
      if (child.exitCode !== null || child.signalCode !== null) listener(child.exitCode ?? 1);
      else exits.add(listener);
    },
    onOutput(listener) {
      child.stdout?.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')));
    },
    kill() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); },
  };
  return host;
};
