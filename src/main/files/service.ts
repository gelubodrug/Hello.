import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { FileDocument, FileEntry, FileListing } from '../../shared/files';

const MAX_ENTRIES = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const SEARCH_SKIP = new Set(['.git', 'node_modules', '.next', '.venv', 'venv', 'dist', 'out', 'build', 'coverage']);
const inside = (root: string, target: string) => { const path = relative(root, target); return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)); };
const portable = (path: string) => path.split(sep).join('/');

/** No renderer-supplied root, arbitrary filesystem IPC, writes or agent tool. */
export class WorkspaceFiles {
  constructor(private folder: (conversationId: string) => string | null) {}

  async target(conversationId: string, path: string) {
    const folder = this.folder(conversationId);
    if (!folder) throw new Error('Choose a folder for this conversation to browse its files.');
    if (typeof path !== 'string' || path.length > 8192 || /[\u0000-\u001f]/.test(path)) throw new Error('Invalid file path.');
    const root = await realpath(folder);
    const lexical = resolve(folder, path);
    if (!inside(resolve(folder), lexical) && !inside(root, lexical)) throw new Error('This file is outside this conversation’s folder.');
    const absolute = await realpath(lexical);
    if (!inside(root, absolute)) throw new Error('This link points outside this conversation’s folder.');
    return { root, absolute, path: portable(relative(root, absolute)) };
  }

  async list(id: string, path = '', search = ''): Promise<FileListing> {
    const target = await this.target(id, path);
    if (!(await lstat(target.absolute)).isDirectory()) throw new Error('This path is not a folder.');
    const query = search.trim().toLocaleLowerCase();
    const result: FileListing = { root: target.root, entries: [], limited: false, skipped: 0 };
    const entries = new Map<string, FileEntry>();
    const pending = [{ absolute: target.absolute, path: target.path, depth: 0 }];
    const deadline = Date.now() + 4000;
    let visited = 0;
    for (let index = 0; index < pending.length; index++) {
      if (Date.now() > deadline) { result.limited = true; break; }
      const directory = pending[index];
      // Revalidate directories when dequeued; don't follow links swapped in during traversal.
      try {
        if ((await realpath(directory.absolute)) !== directory.absolute) { result.skipped++; continue; }
        const stream = await opendir(directory.absolute);
        for await (const entry of stream) {
          if (++visited > MAX_ENTRIES || Date.now() > deadline) { result.limited = true; break; }
          const entryPath = portable(relative(target.root, resolve(directory.absolute, entry.name)));
          const kind = entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'link' : entry.isFile() ? 'file' : null;
          if (!kind) continue;
          const item: FileEntry = { path: entryPath, name: entry.name, kind };
          if (!query || entryPath.toLocaleLowerCase().includes(query)) {
            entries.set(entryPath, item);
            // Include ancestors so filtered results retain a real hierarchy.
            const parts = entryPath.split('/');
            while (query && parts.length > 1) {
              parts.pop(); const ancestor = parts.join('/');
              if (!entries.has(ancestor)) entries.set(ancestor, { path: ancestor, name: parts.at(-1)!, kind: 'directory' });
            }
          }
          if (query && kind === 'directory') {
            if (SEARCH_SKIP.has(entry.name) || directory.depth >= 24) result.skipped++;
            else pending.push({ absolute: resolve(directory.absolute, entry.name), path: entryPath, depth: directory.depth + 1 });
          }
        }
      } catch (error) { if (!index) throw error; result.skipped++; }
      if (result.limited || !query) break;
    }
    result.entries = [...entries.values()].sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, undefined, { numeric: true }));
    return result;
  }

  async read(id: string, path: string): Promise<FileDocument> {
    const target = await this.target(id, path);
    const handle = await open(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Select a regular file to preview.');
      const document: FileDocument = { path: target.path, absolutePath: target.absolute, name: basename(target.absolute), size: stat.size, modifiedAt: stat.mtimeMs, content: null };
      if (stat.size > MAX_BYTES) return { ...document, reason: 'This file is larger than 2 MB. Open it in its default app or show it in Finder.' };
      // Bounded even if another process grows the file after stat.
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > MAX_BYTES) return { ...document, reason: 'This file grew beyond the 2 MB preview limit. Refresh or open it externally.' };
      const bytes = buffer.subarray(0, length);
      try {
        if (bytes.includes(0)) throw new Error('Binary file');
        document.content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (document.content.split('\n', 20_002).length > 20_000) {
          document.content = null;
          document.reason = 'This file has more than 20,000 lines. Open it in its default app to keep the viewer responsive.';
        }
      } catch { document.reason = 'Preview supports UTF-8 text and Markdown. Open this file in its default app or show it in Finder.'; }
      return document;
    } finally { await handle.close(); }
  }
}
