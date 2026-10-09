import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DshStatus } from '../src/shared/types';
import { dshLayout, type DshLayout } from '../src/main/dsh/layout';
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
  writeFileSync(place.installAnchor, JSON.stringify({ version: '0.2.0-rc.2' }));
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
    latest: async () => '0.2.0-rc.2',
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
    expect(created.status()).toMatchObject({ state: 'absent', version: 'latest' });
  });

  it('installs on the first start, then runs and connects the surface', async () => {
    const { service: created, statuses, surface } = service();
    const status = await created.start();
    expect(status.state).toBe('running');
    expect(statuses.map(item => item.state)).toEqual(expect.arrayContaining(['installing', 'stopped', 'starting', 'running']));
    // The counters, with when the install began and when pnpm last spoke (the live panel).
    expect(statuses.map(item => item.progress).filter(Boolean).at(-1)).toMatchObject({ resolved: 10, downloaded: 4, added: 10, done: true, startedAt: expect.any(Number), at: expect.any(Number) });
    expect(surface.connected).toEqual([{ port: 4567, url: 'http://127.0.0.1:4567/?token=SECRET-TOKEN-1234567890' }]);
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

  it('writes Hello’s patch layer before the host starts', async () => {
    const { service: created, place } = service('ready', { installed: true });
    await created.start();
    const { readFileSync } = await import('node:fs');
    const patch = readFileSync(join(place.root, 'hello.patch.yml'), 'utf8');
    expect(patch).toContain('printUrl: false');
    expect(patch).toContain('openBrowser: false');
    expect(patch).not.toContain('llm-pi-ai');
    expect(patch).not.toContain('agent-default-model');
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

});
