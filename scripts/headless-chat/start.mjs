// Start one headless Hello chat turn (see README.md).
//   node scripts/headless-chat/start.mjs <root> [--pi <path to Pi's rpc-entry.js>]
// <root> must hold `prompt.txt` (the person's message). `folder/` is the folder
// the person chose for the chat, `drop/` the files dropped on it; with neither,
// the chat works in the folder Hello keeps for it, as any chat with none does.
// Everything the run writes stays under <root>.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, openSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const root = resolve(process.argv[2] ?? '');
const pi = process.argv.includes('--pi') ? process.argv[process.argv.indexOf('--pi') + 1] : undefined;
if (!process.argv[2] || !existsSync(join(root, 'prompt.txt'))) {
  console.error('usage: node scripts/headless-chat/start.mjs <root> [--pi <rpc-entry.js>]\n<root> must hold prompt.txt; folder/ (the chat\'s folder) and drop/ (files dropped on it) are optional.');
  process.exit(2);
}
// A run starts clean, but keeps what took a download to make (the Python the sheet tools run scripts in).
for (const name of ['io', 'trace.jsonl', 'result.json', 'runner.log', 'replies']) rmSync(join(root, name), { recursive: true, force: true });
mkdirSync(join(root, 'io'), { recursive: true });
mkdirSync(join(root, 'replies'), { recursive: true });
mkdirSync(join(root, 'data'), { recursive: true });
for (const name of ['hello.sqlite', 'hello.sqlite-wal', 'hello.sqlite-shm', 'pi-chat']) rmSync(join(root, 'data', name), { recursive: true, force: true });
if (!existsSync(join(root, 'node_modules'))) symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'));
// The current source, not the last build: the runner and Hello's Pi extension side by side, as the app ships them.
const common = { bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'warning' };
await build({ ...common, entryPoints: [join(here, 'runner.ts')], outfile: join(root, 'runner.mjs') });
await build({ ...common, entryPoints: [join(repo, 'src/main/chat/pi-extension.ts')], outfile: join(root, 'pi-extension.js') });
copyFileSync(join(here, 'turn.mjs'), join(root, 'turn.mjs'));
const electron = createRequire(import.meta.url)('electron');
const log = openSync(join(root, 'runner.log'), 'a');
// Electron as Node: the SQLite build is Electron's, and Pi is started with this same binary.
const child = spawn(electron, [join(root, 'runner.mjs')], {
  cwd: repo, detached: true, stdio: ['ignore', log, log],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HEADLESS_ROOT: root, ...(pi ? { HEADLESS_PI_ENTRY: pi } : {}) },
});
child.unref();
console.log(`Headless chat started (pid ${child.pid}).\nThe model's chair: node ${join(root, 'turn.mjs')}\nTrace: ${join(root, 'trace.jsonl')}   Result: ${join(root, 'result.json')}`);
