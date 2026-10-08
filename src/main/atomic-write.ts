import { closeSync, fsyncSync, lstatSync, openSync, readlinkSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { open, unlink, rename, type FileHandle } from 'node:fs/promises';

/** Resolve even dangling final links; never replace the link itself. */
export function atomicWriteTarget(file: string, symlinks: 'resolve' | 'refuse' = 'resolve', depth = 0): string {
  if (depth > 40) throw new Error('Too many symbolic links in write path.');
  const absolute = resolve(file);
  const root = parse(absolute).root;
  let current = root;
  const parts = absolute.slice(root.length).split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return join(current, ...parts.slice(i + 1)); throw error; }
    if (stat.isSymbolicLink()) {
      if (symlinks === 'refuse') throw new Error('Symbolic links are not allowed in this write path.');
      return atomicWriteTarget(join(resolve(dirname(current), readlinkSync(current)), ...parts.slice(i + 1)), symlinks, depth + 1);
    }
  }
  return current;
}

/** Same-directory, exclusive temporary file; cleanup also covers failed writes/renames.
 * Like our file reader, this is not a sandbox against concurrent parent-directory swaps.
 */
export function atomicWriteFileSync(file: string, data: string | Uint8Array, options: { mode?: number; symlinks?: 'resolve' | 'refuse' } = {}): void {
  const target = atomicWriteTarget(file, options.symlinks);
  const temporary = join(dirname(target), `.${basename(target)}-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', options.mode ?? 0o600);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (atomicWriteTarget(file, options.symlinks) !== target) throw new Error('Write path changed while saving.');
    renameSync(temporary, target);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

/** Streaming variant: large model downloads never collect in main's memory. */
export async function atomicWriteFile(file: string, write: (handle: FileHandle) => Promise<void>, options: { mode?: number; symlinks?: 'resolve' | 'refuse' } = {}): Promise<void> {
  const target = atomicWriteTarget(file, options.symlinks);
  const temporary = join(dirname(target), `.${basename(target)}-${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, 'wx', options.mode ?? 0o600);
    await write(handle);
    await handle.sync(); await handle.close(); handle = undefined;
    if (atomicWriteTarget(file, options.symlinks) !== target) throw new Error('Write path changed while saving.');
    await rename(temporary, target);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
