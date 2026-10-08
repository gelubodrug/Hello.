import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, statfs } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteFile, atomicWriteFileSync, atomicWriteTarget } from '../atomic-write';
import type { VoiceArtifact } from './manifest';
import { voiceCommand } from './process';

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
export async function fileDigest(file: string, signal: AbortSignal): Promise<string> {
  atomicWriteTarget(file, 'refuse');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('A Voice component is not a regular file.');
    const hash = createHash('sha256'); const buffer = Buffer.alloc(1024 * 1024);
    for (;;) { signal.throwIfAborted(); const { bytesRead } = await handle.read(buffer); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
    return hash.digest('hex');
  } finally { await handle.close(); }
}
export function archivePath(name: string): boolean {
  return !!name && !isAbsolute(name) && !name.includes('\\') && !/[\x00-\x1f\x7f]/.test(name) && !name.split('/').includes('..');
}
function downloadURL(value: string): string {
  const url = new URL(value);
  const allowed = ['github.com', 'release-assets.githubusercontent.com', 'huggingface.co', 'cdn-lfs.huggingface.co', 'cdn-lfs-us-1.huggingface.co', 'cas-bridge.xethub.hf.co', 'us.aws.cdn.hf.co'];
  if (url.protocol !== 'https:' || url.username || url.password || !allowed.includes(url.hostname)) throw new Error('The Voice download redirected to an unapproved source.');
  return url.href;
}

export class VoiceModelStore {
  constructor(readonly root: string, private readonly fetcher: typeof fetch = fetch) {}
  async directory(path = this.root): Promise<string> {
    atomicWriteTarget(path, 'refuse'); await mkdir(path, { recursive: true, mode: 0o700 }); atomicWriteTarget(path, 'refuse'); return path;
  }
  path(asset: VoiceArtifact): string { return join(this.root, `${asset.sha256}-${asset.name}`); }
  async cached(asset: VoiceArtifact, signal: AbortSignal): Promise<boolean> {
    const file = this.path(asset); atomicWriteTarget(file, 'refuse');
    try { return (await lstat(file)).size === asset.bytes && await fileDigest(file, signal) === asset.sha256; }
    catch (error) { if (missing(error)) return false; throw error; }
  }
  async download(asset: VoiceArtifact, signal: AbortSignal, progress: (received: number, total: number) => void, allowDownload = true): Promise<string> {
    await this.directory();
    if (await this.cached(asset, signal)) { progress(asset.bytes, asset.bytes); return this.path(asset); }
    if (!allowDownload) throw new Error('A Voice component is missing or damaged. Click Install Voice in Settings to repair it.');
    const disk = await statfs(this.root);
    if (disk.bavail * disk.bsize < asset.bytes + 512 * 1024 * 1024) throw new Error('Not enough free space to install Voice. Free some disk space and try again.');
    const timeout = new AbortController();
    const combined = AbortSignal.any([signal, timeout.signal, AbortSignal.timeout(30 * 60_000)]);
    let idle: ReturnType<typeof setTimeout>;
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => timeout.abort(new Error('The Voice download stopped responding. Try again.')), 60_000); };
    touch();
    try {
      let url = downloadURL(asset.url); let response: Response | undefined;
      for (let redirects = 0; redirects < 6; redirects++) {
        response = await this.fetcher(url, { redirect: 'manual', signal: combined });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location) throw new Error('The Voice download location is missing.');
        url = downloadURL(new URL(location, url).href); response = undefined;
      }
      if (!response?.ok || !response.body) throw new Error(`The Voice download failed${response ? ` (HTTP ${response.status})` : ''}. Try again.`);
      const reader = response.body.getReader(); const hash = createHash('sha256'); let received = 0;
      progress(0, asset.bytes);
      try {
        await atomicWriteFile(this.path(asset), async handle => {
          for (;;) {
            combined.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break;
            touch(); received += chunk.value.byteLength;
            if (received > asset.bytes) throw new Error('The Voice download has an unexpected size.');
            hash.update(chunk.value); await handle.writeFile(chunk.value); progress(received, asset.bytes);
          }
          if (received !== asset.bytes || hash.digest('hex') !== asset.sha256) throw new Error('The Voice download did not pass its SHA-256 check. Try again.');
        }, { symlinks: 'refuse' });
      } finally { await reader.cancel().catch(() => {}); }
      return this.path(asset);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOSPC') throw new Error('The disk filled while installing Voice. Free space and try again.');
      throw error;
    } finally { clearTimeout(idle!); }
  }

  /** Extract only a hash-verified archive into a new private directory. Reject
   * links, devices and traversal before extraction; verify the resulting tree.
   */
  async unpack(asset: VoiceArtifact, signal: AbortSignal): Promise<string> {
    const target = join(this.root, `installed-${asset.sha256}`);
    atomicWriteTarget(target, 'refuse');
    try {
      const receiptPath = join(target, '.installed.json'); atomicWriteTarget(receiptPath, 'refuse');
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as { sha256: string; files: Array<{ path: string; digest: string }> };
      if (receipt.sha256 === asset.sha256 && Array.isArray(receipt.files) && receipt.files.length > 0 && receipt.files.length <= 10_000) {
        let valid = true;
        for (const file of receipt.files) {
          if (!archivePath(file.path) || await fileDigest(join(target, file.path), signal) !== file.digest) { valid = false; break; }
        }
        if (valid) return target;
      }
    } catch (error) { if (signal.aborted) throw error; /* interrupted/corrupt install is replaced from its checked cache */ }
    if (!await this.cached(asset, signal)) throw new Error('Download the Voice component before installing it.');
    const archive = this.path(asset);
    // macOS bsdtar reads both ZIP and tar.bz2; no external installer/toolchain.
    const listing = await voiceCommand('/usr/bin/tar', ['-tf', archive], { signal, cwd: this.root, capture: true });
    const names = listing.trim().split('\n');
    if (names.length > 10_000 || names.some(name => !archivePath(name))) throw new Error('The Voice archive contains an unsafe path.');
    const details = await voiceCommand('/usr/bin/tar', ['-tvf', archive], { signal, cwd: this.root, capture: true });
    if (details.trim().split('\n').some(line => !['-', 'd'].includes(line[0]))) throw new Error('Links and special files are not allowed in Voice archives.');
    const stage = await mkdtemp(join(this.root, '.install-'));
    try {
      await voiceCommand('/usr/bin/tar', ['--no-same-owner', '-xf', archive, '-C', stage], { signal, cwd: this.root });
      const files: Array<{ path: string; digest: string }> = []; let bytes = 0;
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          signal.throwIfAborted(); const path = join(dir, entry.name); atomicWriteTarget(path, 'refuse');
          if (entry.isDirectory()) await walk(path);
          else if (entry.isFile()) {
            bytes += (await lstat(path)).size;
            if (bytes > 1024 * 1024 * 1024 || files.length >= 10_000) throw new Error('The Voice archive expands beyond its limit.');
            files.push({ path: relative(stage, path), digest: await fileDigest(path, signal) });
          } else throw new Error('The Voice archive contains a special file.');
        }
      };
      await walk(stage);
      atomicWriteFileSync(join(stage, '.installed.json'), JSON.stringify({ sha256: asset.sha256, files }), { symlinks: 'refuse' });
      atomicWriteTarget(target, 'refuse'); await rm(target, { recursive: true, force: true });
      await rename(stage, target); return target;
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
}
