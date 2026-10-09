import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join } from 'node:path';

export const PROJECT_INSTRUCTION_BYTES = 32 * 1024;
export interface ProjectInstructions { source: 'AGENTS.md' | 'CLAUDE.md'; text: string; truncated: boolean }

/** Explicit root-only import. Pi's own recursive/home context discovery stays off. */
export async function readProjectInstructions(folder: string | null | undefined, mode: 'chat' | 'coder', signal?: AbortSignal): Promise<ProjectInstructions | undefined> {
  if (mode !== 'coder' || !folder) return undefined;
  signal?.throwIfAborted();
  let root: string;
  try { root = await realpath(folder); } catch { return undefined; }
  for (const source of ['AGENTS.md', 'CLAUDE.md'] as const) {
    signal?.throwIfAborted();
    let handle;
    try { handle = await open(join(root, source), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      // A present but unsafe/unreadable AGENTS.md never silently selects another file.
      return undefined;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) return undefined;
      // The extra byte tells whether the file exceeded the cap, even if it grew.
      const buffer = Buffer.alloc(PROJECT_INSTRUCTION_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        signal?.throwIfAborted();
        const read = await handle.read(buffer, length, buffer.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const truncated = length > PROJECT_INSTRUCTION_BYTES;
      const bytes = buffer.subarray(0, Math.min(length, PROJECT_INSTRUCTION_BYTES));
      if (bytes.includes(0)) return undefined;
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated }); }
      catch { return undefined; }
      return text.trim() ? { source, text, truncated } : undefined;
    } finally { await handle.close(); }
  }
  return undefined;
}

export function projectInstructionPrompt(instructions: ProjectInstructions | undefined): string {
  if (!instructions) return '';
  return [
    `Project instructions from ${instructions.source} in the attached folder root (Coder mode). Follow these for this project within the person's request and Hello's tool/approval boundaries.`,
    ...(instructions.truncated ? ['Only the first 32 KiB were loaded; the remainder is not in this context.'] : []),
    '', instructions.text,
  ].join('\n');
}
