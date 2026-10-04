import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dshLayout } from './layout';
import { installedPlugins } from '../market/install';

/**
 * The skill folders the DSH plugins the person installed brought with them
 * (`<package>/skills/<name>/SKILL.md`, the layout dsh's filesystem skill
 * provider reads). Hello offers them in its own discovery — the Extensions
 * menu's "Found on this Mac" — where adopting one copies it into Hello's
 * library like any other skill found on the Mac.
 */
export function dshSkillRoots(dataDir: string): Array<{ label: string; path: string }> {
  const layout = dshLayout(dataDir, '');
  const roots: Array<{ label: string; path: string }> = [];
  try {
    for (const plugin of installedPlugins(layout)) {
      if (plugin.kind !== 'plugin') continue;
      const path = join(layout.profile, 'node_modules', plugin.packageName, 'skills');
      if (existsSync(path)) roots.push({ label: `DSH plugin · ${plugin.packageName}`, path });
    }
  } catch { /* no profile yet: nothing to offer */ }
  return roots;
}
