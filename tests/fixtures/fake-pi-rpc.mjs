// A stand-in for Pi's RPC child: answers get_state at once and, for a prompt,
// says it is compacting for FAKE_PI_COMPACTION_MS before acknowledging — or,
// with FAKE_PI_SILENT set, just stays quiet that long.
//
// Shutdown and startup behaviour, for the transport's own tests:
// FAKE_PI_SHUTDOWN_MS: when its input ends, it works that long, writes
//   FAKE_PI_MARKER and exits, the way Pi runs session_shutdown handlers.
// FAKE_PI_IGNORE_EOF: it keeps running when its input ends.
// FAKE_PI_LOAD_ERROR: it reports an extension it could not load and exits.
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const out = (record) => process.stdout.write(JSON.stringify(record) + '\n');
if (process.env.FAKE_PI_LOAD_ERROR) {
  process.stderr.write(`Error: Failed to load extension "${process.env.FAKE_PI_LOAD_ERROR}": Failed to load extension: Cannot find module '@modelcontextprotocol/client'\nHint: Start without extensions using "pi -ne".\n`);
  process.exit(1);
}
if (process.env.FAKE_PI_IGNORE_EOF) setInterval(() => {}, 1000);
const received = [];
process.stdin.on('end', () => {
  const work = Number(process.env.FAKE_PI_SHUTDOWN_MS ?? 0);
  if (!work || process.env.FAKE_PI_IGNORE_EOF) return;
  setTimeout(() => {
    if (process.env.FAKE_PI_MARKER) writeFileSync(process.env.FAKE_PI_MARKER, `finished after ${received.join(',')}`);
    process.exit(0);
  }, work);
});
createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line);
  received.push(command.type);
  if (command.type === 'prompt') {
    const delay = Number(process.env.FAKE_PI_COMPACTION_MS ?? 0);
    if (!process.env.FAKE_PI_SILENT) out({ type: 'compaction_start', reason: 'threshold' });
    setTimeout(() => {
      if (!process.env.FAKE_PI_SILENT) out({ type: 'compaction_end', result: { summary: 'shorter' } });
      out({ id: command.id, type: 'response', command: 'prompt', success: true });
    }, delay);
    return;
  }
  out({ id: command.id, type: 'response', command: command.type, success: true, data: {} });
});
