import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packagesToAdd, pnpmActivity, runPnpm } from '../src/main/dsh/pnpm';

// User, 01.10: "pune ceva viu aici, că nu știi nimic ce face… e blocat, se
// reia, verifică conexiunea" — pnpm had said Done and hung for two hours.
const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
const fake = (name: string) => ({ command: process.execPath, args: [resolve(__dirname, 'fixtures', name)], env: {} });
const cwd = () => { const made = mkdtempSync(join(tmpdir(), 'hello-pnpm-')); folders.push(made); return made; };

describe('pnpm, run by Hello', () => {
  it('is taken at its word once it says Done, if it does not exit', async () => {
    const run = await runPnpm(fake('fake-pnpm-lingers.mjs'), ['install'], { cwd: cwd(), doneGraceMs: 150 });
    expect(run.code).toBe(0);
    expect(run.output).toContain('pnpm said Done but did not exit');
  });

  it('is stopped when it prints nothing for too long, and says why', async () => {
    const run = await runPnpm(fake('fake-pnpm-silent.mjs'), ['install'], { cwd: cwd(), quietLimitMs: 300 });
    expect(run.code).toBe(1);
    expect(run.output).toContain('printed nothing');
    expect(run.output).toContain('Check the connection');
  });
});

describe('what pnpm says it is doing', () => {
  it('reads retries, slow downloads, builds and the end in the person\'s words', () => {
    expect(pnpmActivity('[WARN] GET https://registry.npmjs.org/@deepseek-ai/libreoffice-kit-wasm/-/libreoffice-kit-wasm-0.1.1.tgz error (23). Will retry in 10 seconds. 2 retries left.'))
      .toBe('Retrying @deepseek-ai/libreoffice-kit-wasm in 10 seconds (2 tries left, error 23). If this keeps repeating, check the connection.');
    expect(pnpmActivity('[WARN] Tarball download average speed 41 KiB/s (size 112 KiB) is below 50 KiB/s: https://registry.npmjs.org/@img/sharp-linux-ppc64/-/sharp-linux-ppc64-0.35.5.tgz (GET)'))
      .toBe('Slow download, 41 KiB/s: @img/sharp-linux-ppc64');
    expect(pnpmActivity('node_modules/koffi install$ node ./cnoke.cjs -P . -D src/koffi --prebuild --release')).toBe('Building koffi…');
    expect(pnpmActivity('.../@deepseek-ai/dsh-subprocess-local postinstall: Done')).toBe('Built @deepseek-ai/dsh-subprocess-local.');
    expect(pnpmActivity('Done in 34.9s using pnpm v11.8.0')).toBe('Packages in place in 34.9s. Finishing…');
  });

  it('leaves the counters\' own lines to the counters', () => {
    expect(pnpmActivity('Progress: resolved 592, reused 52, downloaded 18, added 35')).toBeUndefined();
    expect(pnpmActivity('+++++++++++++-----')).toBeUndefined();
    expect(pnpmActivity('Packages: +315 -85')).toBeUndefined();
    expect(packagesToAdd('Packages: +315 -85')).toBe(315);
    expect(packagesToAdd('Packages: -3')).toBeUndefined();
  });
});
