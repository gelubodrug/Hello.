import { utilityProcess } from 'electron';
import type { HostChild, SpawnHost } from './host';

/**
 * The host as an Electron utility process: Electron's own Node, sandboxed
 * from the window, ended with the app. It runs third-party plugin code, so
 * nothing of Hello's reaches it but the environment main built for it.
 */
export const utilitySpawn: SpawnHost = (entry, args, options) => {
  const child = utilityProcess.fork(entry, args, {
    cwd: options.cwd,
    env: options.env,
    execArgv: options.execArgv,
    serviceName: options.serviceName,
    stdio: 'pipe',
  });
  let exited: number | undefined;
  const exits = new Set<(code: number) => void>();
  child.on('exit', code => {
    exited = code;
    for (const listener of [...exits]) listener(code);
  });
  const host: HostChild = {
    get pid() { return child.pid; },
    postMessage(message) { child.postMessage(message); },
    onMessage(listener) { child.on('message', listener); },
    onExit(listener) {
      if (exited !== undefined) listener(exited);
      else exits.add(listener);
    },
    onOutput(listener) {
      child.stdout?.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')));
    },
    kill() { if (exited === undefined) child.kill(); },
  };
  return host;
};
