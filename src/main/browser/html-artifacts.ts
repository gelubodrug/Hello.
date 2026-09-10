import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const MAX_HTML_ARTIFACT_BYTES = 512 * 1024;
export interface HtmlArtifact { id: string; folder: string; path: string }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

/** Private, persistent output files. These paths never constitute a workspace grant. */
export class HtmlArtifacts {
  private dataRoot?: Promise<string>;
  private generations = new Map<string, number>();
  private pending = new Map<string, Promise<void>>();

  constructor(private readonly dataDir: string) {
    if (!dataDir || !isAbsolute(dataDir)) throw new Error('HTML artifacts require an absolute app data directory.');
  }

  create(conversationId: string, html: string, signal?: AbortSignal): Promise<HtmlArtifact> {
    const key = this.key(conversationId);
    const generation = this.generations.get(key) ?? 0;
    if (typeof html !== 'string' || !html.trim()) return Promise.reject(new Error('Provide nonempty HTML content.'));
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_ARTIFACT_BYTES)
      return Promise.reject(new Error('HTML content exceeds the 512 KiB limit.'));
    return this.queue(key, async () => {
      const current = () => this.current(key, generation, signal);
      current();
      const parent = await this.conversationFolder(key, true);
      current();
      const id = randomUUID();
      const folder = join(parent, id);
      const path = join(folder, 'index.html');
      // No recursive mkdir or overwrite at the artifact boundary: an existing ID
      // (including a symlink) fails instead of reusing another output directory.
      await mkdir(folder, { mode: 0o700 });
      try {
        current();
        await this.directory(folder);
        await this.conversationFolder(key, false);
        const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          current();
          const opened = await handle.stat();
          const existing = await lstat(path);
          if (!opened.isFile() || opened.nlink !== 1 || !existing.isFile() ||
              opened.dev !== existing.dev || opened.ino !== existing.ino || await realpath(path) !== path)
            throw new Error('The HTML artifact path changed while creating it.');
          await handle.writeFile(html, { encoding: 'utf8', signal });
          await handle.sync();
        } finally { await handle.close(); }
        await this.validate(key, id);
        current();
        return { id, folder, path };
      } catch (error) {
        // Only this invocation's exclusively created directory is eligible for
        // cleanup, and never through a replaced app/conversation directory.
        await this.cleanup(key, folder).catch(() => {});
        throw error;
      }
    });
  }

  get(conversationId: string, id: string): Promise<HtmlArtifact> {
    const key = this.key(conversationId);
    if (!UUID.test(id)) return Promise.reject(new Error('Invalid HTML artifact ID.'));
    const generation = this.generations.get(key) ?? 0;
    return this.queue(key, async () => {
      this.current(key, generation);
      const artifact = await this.validate(key, id);
      this.current(key, generation);
      return artifact;
    });
  }

  removeConversation(conversationId: string): Promise<void> {
    const key = this.key(conversationId);
    // Invalidate immediately, before waiting for an in-flight file write. That
    // write must clean up and reject rather than publish an output after delete.
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    return this.queue(key, async () => {
      let folder: string;
      try { folder = await this.conversationFolder(key, false); }
      catch (error) { if (missing(error)) return; throw error; }
      await rm(folder, { recursive: true, force: true });
    });
  }

  private key(conversationId: string): string {
    if (typeof conversationId !== 'string' || !conversationId.trim()) throw new Error('A conversation is required for HTML artifacts.');
    return createHash('sha256').update(conversationId).digest('hex');
  }

  private current(key: string, generation: number, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (generation !== (this.generations.get(key) ?? 0)) throw new Error('This conversation’s HTML artifacts were deleted.');
  }

  private queue<T>(key: string, work: () => Promise<T>): Promise<T> {
    const result = (this.pending.get(key) ?? Promise.resolve()).then(work);
    const settled = result.then(() => {}, () => {});
    this.pending.set(key, settled);
    void settled.then(() => { if (this.pending.get(key) === settled) this.pending.delete(key); });
    return result;
  }

  private root(): Promise<string> {
    if (!this.dataRoot) {
      this.dataRoot = (async () => {
        await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
        const canonical = await realpath(this.dataDir);
        await this.directory(canonical);
        return canonical;
      })();
    }
    return this.dataRoot;
  }

  private async directory(path: string, create = false): Promise<void> {
    if (create) {
      try { await mkdir(path, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path))
      throw new Error('The HTML artifact directory is not a contained regular directory.');
  }

  private async conversationFolder(key: string, create: boolean): Promise<string> {
    const root = await this.root();
    if (await realpath(this.dataDir) !== root) throw new Error('The app data directory changed.');
    await this.directory(root);
    const artifacts = join(root, 'artifacts');
    await this.directory(artifacts, create);
    const folder = join(artifacts, key);
    await this.directory(folder, create);
    return folder;
  }

  private async validate(key: string, id: string): Promise<HtmlArtifact> {
    const folder = join(await this.conversationFolder(key, false), id);
    await this.directory(folder);
    const path = join(folder, 'index.html');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      const existing = await lstat(path);
      if (!opened.isFile() || opened.nlink !== 1 || !existing.isFile() || opened.size === 0 ||
          opened.size > MAX_HTML_ARTIFACT_BYTES || opened.dev !== existing.dev || opened.ino !== existing.ino ||
          await realpath(path) !== path)
        throw new Error('The HTML artifact is not a contained regular HTML file.');
      await this.conversationFolder(key, false);
      await this.directory(folder);
      return { id, folder, path };
    } finally { await handle.close(); }
  }

  private async cleanup(key: string, folder: string): Promise<void> {
    const parent = await this.conversationFolder(key, false);
    if (dirname(folder) !== parent || !UUID.test(basename(folder)))
      throw new Error('Invalid HTML artifact cleanup path.');
    // rm removes a final symlink itself; it never follows it to another folder.
    await rm(folder, { recursive: true, force: true });
  }
}
