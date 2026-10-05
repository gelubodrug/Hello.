/** Paths are relative to the conversation folder; only main resolves authority. */
export interface FileEntry {
  path: string;
  name: string;
  kind: 'directory' | 'file' | 'link';
}
export interface FileListing {
  root: string;
  entries: FileEntry[];
  limited: boolean;
  skipped: number;
}
/** A line of a file that holds the words searched for (audit A3b): where, and
 *  a short piece of it with the match's place inside that piece. Never a body. */
export interface ContentMatch { path: string; line: number; snippet: string; start: number; end: number }
/** What a search of a folder's contents found, and how far it got. */
export interface ContentSearch {
  requestId: string;
  matches: ContentMatch[];
  /** It stopped before the end: too many results, files, bytes or seconds. */
  limited: boolean;
  reasons: Array<'results' | 'entries' | 'bytes' | 'time'>;
  filesScanned: number;
  bytesScanned: number;
  /** Folders and files passed over: dependencies, links, binary, too large, unreadable. */
  skipped: number;
}
export interface FileDocument {
  path: string;
  absolutePath: string;
  name: string;
  size: number;
  modifiedAt: number;
  content: string | null;
  reason?: string;
}
export interface FilesTab { id: string; conversationId: string; kind: 'files'; title: string; }
export const filesTabId = (conversationId: string) => `files-${conversationId}`;

export interface FileLink { path: string; line?: number; anchor?: string; }
/** Recognize local references only. Never convert arbitrary URL schemes into paths. */
export function fileLink(href: string, relativeTo = ''): FileLink | null {
  if (!href || href.startsWith('//') || /[\u0000-\u001f]/.test(href)) return null;
  let value = href;
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.host && url.host !== 'localhost') return null;
      value = url.pathname + url.hash;
    } catch { return null; }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[^/:]+\.[a-z\d]+:\d+(?::\d+)?(?:#.*)?$/i.test(value)) return null;
  const hash = value.indexOf('#');
  let anchor = hash >= 0 ? value.slice(hash + 1) : undefined;
  value = hash >= 0 ? value.slice(0, hash) : value;
  try { value = decodeURIComponent(value); if (anchor) anchor = decodeURIComponent(anchor); } catch { return null; }
  const suffix = /:(\d+)(?::\d+)?$/.exec(value);
  const line = suffix ? Number(suffix[1]) : anchor && /^L\d+(?:-L?\d+)?$/.test(anchor) ? Number(anchor.match(/\d+/)![0]) : undefined;
  if (suffix) value = value.slice(0, -suffix[0].length);
  if (!value) value = relativeTo;
  else if (!value.startsWith('/') && relativeTo.includes('/')) value = relativeTo.slice(0, relativeTo.lastIndexOf('/') + 1) + value;
  if (!value || /[\u0000-\u001f]/.test(value)) return null;
  return { path: value, ...(line && Number.isSafeInteger(line) ? { line } : {}), ...(anchor && !line ? { anchor } : {}) };
}

export function fileLanguage(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  return ({ md: 'markdown', mdx: 'markdown', markdown: 'markdown', ts: 'typescript', tsx: 'tsx',
    js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript', json: 'json',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go', swift: 'swift', sh: 'bash', zsh: 'bash',
    yml: 'yaml', yaml: 'yaml', css: 'css', scss: 'scss', html: 'html', htm: 'html',
    xml: 'xml', svg: 'xml', toml: 'toml', sql: 'sql', c: 'c', h: 'c', cpp: 'cpp',
    java: 'java', kt: 'kotlin', diff: 'diff', patch: 'diff', csv: 'csv', txt: 'text',
  } as Record<string, string>)[extension] ?? (name.toLowerCase() === 'dockerfile' ? 'dockerfile' : 'text');
}
