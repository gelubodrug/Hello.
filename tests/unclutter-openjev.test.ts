import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CALIBRATION, OpenJev, launchSpec, pickOpenJev } from '../src/main/unclutter/openjev';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'hello-openjev-')); dirs.push(dir); return dir; };

/** A home with the weights and, optionally, the helper environment in Hello's data folder. */
function home({ helper = true, pinned = false }: { helper?: boolean; pinned?: boolean } = {}): { home: string; data: string } {
  const root = temp();
  mkdirSync(join(root, 'Models', 'MLX', 'openjev-MLX'), { recursive: true });
  writeFileSync(join(root, 'Models', 'MLX', 'openjev-MLX', 'config.json'), '{}');
  if (helper) {
    const env = join(root, 'hello-data', 'openjev');
    mkdirSync(join(env, 'mlx', 'bin'), { recursive: true });
    mkdirSync(join(env, 'api', 'helper'), { recursive: true });
    writeFileSync(join(env, 'mlx', 'bin', 'python'), '');
    // Not the pinned bytes unless a test supplies them: such a helper is never run.
    writeFileSync(join(env, 'api', 'helper', 'shim.py'), pinned ? 'x' : 'tampered');
    writeFileSync(join(env, 'api', 'helper', 'shim_mlx.py'), 'tampered');
  }
  return { home: root, data: join(root, 'hello-data') };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('OpenJev location', () => {
  it('picks the MLX folder among the openjev ones', () => {
    expect(pickOpenJev(['qwen', 'openjev', 'openjev-MLX'])).toBe('openjev-MLX');
    expect(pickOpenJev(['qwen'])).toBeNull();
  });

  it('runs the helper as the model card does: this machine only, the fixed calibration', () => {
    const spec = launchSpec('/h', '/m/openjev-MLX', 3001);
    expect(spec.command).toBe('/h/mlx/bin/python');
    expect(spec.args).toEqual(['/h/api/helper/shim_mlx.py', '--helper', '/h/api/helper/shim.py', '--model', '/m/openjev-MLX', '--host', '127.0.0.1', '--port', '3001']);
    expect(spec.env).toMatchObject({ TOKENIZER: '/m/openjev-MLX', SHIM_MODEL: '/m/openjev-MLX', ...CALIBRATION });
  });
});

describe('OpenJev helper', () => {
  it('uses a helper that already answers, and never starts or stops another', async () => {
    const paths = home();
    const spawn = vi.fn();
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const address = String(url);
      if (address.endsWith('/v1/version')) return address.includes(':3000/') ? json({ model_dir: 'openjev-MLX' }) : json({}, 404);
      expect(JSON.parse(String(init?.body))).toEqual({ model: 'openjev', state: {}, questions: {} });
      return json({ answers: {} });
    });
    const openjev = new OpenJev({ dataDir: paths.data, home: paths.home, fetch: fetch as typeof globalThis.fetch, spawn });
    expect((await openjev.status()).state).toBe('ready');
    expect(await openjev.ask({ model: 'openjev', state: {}, questions: {} })).toEqual({ answers: {} });
    expect(spawn).not.toHaveBeenCalled();
    expect(openjev.stop()).toBe(false);
  });

  it('says what is missing instead of installing anything', async () => {
    const paths = home({ helper: false });
    const fetch = vi.fn(async () => { throw new Error('refused'); });
    const openjev = new OpenJev({ dataDir: paths.data, home: paths.home, fetch: fetch as typeof globalThis.fetch });
    const status = await openjev.status();
    expect(status.state).toBe('missing');
    expect(status.detail).toMatch(/helper environment/);
    await expect(openjev.ensure()).rejects.toThrow(/helper environment/);
  });

  it('refuses to run a helper whose files are not the pinned ones', async () => {
    const paths = home();
    const spawn = vi.fn();
    const fetch = vi.fn(async () => { throw new Error('refused'); });
    const openjev = new OpenJev({ dataDir: paths.data, home: paths.home, fetch: fetch as typeof globalThis.fetch, spawn, portFree: async () => true });
    expect((await openjev.status()).state).toBe('stopped');
    await expect(openjev.ensure()).rejects.toThrow(/not the pinned OpenJev helper/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('starts its own helper on a free port, waits for it, and stops only that one', async () => {
    const paths = home();
    const helper = join(paths.data, 'openjev', 'api', 'helper');
    // Pin the test files' own hashes in place of the card's.
    const { createHash } = await import('node:crypto');
    const module = await import('../src/main/unclutter/openjev');
    const pins = module.HELPER_FILES as Array<[string, string]>;
    const saved = pins.map(pin => [...pin] as [string, string]);
    for (const pin of pins) pin[1] = createHash('sha256').update(readFileSync(join(helper, pin[0].replace('helper/', '')))).digest('hex');
    try {
      const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null, kill: vi.fn(() => { child.exitCode = 0; return true; }) });
      const spawn = vi.fn(() => child as never);
      let up = false;
      const fetch = vi.fn(async (url: string | URL | Request) => {
        if (!String(url).includes(':3001/')) throw new Error('refused');
        if (!up) { up = true; throw new Error('loading'); }
        return json({ model_dir: 'openjev-MLX' });
      });
      const openjev = new OpenJev({ dataDir: paths.data, home: paths.home, fetch: fetch as typeof globalThis.fetch, spawn, portFree: async port => port === 3001 });
      await expect(openjev.ensure()).resolves.toBe('http://127.0.0.1:3001');
      expect(spawn).toHaveBeenCalledTimes(1);
      const [, args, options] = spawn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
      expect(args).toContain('127.0.0.1');
      expect(options.env.READOUT_TARGETED).toBe('1');
      expect(JSON.parse(readFileSync(join(paths.data, 'openjev', 'config.json'), 'utf8'))).toEqual({ port: 3001 });
      expect(readFileSync(join(paths.data, 'openjev', 'helper.log'), 'utf8')).toMatch(/--- start .* port 3001/);
      expect((await openjev.status()).ownHelper).toBe(true);
      expect(openjev.stop()).toBe(true);
      expect(child.kill).toHaveBeenCalled();
      expect(openjev.stop()).toBe(false);
    } finally {
      saved.forEach((pin, index) => { pins[index]![1] = pin[1]; });
    }
  }, 10_000);
});
