/**
 * Installing a Pi package into Hello (user, 29.09: "pnpm ca la DSH").
 *
 * The market names one npm package, nothing else. The preview asks npm for
 * a version of it and accepts only a Pi package, in an exact stable version,
 * whose tarball the registry itself serves and vouches for with an
 * integrity. The install is Hello's own pnpm, into a throwaway project: that
 * version, its production dependencies, no install scripts, the registry
 * pinned and the person's own .npmrc left out. The lockfile has to name the
 * integrity the preview saw. The project then becomes the package's folder
 * in Hello's library, where chats turn it on one by one (library.ts).
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { gt, minVersion, satisfies, valid, validRange } from 'semver';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { MarketHttp } from './net';
import { MarketInstallError, NPM_REGISTRY_ORIGIN, outOfSpace, safePackageName, stableExactVersion, type HelloReading } from './install';
import { pnpmFailure, runPnpm, type PnpmInvocation } from '../dsh/pnpm';
import { INSTALLED_LIMITS } from '../extensions/library';

/** The Pi Hello runs, and the modules it hands every extension (bundle.ts keeps them out of bundles). */
export const PI_VERSION = '0.87.1';
const TYPEBOX_VERSION = '1.3.27';
export const PI_PROVIDED: Readonly<Record<string, string>> = Object.fromEntries([
  ...['pi-coding-agent', 'pi-agent-core', 'pi-ai', 'pi-tui'].flatMap(name => [[`@earendil-works/${name}`, PI_VERSION], [`@mariozechner/${name}`, PI_VERSION]]),
  ['typebox', TYPEBOX_VERSION], ['@sinclair/typebox', TYPEBOX_VERSION],
]);
export const PI_INSTALL_TIMEOUT_MS = 5 * 60_000;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

