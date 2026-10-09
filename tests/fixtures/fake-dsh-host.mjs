// A stand-in for src/main/dsh/host-entry.ts: the same messages, no dsh.
// FAKE_DSH_MODE picks the behaviour: ready (default), fatal, exit, silent.
const mode = process.env.FAKE_DSH_MODE ?? 'ready';
const send = message => process.send?.(message);
process.stdout.write(`dsh web: http://127.0.0.1:4567/?token=SECRET-TOKEN-1234567890 home=${process.env.DSH_HOME}\n`);
process.stdout.write(`env telemetry=${process.env.DSH_TELEMETRY_DISABLED} dnt=${process.env.DO_NOT_TRACK} patch=${process.env.HELLO_DSH_PATCH ?? ''} internals=${process.execArgv.includes('--expose-internals')} secret=${process.env.HELLO_SECRET ?? 'none'}\n`);
process.on('message', message => {
  if (message?.type === 'shutdown') {
    send({ type: 'shutdown-complete' });
    setTimeout(() => process.exit(0), 10);
  }
});
if (mode === 'ready') setTimeout(() => send({ type: 'ready', port: 4567, url: 'http://127.0.0.1:4567/?token=SECRET-TOKEN-1234567890' }), 20);
else if (mode === 'fatal') setTimeout(() => { send({ type: 'fatal', message: 'boot failed: ?token=SECRET-TOKEN-1234567890', diagnostic: 'stack' }); setTimeout(() => process.exit(1), 20); }, 20);
else if (mode === 'exit') setTimeout(() => process.exit(3), 20);
setInterval(() => {}, 1000);
