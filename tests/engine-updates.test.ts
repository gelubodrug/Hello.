import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DshStatus, PiEngineStatus } from '../src/shared/types';
import { newer, npmLatest } from '../src/main/updates';
import { PiEngine } from '../src/main/chat/pi-engine';
import { dshLayout, selectedVersion, type DshLayout } from '../src/main/dsh/layout';
import { DshService } from '../src/main/dsh/service';
import { installRuntime } from '../src/main/dsh/runtime';
import { forkSpawn } from '../src/main/dsh/spawn';

// User, 01.10: "DSH v.xxx (update) jos în bară … update dacă există versiune
// nouă, dacă nu, nu … la fel și pentru Pi", updated from the app, with the
// version Hello came with one click away.

const folders: string[] = [];
const services: DshService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const folder = (name: string) => {
  const made = mkdtempSync(join(tmpdir(), name));
  folders.push(made);
  return made;
};

describe('a newer release on npm', () => {
  it('is offered only when it is newer than what runs', () => {
    expect(newer('0.99.2', '0.99.1')).toBe('0.99.2');
    expect(newer('0.2.0-rc.2', '0.1.7-rc.2')).toBe('0.2.0-rc.2');
    expect(newer('0.99.1', '0.99.1')).toBeUndefined();
    expect(newer('0.98.0', '0.99.1')).toBeUndefined();
    expect(newer(undefined, '0.99.1')).toBeUndefined();
    expect(newer('not-a-version', '0.99.1')).toBeUndefined();
  });

  it('is what npm tags latest, and nothing when npm cannot say', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.99.2' })));
    expect(await npmLatest('@earendil-works/pi-coding-agent', fetcher)).toBe('0.99.2');
    expect(String(fetcher.mock.calls[0][0])).toBe('https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest');
    expect(await npmLatest('x', vi.fn<typeof fetch>(async () => new Response('', { status: 404 })))).toBeUndefined();
    expect(await npmLatest('x', vi.fn<typeof fetch>(async () => { throw new TypeError('fetch failed'); }))).toBeUndefined();
    expect(await npmLatest('x', vi.fn<typeof fetch>(async () => new Response('{"version":"latest"}')))).toBeUndefined();
  });
});

/** A Pi package as pnpm leaves it: its package.json and its rpc-entry. */
function piAt(base: string, version: string): string {
  const root = join(base, 'node_modules', '@earendil-works', 'pi-coding-agent');
  mkdirSync(join(root, 'dist', 'bundle'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version }));
  writeFileSync(join(root, 'dist', 'bundle', 'rpc-entry.js'), '');
  return join(root, 'dist', 'bundle', 'rpc-entry.js');
}

describe('the Pi engine', () => {
  const engine = (options: { latest?: string; install?: (folder: string, version: string) => Promise<void> } = {}) => {
    const root = folder('hello-pi-engine-');
    const bundled = piAt(join(root, 'app'), '0.99.1');
    const statuses: PiEngineStatus[] = [];
    const created = new PiEngine({
      root: join(root, 'data', 'pi'),
      pnpm: { command: process.execPath, args: [], env: {} },
      bundledEntry: () => bundled,
      latest: async () => options.latest,
      install: options.install ?? (async (staging, version) => { piAt(staging, version); }),
      emit: status => statuses.push(status),
    });
    return { engine: created, bundled, statuses, root };
  };

  it('runs the Pi Hello came with, and offers update only when npm has a newer one', async () => {
    const { engine: same } = engine({ latest: '0.99.1' });
    expect(await same.checkLatest()).toEqual({ version: '0.99.1', bundled: '0.99.1', state: 'idle' });
    const { engine: pi, bundled } = engine({ latest: '0.99.2' });
    expect(await pi.checkLatest()).toEqual({ version: '0.99.1', bundled: '0.99.1', latest: '0.99.2', state: 'idle' });
    expect(pi.entry()).toBe(bundled);
  });

  it('updates beside the bundled Pi, runs the update from then on, and goes back by removing it', async () => {
    const { engine: pi, bundled, statuses, root } = engine({ latest: '0.99.2' });
    await pi.checkLatest();
    expect(await pi.update()).toEqual({ version: '0.99.2', bundled: '0.99.1', state: 'idle' });
    expect(statuses.map(status => status.state)).toContain('updating');
    expect(pi.entry()).toBe(join(root, 'data', 'pi', 'runtime', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'rpc-entry.js'));
    expect(await pi.useBundled()).toEqual({ version: '0.99.1', bundled: '0.99.1', latest: '0.99.2', state: 'idle' });
    expect(pi.entry()).toBe(bundled);
    expect(existsSync(join(root, 'data', 'pi', 'runtime'))).toBe(false);
  });

  it('keeps the Pi that runs when an update fails, and says why', async () => {
    const { engine: pi, bundled, root } = engine({ latest: '0.99.2', install: async () => { throw new Error('Installing Pi 0.99.2 failed.\nERR_PNPM_FETCH_404'); } });
    await pi.checkLatest();
    expect(await pi.update()).toMatchObject({ version: '0.99.1', latest: '0.99.2', state: 'failed', message: expect.stringContaining('ERR_PNPM_FETCH_404') });
    expect(pi.entry()).toBe(bundled);
    // The staging folder does not stay behind.
    expect(readdirSync(join(root, 'data', 'pi'))).toEqual([]);
  });

  it('runs the bundled Pi again once Hello brings one newer than an earlier update', () => {
    const { engine: pi, bundled, root } = engine();
    piAt(join(root, 'data', 'pi', 'runtime'), '0.98.0');
    expect(pi.current()).toMatchObject({ version: '0.99.1', updated: false, entry: bundled });
  });
});

