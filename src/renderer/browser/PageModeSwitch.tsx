import { Brush, SquareDashedMousePointer, X } from 'lucide-react';
import type { BrowserTab, PageModeKind } from '../../shared/types';
import { PAGE_MODE_KINDS_READY } from './usePageMode';
import './page-mode.css';

interface Props {
  tab: BrowserTab;
  mode: PageModeKind | null;
  pending: PageModeKind | null;
  available: boolean;
  onToggle(kind: PageModeKind): void;
}

const KINDS: Array<{ kind: PageModeKind; label: string; Icon: typeof Brush; idle: string; on: string }> = [
  { kind: 'design', label: 'Design', Icon: SquareDashedMousePointer,
    idle: 'Design — click an element in the page to describe a change',
    on: 'Design on — click an element to describe a change. Esc or click here to stop' },
  { kind: 'annotate', label: 'Annotate', Icon: Brush,
    idle: 'Annotate — mark a zone of the page',
    on: 'Annotate on — click the page to drop a marker. Esc or click here to stop' },
];

/**
 * Design and Annotate. At rest each is an icon like its neighbours; armed, it
 * unfurls into a pill that names the mode and carries its X — while it is on,
 * the page takes clicks as notes instead of following links, and that should
 * never run unannounced. One at a time. Hello's tokens.
 */
export function PageModeSwitch({ tab, mode, pending, available, onToggle }: Props): JSX.Element {
  const blocked = !available ? 'Update Hello. to use page modes'
    : tab.control === 'off' ? 'Enable read access to use'
    : tab.url === 'about:blank' || tab.error ? 'Open a page to use'
    : tab.loading ? 'Wait for the page to load to use'
    : '';
  return <div className="page-mode-switch" role="group" aria-label="Page modes">
    {KINDS.map(({ kind, label, Icon, idle, on }) => {
      const active = mode === kind;
      const ready = PAGE_MODE_KINDS_READY.includes(kind);
      const title = active ? on : !ready ? `${label} is coming soon` : blocked ? `${blocked} ${label}` : idle;
      return <button key={kind} type="button" data-kind={kind}
        className={`page-mode-pill${active ? ' is-on' : ''}`}
        title={title} aria-label={`${label} mode`} aria-pressed={active}
        disabled={!active && (!ready || Boolean(blocked) || pending !== null)}
        onClick={() => onToggle(kind)}>
        <Icon size={15} aria-hidden="true"/>
        <span className="page-mode-label">{label}</span>
        <span className="page-mode-x" aria-hidden="true"><X size={12}/></span>
      </button>;
    })}
  </div>;
}
