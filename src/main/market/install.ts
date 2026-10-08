/**
 * Installing a plugin into the DSH profile, as dsh-community-market does it
 * (lib/install/service.js, MIT, Anywhere Labs), in Hello's hands.
 *
 * A catalog entry contributes one npm package name, nothing else. The preview
 * asks npm's official `latest` for it and accepts only the same name, an
 * exact stable version and a safe `dsh.bundle.patch`; Hello adds a check the
 * market leaves out — the package's dsh peers must accept the dsh this app
 * runs, or it would stop the surface from booting. The confirmation is a
 * one-shot token bound to those facts and to the profile as it was; the
 * install is `pnpm add --save-exact` of that version, after a restore point.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { atomicWriteFileSync } from '../atomic-write';
import { join } from 'node:path';
import { gt, prerelease, satisfies, valid, validRange } from 'semver';
import type { MarketHttp } from './net';
import { saveCheckpoint, profileFingerprint } from '../dsh/checkpoints';
import { DSH_VERSION, selectedVersion, type DshLayout } from '../dsh/layout';
import { ensureHelloProfile, ensureProfileWorkspace, HELLO_BUNDLE, PROFILE_BUNDLES, profileChange, rememberProfile } from '../dsh/profile';
import { pnpmFailure, runPnpm, type PnpmInvocation } from '../dsh/pnpm';

export const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const INTENT_TTL_MS = 5 * 60_000;
/** Never installed or removed through the market: the profile's own parts. */
const PRODUCT_PACKAGES = new Set<string>([...PROFILE_BUNDLES, HELLO_BUNDLE, 'dsh-plugin-desktop', 'dsh-community-market']);

export class MarketInstallError extends Error {
  constructor(readonly code: 'verification-failed' | 'incompatible' | 'conflict' | 'expired' | 'busy' | 'install-failed' | 'out-of-space', message: string, readonly output?: string) {
    super(message);
    this.name = 'MarketInstallError';
  }
}

/** A full disk, said as such (nativ#689) — from pnpm's output or an fs error. */
const OUT_OF_SPACE = /\bENOSPC\b|no space left on device/i;
export function outOfSpace(failure: string | unknown, folder: string, output?: string): MarketInstallError | undefined {
  const full = typeof failure === 'string' ? OUT_OF_SPACE.test(failure)
    : Boolean(failure && typeof failure === 'object' && (failure as { code?: unknown }).code === 'ENOSPC');
  return full ? new MarketInstallError('out-of-space', `The disk is full: the download needs more room in ${folder}. Free some space and try again.`, output) : undefined;
}

export function safePackageName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 214 && PACKAGE_NAME.test(value);
}

export function stableExactVersion(value: unknown): value is string {
  return typeof value === 'string' && valid(value, { loose: false }) === value && prerelease(value, { loose: false }) === null;
}

export function safeBundlePatch(value: unknown): boolean {
  if (typeof value !== 'string' || !value.length || value.length > 512 || value.includes('\0')) return false;
  const path = value.startsWith('./') ? value.slice(2) : value;
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\')
    && path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes(':'));
}

export interface Verified {
  name: string;
  version: string;
  manifest: Record<string, unknown>;
}

