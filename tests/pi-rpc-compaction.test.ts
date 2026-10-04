import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiRpcProcess } from '../src/main/chat/pi-rpc';

const fixture = join(__dirname, 'fixtures', 'fake-pi-rpc.mjs');
const launch = (env: Record<string, string>) => new PiRpcProcess({
  command: process.execPath, args: [fixture], cwd: tmpdir(),
  env: { ...process.env, ...env }, requestTimeoutMs: 400, startupTimeoutMs: 10_000,
});

// A prompt is acknowledged only after Pi's preflight, and preflight compacts
// first when the last turn left the context over the line — a summary the
// model has to write, minutes on a local model (user, 24.09: "Pi command timed
// out (prompt)" three times running, each try compacting the same history
// from scratch and dying at 30 s).
describe('a prompt Pi answers with compaction first', () => {
  it('is not timed out while Pi says it is compacting, and is once Pi has gone quiet', async () => {
    const compacting = launch({ FAKE_PI_COMPACTION_MS: '1200' });
    try {
      await expect(compacting.prompt('resume work')).resolves.toMatchObject({ command: 'prompt', success: true });
    } finally {
      await compacting.dispose();
    }
    const silent = launch({ FAKE_PI_COMPACTION_MS: '1200', FAKE_PI_SILENT: '1' });
    try {
      await expect(silent.prompt('resume work')).rejects.toThrow('Pi command timed out (prompt).');
    } finally {
      await silent.dispose();
    }
  }, 15_000);
});

// Pi runs extensions' session_shutdown handlers when its input ends. A signal
// sent at the same moment cut them off after ~10 ms (experiment 29.09: a
// memory plugin's shutdown work never finished in Hello).
describe('stopping Pi', () => {
  it('aborts the reply, ends its input and lets it finish its own shutdown', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const marker = join(mkdtempSync(join(tmpdir(), 'hello-pi-stop-')), 'finished');
    const pi = launch({ FAKE_PI_SHUTDOWN_MS: '300', FAKE_PI_MARKER: marker });
    await pi.start();
    const started = Date.now();
    await pi.dispose();
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    // get_state is the handshake; the abort reached Pi before its input ended.
    expect(readFileSync(marker, 'utf8')).toBe('finished after get_state,abort');
  });

  it('still stops a Pi that ignores the end of its input', async () => {
    const pi = launch({ FAKE_PI_IGNORE_EOF: '1' });
    await pi.start();
    const started = Date.now();
    await pi.dispose();
    expect(pi.isRunning).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);
});

describe('a Pi that cannot start', () => {
  it('names the extension it could not load, with Pi’s reason', async () => {
    const { PiExtensionLoadError } = await import('../src/main/chat/pi-rpc');
    const pi = launch({ FAKE_PI_LOAD_ERROR: '/library/plugins/abc/index.ts' });
    const failure = await pi.start().then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(PiExtensionLoadError);
    expect(failure).toMatchObject({ extensionPath: '/library/plugins/abc/index.ts', reason: "Cannot find module '@modelcontextprotocol/client'" });
    await pi.dispose();
  });
});
