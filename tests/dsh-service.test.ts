import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DshStatus } from '../src/shared/types';
import { DSH_VERSION, dshLayout, type DshLayout } from '../src/main/dsh/layout';
import { DshService, type SurfaceConnector } from '../src/main/dsh/service';
import { forkSpawn } from '../src/main/dsh/spawn';
import type { HostReady } from '../src/main/dsh/host';

const fixture = resolve(__dirname, 'fixtures/fake-dsh-host.mjs');
const fakePnpm = resolve(__dirname, 'fixtures/fake-pnpm.mjs');
const folders: string[] = [];
const services: DshService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function fakeInstall(place: DshLayout) {
  mkdirSync(join(place.runtime, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  writeFileSync(place.installAnchor, JSON.stringify({ version: DSH_VERSION }));
  mkdirSync(join(place.runtime, 'node_modules', 'node-addon-require-builtin'), { recursive: true });
  writeFileSync(join(place.runtime, 'node_modules', 'node-addon-require-builtin', 'package.json'), '{}');
}

function service(mode = 'ready', options: { install?: 'ok' | 'fail'; installed?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hello-dsh-service-'));
  folders.push(root);
  const place = dshLayout(root, join(root, 'resources'));
  if (options.installed) fakeInstall(place);
  const statuses: DshStatus[] = [];
  const surface: SurfaceConnector & { connected: HostReady[]; disconnects: number } = {
    connected: [],
    disconnects: 0,
    async connect(ready) { this.connected.push(ready); },
    disconnect() { this.disconnects++; },
  };
  const created = new DshService({
    layout: place,
    hostEntry: fixture,
    spawn: (entry, args, spawnOptions) => forkSpawn(entry, args, { ...spawnOptions, env: { ...spawnOptions.env, FAKE_DSH_MODE: mode } }),
    surface,
    pnpm: { command: process.execPath, args: [fakePnpm], env: { ELECTRON_RUN_AS_NODE: '1' } },
    emit: status => statuses.push(status),
    install: async (layoutArg, _pnpm, installOptions) => {
      installOptions?.onProgress?.({ resolved: 10, reused: 0, downloaded: 4, added: 10, done: true });
      if (options.install === 'fail') throw new Error('Installing the DSH runtime failed.\nERR_PNPM_FETCH_404');
      fakeInstall(layoutArg);
    },
  });
  services.push(created);
  return { service: created, statuses, surface, place };
}

describe('DshService', () => {
  it('starts absent when nothing is installed', () => {
    const { service: created } = service();
    expect(created.status()).toMatchObject({ state: 'absent', version: DSH_VERSION, checkpoints: [] });
  });

  it('installs on the first start, then runs and connects the surface', async () => {
    const { service: created, statuses, surface } = service();
    const status = await created.start();
    expect(status.state).toBe('running');
    expect(statuses.map(item => item.state)).toEqual(expect.arrayContaining(['installing', 'stopped', 'starting', 'running']));
    // The counters, with when the install began and when pnpm last spoke (the live panel).
    expect(statuses.map(item => item.progress).filter(Boolean).at(-1)).toMatchObject({ resolved: 10, downloaded: 4, added: 10, done: true, startedAt: expect.any(Number), at: expect.any(Number) });
    expect(surface.connected).toEqual([{ port: 4567, url: 'http://127.0.0.1:4567/?token=SECRET-TOKEN-1234567890', bridgePort: 4568 }]);
  });

  it('mints a tool-bridge token per start, and forgets the bridge with the host', async () => {
    const { service: created } = service('ready', { installed: true });
    expect(created.bridge()).toBeUndefined();
    await created.start();
    const first = created.bridge()!;
    expect(first).toMatchObject({ port: 4568, generation: 1 });
    expect(first.token).toMatch(/^[\w-]{43}$/);
    await created.stop();
    expect(created.bridge()).toBeUndefined();
    await created.start();
    expect(created.bridge()).toMatchObject({ generation: 2 });
    expect(created.bridge()!.token).not.toBe(first.token);
  });

  it('reports a failed install and stays absent', async () => {
    const { service: created } = service('ready', { install: 'fail' });
    const status = await created.install();
    expect(status.state).toBe('absent');
    expect(status.message).toContain('ERR_PNPM_FETCH_404');
  });

  it('shares one install between concurrent calls', async () => {
    const { service: created } = service();
    const [first, second] = [created.install(), created.install()];
    expect(first).toBe(second);
    await first;
  });

  it('reports a boot failure as failed, with the host’s words', async () => {
    const { service: created, surface } = service('fatal', { installed: true });
    const status = await created.start();
    expect(status.state).toBe('failed');
    expect(status.message).toContain('boot failed');
    expect(status.message).not.toContain('SECRET-TOKEN');
    expect(surface.disconnects).toBeGreaterThan(0);
  });

  it('stops, and restarts on request', async () => {
    const { service: created, surface } = service('ready', { installed: true });
    await created.start();
    expect((await created.stop()).state).toBe('stopped');
    expect((await created.restart()).state).toBe('running');
    expect(surface.connected).toHaveLength(2);
  });

  it('takes a healthy restore point after a start', async () => {
    const { service: created } = service('ready', { installed: true });
    const status = await created.start();
    expect(status.checkpoints).toHaveLength(1);
    expect(status.checkpoints[0]).toMatchObject({ kind: 'healthy' });
  });

  it('creates the profile with Hello’s bundle linked, keeping plugins the person added', async () => {
    const { service: created, place } = service('ready', { installed: true });
    mkdirSync(place.profile, { recursive: true });
    writeFileSync(join(place.profile, 'package.json'), JSON.stringify({ dependencies: { dsh1024: '0.5.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh1024'] } } }));
    expect((await created.start()).state).toBe('running');
    const { readFileSync } = await import('node:fs');
    const manifest = JSON.parse(readFileSync(join(place.profile, 'package.json'), 'utf8'));
    expect(manifest.dependencies).toEqual({ dsh1024: '0.5.0', 'hello-dsh': `link:${join(place.resources, 'hello-dsh')}` });
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh1024', 'hello-dsh']);
  });

  it('writes Hello’s patch layer before the host starts', async () => {
    const { service: created, place } = service('ready', { installed: true });
    await created.start();
    const { readFileSync } = await import('node:fs');
    const patch = readFileSync(join(place.root, 'hello.patch.yml'), 'utf8');
    expect(patch).toContain('printUrl: false');
    expect(patch).toContain('openBrowser: false');
  });

  it('waits for the person when the profile changed outside Hello, and starts once accepted', async () => {
    const { service: created, place } = service('ready', { installed: true });
    expect((await created.start()).state).toBe('running');
    await created.stop();
    const { readFileSync } = await import('node:fs');
    const manifest = JSON.parse(readFileSync(join(place.profile, 'package.json'), 'utf8'));
    manifest.dependencies['sneaky-plugin'] = '1.0.0';
    writeFileSync(join(place.profile, 'package.json'), JSON.stringify(manifest));
    const waiting = await created.start();
    expect(waiting).toMatchObject({ state: 'stopped', profileChange: { added: ['sneaky-plugin'], removed: [], changed: [] } });
    expect(waiting.message).toContain('sneaky-plugin');
    const accepted = await created.start({ acceptProfileChange: true });
    expect(accepted.state).toBe('running');
    expect(accepted.profileChange).toBeUndefined();
    await created.stop();
    expect((await created.start()).state).toBe('running');
  });

  it('shows a plugin boot failure until the next start', async () => {
    const { service: created, statuses } = service('ready', { installed: true });
    await created.start();
    created.reportBootFailure(['dsh-better-sidebar']);
    expect(statuses.at(-1)).toMatchObject({ state: 'running', bootFailure: ['dsh-better-sidebar'] });
    expect(statuses.at(-1)?.message).toContain('dsh-better-sidebar');
    await created.restart();
    expect(created.status().bootFailure).toBeUndefined();
  });

  it('uses Hello’s connection by default, and dsh’s own providers when told to', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hello-dsh-model-'));
    folders.push(root);
    const place = dshLayout(root, join(root, 'resources'));
    fakeInstall(place);
    const created = new DshService({
      layout: place, hostEntry: fixture,
      spawn: (entry, args, spawnOptions) => forkSpawn(entry, args, { ...spawnOptions, env: { ...spawnOptions.env, FAKE_DSH_MODE: 'ready' } }),
      surface: { async connect() {}, disconnect() {} },
      pnpm: { command: process.execPath, args: [fakePnpm], env: { ELECTRON_RUN_AS_NODE: '1' } },
      emit: () => {},
      model: () => ({ endpointUrl: 'http://127.0.0.1:9/v1', model: 'local-model', apiKey: '' }),
    });
    services.push(created);
    const { readFileSync } = await import('node:fs');
    expect(created.status().useHelloModel).toBe(true);
    await created.start();
    expect(readFileSync(join(place.root, 'hello.patch.yml'), 'utf8')).toContain('local-model');
    await created.stop();
    expect(created.setUseHelloModel(false).useHelloModel).toBe(false);
    await created.start();
    expect(readFileSync(join(place.root, 'hello.patch.yml'), 'utf8')).not.toContain('llm-pi-ai');
  });
});
