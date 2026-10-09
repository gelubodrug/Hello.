import { prerelease, valid } from 'semver';

export const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
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

export interface HelloReading {
  /** Whether the package contributes interface parts. */
  ui: boolean;
  skills: boolean;
  mcp: boolean;
  lines: string[];
}

export interface InstalledPlugin {
  packageName: string;
  version: string;
  /** plugin: installed from the market; other kinds: imported into Hello. */
  kind: 'plugin' | 'hello' | 'product';
  bundle: boolean;
  /** npm's newest stable version, when it is newer than the one installed. */
  latest?: string;
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