export interface PiVerified {
  name: string;
  version: string;
  /** What the lockfile must say the installed tarball was. */
  integrity: string;
  manifest: Record<string, unknown>;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** One version of a package from npm — `latest` or an exact one — accepted only as a Pi package the registry serves. */
export async function verifyPiPackage(http: MarketHttp, name: string, version: string, signal: AbortSignal): Promise<PiVerified> {
  if (!safePackageName(name)) throw new MarketInstallError('verification-failed', 'That is not an npm package name.');
  if (version !== 'latest' && !stableExactVersion(version)) throw new MarketInstallError('verification-failed', 'That is not an exact version.');
  let response: { value: unknown; finalUrl: string };
  try {
    response = await http.getJson(`${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(name).replace('%40', '@')}/${version}`, signal, { allowedOrigin: NPM_REGISTRY_ORIGIN });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new MarketInstallError('verification-failed', `npm did not answer for ${name}. Try again in a minute.`);
  }
  const manifest = record(response.value);
  if (new URL(response.finalUrl).origin !== NPM_REGISTRY_ORIGIN || manifest.name !== name || !stableExactVersion(manifest.version) || (version !== 'latest' && manifest.version !== version))
    throw new MarketInstallError('verification-failed', 'npm’s answer did not match the package that was asked for.');
  const keywords = Array.isArray(manifest.keywords) ? manifest.keywords : [];
  if (!keywords.includes('pi-package') && !(manifest.pi && typeof manifest.pi === 'object'))
    throw new MarketInstallError('verification-failed', `${name} is not a Pi package: it has no "pi-package" keyword and no "pi" section.`);
  const dist = record(manifest.dist);
  const integrity = typeof dist.integrity === 'string' ? dist.integrity : '';
  let tarball: URL | undefined;
  try { tarball = new URL(String(dist.tarball)); } catch { tarball = undefined; }
  if (!INTEGRITY.test(integrity) || tarball?.origin !== NPM_REGISTRY_ORIGIN)
    throw new MarketInstallError('verification-failed', 'npm does not vouch for this package’s archive (no registry tarball with a sha512 integrity).');
  return { name, version: manifest.version as string, integrity, manifest };
}

/** Whether Hello can run it: its Pi ranges, Node, platform and size. Warnings do not stop an install. */
export function piCompatibility(manifest: Record<string, unknown>): { ok: boolean; reason?: string; warnings: string[] } {
  const warnings: string[] = [];
  const ranges: Array<[string, string]> = [];
  for (const field of ['peerDependencies', 'dependencies'] as const)
    for (const [name, range] of Object.entries(record(manifest[field])))
      if (PI_PROVIDED[name] && typeof range === 'string') ranges.push([name, range]);
  for (const [name, range] of ranges) {
    if (!validRange(range)) continue;
    const provided = PI_PROVIDED[name];
    const lowest = minVersion(range);
    if (lowest && gt(lowest.version, provided)) return { ok: false, reason: `Needs ${name} ${range}; Hello runs ${provided}.`, warnings };
    if (!satisfies(provided, range, { includePrerelease: true })) warnings.push(`Made for ${name} ${range}; Hello runs ${provided}. It may still work.`);
    if (name.startsWith('@mariozechner/')) warnings.push(`Uses Pi’s old name ${name}; Hello maps it to ${name.replace('@mariozechner/', '@earendil-works/')}.`);
  }
  const engines = record(manifest.engines);
  if (typeof engines.node === 'string' && validRange(engines.node) && !satisfies(process.versions.node, engines.node))
    return { ok: false, reason: `Needs Node ${engines.node}; Hello runs Node ${process.versions.node}.`, warnings };
  // npm's rule: `!name` excludes; a list of names allows only those.
  const excluded = (list: unknown, value: string) => {
    const words = Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
    const allowed = words.filter(word => !word.startsWith('!'));
    return words.includes(`!${value}`) || (allowed.length > 0 && !allowed.includes(value));
  };
  if (excluded(manifest.os, process.platform)) return { ok: false, reason: `Does not run on ${process.platform}.`, warnings };
  if (excluded(manifest.cpu, process.arch)) return { ok: false, reason: `Does not run on ${process.arch}.`, warnings };
  const dist = record(manifest.dist);
  if (typeof dist.unpackedSize === 'number' && dist.unpackedSize > INSTALLED_LIMITS.totalBytes)
    return { ok: false, reason: `It is ${Math.round(dist.unpackedSize / 1024 / 1024)} MB; Hello installs packages up to ${INSTALLED_LIMITS.totalBytes / 1024 / 1024} MB.`, warnings };
  if (typeof dist.fileCount === 'number' && dist.fileCount > INSTALLED_LIMITS.files)
    return { ok: false, reason: `It has ${dist.fileCount} files; Hello installs packages of up to ${INSTALLED_LIMITS.files}.`, warnings };
  const pi = manifest.pi && typeof manifest.pi === 'object' ? record(manifest.pi) : undefined;
  if (pi && !['extensions', 'skills', 'prompts'].some(key => Array.isArray(pi[key]) && (pi[key] as unknown[]).length))
    return { ok: false, reason: 'It brings only what Hello does not use (themes or gallery media): no extensions, skills or prompt templates.', warnings };
  const scripts = record(manifest.scripts);
  const hooks = ['preinstall', 'install', 'postinstall'].filter(name => typeof scripts[name] === 'string');
  if (hooks.length) warnings.push(`Its ${hooks.join(' and ')} script${hooks.length > 1 ? 's' : ''} will not run: Hello installs without scripts. Anything that needs them will not work.`);
  if (typeof manifest.deprecated === 'string') warnings.push(`npm marks this version deprecated: ${manifest.deprecated.slice(0, 200)}`);
  return { ok: true, warnings };
}

/** What the package brings to Hello, read from its manifest, in the person's words. */
export function readPiForHello(manifest: Record<string, unknown>, warnings: string[] = []): HelloReading {
  const pi = manifest.pi && typeof manifest.pi === 'object' ? record(manifest.pi) : undefined;
  const has = (key: string) => Boolean(pi && Array.isArray(pi[key]) && (pi[key] as unknown[]).length);
  const dependencies = Object.keys(record(manifest.dependencies)).filter(name => !PI_PROVIDED[name]);
  const extensions = pi ? has('extensions') : true;
  const skills = pi ? has('skills') : false;
  const lines = [
    ...(pi ? [] : ['It declares no "pi" section: Hello reads its extensions/, skills/ and prompts/ folders when it is installed.']),
    ...(extensions ? ['Extension code runs inside the Pi process of each chat you turn it on for, with your user permissions and that chat’s model key. It is not sandboxed.'] : []),
    ...(skills ? ['Skills: instructions the model loads in chats you turn it on for.'] : []),
    ...(has('prompts') ? ['Prompt templates, typed as /name in those chats.'] : []),
    ...(dependencies.length ? [`${dependencies.length} npm ${dependencies.length === 1 ? 'dependency is' : 'dependencies are'} installed with it, without scripts.`] : []),
    'Added to Hello’s library and off in every chat until you turn it on there.',
    'Pi’s terminal interface is not part of Hello: dialogs it opens are declined, and its overlays and key bindings do not appear.',
    ...(has('themes') ? ['Its themes are not used: Hello draws its own interface.'] : []),
    ...warnings,
  ];
  return { ui: false, skills, mcp: false, lines };
}

/** A version newer than the one installed, or undefined. */
export function newerVersion(installed: string, latest: unknown): string | undefined {
  return typeof latest === 'string' && valid(latest) && valid(installed) && gt(latest, installed) ? latest : undefined;
}

/**
 * The package installed by pnpm into a project of its own, ready to become
 * its library folder. Only the requested version skips pnpm's one-day wait
 * for new releases; its dependencies still wait it out.
 */
export async function stagePiPackage(options: {
  pnpm: PnpmInvocation;
  stagingDir: string;
  verified: PiVerified;
  signal: AbortSignal;
  log(line: string): void;
}): Promise<{ project: string; dispose(): Promise<void> }> {
  const { name, version, integrity } = options.verified;
  const project = join(options.stagingDir, randomUUID());
  const dispose = () => rm(project, { recursive: true, force: true });
  try {
    await mkdir(project, { recursive: true, mode: 0o700 });
    await writeFile(join(project, 'package.json'), `${JSON.stringify({ name: 'hello-pi-package', private: true }, null, 2)}\n`, { mode: 0o600 });
    // Its own workspace file: pnpm looks no further up for one, and these are the settings.
    await writeFile(join(project, 'pnpm-workspace.yaml'), stringifyYaml({
      packages: ['.'],
      nodeLinker: 'hoisted',
      packageImportMethod: 'copy',
      autoInstallPeers: false,
      strictPeerDependencies: false,
      strictDepBuilds: false,
      managePackageManagerVersions: false,
      blockExoticSubdeps: true,
      minimumReleaseAgeExclude: [`${name}@${version}`],
    }), { mode: 0o600 });
    // The person's .npmrc — a token, another registry — is not this install's business.
    await writeFile(join(project, '.npmrc-hello'), '', { mode: 0o600 });
    const args = ['add', `${name}@${version}`, '--save-exact', '--prod', '--ignore-scripts', `--config.registry=${NPM_REGISTRY_ORIGIN}/`];
    options.log(`Pi market: pnpm ${args.join(' ')}`);
    const run = await runPnpm(options.pnpm, args, {
      cwd: project,
      env: { npm_config_userconfig: join(project, '.npmrc-hello') },
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(PI_INSTALL_TIMEOUT_MS)]),
      onLine: line => options.log(`pnpm: ${line}`),
    });
    if (run.code !== 0) {
      const output = pnpmFailure(run.output);
      const full = outOfSpace(run.output, options.stagingDir, output);
      if (full) throw full;
      if (/NO_MATURE_MATCHING_VERSION/.test(run.output))
        throw new MarketInstallError('install-failed', `A dependency of ${name} was published less than a day ago; pnpm waits a day before installing new releases. Try again tomorrow.`, output);
      throw new MarketInstallError('install-failed', `pnpm could not install ${name}.`, output);
    }
    // What was installed is what the preview showed.
    let locked: unknown;
    try {
      const lockfile = record(parseYaml(await readFile(join(project, 'pnpm-lock.yaml'), 'utf8')));
      locked = record(record(record(lockfile.packages)[`${name}@${version}`]).resolution).integrity;
    } catch { locked = undefined; }
    if (locked !== integrity) throw new MarketInstallError('verification-failed', `The archive pnpm installed for ${name} is not the one npm vouched for.`);
    const directory = join(project, 'node_modules', ...name.split('/'));
    const info = await lstat(directory);
    const inside = (await realpath(directory)).startsWith(`${await realpath(project)}${sep}`);
    const manifest = record(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')));
    if (!info.isDirectory() || !inside || manifest.name !== name || manifest.version !== version)
      throw new MarketInstallError('verification-failed', `pnpm did not leave ${name}@${version} where Hello expected it.`);
    return { project, dispose };
  } catch (error) {
    await dispose();
    throw outOfSpace(error, options.stagingDir) ?? error;
  }
}
