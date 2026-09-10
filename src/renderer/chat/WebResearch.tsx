import { ChevronDown, Globe, Search } from 'lucide-react';
import type { MessagePart } from '../../shared/types';
import { readWebResult, type WebSource } from '../../shared/web';
import { api } from '../api';
import { ErrorNote, MenuButton } from '../ui/primitives';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { activitySummary } from './activity';
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

export function ActivityGroup({ parts, streaming, children }: {
  parts: readonly MessagePart[]; streaming: boolean; children: ReactNode;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const id = useId();
  const summary = activitySummary(parts);
  const open = override ?? (streaming || summary.failed > 0 || summary.approvals > 0 || summary.unfinished > 0);
  useLayoutEffect(() => {
    const node = viewport.current;
    // Only follow live additions inside this bounded viewport. Reading earlier
    // steps or using a disclosure must not move the reader or outer transcript.
    if (node && open && streaming && following.current && !node.contains(document.activeElement))
      node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
  }, [parts, streaming, open]);
  const states = [summary.failed ? `${summary.failed} failed` : '', summary.approvals ? 'Needs approval' : '',
    summary.unfinished ? (streaming ? 'Running' : 'Unfinished') : ''].filter(Boolean).join(' · ');
  return <div className="activity-group" data-failed={summary.failed > 0 || undefined} data-approval={summary.approvals > 0 || undefined}>
    <button type="button" className="disclosure-button activity-summary" aria-expanded={open} aria-controls={id}
      onClick={() => setOverride(!open)}>
      <span className="activity-summary-copy"><span>{summary.title}</span>
        {summary.counts && <span className="activity-counts">{summary.counts}</span>}</span>
      <ChevronDown size={14} className="disclosure-chevron" aria-hidden />
      {states && <small className="activity-state">{states}</small>}
    </button>
    <ChatDisclosure id={id} open={open} className="activity-reveal">
    <div ref={viewport} className="activity-detail"
      role="region" aria-label={`${summary.title} steps`} tabIndex={0}
      onScroll={event => {
        if (event.target !== event.currentTarget) return;
        const node = event.currentTarget;
        following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 16;
      }}
      onWheelCapture={event => { if (event.deltaY < 0) following.current = false; }}
      onKeyDownCapture={event => {
        if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) following.current = false;
      }}
      onClickCapture={() => { following.current = false; setOverride(true); }}
      onContextMenuCapture={() => { following.current = false; setOverride(true); }}>
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

export function webToolTitle(part: Extract<MessagePart, { type: 'tool' }>): string {
  if (part.name === 'browser_show_html') return part.status === 'complete' ? 'Created visual' : 'Create visual';
  if (part.name === 'browser_open') return part.status === 'complete' ? 'Opened in Browser' : 'Open in Browser';
  try {
    const input = JSON.parse(part.input);
    if (part.name === 'web_search') return part.status === 'complete' ? 'Searched web' : 'Search web';
    if (part.name === 'fetch_url') return typeof input.url === 'string' ? `Read ${host(input.url)}` : 'Read web page';
  } catch { /* Arguments are still streaming. */ }
  return part.name === 'web_search' ? (part.status === 'complete' ? 'Searched web' : 'Search web') : part.name === 'fetch_url' ? 'Read web page' : part.name;
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
