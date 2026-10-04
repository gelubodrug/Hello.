import { useEffect, useState, type ReactNode } from 'react';
import type { ExtensionAnswer, ExtensionDialog, ExtensionUiState, ExtensionWidget } from '../../shared/types';
import { api } from '../api';
import './ExtensionPanel.css';

// What the plugins active in a chat show, while its Pi runs headless (user,
// 29.09: "când activezi lucruri pentru Pi, dar îl folosești headless, ele nu
// mai apar"). Pi sends a plugin's text widgets, status lines, notices and
// questions over RPC; they are shown here, beside the composer. A plugin's
// terminal components never leave Pi and cannot be shown. Every word below is
// the plugin's, rendered as plain text.

const NOTICE_MS = 10_000;

/** A run in pi-subagents' status for hosts (docs/observability.md, "Host inspection protocol"). */
interface SubagentRun { id?: string; label?: string; state?: string; activity?: { currentTool?: string; toolCount?: number; turnCount?: number }; children?: SubagentRun[] }
const RUN_STATES: Record<string, string> = { queued: 'queued', running: 'running', complete: 'done', failed: 'failed', partial: 'partly done', paused: 'paused', stopped: 'stopped', rejected: 'refused' };

/**
 * What a widget is for a person. A line of data for hosts — `NAME_JSON:{…}` —
 * is never shown raw: pi-subagents' run status becomes a list of runs, and its
 * inspection replies, which hosts must not render, are not shown at all.
 */
export function readWidget(widget: ExtensionWidget): { kind: 'text'; lines: string[] } | { kind: 'runs'; runs: SubagentRun[] } | { kind: 'hidden' } {
  const first = widget.lines[0] ?? '';
  if (first.startsWith('PI_SUBAGENT_ASYNC_JSON:')) {
    try {
      const snapshot = JSON.parse(first.slice('PI_SUBAGENT_ASYNC_JSON:'.length)) as { runs?: unknown };
      const runs = Array.isArray(snapshot.runs) ? snapshot.runs.filter((run): run is SubagentRun => Boolean(run) && typeof run === 'object') : [];
      return runs.length ? { kind: 'runs', runs } : { kind: 'hidden' };
    } catch { return { kind: 'hidden' }; }
  }
  const lines = widget.lines.filter(line => !/^[A-Z][A-Z0-9_]*_JSON:/.test(line));
  return lines.length ? { kind: 'text', lines } : { kind: 'hidden' };
}

function RunRows({ runs, depth }: { runs: SubagentRun[]; depth: number }) {
  return (
    <>
      {runs.slice(0, 20).map((run, index) => {
        const state = typeof run.state === 'string' ? run.state : 'queued';
        const detail = [
          run.activity?.currentTool ? `using ${run.activity.currentTool}` : '',
          typeof run.activity?.toolCount === 'number' && run.activity.toolCount ? `${run.activity.toolCount} tool${run.activity.toolCount === 1 ? '' : 's'}` : '',
          typeof run.id === 'string' ? run.id.slice(0, 8) : '',
        ].filter(Boolean).join(' · ');
        return (
          <div key={`${run.id ?? index}-${depth}`}>
            <div className="extension-run" data-state={state} style={{ paddingLeft: depth * 16 }}>
              <span className="extension-run-state">{RUN_STATES[state] ?? state}</span>
              <span className="extension-run-label">{typeof run.label === 'string' && run.label ? run.label : 'subagent'}</span>
              {detail && <span className="extension-run-detail">{detail}</span>}
            </div>
            {depth < 2 && Array.isArray(run.children) && run.children.length > 0 && <RunRows runs={run.children} depth={depth + 1} />}
          </div>
        );
      })}
    </>
  );
}

const empty = (conversationId: string): ExtensionUiState => ({ conversationId, widgets: [], statuses: [], notices: [], dialogs: [] });

