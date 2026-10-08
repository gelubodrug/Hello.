import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDataStore, type DataStore } from '../src/main/data/store';
import { ResourceLibrary, resourceDirectory, type PluginConfig } from '../src/main/extensions/library';
import { outOfSpace } from '../src/main/market/install';
import type { MarketHttp } from '../src/main/market/net';
import { galleryUrl, parseGallery } from '../src/main/market/pi-gallery';
import { normalizePiObject, piTypes } from '../src/main/market/pi-catalog';
import { PI_PROVIDED, PI_VERSION, piCompatibility, readPiForHello, verifyPiPackage } from '../src/main/market/pi-install';
import { PiMarketService } from '../src/main/market/pi-service';

// Nothing reaches the network: pi.dev and npm are a map of URLs, and pnpm is
// a script that writes what pnpm would.
const GALLERY = readFileSync(path.join(__dirname, 'fixtures', 'pi-gallery-page.html'), 'utf8');
const FAKE_PNPM = path.join(__dirname, 'fixtures', 'fake-pnpm-pi.mjs');
const INTEGRITY = 'sha512-cGFja2FnZQ==';

let directory: string;
let store: DataStore;
let library: ResourceLibrary;

function manifest(version: string, extra: Record<string, unknown> = {}) {
  return {
    name: 'pi-demo', version, keywords: ['pi-package', 'extension'], description: 'A demo extension.',
    pi: { extensions: ['./index.ts'], skills: ['./skills'] },
    dist: { tarball: `https://registry.npmjs.org/pi-demo/-/pi-demo-${version}.tgz`, integrity: INTEGRITY, unpackedSize: 2048, fileCount: 4 },
    ...extra,
  };
}

function fakeHttp(json: Record<string, unknown>, pages: Record<string, string> = {}): MarketHttp & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getJson: vi.fn(async (url: string) => {
      calls.push(url);
      if (!(url in json)) throw new Error(`HTTP 404 ${url}`);
      return { value: json[url], finalUrl: url };
    }),
    getBytes: vi.fn(async (url: string) => {
      calls.push(url);
      if (!(url in pages)) throw new Error(`HTTP 503 ${url}`);
      return { body: Buffer.from(pages[url]), contentType: 'text/html', finalUrl: url };
    }),
  };
}

