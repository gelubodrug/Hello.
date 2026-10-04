import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Blocks, FolderOpen, Loader2, PanelLeft, Play, RotateCcw, RotateCw, Square, Store, X } from 'lucide-react';
import type { DshStatus } from '../../shared/types';
import { api } from '../api';
import './dsh.css';

interface Props {
  open: boolean;
  onClose(): void;
  onOpenMarket?(): void;
  /** Hello's chats sidebar is hidden, so nothing beside the surface leads back to the chats. */
  sidebarHidden?: boolean;
  onShowSidebar?(): void;
}

const STATE_LABEL: Record<DshStatus['state'], string> = {
  absent: 'Not installed',
  installing: 'Installing',
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  failed: 'Stopped with an error',
};

/** Minutes and seconds, as a clock reads them. */
function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Quiet this long, pnpm is said to be quiet, and for how long. */
const QUIET_MS = 20_000;

/**
 * The install as it happens: what is in place, how long it has been going,
 * what pnpm is doing right now, and — once it has gone quiet — for how long,
 * so a stuck download reads as one (user, 01.10: "pune ceva viu aici, că nu
 * știi nimic ce face… e blocat, se reia, verifică conexiunea").
 */
function InstallPanel({ version, progress }: { version?: string; progress?: DshStatus['progress'] }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const total = progress?.total || progress?.resolved || 0;
  const percent = progress?.done ? 100 : total ? Math.min(100, Math.round(((progress?.added ?? 0) / total) * 100)) : 4;
  const quiet = progress?.at ? now - progress.at : 0;
  const live = quiet < QUIET_MS;
  return (
    <>
      <h2>Installing dsh {version}…</h2>
      <div className="dsh-progress" data-live={live || undefined} aria-hidden><span style={{ width: `${percent}%` }} /></div>
      <p className="muted">
        {!progress?.resolved ? 'Resolving packages…'
          : progress.done ? `All ${progress.total ?? progress.added} packages in place · finishing`
            : `${progress.added} of ${total} packages in place · ${progress.downloaded} downloaded`}
        {progress?.startedAt ? ` · ${clock(now - progress.startedAt)}` : ''}
      </p>
      {progress?.activity && <p className="dsh-activity">{progress.activity}</p>}
      {!live && (
        <p className="dsh-quiet">
          Nothing from pnpm for {clock(quiet)}. It is still running and gives up on its own after a few minutes; if it stays quiet, check the connection.
        </p>
      )}
    </>
  );
}

export function useDshStatus(): DshStatus | null {
  const [status, setStatus] = useState<DshStatus | null>(null);
  useEffect(() => {
    const bridge = api.dsh;
    if (!bridge) return;
    let alive = true;
    void bridge.status().then(value => { if (alive) setStatus(value); }).catch(() => {});
    const unsubscribe = bridge.onStatus(value => setStatus(value));
    return () => { alive = false; unsubscribe(); };
  }, []);
  return status;
}

/**
 * The DSH surface: dsh's own client, hosted by Hello in a page of its own.
 *
 * The page is a <webview> in a fixed host, like a browser tab's: moved over
 * this view while it is open, parked off screen while it is not, never
 * unmounted — so closing the view and opening it again shows the same page,
 * not a reloaded one. The page exists only while a host runs; before that,
 * this view says what is happening and offers the one next step.
 */
