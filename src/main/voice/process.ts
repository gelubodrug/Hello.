import { spawn } from 'node:child_process';

/** No shell, inherited credentials, or child output in app logs. */
export function voiceCommand(executable: string, args: string[], options: { signal: AbortSignal; cwd: string; library?: string; capture?: boolean; timeout?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeout ?? 180_000)]);
    signal.throwIfAborted();
    const child = spawn(executable, args, { cwd: options.cwd, env: { PATH: '/usr/bin:/bin', ...(options.library ? { DYLD_LIBRARY_PATH: options.library } : {}) }, stdio: ['ignore', options.capture ? 'pipe' : 'ignore', 'ignore'] });
    let output = ''; let failure: Error | undefined;
    const stop = () => { failure = new Error('Voice operation cancelled or timed out.'); child.kill('SIGKILL'); };
    signal.addEventListener('abort', stop, { once: true });
    child.stdout?.on('data', chunk => {
      output += String(chunk);
      if (output.length > 2_000_000) { failure = new Error('The Voice archive has too many entries.'); child.kill('SIGKILL'); }
    });
    child.once('error', () => { failure = new Error('The Voice component could not be started on this Mac.'); });
    child.once('close', code => {
      signal.removeEventListener('abort', stop);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`The Voice component exited with code ${code ?? 'unknown'}. Try again in Settings › Voice.`));
      else resolve(output);
    });
  });
}
