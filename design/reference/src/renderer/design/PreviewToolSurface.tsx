import { useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bot, Globe, RotateCw } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import './PreviewToolSurface.css';

export type PreviewToolKind = 'browser' | 'terminal' | 'worker';
type ControlMode = 'off' | 'read-only' | 'full';
const CONTROL_LABELS: Record<ControlMode, string> = {
  off: 'Off',
  'read-only': 'Read only',
  full: 'Full',
};
const SAMPLE_ADDRESS = 'https://example.test/research';

/** Fixture responses only. No command here is passed to a shell or a model. */
export function simulatePreviewToolInput(kind: 'terminal' | 'worker', input: string): string {
  const command = input.trim();
  if (kind === 'worker') {
    if (command === 'help')
      return 'Preview worker: type a task to see a simulated reply.\nUse clear to clear this local transcript. No model is connected.';
    return 'Simulated plan\n\n1. Read the relevant Runbook and Tasks entries.\n2. Work on the requested change.\n3. Check the result and report back.\n\nThis is a UI preview. No model was called and no work was executed.';
  }
  switch (command) {
    case 'help':
      return 'Simulated commands: help, pwd, ls, whoami, clear.\nThese are fixed preview responses; nothing runs on your machine.';
    case 'pwd':
      return '/preview/research-workspace  (simulated path)';
    case 'ls':
      return 'runbook.md  tasks.md  src/\n(simulated files — no directory was read)';
    case 'whoami':
      return 'preview-user  (simulated identity)';
    default:
      return 'Not executed: this terminal is a visual simulation.\nTry help, pwd, ls, whoami or clear.';
  }
}

function BrowserPreview() {
  const [addresses, setAddresses] = useState([SAMPLE_ADDRESS]);
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState(SAMPLE_ADDRESS);
  const [control, setControl] = useState<ControlMode>('off');
  const [notice, setNotice] = useState('Local browser preview. No website is opened.');
  const [reading, setReading] = useState(false);

  function revisit(next: number) {
    setIndex(next);
    setDraft(addresses[next]);
    setNotice('Preview history changed. No website is opened.');
  }

  return (
    <section className="preview-tool-browser" aria-label="Browser preview">
      <div className="preview-tool-browser-toolbar">
        <div className="preview-tool-nav">
          <Tooltip label="Back in preview history">
            <button
              type="button"
              aria-label="Back in preview history"
              disabled={index === 0}
              onClick={() => revisit(index - 1)}
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip label="Forward in preview history">
            <button
              type="button"
              aria-label="Forward in preview history"
              disabled={index === addresses.length - 1}
              onClick={() => revisit(index + 1)}
            >
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip label="Reload local preview">
            <button
              type="button"
              aria-label="Reload local preview"
              onClick={() => setNotice('The local sample is ready. No network request was made.')}
            >
              <RotateCw size={16} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
        <form
          className="preview-tool-address"
          onSubmit={(event) => {
            event.preventDefault();
            const address = draft.trim();
            if (!address) return;
            const next = [...addresses.slice(0, index + 1), address];
            setAddresses(next);
            setIndex(next.length - 1);
            setDraft(address);
            setNotice(
              'Preview address changed. The page below is still the local sample; no website is opened.',
            );
          }}
        >
          <Globe size={14} aria-hidden="true" />
          <input
            aria-label="Browser address (preview)"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
          />
        </form>
        <Tooltip
          label={`Agent control: ${CONTROL_LABELS[control]}. Preview only; no permissions change.`}
        >
          <button
            type="button"
            className="preview-tool-control"
            data-control={control}
            aria-label={`Agent control: ${CONTROL_LABELS[control]} (preview only)`}
            onClick={() => {
              const next =
                control === 'off' ? 'read-only' : control === 'read-only' ? 'full' : 'off';
              setControl(next);
              setNotice(
                `Agent control ${CONTROL_LABELS[next].toLowerCase()} is shown for this preview only. No permissions changed.`,
              );
            }}
          >
            <Bot size={14} aria-hidden="true" />
            <span>Agent control</span>
            <small>{CONTROL_LABELS[control]}</small>
          </button>
        </Tooltip>
      </div>
      <div className="preview-tool-page">
        <article>
          <div className="preview-tool-page-brand">
            <Globe size={16} aria-hidden="true" /> Field notes
          </div>
          <h1>A shared place for research</h1>
          <p className="preview-tool-lead">
            Keep the conversation close while you read, compare sources and decide what to do next.
          </p>
          <h2>From a finding to a next step</h2>
          <p>
            The browser is the shared view. Useful findings can become notes in the chat’s Runbook;
            the Tasks notebook keeps the work that follows visible.
          </p>
          <ul>
            <li>Keep the source beside the decision it informs.</li>
            <li>Make a small, explicit task when there is work to do.</li>
            <li>Return to the chat without losing the page.</li>
          </ul>
          <blockquote>
            Research and execution share context, but they do not need to share one crowded panel.
          </blockquote>
          <button
            type="button"
            className="preview-tool-reading"
            aria-pressed={reading}
            onClick={() => setReading((current) => !current)}
          >
            {reading ? 'Saved in this preview' : 'Keep in preview reading list'}
          </button>
          <p className="preview-tool-page-caption">
            Sample content rendered locally. This button changes only the preview.
          </p>
        </article>
      </div>
      <p className="preview-tool-notice" role="status">
        {notice}
      </p>
    </section>
  );
}

