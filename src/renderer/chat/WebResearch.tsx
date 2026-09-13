import { ChevronDown, Globe, Search } from 'lucide-react';
import type { MessagePart } from '../../shared/types';
import { readWebResult, type WebSource } from '../../shared/web';
import { api } from '../api';
import { ErrorNote, MenuButton } from '../ui/primitives';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { activitySummary, stepLabel } from './activity';
import { ChatDisclosure } from './ChatDisclosure';

const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

function SourceIcon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const domain = host(url);
  return <span className="source-icon" aria-hidden="true">
    {failed ? <Globe size={16} /> : <img width={20} height={20} alt="" loading="lazy"
      referrerPolicy="no-referrer" src={`https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`}
      onError={() => setFailed(true)} />}
  </span>;
}

export function ActivityGroup({ parts, streaming, tail, children }: {
  parts: readonly MessagePart[]; streaming: boolean; tail?: ReactNode; children: ReactNode;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  const id = useId();
  const summary = activitySummary(parts);
  // Anything that wants the reader opens the whole list. Otherwise, while the
  // reply is still arriving, only the tail shows: the list unrolling in full is
  // what made this ugly, and the work happening now is what is worth seeing.
  const attention = summary.failed > 0 || summary.approvals > 0;
  const open = override ?? (attention || (!streaming && summary.unfinished > 0));
  const live = override === null && streaming && !open && tail !== undefined;
  const states = [summary.failed ? `${summary.failed} failed` : '', summary.approvals ? 'Needs approval' : '',
    summary.unfinished ? (streaming ? 'Running' : 'Unfinished') : ''].filter(Boolean).join(' · ');
  return <div className="activity-group" data-failed={summary.failed > 0 || undefined} data-approval={summary.approvals > 0 || undefined}>
    <button type="button" className="disclosure-button activity-summary" aria-expanded={open} aria-controls={id}
      onClick={() => setOverride(!open)}>
      <span className="activity-summary-copy"><span>{summary.title}</span>
        {summary.counts && <span className="activity-counts">{summary.counts}</span>}</span>
      <ChevronDown size={14} className="disclosure-chevron" aria-hidden />
      {states && <small className="activity-state" data-running={streaming && summary.unfinished > 0 || undefined}>{states}</small>}
    </button>
    {live && <div className="activity-tail"><div className="activity-entries">{tail}</div></div>}
    <ChatDisclosure id={id} open={open} className="activity-reveal">
    {/* The transcript is the only scroll; nothing here follows or is followed. */}
    <div className="activity-detail" role="region" aria-label={`${summary.title} steps`}
      onClickCapture={() => setOverride(true)}
      onContextMenuCapture={() => setOverride(true)}>
      <div className="activity-entries">{children}</div>
    </div>
    </ChatDisclosure>
  </div>;
}

export function webToolArgument(part: Extract<MessagePart, { type: 'tool' }>): string | null {
  try {
    const input = JSON.parse(part.input);
    const value = part.name === 'web_search' ? input.query : part.name === 'fetch_url' ? input.url : null;
    return typeof value === 'string' ? value : null;
  } catch { return null; }
}

/** One list of names for every tool, in activity.ts, so a tool cannot ship
 *  without one and the merged form cannot disagree with the single one. */
export function webToolTitle(part: Extract<MessagePart, { type: 'tool' }>): string {
  return stepLabel([part]);
}

export function WebToolOutput({ part }: { part: MessagePart }) {
  const result = readWebResult(part);
  const [error, setError] = useState<string | null>(null);
  if (!result) return null;
  const open = (url: string) => void api.system.openExternal(url).catch(() => setError('Could not open this source.'));
  return <div className="web-tool-output">
    {result.kind === 'web_search' ? <>
      <p className="meta-label">{result.engine} · {result.results.length} results · previews only</p>
      {result.broadenedTo && <p className="meta-label">Broadened to: {result.broadenedTo}</p>}
      <ol className="web-search-results">{result.results.map(hit => <li key={hit.url}>
        <a href={hit.url} onClick={event => { event.preventDefault(); open(hit.url); }}>
          <span className="web-source-host">{host(hit.url)}</span>{hit.title}
        </a>
        {hit.snippet && <p>{hit.snippet}</p>}
      </li>)}</ol>
      {!result.results.length && <p>{result.note}</p>}
    </> : <>
      <a className="web-fetched-source" href={result.source.url} onClick={event => { event.preventDefault(); open(result.source.url); }}>
        <Globe size={14} /><span>[{result.source.id}] {result.source.title}<small>{host(result.source.url)}</small></span>
      </a>
      <p className="meta-label">Read {new Date(result.source.fetchedAt).toLocaleString()}{result.truncated ? ' · excerpt truncated' : ''}</p>
      <pre className="web-page-excerpt">{result.text}</pre>
    </>}
    <ErrorNote error={error} />
  </div>;
}

export function MessageSources({ sources }: { sources: readonly WebSource[] }) {
  const [error, setError] = useState<string | null>(null);
  if (!sources.length) return null;
  return <div className="message-sources">
    <MenuButton className="pill sources-pill" label={`Sources: ${sources.length} pages read`} menuLabel="Sources — pages read" align="start"
      menuClassName="sources-menu" heading="Sources"
      items={sources.map(source => ({ id: String(source.id), label: `[${source.id}] ${host(source.url)}`, detail: source.title,
        leading: <SourceIcon url={source.url} />,
        action: () => void api.system.openExternal(source.url).catch(() => setError('Could not open this source.')) }))}>
      <span className="sources-marks" aria-hidden="true">{sources.slice(0, 4).map(source => <SourceIcon key={source.id} url={source.url} />)}</span>
      <span className="sr-only">Sources</span>
      {sources.length > 4 && <span className="sources-count">+{sources.length - 4}</span>}
    </MenuButton>
    <ErrorNote error={error} />
  </div>;
}

export const webToolIcon = (name: string) => name === 'web_search' ? Search : name === 'fetch_url' ? Globe : null;
