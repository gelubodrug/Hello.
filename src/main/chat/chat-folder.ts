import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { CHAT_FOLDER_NAME } from '../../shared/chat-folder';

/** Where a chat's own folder is, in the app's data. */
export const chatFolderOf = (dataDir: string, conversationId: string) =>
  join(dataDir, 'chat-files', createHash('sha256').update(conversationId).digest('hex'), CHAT_FOLDER_NAME);

/**
 * A copy of a file the person dropped, in the chat's own folder, under its own name — or that name with a number
 * when it is taken, there or wherever else `taken` says a file of that name is already meant.
 */
export async function bringIn(folder: string, source: string, taken?: (name: string) => Promise<boolean>): Promise<string> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const extension = extname(source), stem = basename(source, extension);
  let name = basename(source);
  for (let n = 2; await stat(join(folder, name)).then(() => true, () => false) || await taken?.(name); n++) name = `${stem} (${n})${extension}`;
  await copyFile(source, join(folder, name));
  return name;
}

/** What the chat's own folder holds, at its top: names and sizes, for the model to know what it was given. */
export async function chatFiles(folder: string): Promise<Array<{ name: string; bytes: number }>> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const files: Array<{ name: string; bytes: number }> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || entry.name.startsWith('.') || entry.name.startsWith('~$') || files.length >= 40) continue;
    files.push({ name: entry.name, bytes: (await stat(join(folder, entry.name)).catch(() => undefined))?.size ?? 0 });
  }
  return files;
}

/**
 * A file Hello keeps for the chat, asked for by its name alone — what a PDF dropped from outside the person's
 * folder is, as a workbook from outside is a copy in Hello. A name and nothing more: no path reaches the rest of
 * the app's data this way, and a link left there is not followed.
 */
export async function keptFile(dataDir: string, conversationId: string, requested: string): Promise<string | undefined> {
  const name = requested.trim().replace(/^\.\//, '');
  if (!name || name.startsWith('.') || name !== basename(name) || /[\\/\0]/.test(name)) return undefined;
  const absolute = join(chatFolderOf(dataDir, conversationId), name);
  return (await lstat(absolute).then(info => info.isFile(), () => false)) ? absolute : undefined;
}

/** Gone with the chat. */
export const removeChatFolder = (dataDir: string, conversationId: string) =>
  rm(join(chatFolderOf(dataDir, conversationId), '..'), { recursive: true, force: true });