export function useExtensionUi({ conversationId, onEditorText, onError }: {
  conversationId: string;
  /** Text a plugin put in the composer. */
  onEditorText(text: string): void;
  onError(reason: unknown): void;
}): { above: ReactNode; below: ReactNode } {
  const chat = (api as Partial<typeof api>).chat;
  const [state, setState] = useState<ExtensionUiState>(() => empty(conversationId));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setState(empty(conversationId));
    let alive = true;
    void chat?.extensionUi?.(conversationId).then(next => { if (alive) setState(next); }).catch(() => {});
    const unsubscribe = chat?.onExtensionUi?.(next => { if (next.conversationId === conversationId) setState(next); });
    return () => { alive = false; unsubscribe?.(); };
  }, [chat, conversationId]);
  // A notice stays a little while; a question stays until it is answered.
  const fresh = state.notices.filter(notice => now - notice.at < NOTICE_MS);
  useEffect(() => {
    if (!fresh.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(250, NOTICE_MS - (Date.now() - fresh[0].at)));
    return () => clearTimeout(timer);
  }, [fresh.length, fresh[0]?.id]);
  useEffect(() => { setNow(Date.now()); }, [state.notices.length]);
  const editorAt = state.editorText?.at;
  useEffect(() => { if (state.editorText) onEditorText(state.editorText.text); }, [editorAt]);

  const answer = (dialog: ExtensionDialog, value: ExtensionAnswer) => {
    void chat?.answerExtension?.(conversationId, dialog.id, value).catch(onError);
  };
  const widgets = (placement: 'aboveEditor' | 'belowEditor') => state.widgets.filter(widget => widget.placement === placement).flatMap(widget => {
    const read = readWidget(widget);
    if (read.kind === 'hidden') return [];
    if (read.kind === 'runs') return [(
      <div key={widget.key} className="extension-runs" role="status" aria-label="Subagent runs">
        <RunRows runs={read.runs} depth={0} />
      </div>
    )];
    return [<pre key={widget.key} className="extension-widget" aria-label={`Shown by a plugin: ${widget.key}`}>{read.lines.join('\n')}</pre>];
  });
  const dialog = state.dialogs[0];
  const aboveWidgets = widgets('aboveEditor');
  const hasAbove = aboveWidgets.length || state.statuses.length || fresh.length || dialog;
  const above = hasAbove ? (
    <div className="extension-panel" aria-label="What this chat’s plugins show">
      {dialog && <ExtensionQuestion key={dialog.id} dialog={dialog} waiting={state.dialogs.length - 1} onAnswer={value => answer(dialog, value)} />}
      {fresh.map(notice => <p key={notice.id} className="extension-notice" data-kind={notice.kind} role="status">{notice.message}</p>)}
      {aboveWidgets}
      {state.statuses.length > 0 && (
        <div className="extension-statuses">
          {state.statuses.map(status => <span key={status.key} className="extension-status" title={status.key}>{status.text}</span>)}
        </div>
      )}
    </div>
  ) : null;
  const belowWidgets = widgets('belowEditor');
  const below = belowWidgets.length ? <div className="extension-panel extension-panel-below">{belowWidgets}</div> : null;
  return { above, below };
}

/** A plugin's question, waiting for the person: choose, confirm, type or edit. */
function ExtensionQuestion({ dialog, waiting, onAnswer }: { dialog: ExtensionDialog; waiting: number; onAnswer(answer: ExtensionAnswer): void }) {
  const [value, setValue] = useState(dialog.prefill ?? '');
  const cancel = <button type="button" className="text-button" onClick={() => onAnswer({ cancelled: true })}>Dismiss</button>;
  return (
    <section className="extension-question" role="group" aria-label={`A plugin asks: ${dialog.title}`}>
      <header>
        <span className="extension-question-from">A plugin asks</span>
        {waiting > 0 && <span className="extension-question-more">{waiting} more waiting</span>}
      </header>
      <h3>{dialog.title}</h3>
      {dialog.message && <p>{dialog.message}</p>}
      {dialog.method === 'select' && (
        <div className="extension-question-actions">
          {(dialog.options ?? []).map(option => <button key={option} type="button" className="pill" onClick={() => onAnswer({ value: option })}>{option}</button>)}
          {cancel}
        </div>
      )}
      {dialog.method === 'confirm' && (
        <div className="extension-question-actions">
          <button type="button" className="pill" onClick={() => onAnswer({ confirmed: true })}>Yes</button>
          <button type="button" className="pill" onClick={() => onAnswer({ confirmed: false })}>No</button>
        </div>
      )}
      {(dialog.method === 'input' || dialog.method === 'editor') && (
        <form className="extension-question-form" onSubmit={event => { event.preventDefault(); onAnswer({ value }); }}>
          {dialog.method === 'input'
            ? <input aria-label={dialog.title} value={value} placeholder={dialog.placeholder} onChange={event => setValue(event.target.value)} autoFocus />
            : <textarea aria-label={dialog.title} value={value} rows={6} onChange={event => setValue(event.target.value)} autoFocus />}
          <div className="extension-question-actions">
            <button type="submit" className="pill">Send</button>
            {cancel}
          </div>
        </form>
      )}
      {dialog.expiresAt && <small className="extension-question-expiry">Pi answers it by itself at {new Date(dialog.expiresAt).toLocaleTimeString()}.</small>}
    </section>
  );
}