function template(): string {
  const root = path.join(directory, 'template');
  mkdirSync(path.join(root, 'skills', 'demo'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'pi-demo', version: '0.0.0', pi: { extensions: ['./index.ts'], skills: ['./skills'] }, dependencies: { 'left-pad': '1.3.0' } }));
  writeFileSync(path.join(root, 'index.ts'), "import pad from 'left-pad';\nexport default function () { void pad; }\n");
  writeFileSync(path.join(root, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Demo skill.\n---\nSteps.\n');
  return root;
}

function service(http: MarketHttp, pnpmEnv: Record<string, string> = {}) {
  const changed = vi.fn();
  const market = new PiMarketService({
    store, library, http, changed, log: () => {}, normalizeIcon: () => null,
    stagingDir: path.join(directory, 'data', 'pi-staging'),
    pnpm: { command: process.execPath, args: [FAKE_PNPM], env: {
      ELECTRON_RUN_AS_NODE: '1', FAKE_PI_TEMPLATE: template(), FAKE_PI_INTEGRITY: INTEGRITY,
      FAKE_PI_RECORD: path.join(directory, 'pnpm-record.json'), ...pnpmEnv,
    } },
  });
  library.packages = { update: row => market.update(row) };
  return { market, changed };
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hello-pi-market-'));
  store = createDataStore(path.join(directory, 'data'), { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  library = new ResourceLibrary(store);
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('the list, as pi.dev/packages shows it', () => {
  it('reads the gallery’s cards and count: author, downloads a month, published, types, repository', () => {
    const page = parseGallery(GALLERY);
    expect(page).toMatchObject({ total: 305, all: 5548 });
    expect(page.items.map(item => item.name)).toEqual(['incitaciones', 'pi-code', '@agimon-ai/doompi-domain']);
    expect(page.items[0]).toMatchObject({ publisher: 'charly-vibes', installs: 1740, types: ['skill', 'prompt'], repository: 'https://www.npmjs.com/package/incitaciones' });
    expect(page.items[0].updatedAt).toBe(new Date(1790688344052).toISOString());
    expect(page.items[1]).toMatchObject({ publisher: 'ilovepixelart', repository: 'https://github.com/ilovepixelart/pi-code', icons: ['https://github.com/ilovepixelart.png?size=96'] });
  });

  it('asks the gallery with its own filters and order, leaving its defaults out', () => {
    expect(galleryUrl({})).toBe('https://pi.dev/packages');
    expect(galleryUrl({ q: ' mcp ', type: 'extension', sort: 'updated', page: 2 })).toBe('https://pi.dev/packages?name=mcp&type=extension&sort=recent&page=2');
    expect(galleryUrl({ type: 'nonsense', sort: 'downloads', page: 1 })).toBe('https://pi.dev/packages');
    expect(galleryUrl({ sort: 'name' })).toBe('https://pi.dev/packages?sort=name');
  });

  it('pages through the gallery and says how many the filter left of how many there are', async () => {
    const http = fakeHttp({}, { 'https://pi.dev/packages?type=skill&sort=recent': GALLERY, 'https://pi.dev/packages?type=skill&sort=recent&page=2': GALLERY.replace(/incitaciones/g, 'other-one') });
    const { market } = service(http);
    const first = await market.query({ category: 'skill', sort: 'updated' });
    expect(first).toMatchObject({ total: 305, unfiltered: 5548, categories: ['extension', 'skill', 'theme', 'prompt'] });
    expect(first.items.map(item => item.name)).toEqual(['incitaciones', 'pi-code', '@agimon-ai/doompi-domain']);
    expect(first.items[0]).toMatchObject({ publisher: 'charly-vibes', installs: 1740, installable: true, sourceName: 'Pi packages' });
    const second = await market.query({ category: 'skill', sort: 'updated', cursor: first.nextCursor });
    expect(second.items[0].name).toBe('other-one');
    await expect(market.query({ category: 'extension', cursor: first.nextCursor })).rejects.toThrow(/expired/);
  });

  it('reads npm’s search when pi.dev does not answer', async () => {
    const search = 'https://registry.npmjs.org/-/v1/search?text=keywords%3Api-package&size=250&from=0';
    const http = fakeHttp({ [search]: { total: 1, objects: [{
      package: { name: 'pi-mcp-adapter', description: 'MCP for Pi', keywords: ['pi-package', 'pi-extension'], date: '2026-09-28T10:00:00.000Z',
        maintainers: [{ username: 'nicopreme', email: 'hidden@example.com' }], links: { repository: 'git+https://github.com/nicobailon/pi-mcp-adapter.git' } },
      downloads: { monthly: 1200000 },
    }] } });
    const { market } = service(http);
    const page = await market.query({});
    expect(page.items).toMatchObject([{ name: 'pi-mcp-adapter', publisher: 'nicopreme', installs: 1200000, repository: 'https://github.com/nicobailon/pi-mcp-adapter', categories: ['extension'] }]);
    expect(JSON.stringify(page)).not.toContain('hidden@example.com');
  });

  it('names a package’s types by pi.dev’s keyword rule', () => {
    expect(piTypes(['pi-package', 'pi-extension', 'skills', 'prompt-templates'])).toEqual(['extension', 'skill', 'prompt']);
    expect(piTypes(['pi-package', 'agents'])).toEqual(['package']);
    expect(normalizePiObject({ package: { name: '../bad' } })).toBeNull();
  });
});

describe('what an install checks', () => {
  it('accepts only a Pi package the registry serves, with a sha512 integrity', async () => {
    const latest = 'https://registry.npmjs.org/pi-demo/latest';
    const good = await verifyPiPackage(fakeHttp({ [latest]: manifest('1.0.0') }), 'pi-demo', 'latest', new AbortController().signal);
    expect(good).toMatchObject({ name: 'pi-demo', version: '1.0.0', integrity: INTEGRITY });
    for (const bad of [
      manifest('1.0.0', { name: 'other' }),
      manifest('1.0.0', { keywords: [], pi: undefined }),
      manifest('1.0.0', { dist: { tarball: 'https://evil.example/pi-demo.tgz', integrity: INTEGRITY } }),
      manifest('1.0.0', { dist: { tarball: 'https://registry.npmjs.org/pi-demo/-/x.tgz', integrity: 'sha1-abc' } }),
      manifest('1.0.0-beta.1'),
    ]) await expect(verifyPiPackage(fakeHttp({ [latest]: bad }), 'pi-demo', 'latest', new AbortController().signal)).rejects.toThrow();
  });

  // PI_VERSION is what every extension's peer range is judged against, so it
  // has to be the Pi that is actually in node_modules, not a number left behind
  // by an upgrade (it said 0.87.1 while Hello ran 1.0.x).
  it('names the Pi Hello actually depends on', () => {
    const ours = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(PI_VERSION).toBe(ours.dependencies['@earendil-works/pi-coding-agent']);
    for (const name of ['pi-coding-agent', 'pi-agent-core', 'pi-ai', 'pi-tui'])
      for (const scope of ['@earendil-works', '@mariozechner'])
        expect(PI_PROVIDED[`${scope}/${name}`]).toBe(PI_VERSION);
  });

  it('refuses what Hello cannot run, and warns about what may not work', () => {
    expect(piCompatibility(manifest('1.0.0', { peerDependencies: { '@earendil-works/pi-coding-agent': '>=2.0.0' } }))).toMatchObject({ ok: false, reason: expect.stringContaining(PI_VERSION) });
    expect(piCompatibility(manifest('1.0.0', { peerDependencies: { '@earendil-works/pi-coding-agent': '^0.84.0' } }))).toMatchObject({ ok: true, warnings: [expect.stringContaining('It may still work')] });
    expect(piCompatibility(manifest('1.0.0', { pi: { themes: ['./themes'] } }))).toMatchObject({ ok: false, reason: expect.stringContaining('themes') });
    expect(piCompatibility(manifest('1.0.0', { dist: { unpackedSize: 200 * 1024 * 1024 } }))).toMatchObject({ ok: false });
    expect(piCompatibility(manifest('1.0.0', { os: ['win32'] }))).toMatchObject({ ok: false });
    const scripted = piCompatibility(manifest('1.0.0', { scripts: { postinstall: 'node setup.js' } }));
    expect(scripted.warnings.join(' ')).toContain('will not run');
    expect(readPiForHello(manifest('1.0.0')).lines.join(' ')).toContain('off in every chat until you turn it on');
  });
});

describe('installing, updating and removing, in Hello’s library', () => {
  const latest = 'https://registry.npmjs.org/pi-demo/latest';

  async function install(http: MarketHttp & { calls: string[] }, extraEnv: Record<string, string> = {}) {
    const { market, changed } = service(http, extraEnv);
    const preview = await market.previewByName('pi-demo');
    expect(preview).toMatchObject({ action: 'install', version: '1.0.0', compatibility: { ok: true } });
    return { market, changed, preview };
  }

  it('installs with pnpm into the library, off in every chat, and knows it was the market’s', async () => {
    const http = fakeHttp({ [latest]: manifest('1.0.0') });
    const { market, changed, preview } = await install(http);
    const result = await market.confirm(preview.token);
    expect(result).toMatchObject({ action: 'install', packageName: 'pi-demo', version: '1.0.0' });
    expect(changed).toHaveBeenCalled();
    const row = store.listResourceRows().find(item => item.source === 'npm:pi-demo')!;
    expect(row).toMatchObject({ kind: 'plugin', name: 'pi-demo', version: '1.0.0' });
    const config = JSON.parse(row.config) as PluginConfig;
    expect(config.installed).toEqual({ manager: 'pnpm', package: 'pi-demo', root: 'node_modules/pi-demo' });
    const folder = resourceDirectory(store.dataDir, row);
    expect(existsSync(path.join(folder, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
    expect(await library.verify(row)).toBe('ready');
    // pnpm ran without scripts, on the registry, without the person's .npmrc.
    const record = JSON.parse(readFileSync(path.join(directory, 'pnpm-record.json'), 'utf8'));
    expect(record.args).toEqual(expect.arrayContaining(['add', 'pi-demo@1.0.0', '--save-exact', '--prod', '--ignore-scripts', '--config.registry=https://registry.npmjs.org/']));
    expect(record.userconfig).toMatch(/\.npmrc-hello$/);
    expect(record.workspace).toContain('pi-demo@1.0.0');
    expect(readdirSync(path.join(directory, 'data', 'pi-staging'))).toEqual([]);
    // Turned on in a chat, its paths are inside the installed package.
    const chat = store.createConversation().id;
    store.setResourceActive(chat, row.id, true);
    const active = await library.activeFor(chat);
    expect(active.extensions[0].files).toEqual([path.join(folder, 'node_modules', 'pi-demo', 'index.ts')]);
    expect(active.skillDirectories).toEqual([{ name: 'demo', directory: path.join(folder, 'node_modules', 'pi-demo', 'skills', 'demo') }]);
    // An edit to the installed package is noticed, not loaded.
    writeFileSync(path.join(folder, 'node_modules', 'pi-demo', 'index.ts'), 'export default () => {};\n');
    expect(await library.verify(row)).toBe('modified');
  });

  it('lists what it installed with npm’s newer version, updates it in place, and removes it', async () => {
    const json: Record<string, unknown> = { [latest]: manifest('1.0.0') };
    const http = fakeHttp(json);
    const first = await install(http);
    await first.market.confirm(first.preview.token);
    const rowId = store.listResourceRows()[0].id;
    expect(await first.market.installed()).toEqual([{ packageName: 'pi-demo', version: '1.0.0', kind: 'plugin', bundle: false }]);
    json[latest] = manifest('1.1.0');
    expect(await first.market.installed()).toEqual([{ packageName: 'pi-demo', version: '1.0.0', kind: 'plugin', bundle: false, latest: '1.1.0' }]);
    const update = await first.market.previewUpdate('pi-demo');
    expect(update).toMatchObject({ action: 'update', from: '1.0.0', version: '1.1.0' });
    await first.market.confirm(update.token);
    expect(store.listResourceRows()).toMatchObject([{ id: rowId, version: '1.1.0', source: 'npm:pi-demo' }]);
    await expect(first.market.previewUpdate('pi-demo')).rejects.toThrow(/already npm’s newest/);
    const removal = first.market.previewUninstall('pi-demo');
    await first.market.confirm(removal.token);
    expect(store.listResourceRows()).toEqual([]);
    expect(existsSync(path.join(directory, 'data', 'library', 'plugins', rowId))).toBe(false);
  });

  it('installs nothing when pnpm brought another archive than npm vouched for', async () => {
    const http = fakeHttp({ [latest]: manifest('1.0.0') });
    const { market, preview } = await install(http, { FAKE_PI_INTEGRITY: 'sha512-b3RoZXI=' });
    await expect(market.confirm(preview.token)).rejects.toThrow(/not the one npm vouched for/);
    expect(store.listResourceRows()).toEqual([]);
    expect(readdirSync(path.join(directory, 'data', 'pi-staging'))).toEqual([]);
  });

  it('says what pnpm said when it fails, and leaves nothing behind', async () => {
    const http = fakeHttp({ [latest]: manifest('1.0.0') });
    const { market, preview } = await install(http, { FAKE_PI_EXIT: '1', FAKE_PI_OUTPUT: 'ERR_PNPM_NO_MATURE_MATCHING_VERSION left-pad' });
    await expect(market.confirm(preview.token)).rejects.toThrow(/less than a day ago/);
    expect(store.listResourceRows()).toEqual([]);
  });

  it('says the disk is full when pnpm ran out of space, and leaves nothing behind', async () => {
    const http = fakeHttp({ [latest]: manifest('1.0.0') });
    const { market, preview } = await install(http, { FAKE_PI_EXIT: '1', FAKE_PI_OUTPUT: 'ENOSPC: no space left on device, write' });
    await expect(market.confirm(preview.token)).rejects.toMatchObject({ code: 'out-of-space', message: expect.stringMatching(/disk is full/) });
    expect(store.listResourceRows()).toEqual([]);
    expect(readdirSync(path.join(directory, 'data', 'pi-staging'))).toEqual([]);
  });

  it('names a full disk from an fs error too, and leaves other failures as they were', () => {
    const error = Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    expect(outOfSpace(error, '/staging')).toMatchObject({ code: 'out-of-space', message: expect.stringContaining('/staging') });
    expect(outOfSpace(Object.assign(new Error('EACCES'), { code: 'EACCES' }), '/staging')).toBeUndefined();
    expect(outOfSpace('ERR_PNPM_NO_MATURE_MATCHING_VERSION', '/staging')).toBeUndefined();
  });

  it('updates from Settings through the library, and refuses a name another plugin holds', async () => {
    const json: Record<string, unknown> = { [latest]: manifest('1.0.0') };
    const http = fakeHttp(json);
    const first = await install(http);
    await first.market.confirm(first.preview.token);
    json[latest] = manifest('1.2.0');
    const row = store.listResourceRows()[0];
    await expect(library.update(row.id)).resolves.toMatchObject({ version: '1.2.0', source: 'npm:pi-demo' });
    await expect(first.market.previewByName('pi-demo')).rejects.toThrow(/already installed/);
  });
});