/** npm `latest` for a package, accepted only in the shape of a dsh plugin bundle. */
export async function verifyNpmLatest(http: MarketHttp, name: string, signal: AbortSignal): Promise<Verified> {
  if (!safePackageName(name) || PRODUCT_PACKAGES.has(name)) throw new MarketInstallError('verification-failed', 'The plugin package target is invalid.');
  let response: { value: unknown; finalUrl: string };
  try {
    response = await http.getJson(`${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(name).replace('%40', '@')}/latest`, signal, { allowedOrigin: NPM_REGISTRY_ORIGIN });
  } catch {
    throw new MarketInstallError('verification-failed', 'The plugin package could not be verified with npm.');
  }
  const manifest = response.value;
  if (new URL(response.finalUrl).origin !== NPM_REGISTRY_ORIGIN || !manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new MarketInstallError('verification-failed', 'The npm verification response was invalid.');
  const record = manifest as Record<string, unknown>;
  if (record.name !== name || !stableExactVersion(record.version))
    throw new MarketInstallError('verification-failed', 'The npm package identity did not match the catalog.');
  const dsh = record.dsh as { bundle?: { patch?: unknown } } | undefined;
  if (!safeBundlePatch(dsh && typeof dsh === 'object' ? dsh.bundle?.patch : undefined))
    throw new MarketInstallError('verification-failed', 'The npm package does not declare a valid DSH bundle.');
  return { name, version: record.version as string, manifest: record };
}

/**
 * Whether a package accepts the dsh this app runs: every `@deepseek-ai/*`
 * peer range, and a declared `dsh.compatibility.dsh`, must include it.
 */
export function compatibility(manifest: Record<string, unknown>, dshVersion = DSH_VERSION): { ok: true } | { ok: false; reason: string } {
  const ranges: Array<[string, string]> = [];
  const peers = manifest.peerDependencies;
  if (peers && typeof peers === 'object' && !Array.isArray(peers))
    for (const [name, range] of Object.entries(peers as Record<string, unknown>))
      if (name.startsWith('@deepseek-ai/dsh') && typeof range === 'string') ranges.push([name, range]);
  const declared = (manifest.dsh as { compatibility?: { dsh?: unknown } } | undefined)?.compatibility?.dsh;
  if (typeof declared === 'string') ranges.push(['dsh', declared]);
  for (const [name, range] of ranges) {
    if (!validRange(range)) continue;
    if (!satisfies(dshVersion, range, { includePrerelease: true }))
      return { ok: false, reason: `Needs ${name} ${range}; Hello. runs dsh ${dshVersion}.` };
  }
  return { ok: true };
}

export interface HelloReading {
  /** Interface parts: they run in the DSH surface only. */
  ui: boolean;
  skills: boolean;
  mcp: boolean;
  lines: string[];
}

/** What the package brings, read from its manifest alone, in the person's words. */
export function readForHello(manifest: Record<string, unknown>): HelloReading {
  const dsh = (manifest.dsh ?? {}) as { client?: unknown };
  const peers = Object.keys((manifest.peerDependencies ?? {}) as Record<string, unknown>);
  const keywords = Array.isArray(manifest.keywords) ? (manifest.keywords as unknown[]).filter((word): word is string => typeof word === 'string') : [];
  const ui = dsh.client !== undefined && dsh.client !== null;
  const skills = peers.some(name => name.includes('dsh-skill')) || keywords.some(word => /skill/i.test(word));
  // Tools of its own or an MCP server's: either way they reach the host's tool registry.
  const mcp = peers.some(name => name.includes('dsh-mcp') || name.includes('dsh-tools')) || keywords.some(word => /^(mcp|tools?)$/i.test(word));
  const lines = [
    ui ? 'Interface: in the DSH surface, in Hello’s colours.' : 'No interface of its own.',
    'Runs in the DSH host, a process of its own, with your user permissions.',
    ...(skills ? ['Skills: offered to dsh sessions in the surface, and to Hello. chats from Extensions.'] : []),
    ...(mcp ? ['Tools: offered to dsh sessions in the surface, and to Hello. chats that turn on “dsh-plugins”.'] : []),
  ];
  return { ui, skills, mcp, lines };
}

interface ProfileManifest {
  dependencies?: Record<string, string>;
  dsh?: { profile?: { bundles?: string[] } };
  [key: string]: unknown;
}

function readProfile(layout: DshLayout): ProfileManifest {
  const file = join(layout.profile, 'package.json');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('The DSH profile manifest is not a plain file.');
  const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The DSH profile manifest is invalid.');
  return value as ProfileManifest;
}

/** Adds or removes one bundle in the profile's list, atomically, after pnpm changed its dependencies. */
export function setProfileBundle(layout: DshLayout, name: string, present: boolean): void {
  const manifest = readProfile(layout);
  const current = manifest.dsh?.profile?.bundles ?? [];
  const bundles = present ? (current.includes(name) ? current : [...current, name]) : current.filter(bundle => bundle !== name);
  const next = { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } } };
  const file = join(layout.profile, 'package.json');
  atomicWriteFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { symlinks: 'refuse' });
}

export interface InstalledPlugin {
  packageName: string;
  version: string;
  /** hello: Hello's own bundle; product: dsh's base bundles; plugin: removable. */
  kind: 'plugin' | 'hello' | 'product';
  bundle: boolean;
  /** npm's newest stable version, when it is newer than the one installed. */
  latest?: string;
}

