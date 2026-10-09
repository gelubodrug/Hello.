import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DSH_PROFILE, dshLayout, installedVersion, runtimeReady, selectedVersion } from '../src/main/dsh/layout';
import { inheritedEnv, parseProgress, pnpmFailure } from '../src/main/dsh/pnpm';
import { removeLegacyTheme } from '../src/main/dsh/profile';
import { DSH_SKIPPED_OPTIONAL, runtimeManifest, runtimeWorkspace, writeRuntimeFiles } from '../src/main/dsh/runtime';

const folders: string[] = [];
function layout() {
  const root = mkdtempSync(join(tmpdir(), 'hello-dsh-files-'));
  folders.push(root);
  return dshLayout(root, join(root, 'resources'));
}
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe('dsh layout', () => {
  it('keeps everything under the app data folder, with a profile that is not desktop', () => {
    const place = layout();
    expect(place.home.startsWith(place.root)).toBe(true);
    expect(place.profile).toBe(join(place.home, 'profiles', DSH_PROFILE));
    expect(DSH_PROFILE).not.toBe('desktop');
    expect(place.installAnchor).toBe(join(place.runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  });

  it('calls the runtime ready for an installed version with the shim in place', () => {
    const place = layout();
    expect(runtimeReady(place)).toBe(false);
    mkdirSync(join(place.runtime, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
    writeFileSync(place.installAnchor, JSON.stringify({ version: '0.0.1' }));
    expect(installedVersion(place)).toBe('0.0.1');
    expect(runtimeReady(place)).toBe(false);
    writeFileSync(place.installAnchor, JSON.stringify({ version: '0.2.0-rc.2' }));
    expect(runtimeReady(place)).toBe(false);
    mkdirSync(join(place.runtime, 'node_modules', 'node-addon-require-builtin'), { recursive: true });
    writeFileSync(join(place.runtime, 'node_modules', 'node-addon-require-builtin', 'package.json'), '{}');
    expect(runtimeReady(place)).toBe(true);
  });
});

describe('runtime files', () => {
  it('installs the resolved dsh exactly and replaces the fingerprinted addon with the shim', () => {
    const place = layout();
    expect(runtimeManifest('0.2.0-rc.2')).toMatchObject({ private: true, dependencies: { '@deepseek-ai/dsh': '0.2.0-rc.2' } });
    const workspace = parse(runtimeWorkspace(place)) as Record<string, any>;
    expect(workspace.nodeLinker).toBe('hoisted');
    expect(workspace.managePackageManagerVersions).toBe(false);
    expect(workspace.overrides['node-addon-require-builtin']).toBe(`file:${join(place.resources, 'shims', 'node-addon-require-builtin')}`);
    expect(workspace.allowBuilds['node-pty']).toBe(true);
    expect(workspace.allowBuilds.protobufjs).toBe(false);
  });

  // 148 MB of a 492 MB install is one prebuilt LibreOffice, for converting
  // Office documents inside the DSH surface. The entry package stays, so the
  // plugins that import it still load and only a conversion fails.
  it('leaves the office engine out of the install, every platform of it', () => {
    const workspace = parse(runtimeWorkspace(layout())) as Record<string, any>;
    expect(workspace.ignoredOptionalDependencies).toEqual([...DSH_SKIPPED_OPTIONAL]);
    expect(workspace.ignoredOptionalDependencies).toContain('@deepseek-ai/libreoffice-kit-darwin-arm64');
    // Not the entry package: dsh-office-to-pdf imports it at load.
    expect(workspace.ignoredOptionalDependencies).not.toContain('@deepseek-ai/libreoffice-kit');
    // Named exactly, and only optional dependencies: nothing dsh needs to boot.
    for (const name of DSH_SKIPPED_OPTIONAL) expect(name).toMatch(/^@deepseek-ai\/libreoffice-kit-[a-z0-9-]+$/);
  });

  it('writes both files into the runtime folder', () => {
    const place = layout();
    writeRuntimeFiles(place, '0.2.0-rc.2');
    expect(JSON.parse(readFileSync(join(place.runtime, 'package.json'), 'utf8')).dependencies['@deepseek-ai/dsh']).toBe('0.2.0-rc.2');
    expect(existsSync(join(place.runtime, 'pnpm-workspace.yaml'))).toBe(true);
  });
});

describe('pnpm helpers', () => {
  it('reads append-only progress lines', () => {
    expect(parseProgress('Progress: resolved 587, reused 205, downloaded 311, added 514, done')).toEqual({ resolved: 587, reused: 205, downloaded: 311, added: 514, done: true });
    expect(parseProgress('Progress: resolved 1, reused 0, downloaded 0, added 0')).toMatchObject({ done: false });
    expect(parseProgress('Packages: +514')).toBeUndefined();
  });

  it('keeps pnpm’s last words without its progress chatter', () => {
    const failure = pnpmFailure('Progress: resolved 1, reused 0, downloaded 0, added 0\n ERR_PNPM_FETCH_404  GET https://registry/x: Not Found\n');
    expect(failure).toContain('ERR_PNPM_FETCH_404');
    expect(failure).not.toContain('Progress:');
    expect(pnpmFailure('')).toBe('pnpm stopped without saying why.');
  });

  it('passes on the network and locale, never keys', () => {
    const env = inheritedEnv({ PATH: '/bin', HOME: '/h', HTTPS_PROXY: 'http://p', LANG: 'ro_RO', OPENAI_API_KEY: 'sk-x', HELLO_TEST_API_KEY: 'y', GITHUB_TOKEN: 'z' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', HTTPS_PROXY: 'http://p', LANG: 'ro_RO' });
  });
});

describe('retiring the Hello theme', () => {
  it('removes only its manifest references and preserves all user patch content', () => {
    const place = layout();
    mkdirSync(place.profile, { recursive: true });
    const manifest = {
      name: 'my-profile', private: true, custom: { keep: ['this'] },
      dependencies: { 'hello-dsh': 'link:old-app/hello-dsh', 'my-plugin': '1.2.3' },
      dsh: { other: 'keep', profile: { other: true, bundles: ['@deepseek-ai/dsh-base', 'hello-dsh', 'my-plugin'] } },
    };
    const file = join(place.profile, 'package.json');
    const patch = '# Personal settings\n- id: custom\n  config:\n    untouched: true\n';
    writeFileSync(file, JSON.stringify(manifest));
    writeFileSync(join(place.profile, 'cordis.patch.yml'), patch);
    removeLegacyTheme(place);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      ...manifest,
      dependencies: { 'my-plugin': '1.2.3' },
      dsh: { ...manifest.dsh, profile: { other: true, bundles: ['@deepseek-ai/dsh-base', 'my-plugin'] } },
    });
    expect(readFileSync(join(place.profile, 'cordis.patch.yml'), 'utf8')).toBe(patch);
    const after = readFileSync(file, 'utf8');
    removeLegacyTheme(place);
    expect(readFileSync(file, 'utf8')).toBe(after);
  });

  it('leaves fresh profile creation to upstream and does not revive an old version selection', () => {
    const place = layout();
    removeLegacyTheme(place);
    expect(existsSync(place.profile)).toBe(false);
    mkdirSync(place.root, { recursive: true });
    writeFileSync(join(place.root, 'version.json'), '{"version":"0.1.7-rc.2"}');
    expect(selectedVersion(place)).toBe('latest');
  });
});
