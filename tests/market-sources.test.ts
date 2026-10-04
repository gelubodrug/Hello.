import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dshLayout } from '../src/main/dsh/layout';
import type { MarketHttp } from '../src/main/market/net';
import { MarketService } from '../src/main/market/service';
import { DSHFIND_MANIFEST, normalizeStandardItem, parseSourceManifest, parseStandardPage, standardUrl } from '../src/main/market/standard';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

/** The manifest api.dshfind.com serves (28.09). */
const LIVE_DSHFIND = {
  manifestVersion: '1.0.0',
  providerId: 'com.dshfind.catalog',
  name: 'dshfind Plugin Catalog',
  description: 'Community catalog of DeepSeek Harness plugins indexed by dshfind.',
  homepage: 'https://dshfind.com',
  attribution: { name: 'dshfind', url: 'https://dshfind.com' },
  transport: { kind: 'https-json', endpoint: 'https://api.dshfind.com/market/v1/plugins', method: 'GET' },
  query: { supported: ['q', 'category', 'cursor', 'limit'], defaultLimit: 50, maxLimit: 100, sorts: [] },
};
const memory = { id: '00080000/dsh-project-memory', name: 'dsh-project-memory', displayName: 'dsh-project-memory', summary: 'Read-time project memory plugin for DeepSeek Harness (dsh)', repository: { url: 'https://github.com/00080000/dsh-project-memory' }, package: { registry: 'npm', name: '@yolk_vat-y/dsh-project-memory' }, publisher: { name: '00080000', url: 'https://github.com/00080000' }, categories: ['memory'], latestVersion: '0.5.11', updatedAt: '2026-09-27T05:36:38Z' };
const foxy = { id: '01Virex/dsh-foxy-jumpscare', name: 'dsh-foxy-jumpscare', displayName: 'dsh-foxy-jumpscare', summary: 'A jumpscare.', repository: { url: 'https://github.com/01Virex/dsh-foxy-jumpscare' }, publisher: { name: '01Virex' }, updatedAt: '2026-08-14T10:44:58Z' };
const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({ schemaVersion: '1.0.0', generatedAt: '2026-09-28T13:34:36Z', revision: 'sha256:1', items, page: { total: 13050, ...extra } });

describe('standard catalog sources', () => {
  it('reads the manifest dshfind serves, and the one Hello ships matches it', () => {
    const manifest = parseSourceManifest(LIVE_DSHFIND);
    expect(manifest).toMatchObject({ providerId: DSHFIND_MANIFEST.providerId, endpoint: DSHFIND_MANIFEST.endpoint, supported: DSHFIND_MANIFEST.supported, maxLimit: 100, sorts: [] });
  });

  it('refuses a manifest that breaks the protocol', () => {
    const broken = (patch: (value: any) => void) => { const value = structuredClone(LIVE_DSHFIND) as any; patch(value); return () => parseSourceManifest(value); };
    expect(broken(value => { value.transport.endpoint = 'https://api.dshfind.com/market/plugins'; })).toThrow(/v1\/plugins/);
    expect(broken(value => { value.transport.endpoint = 'http://api.dshfind.com/market/v1/plugins'; })).toThrow(/HTTPS/);
    expect(broken(value => { value.transport.endpoint = 'https://api.dshfind.com:8443/market/v1/plugins'; })).toThrow(/port 443/);
    expect(broken(value => { value.query.defaultLimit = 150; })).toThrow(/defaultLimit/);
    expect(broken(value => { value.query.supported.push('sort'); })).toThrow(/sorts/);
    expect(broken(value => { value.extra = 1; })).toThrow(/unknown field/);
    expect(broken(value => { value.name = 'bad‮name'; })).toThrow(/name/);
  });

  it('asks only for the features a source declares', () => {
    const url = new URL(standardUrl(DSHFIND_MANIFEST, { q: ' memory ', category: 'memory', cursor: 'abc', sort: 'downloads', locale: 'ro' }, 100));
    expect(url.origin + url.pathname).toBe('https://api.dshfind.com/market/v1/plugins');
    expect([...url.searchParams]).toEqual([['q', 'memory'], ['category', 'memory'], ['cursor', 'abc'], ['limit', '100']]);
  });

  it('checks a page, and keeps an npm target only from the package field', () => {
    const parsed = parseStandardPage(page([memory, foxy], { nextCursor: 'c1' }), 100);
    expect(parsed).toMatchObject({ nextCursor: 'c1', total: 13050 });
    const [withPackage, repositoryOnly] = parsed.records.map(normalizeStandardItem);
    expect(withPackage).toMatchObject({ id: memory.id, npm: '@yolk_vat-y/dsh-project-memory', repository: 'https://github.com/00080000/dsh-project-memory', categories: ['memory'], publisher: '00080000' });
    expect(repositoryOnly?.npm).toBeUndefined();
    expect(normalizeStandardItem({ ...foxy, repository: undefined, package: { registry: 'npm', name: 'solo' } })?.repository).toBe('https://www.npmjs.com/package/solo');
    expect(normalizeStandardItem({ ...foxy, repository: { url: 'https://gitlab.com/a/b' } })).toBeUndefined();
    expect(() => parseStandardPage(page([memory, foxy]), 1)).toThrow(/more than/);
    expect(() => parseStandardPage(page([memory, memory]), 10)).toThrow(/repeats/);
    expect(() => parseStandardPage(page([memory], { nextCursor: '' }), 10)).toThrow(/cursor/);
    expect(() => parseStandardPage({ ...page([]), schemaVersion: '2.0.0' }, 10)).toThrow(/version/);
  });
});