export function installedPlugins(layout: DshLayout): InstalledPlugin[] {
  if (!existsSync(join(layout.profile, 'package.json'))) return [];
  const manifest = readProfile(layout);
  const bundles = new Set(manifest.dsh?.profile?.bundles ?? []);
  const rows: InstalledPlugin[] = [];
  for (const [packageName, spec] of Object.entries(manifest.dependencies ?? {})) {
    let version = spec;
    try {
      const installed = JSON.parse(readFileSync(join(layout.profile, 'node_modules', packageName, 'package.json'), 'utf8')) as { version?: unknown };
      if (typeof installed.version === 'string') version = installed.version;
    } catch { /* the declared spec stands */ }
    rows.push({ packageName, version, kind: packageName === HELLO_BUNDLE ? 'hello' : PRODUCT_PACKAGES.has(packageName) ? 'product' : 'plugin', bundle: bundles.has(packageName) });
  }
  return rows.sort((a, b) => a.packageName.localeCompare(b.packageName));
}

export interface OperationPreview {
  token: string;
  action: 'install' | 'uninstall' | 'update';
  displayName: string;
  packageName: string;
  version?: string;
  /** For an update: the version installed now. */
  from?: string;
  /** A plugin being made on this Mac: linked from this folder, not fetched from npm. */
  folder?: string;
  profile: string;
  expiresAt: number;
  compatibility: { ok: boolean; reason?: string };
  hello?: HelloReading;
}

export interface OperationResult {
  action: 'install' | 'uninstall' | 'update';
  packageName: string;
  version?: string;
  installedAt: number;
}

interface Intent { preview: OperationPreview; fingerprint: string; outsideChange: boolean }

/** Previews, confirms and runs plugin operations on the profile, one at a time. */
export class MarketInstaller {
  private intents = new Map<string, Intent>();
  private active = false;

  constructor(private readonly options: {
    layout: DshLayout;
    pnpm: PnpmInvocation;
    http: MarketHttp;
    log(line: string): void;
    now?: () => number;
  }) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private remember(preview: Omit<OperationPreview, 'token' | 'expiresAt' | 'profile'>): OperationPreview {
    const now = this.now();
    for (const [token, intent] of this.intents) if (intent.preview.expiresAt <= now) this.intents.delete(token);
    ensureHelloProfile(this.options.layout);
    const full: OperationPreview = { ...preview, token: randomBytes(32).toString('base64url'), expiresAt: now + INTENT_TTL_MS, profile: 'Hello' };
    this.intents.set(full.token, { preview: full, fingerprint: profileFingerprint(this.options.layout), outsideChange: profileChange(this.options.layout) !== undefined });
    return full;
  }

  async previewInstall(name: string, displayName: string, signal: AbortSignal): Promise<OperationPreview> {
    if (installedPlugins(this.options.layout).some(row => row.packageName === name))
      throw new MarketInstallError('conflict', 'This plugin is already in the DSH profile.');
    const verified = await verifyNpmLatest(this.options.http, name, signal);
    return this.remember({
      action: 'install',
      displayName,
      packageName: verified.name,
      version: verified.version,
      compatibility: compatibility(verified.manifest, selectedVersion(this.options.layout)),
      hello: readForHello(verified.manifest),
    });
  }