function ConsolePreview({ kind, label }: { kind: 'terminal' | 'worker'; label?: string }) {
  const [draft, setDraft] = useState('');
  const [history, setHistory] = useState<{ id: number; command: string; output: string }[]>([]);
  const sequence = useRef(0);
  const transcript = useRef<HTMLDivElement>(null);
  const worker = kind === 'worker';
  return (
    <section
      className="preview-tool-console"
      data-tool={kind}
      aria-label={worker ? 'CLI worker preview' : 'Terminal preview'}
    >
      <div className="preview-tool-console-scroll" ref={transcript}>
        <p className="preview-tool-console-name">{label ?? (worker ? 'CLI worker' : 'Terminal')}</p>
        <p className="preview-tool-console-hint">
          {worker
            ? 'Local task preview. No model is connected.'
            : 'Local shell preview. No process is launched.'}
        </p>
        <p className="preview-tool-console-hint">
          {worker ? 'Type a task below to try the conversation.' : 'Try help, pwd or ls.'}
        </p>
        <div aria-live="polite" aria-relevant="additions">
          {history.map((entry) => (
            <div className="preview-tool-console-entry" key={entry.id}>
              <p>
                <span className="preview-tool-prompt">
                  {worker ? 'You ›' : 'preview@workspace ~ %'}
                </span>{' '}
                {entry.command}
              </p>
              <pre>{entry.output}</pre>
            </div>
          ))}
        </div>
        <form
          className="preview-tool-console-input"
          onSubmit={(event) => {
            event.preventDefault();
            const command = draft.trim();
            if (!command) return;
            setDraft('');
            if (command === 'clear') setHistory([]);
            else
              setHistory((current) => [
                ...current,
                {
                  id: ++sequence.current,
                  command,
                  output: simulatePreviewToolInput(kind, command),
                },
              ]);
            requestAnimationFrame(() => {
              const el = transcript.current;
              if (el && !el.closest('[hidden]')) el.scrollTop = el.scrollHeight;
            });
          }}
        >
          <span className="preview-tool-prompt" aria-hidden="true">
            {worker ? 'You ›' : 'preview@workspace ~ %'}
          </span>
          <input
            aria-label={worker ? 'Task for preview worker' : 'Command for preview terminal'}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </form>
      </div>
      <p className="preview-tool-console-footer">Simulation only — input stays in this page.</p>
    </section>
  );
}

/** Parent owns pills and visibility; keep each keyed instance mounted to retain its state. */
export function PreviewToolSurface({ kind, label }: { kind: PreviewToolKind; label?: string }) {
  return kind === 'browser' ? <BrowserPreview /> : <ConsolePreview kind={kind} label={label} />;
}
