import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DshLayout } from './layout';

/**
 * Restore points for the DSH profile.
 *
 * A profile is three files — the package list, its lockfile and the patch
 * layer — and a plugin that breaks the surface breaks it through them. A
 * point is taken after every start that booted a profile different from the
 * last point ("healthy"), and before every change Hello makes to it
 * ("before"). Restoring writes the three files back; main then reinstalls.
 */
export type CheckpointKind = 'healthy' | 'before';

export interface Checkpoint {
  id: string;
  kind: CheckpointKind;
  at: number;
  /** What the point was taken for, in words the person reads. */
  label: string;
  fingerprint: string;
}

export const PROFILE_FILES = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'] as const;
const KEEP: Record<CheckpointKind, number> = { healthy: 3, before: 5 };

export function profileFingerprint(layout: DshLayout): string {
  const hash = createHash('sha256');
  for (const name of PROFILE_FILES) {
    const path = join(layout.profile, name);
    hash.update(`${name}\0`);
    if (existsSync(path)) hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

export function listCheckpoints(layout: DshLayout): Checkpoint[] {
  if (!existsSync(layout.checkpoints)) return [];
  const points: Checkpoint[] = [];
  for (const id of readdirSync(layout.checkpoints)) {
    try {
      const meta = JSON.parse(readFileSync(join(layout.checkpoints, id, 'checkpoint.json'), 'utf8')) as Checkpoint;
      if (meta.id === id) points.push(meta);
    } catch { /* an unreadable point is not offered */ }
  }
  return points.sort((a, b) => b.at - a.at);
}

/** Takes a point of the profile as it is now. Returns undefined when there is no profile yet. */
export function saveCheckpoint(layout: DshLayout, kind: CheckpointKind, label: string, now = Date.now()): Checkpoint | undefined {
  if (!existsSync(join(layout.profile, 'package.json'))) return undefined;
  const fingerprint = profileFingerprint(layout);
  if (kind === 'healthy' && listCheckpoints(layout).some(point => point.kind === 'healthy' && point.fingerprint === fingerprint)) return undefined;
  const id = `${now.toString(36)}-${randomUUID().slice(0, 8)}`;
  const folder = join(layout.checkpoints, id);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  for (const name of PROFILE_FILES) {
    const source = join(layout.profile, name);
    if (existsSync(source)) copyFileSync(source, join(folder, name));
  }
  const point: Checkpoint = { id, kind, at: now, label, fingerprint };
  writeFileSync(join(folder, 'checkpoint.json'), `${JSON.stringify(point, null, 2)}\n`);
  prune(layout);
  return point;
}

function prune(layout: DshLayout): void {
  for (const kind of Object.keys(KEEP) as CheckpointKind[]) {
    const points = listCheckpoints(layout).filter(point => point.kind === kind);
    for (const stale of points.slice(KEEP[kind])) rmSync(join(layout.checkpoints, stale.id), { recursive: true, force: true });
  }
}

/** Writes a point's files back over the profile. A file the point did not have is removed. */
export function restoreCheckpoint(layout: DshLayout, id: string): Checkpoint {
  const point = listCheckpoints(layout).find(item => item.id === id);
  if (!point) throw new Error('That restore point no longer exists.');
  const folder = join(layout.checkpoints, point.id);
  for (const name of PROFILE_FILES) {
    const saved = join(folder, name);
    const target = join(layout.profile, name);
    if (existsSync(saved)) copyFileSync(saved, target);
    else rmSync(target, { force: true });
  }
  return point;
}
