import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { listCheckpoints, profileFingerprint, restoreCheckpoint, saveCheckpoint } from '../src/main/dsh/checkpoints';
import { DSH_PROFILE, DSH_VERSION, dshLayout, installedVersion, runtimeReady } from '../src/main/dsh/layout';
import { inheritedEnv, parseProgress, pnpmFailure } from '../src/main/dsh/pnpm';
import { ensureProfileWorkspace } from '../src/main/dsh/profile';
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

  it('calls the runtime ready only for the pinned version with the shim in place', () => {
    const place = layout();
    expect(runtimeReady(place)).toBe(false);
    mkdirSync(join(place.runtime, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
    writeFileSync(place.installAnchor, JSON.stringify({ version: '0.0.1' }));
    expect(installedVersion(place)).toBe('0.0.1');
    expect(runtimeReady(place)).toBe(false);
    writeFileSync(place.installAnchor, JSON.stringify({ version: DSH_VERSION }));
    expect(runtimeReady(place)).toBe(false);
    mkdirSync(join(place.runtime, 'node_modules', 'node-addon-require-builtin'), { recursive: true });
    writeFileSync(join(place.runtime, 'node_modules', 'node-addon-require-builtin', 'package.json'), '{}');
    expect(runtimeReady(place)).toBe(true);
  });
});

describe('runtime files', () => {
  it('pins dsh exactly and replaces the fingerprinted addon with the shim', () => {
    const place = layout();
    expect(runtimeManifest()).toMatchObject({ private: true, dependencies: { '@deepseek-ai/dsh': DSH_VERSION } });
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
    writeRuntimeFiles(place);
    expect(JSON.parse(readFileSync(join(place.runtime, 'package.json'), 'utf8')).dependencies['@deepseek-ai/dsh']).toBe(DSH_VERSION);
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

describe('restore points', () => {
  function profile(place: ReturnType<typeof layout>, packages: string) {
    mkdirSync(place.profile, { recursive: true });
    writeFileSync(join(place.profile, 'package.json'), packages);
    writeFileSync(join(place.profile, 'cordis.patch.yml'), '[]\n');
  }

  it('takes nothing before there is a profile', () => {
    expect(saveCheckpoint(layout(), 'healthy', 'x')).toBeUndefined();
  });

  it('takes a healthy point once per distinct profile, newest first', () => {
    const place = layout();
    profile(place, '{"a":1}');
    expect(saveCheckpoint(place, 'healthy', 'first', 1000)).toBeDefined();
    expect(saveCheckpoint(place, 'healthy', 'same again', 2000)).toBeUndefined();
    profile(place, '{"a":2}');
    expect(saveCheckpoint(place, 'healthy', 'second', 3000)).toBeDefined();
    expect(listCheckpoints(place).map(point => point.label)).toEqual(['second', 'first']);
  });

  it('keeps the last three healthy points', () => {
    const place = layout();
    for (let index = 0; index < 5; index++) {
      profile(place, `{"n":${index}}`);
      saveCheckpoint(place, 'healthy', `p${index}`, 1000 + index);
    }
    expect(listCheckpoints(place).map(point => point.label)).toEqual(['p4', 'p3', 'p2']);
  });

  it('writes a point back, removing files it did not have', () => {
    const place = layout();
    profile(place, '{"good":true}');
    const point = saveCheckpoint(place, 'healthy', 'good', 1000)!;
    const good = profileFingerprint(place);
    writeFileSync(join(place.profile, 'package.json'), '{"broken":true}');
    writeFileSync(join(place.profile, 'pnpm-lock.yaml'), 'lock');
    restoreCheckpoint(place, point.id);
    expect(readFileSync(join(place.profile, 'package.json'), 'utf8')).toBe('{"good":true}');
    expect(existsSync(join(place.profile, 'pnpm-lock.yaml'))).toBe(false);
    expect(profileFingerprint(place)).toBe(good);
    expect(() => restoreCheckpoint(place, 'gone')).toThrow('no longer exists');
  });
});

describe('profile workspace', () => {
  it('keeps dsh’s settings and adds Hello’s two', () => {
    const place = layout();
    mkdirSync(place.profile, { recursive: true });
    writeFileSync(join(place.profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n');
    ensureProfileWorkspace(place);
    const workspace = parse(readFileSync(join(place.profile, 'pnpm-workspace.yaml'), 'utf8')) as Record<string, unknown>;
    expect(workspace).toMatchObject({ nodeLinker: 'hoisted', autoInstallPeers: false, strictDepBuilds: false, managePackageManagerVersions: false });
  });
});

describe('changes made outside Hello', () => {
  it('knows nothing before Hello first left the profile, then sees added, removed and changed packages', async () => {
    const { profileChange, rememberProfile } = await import('../src/main/dsh/profile');
    const place = layout();
    mkdirSync(place.profile, { recursive: true });
    const write = (dependencies: Record<string, string>) => writeFileSync(join(place.profile, 'package.json'), JSON.stringify({ dependencies }));
    write({ a: '1.0.0', b: '1.0.0' });
    expect(profileChange(place)).toBeUndefined();
    rememberProfile(place);
    expect(profileChange(place)).toBeUndefined();
    write({ a: '1.0.1', c: '2.0.0' });
    expect(profileChange(place)).toEqual({ added: ['c'], removed: ['b'], changed: ['a'] });
    rememberProfile(place);
    expect(profileChange(place)).toBeUndefined();
  });
});

describe('skills from DSH plugins', () => {
  it('offers the skill folders of the plugins the person installed, and not Hello’s own bundle', async () => {
    const { dshSkillRoots } = await import('../src/main/dsh/skills');
    const { discoverSkills } = await import('../src/main/extensions/discovery');
    const root = mkdtempSync(join(tmpdir(), 'hello-dsh-skills-'));
    folders.push(root);
    const place = dshLayout(root, '');
    mkdirSync(join(place.profile, 'node_modules', '@tt-a1i', 'archify-dsh', 'skills', 'archify'), { recursive: true });
    mkdirSync(join(place.profile, 'node_modules', 'hello-dsh', 'skills', 'mine'), { recursive: true });
    writeFileSync(join(place.profile, 'node_modules', '@tt-a1i', 'archify-dsh', 'skills', 'archify', 'SKILL.md'), '---\nname: archify\ndescription: Diagrams as HTML.\n---\n# Archify\n');
    writeFileSync(join(place.profile, 'node_modules', 'hello-dsh', 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---\n');
    writeFileSync(join(place.profile, 'package.json'), JSON.stringify({ dependencies: { '@tt-a1i/archify-dsh': '0.1.0', 'hello-dsh': 'link:x' }, dsh: { profile: { bundles: ['@tt-a1i/archify-dsh', 'hello-dsh'] } } }));
    const roots = dshSkillRoots(root);
    expect(roots).toEqual([{ label: 'DSH plugin · @tt-a1i/archify-dsh', path: join(place.profile, 'node_modules', '@tt-a1i', 'archify-dsh', 'skills') }]);
    const empty = mkdtempSync(join(tmpdir(), 'hello-home-'));
    folders.push(empty);
    const skills = await discoverSkills(empty, [], roots);
    expect(skills.map(skill => [skill.name, skill.source, skill.description])).toEqual([['archify', 'DSH plugin · @tt-a1i/archify-dsh', 'Diagrams as HTML.']]);
  });
});