export function DshView({ open, onClose, onOpenMarket, sidebarHidden, onShowSidebar }: Props): JSX.Element {
  const status = useDshStatus();
  const slot = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const running = status?.state === 'running';
  const shown = useRef(false);
  shown.current = open && running;
  const place = useRef<() => void>(() => {});
  const started = useRef(false);

  // Opening the surface is asking for it: a stopped host starts. An absent one
  // does not install on its own — that is half a gigabyte, and a choice.
  useEffect(() => {
    if (!open || !status || started.current) return;
    if (status.state === 'stopped' && !status.profileChange) {
      started.current = true;
      void api.dsh?.start().catch((reason: Error) => setError(reason.message));
    }
  }, [open, status]);
  useEffect(() => { if (status?.state !== 'stopped') started.current = false; }, [status?.state]);

  useLayoutEffect(() => {
    const bridge = api.dsh;
    if (!bridge) return;
    const host = document.createElement('div');
    host.className = 'dsh-guest-host';
    (document.getElementById('root') ?? document.body).appendChild(host);
    let size = { width: 1024, height: 720 };
    let frame = 0;
    let dropped = false;
    let mounted = '';
    const apply = () => {
      const rect = slot.current?.getBoundingClientRect();
      const visible = shown.current && !!rect && rect.width > 2 && rect.height > 2;
      if (visible && rect) size = { width: Math.round(rect.width), height: Math.round(rect.height) };
      host.style.width = `${size.width}px`;
      host.style.height = `${size.height}px`;
      host.style.transform = `translate(${Math.round(visible && rect ? rect.x : 0)}px, ${Math.round(visible && rect ? rect.y : 0)}px)`;
      host.style.zIndex = visible ? '1' : '-1';
      host.style.pointerEvents = visible ? 'auto' : 'none';
    };
    const position = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(apply); };
    place.current = position;
    apply();
    void bridge.attach().then(src => {
      if (dropped) return;
      mounted = src;
      const element = document.createElement('webview');
      // Only the src main just minted. Every other attribute is main's to set.
      element.setAttribute('src', src);
      host.appendChild(element);
      position();
    }).catch((reason: Error) => { if (!dropped) setError(reason.message); });
    const observer = new ResizeObserver(position);
    if (slot.current) observer.observe(slot.current);
    window.addEventListener('resize', position);
    return () => {
      dropped = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', position);
      place.current = () => {};
      host.remove();
      void bridge.detach(mounted.split('hello-dsh-')[1] ?? '').catch(() => {});
    };
  }, []);
  useEffect(() => { place.current(); }, [open, running]);

  const run = (task: () => Promise<unknown> | undefined) => {
    setError('');
    setBusy(true);
    void Promise.resolve(task()).catch((reason: Error) => setError(reason.message)).finally(() => setBusy(false));
  };
  const bridge = api.dsh;
  const state = status?.state;
  const progress = status?.progress;
  const latest = status?.checkpoints[0];

  return (
    <section className="workspace dsh-view" hidden={!open} data-state={state ?? 'loading'} aria-label="DSH surface">
      <header className="dsh-view-head">
        {/* With the sidebar hidden, the way back to the chats starts here. */}
        {sidebarHidden && onShowSidebar && (
          <button type="button" className="icon-button" title="Pin chats sidebar" aria-label="Pin chats sidebar" onClick={onShowSidebar}><PanelLeft size={16} /></button>
        )}
        <Blocks size={16} aria-hidden />
        <strong>DSH</strong>
        <span className="dsh-state-pill" data-state={state}>{state ? STATE_LABEL[state] : 'Loading'}</span>
        <span className="dsh-view-grow" />
        {running && <button type="button" className="icon-button" title="Reload the page" aria-label="Reload the page" onClick={() => run(() => bridge?.reload())}><RotateCw size={15} /></button>}
        {(running || state === 'failed') && <button type="button" className="icon-button" title="Restart DSH" aria-label="Restart DSH" disabled={busy} onClick={() => run(() => bridge?.restart())}><RotateCcw size={15} /></button>}
        {running && <button type="button" className="icon-button" title="Stop DSH" aria-label="Stop DSH" disabled={busy} onClick={() => run(() => bridge?.stop())}><Square size={14} /></button>}
        {onOpenMarket && <button type="button" className="icon-button" title="Community Plugin Market" aria-label="Community Plugin Market" onClick={onOpenMarket}><Store size={15} /></button>}
        <button type="button" className="icon-button" title="Show the host log" aria-label="Show the host log" onClick={() => run(() => bridge?.revealLogs())}><FolderOpen size={15} /></button>
        <button type="button" className="icon-button" title="Close DSH" aria-label="Close DSH" onClick={onClose}><X size={16} /></button>
      </header>
      {running && status?.bootFailure && (
        <div className="dsh-banner" role="alert">
          <span>The DSH page could not start {status.bootFailure.join(', ')}.</span>
          {onOpenMarket && <button type="button" className="text-button" onClick={onOpenMarket}>Plugin Market</button>}
          {latest && <button type="button" className="text-button" disabled={busy} onClick={() => run(() => bridge?.restore(latest.id))}>Restore the profile of {new Date(latest.at).toLocaleString()}</button>}
        </div>
      )}
      <div className="dsh-view-body">
        <div ref={slot} className="dsh-slot" />
        {!running && (
          <div className="dsh-panel" role="status">
            {!bridge && <p>This window’s bridge has no DSH surface yet. Restart Hello. to load it.</p>}
            {bridge && !status && <p><Loader2 size={16} className="spin" /> Checking DSH…</p>}
            {state === 'absent' && (
              <>
                <h2>DeepSeek Harness, inside Hello.</h2>
                <p>dsh’s own client and its plugins — interface plugins, themes, tools — run here, in a surface of their own, in Hello’s colours.</p>
                <p className="muted">Hello. installs dsh {status?.version} into its own data folder: about 0.5 GB, once. Nothing in ~/.dsh is read or changed. Plugins run as local code with your permissions.</p>
                <button type="button" className="pill dsh-primary" disabled={busy} onClick={() => run(() => bridge?.install().then(next => next.state === 'stopped' ? bridge.start() : next))}>Install DSH</button>
              </>
            )}
            {state === 'installing' && <InstallPanel version={status?.version} progress={progress} />}
            {state === 'stopped' && status?.profileChange && (
              <>
                <h2>The DSH profile changed outside Hello.</h2>
                <ul className="dsh-change">
                  {status.profileChange.added.map(name => <li key={`a${name}`}>Added <code>{name}</code></li>)}
                  {status.profileChange.removed.map(name => <li key={`r${name}`}>Removed <code>{name}</code></li>)}
                  {status.profileChange.changed.map(name => <li key={`c${name}`}>Changed <code>{name}</code></li>)}
                </ul>
                <p className="muted">A plugin runs with your permissions and can install others. Start only with packages you recognise.</p>
                <div className="dsh-actions">
                  <button type="button" className="pill dsh-primary" disabled={busy} onClick={() => run(() => bridge?.start(true))}>Start with these changes</button>
                  {latest && <button type="button" className="pill" disabled={busy} onClick={() => run(() => bridge?.restore(latest.id))}>Restore the profile of {new Date(latest.at).toLocaleString()}</button>}
                </div>
              </>
            )}
            {state === 'stopped' && !status?.profileChange && (
              <>
                <h2>DSH is stopped.</h2>
                <button type="button" className="pill dsh-primary" disabled={busy} onClick={() => run(() => bridge?.start())}><Play size={14} /> Start</button>
              </>
            )}
            {(state === 'starting' || state === 'stopping') && <p><Loader2 size={16} className="spin" /> {state === 'starting' ? (status?.message ?? 'Starting DSH…') : 'Stopping DSH…'}</p>}
            {state === 'failed' && (
              <>
                <h2>DSH stopped.</h2>
                {status?.message && <pre className="dsh-error">{status.message}</pre>}
                <div className="dsh-actions">
                  <button type="button" className="pill dsh-primary" disabled={busy} onClick={() => run(() => bridge?.start())}><Play size={14} /> Start again</button>
                  {latest && <button type="button" className="pill" disabled={busy} onClick={() => run(() => bridge?.restore(latest.id))}>Restore the profile of {new Date(latest.at).toLocaleString()}</button>}
                  <button type="button" className="pill" onClick={() => run(() => bridge?.revealLogs())}>Show the log</button>
                </div>
              </>
            )}
            {status?.message && state !== 'failed' && state !== 'starting' && !status.profileChange && <p className="error-text">{status.message}</p>}
            {error && <p className="error-text">{error}</p>}
          </div>
        )}
      </div>
    </section>
  );
}
