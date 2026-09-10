import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { WorkspaceFiles } from './service';

/** Resolve Files-pane drag data against its conversation, never a supplied root. */
export async function resolveDropPaths(folder: string | null, paths: unknown): Promise<string[]> {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 16) {
    throw new Error('Drop between 1 and 16 files or folders.');
  }
  if (paths.some(path => typeof path !== 'string' || !path || path.length > 8192 ||
    isAbsolute(path) || /^[a-z][a-z0-9+.-]*:/i.test(path) || /[\u0000-\u001f\u007f-\u009f]/.test(path))) {
    throw new Error('Invalid file drag path. Drag the item from Files again.');
  }
  const files = new WorkspaceFiles(() => folder);
  const result: string[] = [];
  for (const path of paths as string[]) {
    const target = await files.target('drop', path);
    const info = await stat(target.absolute);
    if (!info.isFile() && !info.isDirectory()) throw new Error('Only regular files and folders can be dropped.');
    if (!result.includes(target.absolute)) result.push(target.absolute);
  }
  return result;
}
