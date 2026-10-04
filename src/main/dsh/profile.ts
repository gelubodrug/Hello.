import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { DshLayout } from './layout';

/**
 * The profile's pnpm settings, as Hello needs them for plugin installs.
 *
 * dsh writes `pnpm-workspace.yaml` when it creates the profile (hoisted,
 * no automatic peers). Hello adds two settings: a plugin's own install
 * scripts do not run and do not fail the install (pnpm 11 makes an unlisted
 * script a hard error), and pnpm never swaps itself for another version.
 */
export function ensureProfileWorkspace(layout: DshLayout): void {
  const file = join(layout.profile, 'pnpm-workspace.yaml');
  let current: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed = parse(readFileSync(file, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
    } catch { /* rewritten below */ }
  }
  const next = {
    packages: ['.'],
    nodeLinker: 'hoisted',
    autoInstallPeers: false,
    ...current,
    strictDepBuilds: false,
    managePackageManagerVersions: false,
  };
  const text = stringify(next);
  if (!existsSync(file) || readFileSync(file, 'utf8') !== text) writeFileSync(file, text);
}

/** Hello's own bundle: the Hello theme and brand over dsh's client. */
export const HELLO_BUNDLE = 'hello-dsh';
/** The profile template's bundles, then Hello's. */
export const PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', HELLO_BUNDLE] as const;

const ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`;
const USER_PATCH = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`;

interface ProfileManifest {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  dsh?: { profile?: { bundles?: string[] } };
  [key: string]: unknown;
}

/**
 * The profile as Hello runs it: dsh's web template plus Hello's bundle,
 * linked from the app's own files so a new Hello brings its theme along
 * without a reinstall. Creates the profile the first time — the files dsh
 * itself would write — and on later starts only adds what is missing,
 * leaving every plugin the person installed where it is.
 * @returns whether package.json changed, and so whether pnpm must run.
 */
export function ensureHelloProfile(layout: DshLayout): { changed: boolean } {
  mkdirSync(layout.profile, { recursive: true, mode: 0o700 });
  const file = join(layout.profile, 'package.json');
  const link = `link:${join(layout.resources, HELLO_BUNDLE)}`;
  let manifest: ProfileManifest = { name: 'dsh-profile-hello', private: true, dependencies: {}, dsh: { profile: { bundles: [...PROFILE_BUNDLES] } } };
  let existed = false;
  if (existsSync(file)) {
    existed = true;
    try { manifest = JSON.parse(readFileSync(file, 'utf8')) as ProfileManifest; }
    catch { throw new Error(`The DSH profile's package.json cannot be read: ${file}`); }
  }
  const before = JSON.stringify(manifest);
  manifest.dependencies = { ...manifest.dependencies, [HELLO_BUNDLE]: link };
  const bundles = manifest.dsh?.profile?.bundles ?? [...PROFILE_BUNDLES];
  if (!bundles.includes(HELLO_BUNDLE)) bundles.push(HELLO_BUNDLE);
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } };
  const changed = !existed || JSON.stringify(manifest) !== before;
  if (changed) writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  if (!existsSync(join(layout.profile, 'cordis.yml'))) writeFileSync(join(layout.profile, 'cordis.yml'), ROOT_CONFIG);
  if (!existsSync(join(layout.profile, 'cordis.patch.yml'))) writeFileSync(join(layout.profile, 'cordis.patch.yml'), USER_PATCH);
  ensureProfileWorkspace(layout);
  return { changed };
}

interface KnownProfile { dependencies: Record<string, string> }

function currentDependencies(layout: DshLayout): Record<string, string> | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(layout.profile, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    return { ...manifest.dependencies };
  } catch {
    return undefined;
  }
}

/** Records the profile's packages as Hello last left them: after a start it booted, and after every change Hello made. */
export function rememberProfile(layout: DshLayout): void {
  const dependencies = currentDependencies(layout);
  if (!dependencies) return;
  mkdirSync(layout.root, { recursive: true, mode: 0o700 });
  writeFileSync(join(layout.root, 'profile-known.json'), `${JSON.stringify({ dependencies } satisfies KnownProfile, null, 2)}\n`);
}

export interface ProfileChange { added: string[]; removed: string[]; changed: string[] }

/**
 * Packages the profile gained, lost or changed since Hello last left it.
 * A plugin runs with the person's permissions and can install others itself
 * (dsh1024's routes run `dsh plugin add`); such a change is shown and confirmed
 * before the host boots with it. Undefined when nothing changed or nothing is known yet.
 */
export function profileChange(layout: DshLayout): ProfileChange | undefined {
  let known: KnownProfile;
  try { known = JSON.parse(readFileSync(join(layout.root, 'profile-known.json'), 'utf8')) as KnownProfile; }
  catch { return undefined; }
  const current = currentDependencies(layout);
  if (!current) return undefined;
  const added = Object.keys(current).filter(name => !(name in known.dependencies)).sort();
  const removed = Object.keys(known.dependencies).filter(name => !(name in current)).sort();
  const changed = Object.keys(current).filter(name => name in known.dependencies && known.dependencies[name] !== current[name]).sort();
  return added.length || removed.length || changed.length ? { added, removed, changed } : undefined;
}
