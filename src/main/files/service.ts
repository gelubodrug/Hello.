import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ContentMatch, ContentSearch, FileDocument, FileEntry, FileListing } from '../../shared/files';
import { foldForSearch, originalSearchRange } from '../../shared/search-text';

const MAX_ENTRIES = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const SEARCH_SKIP = new Set(['.git', 'node_modules', '.next', '.venv', 'venv', 'dist', 'out', 'build', 'coverage']);
/** How far a search of the contents goes (audit A3b): starting limits, not measurements. */
export const CONTENT_SEARCH_LIMITS = { results: 200, entries: MAX_ENTRIES, depth: 24, bytes: 20 * 1024 * 1024, ms: 4000, fileBytes: MAX_BYTES, fileLines: 20_000 } as const;
/** A line longer than this is shown as a piece around its match. */
const SNIPPET = 160;
const inside = (root: string, target: string) => { const path = relative(root, target); return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)); };
const portable = (path: string) => path.split(sep).join('/');

/** No renderer-supplied root, arbitrary filesystem IPC, writes or agent tool. */
export class WorkspaceFiles {
  /** One search of the contents at a time per chat: a newer one stops the older. */
  private searches = new Map<string, { requestId: string; controller: AbortController }>();
  constructor(private folder: (conversationId: string) => string | null) {}

  /** Stops the chat's search of the contents, if one runs (Files hidden, folder changed). */
  cancelSearch(conversationId: string): void {
    this.searches.get(conversationId)?.controller.abort();
    this.searches.delete(conversationId);
  }

  /**
   * The lines of the chat's folder that hold the words, literally (audit A3b):
   * regular UTF-8 text files within the limits, read once each and kept
   * nowhere; links are not followed, and dependency, build and .git folders
   * are passed over. It stops at a limit with what it has, and says which.
   */
  async searchContents(conversationId: string, requestId: string, query: string, matchCase = false): Promise<ContentSearch> {
    this.cancelSearch(conversationId);
    const controller = new AbortController();
    this.searches.set(conversationId, { requestId, controller });
    const result: ContentSearch = { requestId, matches: [], limited: false, reasons: [], filesScanned: 0, bytesScanned: 0, skipped: 0 };
    const stop = (reason: ContentSearch['reasons'][number]) => { result.limited = true; if (!result.reasons.includes(reason)) result.reasons.push(reason); };
    const needle = foldForSearch(query, matchCase).folded;
    try {
      if (!needle) return result;
      const target = await this.target(conversationId, '');
      const deadline = Date.now() + CONTENT_SEARCH_LIMITS.ms;
      const pending = [{ absolute: target.absolute, depth: 0 }];
      let visited = 0;
      // A stopped search ends where it is; nobody reads what it found.
      for (let index = 0; index < pending.length && !result.limited && !controller.signal.aborted; index++) {
        const directory = pending[index];
        try {
          // A folder swapped for a link while the search ran is not followed.
          if ((await realpath(directory.absolute)) !== directory.absolute || !inside(target.root, directory.absolute)) { result.skipped++; continue; }
          const stream = await opendir(directory.absolute);
          for await (const entry of stream) {
            if (controller.signal.aborted) break;
            if (++visited > CONTENT_SEARCH_LIMITS.entries) { stop('entries'); break; }
            if (Date.now() > deadline) { stop('time'); break; }
            const absolute = resolve(directory.absolute, entry.name);
            if (entry.isDirectory()) {
              if (SEARCH_SKIP.has(entry.name) || directory.depth >= CONTENT_SEARCH_LIMITS.depth) result.skipped++;
              else pending.push({ absolute, depth: directory.depth + 1 });
              continue;
            }
            if (!entry.isFile()) { result.skipped++; continue; }
            const text = await this.searchable(absolute, result, stop);
            if (text === null) continue;
            result.filesScanned++;
            const path = portable(relative(target.root, absolute));
            const lines = text.split(/\r?\n/);
            for (let at = 0; at < lines.length; at++) {
              if (controller.signal.aborted) break;
              if (Date.now() > deadline) { stop('time'); break; }
              const line = lines[at];
              const { folded, map } = foldForSearch(line, matchCase);
              const found = folded.indexOf(needle);
              if (found < 0) continue;
              if (result.matches.length >= CONTENT_SEARCH_LIMITS.results) { stop('results'); break; }
              const original = originalSearchRange(line, map, found, needle.length);
              result.matches.push(snippetOf(path, at + 1, line, original.start, original.end - original.start));
            }
            if (result.limited) break;
          }
        } catch (error) { if (!index) throw error; result.skipped++; }
      }
      return result;
    } finally {
      if (this.searches.get(conversationId)?.controller === controller) this.searches.delete(conversationId);
    }
  }

  /** A file's text when it is a regular UTF-8 file within the limits; null, and counted as passed over, when not. */
  private async searchable(absolute: string, result: ContentSearch, stop: (reason: ContentSearch['reasons'][number]) => void): Promise<string | null> {
    let handle;
    try { handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch { result.skipped++; return null; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > CONTENT_SEARCH_LIMITS.fileBytes) { result.skipped++; return null; }
      if (result.bytesScanned + stat.size > CONTENT_SEARCH_LIMITS.bytes) { stop('bytes'); return null; }
      const buffer = Buffer.alloc(Math.min(stat.size, CONTENT_SEARCH_LIMITS.fileBytes) + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      result.bytesScanned += length;
      if (length > CONTENT_SEARCH_LIMITS.fileBytes) { result.skipped++; return null; }
      const bytes = buffer.subarray(0, length);
      if (bytes.includes(0)) { result.skipped++; return null; }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.split('\n', CONTENT_SEARCH_LIMITS.fileLines + 2).length > CONTENT_SEARCH_LIMITS.fileLines) { result.skipped++; return null; }
      return text;
    } catch { result.skipped++; return null; }
    finally { await handle.close(); }
  }

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

/** A line, or the piece of it around the match, with the match's place in what is shown. */
function snippetOf(path: string, line: number, text: string, found: number, length: number): ContentMatch {
  if (text.length <= SNIPPET) return { path, line, snippet: text, start: found, end: found + length };
  let from = Math.max(0, Math.min(found - 60, text.length - SNIPPET));
  let to = from + SNIPPET;
  // A character written as two code units stays whole at either edge.
  if (from > 0 && /[\uDC00-\uDFFF]/.test(text[from])) from--;
  if (to < text.length && /[\uD800-\uDBFF]/.test(text[to - 1])) to++;
  const lead = from > 0 ? '…' : '';
  const start = found - from + lead.length;
  return { path, line, snippet: `${lead}${text.slice(from, to)}${to < text.length ? '…' : ''}`, start, end: start + Math.min(length, to - found) };
}
