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
