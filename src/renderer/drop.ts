import { api } from './api';

export const HELLO_FILES_MIME = 'application/x-hello-files';
const MAX_FILES = 16;

export function hasFileDrop(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).some(type => type === 'Files' || type === HELLO_FILES_MIME);
}

export function setInternalFileDrop(transfer: DataTransfer, conversationId: string, paths: string[]): void {
  transfer.effectAllowed = 'copy';
  transfer.setData(HELLO_FILES_MIME, JSON.stringify({ conversationId, paths }));
}

/** Snapshot native paths or the internal payload before a drag event is released. */
export async function droppedPaths(transfer: DataTransfer): Promise<string[]> {
  const files = Array.from(transfer.files);
  if (files.length) return validatePaths(api.system.pathsForFiles(files));
  const source = transfer.getData(HELLO_FILES_MIME);
  if (!source || source.length > MAX_FILES * 8300) throw new Error('Drop local files or folders from Finder or Hello’s Files pane.');
  let data: unknown;
  try { data = JSON.parse(source); } catch { throw new Error('This file drag could not be read. Drag the item again.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid file drag.');
  const { conversationId, paths } = data as { conversationId?: unknown; paths?: unknown };
  if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 500) throw new Error('Invalid file drag conversation.');
  return validatePaths(await api.files.resolvePaths(conversationId, validatePaths(paths)));
}

function validatePaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_FILES ||
    paths.some(path => typeof path !== 'string' || !path || path.length > 8192 || /[\u0000-\u001f\u007f-\u009f]/.test(path))) {
    throw new Error('Drop up to 16 files or folders without control characters in their names.');
  }
  return [...new Set(paths as string[])];
}

/** File names are shell arguments, never commands or terminal control input. */
export function quoteTerminalPaths(paths: string[]): string {
  return validatePaths(paths).map(path => `'${path.replace(/'/g, `'"'"'`)}'`).join(' ') + ' ';
}
