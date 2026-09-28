// A stand-in for Pi's RPC child: answers get_state at once and, for a prompt,
// says it is compacting for FAKE_PI_COMPACTION_MS before acknowledging — or,
// with FAKE_PI_SILENT set, just stays quiet that long.
import { createInterface } from 'node:readline';
const out = (record) => process.stdout.write(JSON.stringify(record) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line);
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