  /**
   * A plugin from a folder on this Mac — one being made in Hello, say. The
   * folder's package.json must name itself and a safe bundle patch; it is
   * linked, so edits reach the host on its next restart.
   */
  previewFolder(folder: string): OperationPreview {
    const file = join(folder, 'package.json');
    let manifest: Record<string, unknown>;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('not a file');
      manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      throw new MarketInstallError('verification-failed', 'That folder has no readable package.json.');
    }
    const name = manifest.name;
    if (!safePackageName(name) || PRODUCT_PACKAGES.has(name)) throw new MarketInstallError('verification-failed', 'The folder’s package.json names no valid package.');
    const dsh = manifest.dsh as { bundle?: { patch?: unknown } } | undefined;
    if (!safeBundlePatch(dsh && typeof dsh === 'object' ? dsh.bundle?.patch : undefined))
      throw new MarketInstallError('verification-failed', 'The folder does not declare a valid DSH bundle (dsh.bundle.patch).');
    if (!existsSync(join(folder, (dsh!.bundle!.patch as string).replace(/^\.\//, ''))))
      throw new MarketInstallError('verification-failed', 'The bundle patch the folder names is not there.');
    if (installedPlugins(this.options.layout).some(row => row.packageName === name))
      throw new MarketInstallError('conflict', 'A plugin with this name is already in the DSH profile.');
    return this.remember({
      action: 'install',
      displayName: name,
      packageName: name,
      ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}),
      folder,
      compatibility: compatibility(manifest, selectedVersion(this.options.layout)),
      hello: readForHello(manifest),
    });
  }

  previewUninstall(name: string): OperationPreview {
    const row = installedPlugins(this.options.layout).find(item => item.packageName === name);
    if (!row || row.kind !== 'plugin') throw new MarketInstallError('conflict', 'This plugin is no longer a removable direct dependency of the DSH profile.');
    return this.remember({ action: 'uninstall', displayName: name, packageName: name, version: row.version, compatibility: { ok: true } });
  }

  /** npm's newest version of an installed plugin, checked like an install (user, 29.09: update from the same place). */
  async previewUpdate(name: string, signal: AbortSignal): Promise<OperationPreview> {
    const row = installedPlugins(this.options.layout).find(item => item.packageName === name);
    if (!row || row.kind !== 'plugin') throw new MarketInstallError('conflict', 'This plugin is no longer a removable direct dependency of the DSH profile.');
    const verified = await verifyNpmLatest(this.options.http, name, signal);
    if (!valid(row.version) || !gt(verified.version, row.version)) throw new MarketInstallError('conflict', `${name} ${row.version} is already npm’s newest version.`);
    return this.remember({
      action: 'update', displayName: name, packageName: name, version: verified.version, from: row.version,
      compatibility: compatibility(verified.manifest, selectedVersion(this.options.layout)), hello: readForHello(verified.manifest),
    });
  }

  async confirm(token: string): Promise<OperationResult> {
    const intent = this.intents.get(token);
    this.intents.delete(token);
    if (!intent || intent.preview.expiresAt <= this.now()) throw new MarketInstallError('expired', 'This confirmation has expired. Open the plugin again.');
    if (!intent.preview.compatibility.ok) throw new MarketInstallError('incompatible', intent.preview.compatibility.reason ?? 'This plugin does not fit the dsh Hello. runs.');
    if (this.active) throw new MarketInstallError('busy', 'Another plugin operation is already running.');
    const { layout, pnpm } = this.options;
    if (profileFingerprint(layout) !== intent.fingerprint) throw new MarketInstallError('conflict', 'The DSH profile changed since this preview. Open the plugin again.');
    this.active = true;
    try {
      const { preview } = intent;
      ensureProfileWorkspace(layout);
      saveCheckpoint(layout, 'before', `Before ${preview.action === 'install' ? 'installing' : preview.action === 'update' ? 'updating' : 'removing'} ${preview.packageName}`, this.now());
      // pnpm 11 installs nothing published less than a day ago. The version the
      // person confirmed is exempt, and only it: its dependencies still wait.
      const args = preview.action === 'uninstall' ? ['remove', preview.packageName]
        : preview.folder ? ['add', `link:${preview.folder}`]
          : ['add', `${preview.packageName}@${preview.version}`, '--save-exact', `--config.minimum-release-age-exclude=${preview.packageName}@${preview.version}`];
      this.options.log(`Market: pnpm ${args.join(' ')}`);
      const run = await runPnpm(pnpm, args, { cwd: layout.profile, onLine: line => this.options.log(`pnpm: ${line}`) });
      if (run.code !== 0) {
        const full = outOfSpace(run.output, layout.profile, pnpmFailure(run.output));
        if (full) throw full;
        if (/NO_MATURE_MATCHING_VERSION/.test(run.output))
          throw new MarketInstallError('install-failed', `A dependency of ${preview.packageName} was published less than a day ago; pnpm waits a day before installing new releases. Try again tomorrow.`, pnpmFailure(run.output));
        throw new MarketInstallError('install-failed', `pnpm could not ${preview.action} ${preview.packageName}.`, pnpmFailure(run.output));
      }
      setProfileBundle(layout, preview.packageName, preview.action !== 'uninstall');
      // Hello's own change: the next start does not ask about it. A change made
      // outside Hello before this one still does, because it was never recorded.
      if (!intent.outsideChange) rememberProfile(layout);
      return { action: preview.action, packageName: preview.packageName, ...(preview.version ? { version: preview.version } : {}), installedAt: this.now() };
    } finally {
      this.active = false;
    }
  }
}
