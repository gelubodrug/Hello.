import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dshLayout } from '../src/main/dsh/layout';
import { listCheckpoints } from '../src/main/dsh/checkpoints';
import { compatibility, installedPlugins, MarketInstaller, readForHello, safeBundlePatch, setProfileBundle, stableExactVersion, verifyNpmLatest } from '../src/main/market/install';
import { cachedMarketHttp, createMarketHttp, MarketNetworkError, safeAddress, validateUrl, type MarketHttp, type RawResponse } from '../src/main/market/net';
import { normalizeItem, parseProviderPage, providerUrl, reviewedNpmTarget } from '../src/main/market/store1024';

const folders: string[] = [];
const npm = (manifest: Record<string, unknown>): MarketHttp => ({
  getJson: async url => ({ value: manifest, finalUrl: url }),
  getBytes: async () => { throw new Error('no'); },
});
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe('the market’s network rules', () => {
  it('accepts only plain HTTPS on 443', () => {
    expect(validateUrl('https://deepseek1024.com/api').host).toBe('deepseek1024.com');
    for (const bad of ['http://deepseek1024.com/', 'https://user:pw@x.com/', 'https://x.com/#f', 'https://x.com:8443/', 'not a url'])
      expect(() => validateUrl(bad)).toThrow(MarketNetworkError);
  });

  it('refuses loopback, private, link-local and tunnel addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.9', '169.254.1.1', '100.64.0.1', '::1', 'fe80::1', 'fc00::1', '64:ff9b::7f00:1', '::ffff:127.0.0.1'])
      expect(() => safeAddress(address), address).toThrow(MarketNetworkError);
    expect(safeAddress('104.16.1.1')).toBe(4);
    expect(safeAddress('2606:4700::1')).toBe(6);
  });

  function http(responses: Record<string, RawResponse>, lookup: Record<string, string> = {}) {
    const asked: string[] = [];
    const client = createMarketHttp({
      lookup: async hostname => [{ address: lookup[hostname] ?? '104.16.1.1', family: 4 }],
      request: async url => { asked.push(url.href); const response = responses[url.href]; if (!response) throw new Error(`unexpected ${url.href}`); return response; },
    });
    return { client, asked };
  }
  const json = (value: unknown): RawResponse => ({ statusCode: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify(value)) });

  it('follows up to three redirects on the allowed origin, and no further', async () => {
    const hop = (to: string): RawResponse => ({ statusCode: 302, headers: { location: to }, body: Buffer.alloc(0) });
    const ok = http({ 'https://a.com/1': hop('/2'), 'https://a.com/2': hop('/3'), 'https://a.com/3': json({ ok: true }) });
    expect((await ok.client.getJson('https://a.com/1', new AbortController().signal)).value).toEqual({ ok: true });
    const tooMany = http({ 'https://a.com/1': hop('/2'), 'https://a.com/2': hop('/3'), 'https://a.com/3': hop('/4'), 'https://a.com/4': hop('/5'), 'https://a.com/5': json({}) });
    await expect(tooMany.client.getJson('https://a.com/1', new AbortController().signal)).rejects.toThrow('redirect');
    const offOrigin = http({ 'https://a.com/1': hop('https://evil.com/x') });
    await expect(offOrigin.client.getJson('https://a.com/1', new AbortController().signal, { allowedOrigin: 'https://a.com' })).rejects.toThrow('redirect');
  });

  it('refuses a name that resolves to a private address, and a non-JSON answer', async () => {
    const privateName = http({ 'https://intranet.com/x': json({}) }, { 'intranet.com': '10.0.0.5' });
    await expect(privateName.client.getJson('https://intranet.com/x', new AbortController().signal)).rejects.toThrow('blocked-address');
    const html = http({ 'https://a.com/x': { statusCode: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>') } });
    await expect(html.client.getJson('https://a.com/x', new AbortController().signal)).rejects.toThrow('response');
  });
});

describe('the 1024Store adapter', () => {
  it('takes only an npm package name, and only from the exact inert command shape', () => {
    expect(reviewedNpmTarget('dsh plugin --profile web add @openviking/dsh-memory-plugin')).toBe('@openviking/dsh-memory-plugin');
    expect(reviewedNpmTarget('dsh plugin --profile web add dsh1024@0.5.0')).toBe('dsh1024');
    expect(reviewedNpmTarget('dsh plugin --profile web add github:imsai-sh/awesome-deepseek-harness-plugins')).toBeUndefined();
    expect(reviewedNpmTarget('dsh plugin --profile web add x; rm -rf ~')).toBeUndefined();
    expect(reviewedNpmTarget('npm install evil')).toBeUndefined();
  });

  const record = {
    id: 'volcengine/OpenViking/examples/dsh-memory-plugin', name: 'dsh-memory-plugin', owner: 'volcengine',
    url: 'https://github.com/volcengine/OpenViking', category: 'memory', installCount: 386, stars: 38859,
    description: { en: 'Unifies long-term memory.', zh: '整合长期记忆' },
    install: 'dsh plugin --profile web add @openviking/dsh-memory-plugin', pushedAt: '2026-09-28T10:23:50Z',
  };

  it('normalizes a record the way the market does', () => {
    expect(normalizeItem(record)).toEqual({
      id: record.id, name: 'dsh-memory-plugin', summary: 'Unifies long-term memory.', publisher: 'volcengine', categories: ['memory'],
      repository: 'https://github.com/volcengine/OpenViking', npm: '@openviking/dsh-memory-plugin', updatedAt: '2026-09-28T10:23:50.000Z',
      stars: 38859, installs: 386, icons: ['https://github.com/volcengine.png?size=96'],
    });
    expect(normalizeItem(record, 'zh-CN')?.summary).toBe('整合长期记忆');
  });

  it('keeps a GitHub-only entry as manual, and drops records that do not fit', () => {
    const manual = normalizeItem({ ...record, install: 'dsh plugin --profile web add github:imsai-sh/awesome-deepseek-harness-plugins' });
    expect(manual?.npm).toBeUndefined();
    expect(manual?.manualCommand).toContain('github:imsai-sh');
    expect(normalizeItem({ ...record, url: 'https://gitlab.com/a/b' })).toBeUndefined();
    expect(normalizeItem({ ...record, name: 'bad‮name' })).toBeUndefined();
    expect(normalizeItem({ ...record, id: '' })).toBeUndefined();
  });

  it('refuses a page that does not add up', () => {
    const page = { plugins: [record], limit: 1, total: 3, catalogTotal: 10, totalPages: 3, page: 1, generatedAt: '2026-09-28T11:39:00Z', source: 'live', categories: [{ id: 'memory', count: 10 }] };
    expect(parseProviderPage(page, 1, 1)).toMatchObject({ total: 3, totalPages: 3, categories: ['memory'] });
    expect(() => parseProviderPage({ ...page, limit: 2 }, 1, 1)).toThrow('page limit');
    expect(() => parseProviderPage({ ...page, totalPages: 2 }, 1, 1)).toThrow('page count');
    expect(() => parseProviderPage({ ...page, plugins: [] }, 1, 1)).toThrow('page length');
    expect(() => parseProviderPage({ ...page, total: 20 }, 1, 1)).toThrow('exceeds');
  });

  it('asks the provider for exactly the query', () => {
    const url = new URL(providerUrl({ q: 'memory', category: 'skill', sort: 'downloads' }, 2, 50));
    expect(url.origin + url.pathname).toBe('https://deepseek1024.com/api/v2/plugins');
    expect(Object.fromEntries(url.searchParams)).toEqual({ page: '2', limit: '50', q: 'memory', category: 'skill', sort: 'installs' });
  });
});

describe('install preview', () => {
  it('accepts npm latest only with the same name, a stable exact version and a safe bundle patch', async () => {
    const good = { name: 'dsh1024', version: '0.5.0', dsh: { bundle: { patch: './cordis.patch.yml' } } };
    await expect(verifyNpmLatest(npm(good), 'dsh1024', new AbortController().signal)).resolves.toMatchObject({ version: '0.5.0' });
    await expect(verifyNpmLatest(npm({ ...good, name: 'other' }), 'dsh1024', new AbortController().signal)).rejects.toThrow('did not match');
    await expect(verifyNpmLatest(npm({ ...good, version: '1.0.0-rc.1' }), 'dsh1024', new AbortController().signal)).rejects.toThrow('did not match');
    await expect(verifyNpmLatest(npm({ ...good, dsh: { bundle: { patch: '../escape.yml' } } }), 'dsh1024', new AbortController().signal)).rejects.toThrow('valid DSH bundle');
    await expect(verifyNpmLatest(npm(good), 'hello-dsh', new AbortController().signal)).rejects.toThrow('invalid');
    expect(stableExactVersion('0.5.0')).toBe(true);
    expect(stableExactVersion('^0.5.0')).toBe(false);
    expect(safeBundlePatch('patches/cordis.patch.yml')).toBe(true);
    expect(safeBundlePatch('/etc/x')).toBe(false);
  });

  it('checks the package’s dsh peers against the dsh Hello runs', () => {
    expect(compatibility({ peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' } })).toEqual({ ok: true });
    expect(compatibility({ peerDependencies: { '@deepseek-ai/dsh-llm': '>=0.1.0-rc.6 <0.2.0 || ^0.1.7-rc.2' } })).toEqual({ ok: true });
    expect(compatibility({ peerDependencies: { '@deepseek-ai/dsh-llm': '^0.2.0-rc.1' } })).toMatchObject({ ok: false, reason: expect.stringContaining('^0.2.0-rc.1') });
    expect(compatibility({ dsh: { compatibility: { dsh: '>=0.1.0-rc.5' } } })).toEqual({ ok: true });
  });

  // The judgement is against the dsh that is running, not the one this build
  // came with: the person can update the runtime from the sidebar, and every
  // caller passes selectedVersion(). A plugin written for both lines must pass
  // on both; one pinned to the old line must not pass on the new one.
  it('judges a package against the dsh that is running, on either line', () => {
    const bothLines = { peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.7-rc.2 || >=0.2.0-rc.1 <0.3.0-0' } };
    expect(compatibility(bothLines, '0.1.7-rc.2')).toEqual({ ok: true });
    expect(compatibility(bothLines, '0.2.0-rc.2')).toEqual({ ok: true });
    expect(compatibility(bothLines, '0.3.0')).toMatchObject({ ok: false });
    const oldLineOnly = { peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.7' } };
    expect(compatibility(oldLineOnly, '0.1.7-rc.2')).toEqual({ ok: true });
    expect(compatibility(oldLineOnly, '0.2.0-rc.2')).toMatchObject({ ok: false, reason: expect.stringContaining('0.2.0-rc.2') });
    // A release candidate of the running line counts: includePrerelease.
    expect(compatibility({ dsh: { compatibility: { dsh: '>=0.2.0' } } }, '0.2.0-rc.2')).toMatchObject({ ok: false });
    expect(compatibility({ dsh: { compatibility: { dsh: '>=0.2.0-rc.1' } } }, '0.2.0-rc.2')).toEqual({ ok: true });
  });

  it('says what a package brings, from its manifest', () => {
    expect(readForHello({ dsh: { client: { platform: 'web' } } }).ui).toBe(true);
    expect(readForHello({ peerDependencies: { '@deepseek-ai/dsh-skill-filesystem': '*' } }).skills).toBe(true);
    expect(readForHello({ peerDependencies: { '@deepseek-ai/dsh-mcp-client': '*' } }).mcp).toBe(true);
  });
});

describe('profile operations', () => {
  function profile() {
    const root = mkdtempSync(join(tmpdir(), 'hello-market-'));
    folders.push(root);
    const place = dshLayout(root, join(root, 'resources'));
    mkdirSync(place.profile, { recursive: true });
    writeFileSync(join(place.profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-hello', dependencies: { 'hello-dsh': 'link:x' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'hello-dsh'] } } }, null, 2));
    return place;
  }

  it('adds and removes one bundle atomically', () => {
    const place = profile();
    setProfileBundle(place, 'dsh1024', true);
    setProfileBundle(place, 'dsh1024', true);
    expect(JSON.parse(readFileSync(join(place.profile, 'package.json'), 'utf8')).dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'hello-dsh', 'dsh1024']);
    setProfileBundle(place, 'dsh1024', false);
    expect(JSON.parse(readFileSync(join(place.profile, 'package.json'), 'utf8')).dsh.profile.bundles).not.toContain('dsh1024');
  });

  it('installs a confirmed preview with pnpm, after a restore point, and lists it', async () => {
    const place = profile();
    const fakePnpm = resolve(__dirname, 'fixtures/fake-pnpm-market.mjs');
    const lines: string[] = [];
    const published: Record<string, unknown> = { name: 'dsh1024', version: '0.5.0', dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } };
    const installer = new MarketInstaller({
      layout: place,
      pnpm: { command: process.execPath, args: [fakePnpm], env: { ELECTRON_RUN_AS_NODE: '1' } },
      http: npm(published),
      log: line => lines.push(line),
    });
    const preview = await installer.previewInstall('dsh1024', 'dsh1024', new AbortController().signal);
    expect(preview).toMatchObject({ action: 'install', packageName: 'dsh1024', version: '0.5.0', compatibility: { ok: true } });
    const result = await installer.confirm(preview.token);
    expect(result).toMatchObject({ action: 'install', packageName: 'dsh1024', version: '0.5.0' });
    // The confirmed version is exempt from pnpm 11's one-day wait for new releases; only it.
    expect(lines.join('\n')).toContain('pnpm add dsh1024@0.5.0 --save-exact --config.minimum-release-age-exclude=dsh1024@0.5.0');
    expect(installedPlugins(place).find(row => row.packageName === 'dsh1024')).toMatchObject({ kind: 'plugin', bundle: true, version: '0.5.0' });
    expect(listCheckpoints(place).some(point => point.kind === 'before')).toBe(true);
    const { profileChange, rememberProfile } = await import('../src/main/dsh/profile');
    expect(profileChange(place)).toBeUndefined();
    void rememberProfile;
    await expect(installer.confirm(preview.token)).rejects.toThrow('expired');

    // An update from Installed: npm's newest version, installed the same way, after a restore point.
    published.version = '0.6.0';
    const update = await installer.previewUpdate('dsh1024', new AbortController().signal);
    expect(update).toMatchObject({ action: 'update', from: '0.5.0', version: '0.6.0', compatibility: { ok: true } });
    await installer.confirm(update.token);
    expect(lines.join('\n')).toContain('pnpm add dsh1024@0.6.0 --save-exact --config.minimum-release-age-exclude=dsh1024@0.6.0');
    expect(installedPlugins(place).find(row => row.packageName === 'dsh1024')).toMatchObject({ version: '0.6.0', bundle: true });
    expect(listCheckpoints(place).some(point => point.label === 'Before updating dsh1024')).toBe(true);
    await expect(installer.previewUpdate('dsh1024', new AbortController().signal)).rejects.toThrow('newest');

    const removal = installer.previewUninstall('dsh1024');
    await installer.confirm(removal.token);
    expect(installedPlugins(place).some(row => row.packageName === 'dsh1024')).toBe(false);
    expect(() => installer.previewUninstall('hello-dsh')).toThrow('removable');
  });

  it('says when a dependency is too new for pnpm, rather than only that pnpm failed', async () => {
    const place = profile();
    const installer = new MarketInstaller({
      layout: place,
      pnpm: { command: process.execPath, args: [resolve(__dirname, 'fixtures/fake-pnpm-market.mjs')], env: { ELECTRON_RUN_AS_NODE: '1', FAKE_PNPM_FAIL: 'ERR_PNPM_NO_MATURE_MATCHING_VERSION No matching version found for dsh-core@^1.2.0' } },
      http: npm({ name: 'dsh1024', version: '0.5.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      log: () => {},
    });
    const preview = await installer.previewInstall('dsh1024', 'dsh1024', new AbortController().signal);
    await expect(installer.confirm(preview.token)).rejects.toThrow(/published less than a day ago/);
    expect(installedPlugins(place).some(row => row.packageName === 'dsh1024')).toBe(false);
  });

  it('refuses an incompatible plugin, and a preview whose profile changed', async () => {
    const place = profile();
    const installer = new MarketInstaller({
      layout: place,
      pnpm: { command: process.execPath, args: [resolve(__dirname, 'fixtures/fake-pnpm-market.mjs')], env: { ELECTRON_RUN_AS_NODE: '1' } },
      http: npm({ name: 'dsh-better-sidebar', version: '0.24.1', peerDependencies: { '@deepseek-ai/dsh-llm': '^0.2.0-rc.1' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      log: () => {},
    });
    const incompatible = await installer.previewInstall('dsh-better-sidebar', 'dsh-better-sidebar', new AbortController().signal);
    expect(incompatible.compatibility.ok).toBe(false);
    await expect(installer.confirm(incompatible.token)).rejects.toThrow('Needs');

    const again = await installer.previewInstall('dsh-better-sidebar', 'x', new AbortController().signal);
    writeFileSync(join(place.profile, 'cordis.patch.yml'), '- id: something\n');
    await expect(installer.confirm(again.token)).rejects.toThrow();
  });
});

describe('plugins made in Hello', () => {
  const template = resolve(__dirname, '../assets/examples/skills/dsh-plugin-creator/template');

  it('ships a template in the shape dsh loads, which Hello’s own gate accepts', async () => {
    const { parse } = await import('yaml');
    const manifest = JSON.parse(readFileSync(join(template, 'package.json'), 'utf8'));
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml');
    expect(compatibility(manifest)).toEqual({ ok: true });
    const patch = parse(readFileSync(join(template, 'cordis.patch.yml'), 'utf8'), { customTags: [{ tag: '!!js', resolve: (value: string) => ({ js: value }) }] }) as Array<{ insert: Array<{ id: string; name: string }> }>;
    expect(patch[0].insert.map(row => row.name)).toEqual([manifest.name, '@deepseek-ai/dsh-skill-filesystem']);
    expect(readFileSync(join(template, 'lib', 'index.js'), 'utf8')).toContain("export const inject = ['tools']");
    expect(readFileSync(join(template, 'skills', 'word-count', 'SKILL.md'), 'utf8')).toMatch(/^---\nname: word-count\ndescription: /);
  });

  it('previews a plugin folder, and links it on confirm', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hello-market-folder-'));
    folders.push(root);
    const place = dshLayout(root, join(root, 'resources'));
    mkdirSync(place.profile, { recursive: true });
    writeFileSync(join(place.profile, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
    const lines: string[] = [];
    const installer = new MarketInstaller({ layout: place, pnpm: { command: process.execPath, args: [resolve(__dirname, 'fixtures/fake-pnpm-market.mjs')], env: { ELECTRON_RUN_AS_NODE: '1' } }, http: npm({}), log: line => lines.push(line) });
    const preview = installer.previewFolder(template);
    expect(preview).toMatchObject({ action: 'install', packageName: 'dsh-plugin-word-count', version: '0.1.0', folder: template, compatibility: { ok: true } });
    expect(preview.hello?.skills).toBe(true);
    expect(() => installer.previewFolder(root)).toThrow('package.json');
  });
});

describe('the shared read of one URL', () => {
  it('is not ended by one caller’s Stop, and each caller stops waiting on its own', async () => {
    let answer!: (value: { value: unknown; finalUrl: string }) => void;
    const seen: AbortSignal[] = [];
    const cached = cachedMarketHttp({
      getJson: (_url, signal) => { seen.push(signal); return new Promise(resolve => { answer = resolve; }); },
      getBytes: async () => { throw new Error('unused'); },
    });
    const first = new AbortController();
    const a = cached.getJson('https://skills.sh/api/search?q=x', first.signal);
    const b = cached.getJson('https://skills.sh/api/search?q=x', new AbortController().signal);
    first.abort();
    await expect(a).rejects.toBeInstanceOf(MarketNetworkError);
    expect(seen).toHaveLength(1);
    expect(seen[0].aborted).toBe(false);
    answer({ value: { ok: true }, finalUrl: 'https://skills.sh/api/search?q=x' });
    await expect(b).resolves.toMatchObject({ value: { ok: true } });
  });
});
