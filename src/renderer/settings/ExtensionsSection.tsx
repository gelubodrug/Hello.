import { Fragment, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Blocks, ChevronRight, Cpu, Download, Pencil, Plug, RefreshCw, Search, Store, Trash2, Wrench } from 'lucide-react';
import type { DiscoveredResources, LibraryResource, McpServerStatus, ResourceKind } from '../../shared/types';
import { api } from '../api';
import { ErrorNote, IconButton, errorText } from '../ui/primitives';

const groups: Array<{ kind: ResourceKind; title: string; blurb: string }> = [
  { kind: 'skill', title: 'Skills', blurb: 'Instructions and reference files the model loads when a task matches. Import a folder with SKILL.md, or a single SKILL.md file.' },
  { kind: 'plugin', title: 'Plugins', blurb: 'Pi packages that add extensions, skills or prompt templates. Extensions are Node code and run with the app’s own access; review a package before importing it.' },
  { kind: 'mcp', title: 'MCP servers', blurb: 'Servers Hello starts on this Mac, or reaches over HTTP. Hello connects, lists their tools and offers them to the chats you activate them in.' },
];

const stateLabel: Record<LibraryResource['state'], string> = {
  ready: 'Unchanged since import',
  modified: 'Changed after import',
  missing: 'Files missing',
};