function market(routes: (url: URL) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'hello-market-sources-'));
  folders.push(root);
  const asked: URL[] = [];
  const http: MarketHttp = {
    async getJson(url) { const parsed = new URL(url); asked.push(parsed); return { value: routes(parsed), finalUrl: url }; },
    async getBytes() { throw new Error('no icons here'); },
  };
  const layout = dshLayout(root, join(root, 'resources'));
  const create = () => new MarketService({ layout, pnpm: { command: 'none', args: [], env: {} }, log: () => {}, normalizeIcon: () => null, http });
  return { service: create(), create, asked, layout };
}

describe('the market’s sources', () => {
  it('starts on DSH 1024Store, with dshfind offered to add', () => {
    const { service } = market(() => ({}));
    expect(service.sources().map(source => [source.id, source.added, source.selected])).toEqual([['dsh-1024store', true, true], ['dshfind', false, false]]);
  });

  it('reads dshfind once it is added and selected, with opaque paging', async () => {
    const { service, asked } = market(url => (url.searchParams.get('cursor') === 'raw-2' ? page([foxy]) : page([memory, foxy], { nextCursor: 'raw-2' })));
    service.addSource('dshfind');
    expect(service.sources().find(source => source.id === 'dshfind')).toMatchObject({ added: true, selected: false });
    service.selectSource('dshfind');
    const first = await service.query({ q: 'memory' });
    expect(asked.at(-1)?.host).toBe('api.dshfind.com');
    expect(first.items.map(item => [item.key, item.sourceName, item.installable])).toEqual([['dshfind:00080000/dsh-project-memory', 'dshfind', true], ['dshfind:01Virex/dsh-foxy-jumpscare', 'dshfind', false]]);
    expect(first.nextCursor).toMatch(/^cursor:/);
    const second = await service.query({ q: 'memory', cursor: first.nextCursor });
    expect(asked.at(-1)?.searchParams.get('cursor')).toBe('raw-2');
    expect(second.items).toHaveLength(1);
    await expect(service.query({ q: 'other', cursor: first.nextCursor })).rejects.toThrow(/expired/);
    await expect(service.query({ cursor: 'raw-2' })).rejects.toThrow(/expired/);
    const installable = await service.query({ installable: true });
    expect(asked.at(-1)?.searchParams.get('limit')).toBe('100');
    expect(installable.items.map(item => item.name)).toEqual(['dsh-project-memory']);
  });

  it('adds a standard source only from a manifest on its own origin, once', async () => {
    const manifest = { ...LIVE_DSHFIND, providerId: 'com.example.catalog', name: 'Example', transport: { ...LIVE_DSHFIND.transport, endpoint: 'https://plugins.example.com/v1/plugins' } };
    const { service, create } = market(url => (url.pathname === '/catalog-source.json' ? (url.host === 'plugins.example.com' ? manifest : { ...manifest }) : page([memory])));
    await expect(service.addStandardSource('https://other.example.com/catalog-source.json')).rejects.toThrow(/own origin/);
    await expect(service.addStandardSource('http://plugins.example.com/catalog-source.json')).rejects.toThrow(/https/);
    const sources = await service.addStandardSource('https://plugins.example.com/catalog-source.json');
    const added = sources.find(source => source.name === 'Example')!;
    expect(added).toMatchObject({ builtIn: false, partner: false, added: true, selected: false, endpointHost: 'plugins.example.com' });
    await expect(service.addStandardSource('https://plugins.example.com/catalog-source.json')).rejects.toThrow(/already/);
    service.selectSource(added.id);
    expect((await service.query({})).items[0].sourceName).toBe('Example');
    // The list survives a restart, and a removed current source hands over to the next.
    const again = create();
    expect(again.sources().find(source => source.selected)?.name).toBe('Example');
    expect(again.removeSource(added.id).find(source => source.selected)?.id).toBe('dsh-1024store');
  });

  it('says so when no source is selected, and falls back to the default on an unreadable list', async () => {
    const { service, layout } = market(() => page([]));
    service.removeSource('dsh-1024store');
    expect(service.sources().filter(source => source.added)).toEqual([]);
    await expect(service.query({})).rejects.toThrow(/No source selected/);
    writeFileSync(join(layout.root, 'market-sources.json'), '{not json');
    expect(service.sources().find(source => source.selected)?.id).toBe('dsh-1024store');
  });
});