describe('the DSH runtime', () => {
  function installed(place: DshLayout, version: string) {
    mkdirSync(join(place.runtime, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
    writeFileSync(place.installAnchor, JSON.stringify({ version }));
    mkdirSync(join(place.runtime, 'node_modules', 'node-addon-require-builtin'), { recursive: true });
    writeFileSync(join(place.runtime, 'node_modules', 'node-addon-require-builtin', 'package.json'), '{}');
  }
  type Install = NonNullable<ConstructorParameters<typeof DshService>[0]['install']>;
  const service = (options: { fail?: boolean; install?: Install } = {}) => {
    const root = folder('hello-dsh-update-');
    const place = dshLayout(root, join(root, 'resources'));
    installed(place, '0.1.7-rc.2');
    const statuses: DshStatus[] = [];
    const created = new DshService({
      layout: place,
      hostEntry: resolve(__dirname, 'fixtures/fake-dsh-host.mjs'),
      spawn: (entry, args, spawnOptions) => forkSpawn(entry, args, spawnOptions),
      surface: { async connect() {}, disconnect() {} },
      pnpm: { command: process.execPath, args: [resolve(__dirname, 'fixtures/fake-pnpm.mjs')], env: {} },
      emit: status => statuses.push(status),
      latest: async () => '0.2.0-rc.2',
      install: options.install ?? (async (layoutArg, _pnpm, installOptions) => {
        if (options.fail) throw new Error('Installing the DSH runtime failed.\nERR_PNPM_FETCH_404');
        installed(layoutArg, installOptions.version);
      }),
    });
    services.push(created);
    return { service: created, place, statuses };
  };

  it('offers and installs the latest dsh without a bundled fallback', async () => {
    const { service: dsh, place } = service();
    expect(await dsh.checkLatest()).toMatchObject({ version: '0.1.7-rc.2', latest: '0.2.0-rc.2' });
    const updated = await dsh.update();
    expect(updated).toMatchObject({ state: 'stopped', version: '0.2.0-rc.2', installedVersion: '0.2.0-rc.2' });
    expect(updated.latest).toBeUndefined();
    expect(selectedVersion(place)).toBe('0.2.0-rc.2');
  });

  it('keeps the dsh that ran when the update cannot be installed, and says why beside its version', async () => {
    const { service: dsh, place } = service({ fail: true });
    await dsh.checkLatest();
    expect(await dsh.update()).toMatchObject({ state: 'stopped', version: '0.1.7-rc.2', latest: '0.2.0-rc.2', updateError: expect.stringContaining('ERR_PNPM_FETCH_404') });
    expect(selectedVersion(place)).toBe('0.1.7-rc.2');
  });

  // User, 01.10: "pune ceva viu aici, că nu știi nimic ce face".
  it('keeps the install panel alive with what pnpm says it is doing', async () => {
    const { service: dsh, statuses } = service({
      install: async (layoutArg, _pnpm, options) => {
        options?.onLine?.('Packages: +315 -85');
        options?.onProgress?.({ resolved: 592, reused: 52, downloaded: 18, added: 35, done: false });
        options?.onLine?.('[WARN] GET https://registry.npmjs.org/@deepseek-ai/libreoffice-kit-wasm/-/libreoffice-kit-wasm-0.1.1.tgz error (23). Will retry in 10 seconds. 2 retries left.');
        installed(layoutArg, options.version);
      },
    });
    await dsh.checkLatest();
    await dsh.update();
    const during = statuses.filter(status => status.state === 'installing').at(-1)!;
    expect(during.progress).toMatchObject({ total: 315, resolved: 592, added: 35, activity: expect.stringContaining('Retrying @deepseek-ai/libreoffice-kit-wasm') });
    expect(during.progress!.at).toBeGreaterThanOrEqual(during.progress!.startedAt!);
  });

  // User, 01.10: "apeși, clipește, se termină imediat": pnpm in CI mode kept
  // the runtime's lockfile — made for the version that ran — frozen.
  it('lets the runtime\'s lockfile follow a new version, as pnpm in CI would refuse it otherwise', async () => {
    const root = folder('hello-dsh-lockfile-');
    const place = dshLayout(root, join(root, 'resources'));
    const pnpm = { command: process.execPath, args: [resolve(__dirname, 'fixtures/fake-pnpm-lockfile.mjs')], env: {} };
    await installRuntime(place, pnpm, { version: '0.1.7-rc.2' });
    await installRuntime(place, pnpm, { version: '0.2.0-rc.2' });
    expect(JSON.parse(readFileSync(place.installAnchor, 'utf8')).version).toBe('0.2.0-rc.2');
  });
});