function ResourceRow({ resource, status, onChanged, onError, busy, setBusy, onEdit }: {
  resource: LibraryResource;
  status?: McpServerStatus;
  onChanged: () => void;
  onError: (message: string | null) => void;
  busy: boolean;
  setBusy: (value: boolean) => void;
  onEdit?: (resource: LibraryResource) => void;
}) {
  const [open, setOpen] = useState(false);
  const [probing, setProbing] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    onError(null);
    try { await action(); onChanged(); }
    catch (reason) { onError(errorText(reason)); }
    finally { setBusy(false); }
  };
  return (
    <li className="extension-row" data-state={resource.state}>
      <div className="extension-head">
        <button type="button" className="extension-disclosure" aria-expanded={open} onClick={() => setOpen(value => !value)}>
          <ChevronRight size={14} className="extension-chevron" aria-hidden />
          <span className="extension-name">{resource.name}</span>
        </button>
        <span className="extension-detail truncate" title={resource.detail}>{resource.detail}</span>
        {resource.state !== 'ready' && (
          <span className="extension-flag" title="Hello loads only the copy you approved.">
            <AlertTriangle size={13} aria-hidden />
            {stateLabel[resource.state]}
          </span>
        )}
        {resource.kind === 'mcp' && status?.needsSignIn && !status.connected ? (
          // The server's own sign-in, in the browser, opened by this click and nothing else.
          <button type="button" className="pill extension-sign-in" disabled={busy || probing || !api.extensions.signIn}
            onClick={() => {
              setProbing(true);
              onError(null);
              void api.extensions.signIn!(resource.id)
                .then(result => { if (!result.connected && result.error) onError(result.error); })
                .then(onChanged)
                .catch(reason => onError(errorText(reason)))
                .finally(() => setProbing(false));
            }}>
            {probing ? 'Signing in…' : 'Sign in'}
          </button>
        ) : resource.kind === 'mcp' && status && (
          <span className={`extension-status${status.connected ? ' is-live' : ''}`}>
            {status.connected ? `${status.tools.length} tool(s)` : status.error ? 'Failed' : 'Not connected'}
          </span>
        )}
        {resource.kind === 'mcp' && (
          <IconButton label={`Edit ${resource.name}`} disabled={busy} onClick={() => onEdit?.(resource)}>
            <Pencil size={14} />
          </IconButton>
        )}
        {resource.kind === 'mcp' ? (
          <IconButton
            label={status?.connected ? `Disconnect ${resource.name}` : `Connect and list tools for ${resource.name}`}
            disabled={busy || probing}
            onClick={() => {
              setProbing(true);
              onError(null);
              const action = status?.connected
                ? api.extensions.disconnect(resource.id)
                : api.extensions.probe(resource.id).then(result => { if (!result.connected && result.error) onError(result.error); });
              void action.then(onChanged)
                .catch(reason => onError(errorText(reason)))
                .finally(() => setProbing(false));
            }}
          >
            <Plug size={14} />
          </IconButton>
        ) : (
          <IconButton
            label={`Re-import ${resource.name} from its source`}
            disabled={busy}
            onClick={() => void run(() => api.extensions.update(resource.id))}
          >
            <RefreshCw size={14} />
          </IconButton>
        )}
        <IconButton label={`Remove ${resource.name}`} disabled={busy} onClick={() => void run(() => api.extensions.remove(resource.id))}>
          <Trash2 size={14} />
        </IconButton>
      </div>
      {open && (
        <div className="extension-body">
          <p className="muted">{resource.description}</p>
          <dl className="extension-facts">
            <div><dt>Source</dt><dd className="truncate" title={resource.source}>{resource.source}</dd></div>
            {resource.version && <div><dt>Version</dt><dd>{resource.version}</dd></div>}
            {resource.fingerprint && <div><dt>Imported copy</dt><dd>{resource.fingerprint}</dd></div>}
            <div><dt>Imported</dt><dd>{new Date(resource.createdAt).toLocaleString()}</dd></div>
          </dl>
          {!!resource.entries.length && (
            <ul className="extension-entries">
              {resource.entries.map(entry => <li key={entry}>{entry}</li>)}
            </ul>
          )}
          {resource.kind === 'mcp' && status?.tools.length ? (
            <p className="muted">Tools: {status.tools.join(', ')}</p>
          ) : null}
          {resource.kind === 'mcp' && status?.error ? <p className="extension-error">{status.error}</p> : null}
          {resource.state === 'modified' && (
            <p className="extension-error">
              The imported copy changed on disk. Chats using it refuse to start until you re-import or remove it.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function McpForm({ onSaved, onError, busy, setBusy, editing, onCancelEdit }: {
  onSaved: () => void;
  onError: (message: string | null) => void;
  busy: boolean;
  setBusy: (value: boolean) => void;
  editing?: LibraryResource | null;
  onCancelEdit?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const [cwd, setCwd] = useState('');
  const [clearEnv, setClearEnv] = useState(false);
  // An address instead of a command is a server reached over HTTP: no arguments or
  // folder then, and the values below are its headers.
  const remote = /^https?:\/\//i.test(command.trim());
  useEffect(() => {
    if (!editing) return;
    setOpen(true);
    setName(editing.name);
    setCommand(editing.mcp?.transport === 'http' ? editing.mcp.url ?? '' : editing.mcp?.command ?? '');
    setArgs(editing.mcp?.args.join('\n') ?? '');
    setCwd(editing.mcp?.cwd ?? '');
    setEnv('');
    setClearEnv(false);
  }, [editing]);
  const close = () => { setOpen(false); setName(''); setCommand(''); setArgs(''); setEnv(''); setCwd(''); setClearEnv(false); onCancelEdit?.(); };
  if (!open)
    return (
      <button type="button" className="text-button" onClick={() => setOpen(true)}>
        <Cpu size={14} />
        Add an MCP server
      </button>
    );
  return (
    <div className="extension-form">
      <label>
        Name
        <input value={name} onChange={event => setName(event.target.value)} placeholder="files" autoComplete="off" spellCheck={false} />
      </label>
      <label>
        Command or URL
        <input value={command} onChange={event => setCommand(event.target.value)} placeholder="/usr/local/bin/my-mcp-server  or  https://mcp.example.com/mcp" autoComplete="off" spellCheck={false} />
      </label>
      {!remote && <>
        <label>
          Arguments (one per line)
          <textarea rows={2} value={args} onChange={event => setArgs(event.target.value)} placeholder="--root&#10;/Users/me/notes" spellCheck={false} />
        </label>
        <label>
          Working folder (optional)
          <input value={cwd} onChange={event => setCwd(event.target.value)} placeholder="/Users/me/notes" spellCheck={false} />
        </label>
      </>}
      <label>
        {remote ? 'Headers (Name: value, one per line)' : 'Environment (NAME=value, one per line)'}
        <textarea rows={2} value={env} onChange={event => setEnv(event.target.value)} placeholder={remote ? 'Authorization: Bearer …' : 'API_TOKEN=…'} spellCheck={false} />
        <span className="muted">
          {editing
            ? 'Stored values are not shown. Leave this empty to keep them, or type the complete set to replace them.'
            : `Values are stored with the same encryption as the model key and ${remote ? 'sent only to this server' : 'passed only to this server’s process'}.`}
        </span>
      </label>
      {editing && <label><input type="checkbox" checked={clearEnv} onChange={event => setClearEnv(event.target.checked)} /> Clear stored environment values</label>}
      <div className="extension-form-actions">
        <button type="button" className="pill" onClick={close}>Cancel</button>
        <button
          type="button"
          className="pill primary-button"
          disabled={busy || !name.trim() || !command.trim()}
          onClick={() => {
            const environment: Record<string, string> = {};
            for (const line of env.split('\n')) {
              if (!line.trim()) continue;
              const match = remote ? /^\s*([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*[:=]\s*(.*)$/.exec(line) : /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
              if (!match) { onError(remote ? 'Use Name: value for each header.' : 'Use NAME=value for each environment entry.'); return; }
              environment[match[1]] = match[2];
            }
            setBusy(true);
            onError(null);
            void api.extensions
              .addMcp({
                ...(editing ? { id: editing.id, keepEnv: !env.trim() && !clearEnv } : {}),
                name: name.trim(), ...(remote ? { command: '', url: command.trim(), args: [], cwd: null } : {
                  command: command.trim(),
                  args: editing?.mcp && args === editing.mcp.args.join('\n') ? editing.mcp.args : args ? args.split('\n') : [],
                  cwd: cwd.trim() || null,
                }),
                env: clearEnv ? {} : environment,
              })
              .then(() => { close(); onSaved(); })
              .catch(reason => onError(errorText(reason)))
              .finally(() => setBusy(false));
          }}
        >
          {editing ? 'Save changes' : 'Save server'}
        </button>
      </div>
    </div>
  );
}

/** The installed library. Importing copies and inspects files; it never runs them. */
export function ExtensionsSection() {
  const [resources, setResources] = useState<LibraryResource[]>([]);
  const [examples, setExamples] = useState<Array<{ kind: 'skill' | 'plugin'; name: string; description: string }>>([]);
  const [status, setStatus] = useState<McpServerStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<LibraryResource | null>(null);
  const [found, setFound] = useState<DiscoveredResources | null>(null);
  const [scanning, setScanning] = useState(false);
  const load = () => {
    void api.extensions.list().then(setResources).catch(reason => setError(errorText(reason)));
    void api.extensions.status().then(setStatus).catch(() => {});
    void api.extensions.examples().then(setExamples).catch(() => setExamples([]));
  };
  useEffect(() => {
    load();
    // What other tools already have is worth knowing without being asked for.
    scanRef.current();
    return api.extensions.onChange(load);
  }, []);
  const importResource = (kind: 'skill' | 'plugin') => {
    setBusy(true);
    setError(null);
    setNotice(null);
    void api.extensions
      .importResource(kind)
      .then(result => {
        if (!result) return;
        setNotice(result.warning
          ? `Imported ${result.name}. ${result.warning}`
          : `Imported ${result.name}. Turn it on for a chat from the composer’s Extensions menu.`);
        load();
      })
      .catch(reason => setError(errorText(reason)))
      .finally(() => setBusy(false));
  };
  const scanRef = useRef<() => void>(() => {});
  const scan = () => {
    setScanning(true);
    setError(null);
    setNotice(null);
    void api.extensions
      .discover()
      .then(result => {
        setFound(result);
        if (!result.mcp.length && !result.skills.length && !result.plugins?.length)
          setNotice('No servers, skills or Pi extensions found in the configuration files of the agent tools on this Mac.');
      })
      .catch(reason => setError(errorText(reason)))
      .finally(() => setScanning(false));
  };
  scanRef.current = scan;
  const adopt = (kind: 'skill' | 'mcp' | 'plugin', id: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    void api.extensions
      .importDiscovered(kind, id)
      .then(result => {
        setNotice(`Added ${result.name}. Turn it on for a chat from the composer’s Extensions menu.`);
        load();
      })
      .catch(reason => setError(errorText(reason)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="settings-form">
      <p className="muted">
        One library for this app. Choose which resources each chat can use from its Extensions menu. Connecting an MCP server here starts it to inspect its tools.
      </p>
      <div className="extension-actions">
        <button type="button" className="text-button" disabled={scanning} onClick={scan}>
          <Search size={14} />
          {scanning ? 'Looking…' : found ? 'Look again' : 'Find what other agent tools already have'}
        </button>
        {found && (
          <span className="muted">
            {found.skills.length + found.mcp.length + (found.plugins?.length ?? 0)
              ? `${found.skills.length} skill(s), ${found.mcp.length} server(s)${found.plugins?.length ? `, ${found.plugins.length} Pi extension(s)` : ''} found`
              : 'Nothing found'}
          </span>
        )}
      </div>
      {groups.map(group => {
        const rows = resources.filter(resource => resource.kind === group.kind);
        return (
          <section className="extension-group" key={group.kind}>
            <header className="extension-group-head">
              <h3>{group.kind === 'skill' ? <Wrench size={14} aria-hidden /> : group.kind === 'plugin' ? <Blocks size={14} aria-hidden /> : <Cpu size={14} aria-hidden />}{group.title}</h3>
              <span className="muted">{rows.length ? `${rows.length} installed` : 'None yet'}</span>
            </header>
            <p className="muted">{group.blurb}</p>
            {!!rows.length && (
              <ul className="extension-list">
                {rows.map(resource => (
                  <Fragment key={resource.id}>
                    <ResourceRow
                      resource={resource}
                      status={status.find(item => item.id === resource.id)}
                      onChanged={load}
                      onError={setError}
                      busy={busy}
                      setBusy={setBusy}
                      onEdit={setEditing}
                    />
                    {/* Edit where the thing is, not at the end of the list. */}
                    {editing?.id === resource.id && (
                      <li className="extension-row extension-row-form">
                        <McpForm onSaved={load} onError={setError} busy={busy} setBusy={setBusy}
                          editing={editing} onCancelEdit={() => setEditing(null)} />
                      </li>
                    )}
                  </Fragment>
                ))}
              </ul>
            )}
            {found && (() => {
              const entries = group.kind === 'skill'
                ? found.skills.map(skill => ({
                    key: skill.id, name: skill.name, source: skill.source,
                    detail: skill.description || skill.path, blocked: undefined as string | undefined,
                  }))
                : group.kind === 'plugin'
                ? (found.plugins ?? []).map(plugin => ({
                    key: plugin.id, name: plugin.name, source: plugin.source,
                    detail: plugin.description || plugin.path,
                    blocked: plugin.unsupported as string | undefined,
                  }))
                : found.mcp.map(server => ({
                    key: server.id, name: server.name, source: server.source,
                    detail: [server.command, ...server.args].join(' '),
                    blocked: server.unsupported,
                  }));
              const fresh = entries.filter(item => !rows.some(resource => resource.name.toLowerCase() === item.name.toLowerCase()));
              if (!fresh.length) return null;
              return (
                <ul className="extension-list extension-found">
                  {fresh.map(item => (
                    <li className="extension-row" key={item.key}>
                      <div className="extension-head">
                        <span className="extension-name">{item.name}</span>
                        <span className="extension-detail truncate" title={item.detail}>{item.source} · {item.detail}</span>
                        <button
                          type="button"
                          className="pill"
                          disabled={busy || Boolean(item.blocked)}
                          title={item.blocked ?? `Copy ${item.name} into this app’s library`}
                          onClick={() => adopt(group.kind, item.key)}
                        >
                          {item.blocked ? 'Not supported' : 'Add'}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              );
            })()}
            {group.kind === 'mcp' ? (
              !editing && <McpForm onSaved={load} onError={setError} busy={busy} setBusy={setBusy} editing={null} onCancelEdit={() => setEditing(null)} />
            ) : (
              <div className="extension-actions">
                {group.kind === 'plugin' && (api as Partial<typeof api>).piMarket && (
                  <button type="button" className="text-button" onClick={() => window.dispatchEvent(new CustomEvent('hello:market-open', { detail: 'pi' }))}>
                    <Store size={14} />
                    Browse Pi packages
                  </button>
                )}
                <button type="button" className="text-button" disabled={busy} onClick={() => importResource(group.kind as 'skill' | 'plugin')}>
                  <Blocks size={14} />
                  {group.kind === 'skill' ? 'Import a skill…' : 'Import a plugin…'}
                </button>
                {examples
                  .filter(example => example.kind === group.kind && !rows.some(resource => resource.name === example.name))
                  .map(example => (
                    <button
                      key={example.name}
                      type="button"
                      className="text-button"
                      disabled={busy}
                      title={example.description}
                      onClick={() => {
                        setBusy(true);
                        setError(null);
                        setNotice(null);
                        void api.extensions
                          .importExample(example.kind, example.name)
                          .then(result => { setNotice(`Imported the bundled ${result.name} example. Turn it on for a chat from the composer’s Extensions menu.`); load(); })
                          .catch(reason => setError(errorText(reason)))
                          .finally(() => setBusy(false));
                      }}
                    >
                      <Download size={14} />
                      Add example: {example.name}
                    </button>
                  ))}
              </div>
            )}
          </section>
        );
      })}
      {notice && <p className="extension-notice" role="status">{notice}</p>}
      <ErrorNote error={error} />
    </div>
  );
}
