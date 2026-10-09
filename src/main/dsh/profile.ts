import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../atomic-write';
import type { DshLayout } from './layout';

/** One-time compatibility cleanup: the removed Hello theme must not break an
 * existing profile's boot. New profiles are created by DSH's web template.
 * User bundles, settings and dependencies are otherwise left to DSH. */
export function removeLegacyTheme(layout: DshLayout): void {
  const file = join(layout.profile, 'package.json');
  if (!existsSync(file)) return;
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as {
    dependencies?: Record<string, string>;
    dsh?: { profile?: { bundles?: string[] } };
  };
  const before = JSON.stringify(manifest);
  if (manifest.dependencies) delete manifest.dependencies['hello-dsh'];
  const profile = manifest.dsh?.profile;
  if (Array.isArray(profile?.bundles)) profile.bundles = profile.bundles.filter(name => name !== 'hello-dsh');
  if (JSON.stringify(manifest) !== before) atomicWriteFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}
