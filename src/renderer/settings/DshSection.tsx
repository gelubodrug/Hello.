import { useEffect, useState } from 'react';
import { FolderOpen, Layers, Play, Plus, RotateCcw, Square } from 'lucide-react';
import { api } from '../api';
import { useDshStatus } from '../dsh/DshView';
import { ErrorNote, errorText } from '../ui/primitives';

const LABEL = {
  absent: 'Not installed',
  installing: 'Installing',
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  failed: 'Stopped with an error',
} as const;

/** Settings › Extensions › DSH surface: the host's state, its controls and its restore points. */
export function DshSection(): JSX.Element | null {
  const status = useDshStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  const [toolsIn, setToolsIn] = useState<boolean | null>(null);
  const bridge = api.dsh;
  useEffect(() => {
    if (!bridge?.toolsInLibrary) return;
    const read = () => void bridge.toolsInLibrary?.().then(setToolsIn).catch(() => {});
    read();
    // Removing the row from the library list is the same switch, turned off.
    return api.extensions.onChange(read);
  }, [bridge]);
  if (!bridge) return null;
  const run = (task: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    void task().catch(reason => setError(errorText(reason))).finally(() => setBusy(false));
  };
  const state = status?.state;
  return (
    <section className="extension-group">
      <header className="extension-group-head">
        <h3><Layers size={14} aria-hidden />DSH surface</h3>
        <span className={`extension-status${state === 'running' ? ' is-live' : ''}`}>{state ? LABEL[state] : 'Checking…'}</span>
      </header>
      <p className="muted">
        DeepSeek Harness’s own client, hosted by Hello. in a process and a page of its own, for dsh interface plugins and themes. dsh {status?.version} lives in this app’s data folder; its plugins run as local code with your permissions.
      </p>
      {status?.message && <p className="extension-error">{status.message}</p>}
      <div className="extension-actions">
        {state === 'absent' && <button type="button" className="text-button" disabled={busy} onClick={() => run(() => bridge.install())}>Install DSH (about 0.5 GB)</button>}
        {(state === 'stopped' || state === 'failed') && <button type="button" className="text-button" disabled={busy} onClick={() => run(() => bridge.start())}><Play size={14} />Start</button>}
        {state === 'running' && <button type="button" className="text-button" disabled={busy} onClick={() => run(() => bridge.restart())}><RotateCcw size={14} />Restart</button>}
        {state === 'running' && <button type="button" className="text-button" disabled={busy} onClick={() => run(() => bridge.stop())}><Square size={13} />Stop</button>}
        <button type="button" className="text-button" onClick={() => run(() => bridge.revealLogs())}><FolderOpen size={14} />Log</button>
      </div>
      <form className="extension-actions" onSubmit={event => { event.preventDefault(); if (adding.trim()) { window.dispatchEvent(new CustomEvent('hello:market-add', { detail: adding.trim() })); setAdding(''); } }}>
        <input value={adding} onChange={event => setAdding(event.currentTarget.value)} placeholder="npm package, e.g. dsh1024" aria-label="Add a DSH plugin by its npm name" style={{ flex: 1, minWidth: 0 }} />
        <button type="submit" className="text-button" disabled={!adding.trim() || state === 'installing'}><Plus size={14} />Add by npm name</button>
        <button type="button" className="text-button" disabled={state === 'installing'} onClick={() => window.dispatchEvent(new Event('hello:market-add-folder'))}>Add from folder…</button>
      </form>
      {status && (
        <label className="dialog-check">
          <input type="checkbox" checked={status.useHelloModel !== false} disabled={!bridge.setUseHelloModel} onChange={event => run(() => bridge.setUseHelloModel?.(event.currentTarget.checked) ?? Promise.resolve())} />
          Sessions in the surface use Hello.’s connection. The key stays in Hello.; the change applies on the next start.
        </label>
      )}
      {status && toolsIn !== null && (
        <label className="dialog-check">
          <input type="checkbox" checked={toolsIn} disabled={busy} onChange={event => { const wanted = event.currentTarget.checked; run(() => bridge.setToolsInLibrary?.(wanted).then(setToolsIn) ?? Promise.resolve()); }} />
          Offer the plugins’ tools to Hello. chats, as the MCP server “dsh-plugins”. It stays off in every chat until you turn it on there.
        </label>
      )}
      {status && (
        <dl className="extension-facts">
          <dt>Version</dt><dd>{status.installedVersion ?? '—'}{status.installedVersion && status.installedVersion !== status.version ? ` (Hello. runs ${status.version})` : ''}</dd>
          <dt>Profile</dt><dd className="truncate" title={status.profileDir}>{status.profileDir}</dd>
        </dl>
      )}
      {!!status?.checkpoints.length && (
        <ul className="extension-list">
          {status.checkpoints.map(point => (
            <li className="extension-row" key={point.id}>
              <div className="extension-head">
                <span className="extension-name">{new Date(point.at).toLocaleString()}</span>
                <span className="extension-detail truncate">{point.label}</span>
                <button type="button" className="text-button" disabled={busy || state === 'installing'} onClick={() => run(() => bridge.restore(point.id))}>Restore</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={error} />
    </section>
  );
}
