import { useMemo } from 'react';
import type { ContentMatch, ContentSearch } from '../../shared/files';
import { FileTypeIcon } from './FileTypeIcon';

const STOPPED: Record<ContentSearch['reasons'][number], string> = {
  results: 'stopped at 200 lines',
  entries: 'stopped at 10,000 entries',
  bytes: 'stopped after reading 20 MiB',
  time: 'stopped after 4 seconds',
};

/** What the line under the results says about a search of the contents. */
export function contentNotice(found: ContentSearch | null, query: string): string {
  if (query.trim().length < 2) return 'Type two or more characters to search inside the files of this chat’s folder.';
  const partial = found?.limited ? `Partial results: ${found.reasons.map(reason => STOPPED[reason]).join(', ')}. ` : '';
  return `${partial}Searches the text of the files in this chat’s folder, as typed; skips dependency, build and .git folders, links, binary and large files.${found?.skipped ? ` ${found.skipped} skipped.` : ''}`;
}

/**
 * The lines a search of the contents found (audit A3b), grouped by file in
 * the order found. The words are shown as text, the match marked; Enter or a
 * click opens the line in Source, ↑/↓ move between lines.
 */
export function ContentResults({ found, scanning, onOpen }: {
  found: ContentSearch | null; scanning: boolean; onOpen(match: ContentMatch): void;
}) {
  const groups = useMemo(() => {
    const files = new Map<string, ContentMatch[]>();
    for (const match of found?.matches ?? []) {
      const lines = files.get(match.path);
      if (lines) lines.push(match); else files.set(match.path, [match]);
    }
    return [...files];
  }, [found]);
  const count = found?.matches.length ?? 0;
  const status = scanning ? 'Searching…'
    : !found ? 'The search stopped before it found anything.'
    : !count ? 'No line in this folder has that.'
    : `${count} ${count === 1 ? 'line' : 'lines'} in ${groups.length} ${groups.length === 1 ? 'file' : 'files'}`;
  return <div className="files-results" aria-label="Lines that match" aria-busy={scanning}
    onKeyDown={event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.files-result')];
      const at = rows.indexOf(event.target as HTMLButtonElement);
      if (at < 0) return;
      event.preventDefault();
      rows[(at + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length].focus();
    }}>
    <p className="files-results-status" role="status">{status}</p>
    {!scanning && groups.map(([path, matches]) => (
      <section key={path} className="files-result-file" aria-label={path}>
        <h3 className="files-result-path" title={path}><FileTypeIcon name={path.slice(path.lastIndexOf('/') + 1)} /><span className="truncate">{path}</span></h3>
        {matches.map(match => (
          <button key={match.line} type="button" className="files-result" title={`${path}:${match.line}`} onClick={() => onOpen(match)}>
            <span className="files-result-line">{match.line}</span>
            <span className="files-result-text">{match.snippet.slice(0, match.start)}<mark>{match.snippet.slice(match.start, match.end)}</mark>{match.snippet.slice(match.end)}</span>
          </button>
        ))}
      </section>
    ))}
  </div>;
}
