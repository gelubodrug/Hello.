// Native dependencies are rebuilt for Electron. Use that same ABI for SQLite tests.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const electron = require('electron');
const child = spawn(electron, ['node_modules/vitest/vitest.mjs', 'run', ...process.argv.slice(2)], {
  stdio: 'inherit', env: {...process.env, ELECTRON_RUN_AS_NODE:'1'},
});
child.on('error', error => { console.error(error.message); process.exitCode=1; });
child.on('exit', code => { process.exitCode=code??1; });
