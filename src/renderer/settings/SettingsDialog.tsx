import { useEffect, useRef, useState } from "react";
import { AudioLines, Blocks, Check, ChevronDown, ChevronLeft, Plug, RefreshCw, SlidersHorizontal, Star, AppWindow } from "lucide-react";
import type { AppSettings, ConnectionModels, LocalServer, ModelChoice, SettingsPatch, VoiceServer } from "../../shared/types";
import { api } from "../api";
import { ErrorNote, IconButton, MenuButton, MenuLayerAbove, errorText } from "../ui/primitives";
import type { MenuItem } from "../ui/primitives";
import { ExtensionsSection } from "./ExtensionsSection";
import { AppAuditSection } from "./AppAuditSection";
import { VoiceSection } from "./VoiceSection";
import { EFFORT_LEVELS, reasoningNote, reasoningReach } from "../../shared/reasoning";
import { ENDPOINT_PRESETS, endpointIdentity, modelName, presetFor, suggestedName } from "./presets";
import { connectionName } from "../../shared/connection-name";
import { compactNumber, t } from "../i18n";

// The same levels the composer offers beside the model.
const reasoningOptions = [{ value: "off", label: "Provider default" }, ...EFFORT_LEVELS] as const;
const approvalOptions = [
  { value: 'all', label: 'Work without asking', detail: 'Writes in the chat folder and shell commands run straight away' },
  { value: 'writes', label: 'Ask before commands', detail: 'Files in the chat folder are written; a shell command waits for you' },
  { value: 'ask', label: 'Ask every time', detail: 'Every file write and every command waits for you' },
] as const;
const compatibilityOptions = [
  { value: 'auto', label: 'Automatic', detail: 'Known cloud-provider formatting' },
  { value: 'openai', label: 'OpenAI-compatible', detail: 'Sends reasoning_effort, so Low/Medium/High reach the server' },
  { value: 'qwen-chat-template', label: 'Local Qwen chat template', detail: 'For a local server that accepts Qwen chat-template parameters' },
] as const;
const SAVED_KEY_MASK = "•".repeat(24);
/** A server on this Mac rarely wants a key, so its key field waits to be asked for. */
const isLocal = (value: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(value.trim());
/** What a connection serves, in a few words: its one model, or how many. */
function served(models: ModelChoice[]): string {
  if (models.length !== 1) return t('models', models.length);
  const [only] = models;
  return only.contextWindow ? `${modelName(only.id)} · ${t('tokens', { n: compactNumber(only.contextWindow) })}` : modelName(only.id);
}

type Section = 'connection' | 'advanced' | 'voice' | 'extensions' | 'app';
type Probe =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'ok'; models: ModelChoice[] }
  | { state: 'error'; message: string };

export function SettingsDialog({
  open,
  settings,
  onSaved,
  onClose,
  dataPath,
  version,
  extensionsCount,
}: {
  open: boolean;
  settings: AppSettings;
  onSaved: (settings: AppSettings) => void;
  onClose: () => void;
  dataPath: string;
  version: string;
  extensionsCount: number;
}) {
  const [draft, setDraft] = useState(settings);
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  // The two token fields are an override. Saving them unchanged would claim
  // them for the selected model and stop main from reading the published ones.
  const [limitsEdited, setLimitsEdited] = useState(false);
  const [keyMasked, setKeyMasked] = useState(false);
  const [models, setModels] = useState<ModelChoice[]>([]);
  /** The kept connections' models, for a subagent model that is not on the chat's connection. */
  const [catalog, setCatalog] = useState<ConnectionModels[]>([]);
  const [probe, setProbe] = useState<Probe>({ state: 'idle' });
  const [servers, setServers] = useState<LocalServer[] | null>(null);
  const [voiceServers, setVoiceServers] = useState<VoiceServer[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [section, setSection] = useState<Section>('connection');
  // Asking the endpoint waits while its address is being typed, and not otherwise.
  const typing = useRef(false);
  const asked = useRef(0);
  const [askAgain, setAskAgain] = useState(0);

  const scan = async () => {
    setScanning(true);
    try { setServers(await api.settings.localServers()); }
    catch { setServers([]); }
    // The same look found the voice servers: Hello finds one, it never starts one.
    try { setVoiceServers(await api.settings.voiceServers?.() ?? []); }
    catch { setVoiceServers([]); }
    finally { setScanning(false); }
  };
  useEffect(() => {
    if (open) {
      setSection('connection');
      setDraft(settings);
      setKey(settings.apiKeySet ? SAVED_KEY_MASK : "");
      setKeyMasked(settings.apiKeySet);
      setKeyEdited(false);
      setKeyOpen(false);
      setLimitsEdited(false);
      setError(null);
      setSaved(false);
      setModels([]);
      setCatalog([]);
      void api.settings.catalog().then(setCatalog, () => {});
      setServers(null);
      setVoiceServers(null);
      void scan();
    }
  }, [open]);

  // THE PAGE READS THE SERVER. Whatever the address says, it is asked for its
  // models — so "is this right?" is answered on the page, next to the address,
  // not by a failure at the bottom after saving (user, 14.09).
  useEffect(() => {
    if (!open) return;
    const url = draft.endpointUrl.trim();
    const sequence = ++asked.current;
    if (!/^https?:\/\/[^/\s]+/i.test(url)) {
      setProbe({ state: 'idle' });
      setModels([]);
      return;
    }
    setProbe({ state: 'checking' });
    const delay = typing.current ? 400 : 0;
    typing.current = false;
    const timer = window.setTimeout(() => {
      api.settings.models(url).then(
        listed => {
          if (sequence !== asked.current) return;
          setModels(listed);
          setProbe({ state: 'ok', models: listed });
          // A server with one model has already said which one.
          if (listed.length === 1) setDraft(value => (value.model === listed[0].id ? value : { ...value, model: listed[0].id }));
        },
        reason => {
          if (sequence !== asked.current) return;
          setModels([]);
          setProbe({ state: 'error', message: errorText(reason) });
        },
      );
    }, delay);
    return () => window.clearTimeout(timer);
  }, [open, draft.endpointUrl, askAgain]);

  const remembered = settings.connections.find(
    entry => endpointIdentity(entry.endpointUrl) === endpointIdentity(draft.endpointUrl));
  // A kept connection on this Mac is named by the server answering there now,
  // never by one that ran there before; keeping it again rewrites the name.
  const named = (entry: { name: string; endpointUrl: string }) => connectionName(entry, servers ?? []);
  const keepName = named({
    name: remembered?.name || suggestedName(draft.endpointUrl) || draft.endpointUrl.trim(),
    endpointUrl: draft.endpointUrl,
  });
  const preset = presetFor(draft.endpointUrl);
  const keyShown = keyOpen || keyMasked || key !== "" || !isLocal(draft.endpointUrl);
  // A key, a model id and a model list all belong to the exact server that
  // issued them. Pointing somewhere else carries none of them along — including
  // a key typed but not yet saved, which would otherwise be sent to, and stored
  // under, a different company's endpoint on the next save.
  const pointAt = (endpointUrl: string) => {
    if (endpointIdentity(endpointUrl) === endpointIdentity(draft.endpointUrl)) {
      setDraft(value => ({ ...value, endpointUrl }));
      return;
    }
    const kept = settings.connections.find(
      entry => endpointIdentity(entry.endpointUrl) === endpointIdentity(endpointUrl));
    const saved = endpointIdentity(endpointUrl) === endpointIdentity(settings.endpointUrl)
      ? settings.apiKeySet
      : Boolean(kept?.apiKeySet);
    setModels([]);
    setKey(saved ? SAVED_KEY_MASK : "");
    setKeyMasked(saved);
    setKeyEdited(false);
    setDraft(value => ({ ...value, endpointUrl, model: kept?.model ?? "" }));
  };
  const adopt = (result: AppSettings) => {
    onSaved(result);
    setDraft(result);
    setKey(result.apiKeySet ? SAVED_KEY_MASK : "");
    setKeyMasked(result.apiKeySet);
    setKeyEdited(false);
    setLimitsEdited(false);
  };
  const run = async (operation: () => Promise<AppSettings>) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try { adopt(await operation()); setSaved(true); }
    catch (reason) {
      setError(errorText(reason));
      // Part of a two-step operation may already have been committed. Show what
      // the store actually holds rather than a draft it has replaced.
      await api.settings.get().then(adopt).catch(() => {});
    }
    finally { setBusy(false); }
  };
  const patch = (): SettingsPatch => ({
    endpointUrl: draft.endpointUrl.trim(),
    model: draft.model.trim(),
    temperature: draft.temperature,
    systemPrompt: draft.systemPrompt,
    reasoningEffort: draft.reasoningEffort,
    ...(limitsEdited ? {
      contextWindow: draft.contextWindow ?? 32768,
      maxOutputTokens: draft.maxOutputTokens ?? 4096,
    } : {}),
    modelCompatibility: draft.modelCompatibility ?? 'auto',
    approvals: draft.approvals ?? 'all',
    subagentModel: (draft.subagentModel ?? '').trim(),
    subagentEndpointUrl: (draft.subagentModel ?? '').trim() ? (draft.subagentEndpointUrl ?? '') : '',
    ...(keyEdited ? { apiKey: key } : {}),
  });
  // The other connections a subagent model can be on: the kept ones, by the
  // name they were kept under. Only a kept connection has a key of its own.
  const otherConnections = (draft.connections ?? []).filter(kept => endpointIdentity(kept.endpointUrl) !== endpointIdentity(draft.endpointUrl)).map(kept => {
    const listed = catalog.find(entry => endpointIdentity(entry.endpointUrl) === endpointIdentity(kept.endpointUrl));
    return { name: kept.name || suggestedName(kept.endpointUrl) || kept.endpointUrl, endpointUrl: kept.endpointUrl, models: listed?.models ?? [], error: listed?.error };
  });
  const subagentElsewhere = draft.subagentModel?.trim() && draft.subagentEndpointUrl
    ? otherConnections.find(connection => endpointIdentity(connection.endpointUrl) === endpointIdentity(draft.subagentEndpointUrl!))
    : undefined;
  const subagentUnlisted = Boolean(subagentElsewhere && subagentElsewhere.models.length &&
    !subagentElsewhere.models.some(model => model.id === draft.subagentModel?.trim()));
  const save = () => run(async () => {
    const result = await api.settings.save(patch());
    // A key just saved is what the endpoint may have been waiting for.
    setAskAgain(value => value + 1);
    return result;
  });
  /** One click: this server, its model, saved. Nothing typed for another
   *  endpoint travels with it — no key, and no limits claimed for a new model. */
  const use = (server: LocalServer) => {
    const model = server.models.length === 1
      ? server.models[0].id
      : server.models.some(item => item.id === draft.model) ? draft.model : "";
    const { apiKey: _key, contextWindow: _context, maxOutputTokens: _output, ...rest } = patch();
    void run(() => api.settings.save({ ...rest, endpointUrl: server.endpointUrl, model }));
  };
  const show = (next: Section) => {
    setSection(next);
    // Main adopts a server's published limits after a save, in the background:
    // show the numbers it holds now, unless a number of your own is waiting.
    if (next === 'advanced' && !limitsEdited)
      void api.settings.get().then(fresh => setDraft(value => ({
        ...value, contextWindow: fresh.contextWindow, maxOutputTokens: fresh.maxOutputTokens,
      }))).catch(() => {});
  };
  if (!open) return null;

  const inUse = (server: LocalServer) => endpointIdentity(server.endpointUrl) === endpointIdentity(settings.endpointUrl);
  const elsewhere = servers?.find(server => endpointIdentity(server.endpointUrl) !== endpointIdentity(draft.endpointUrl));
  const actions = (
    <>
      <ErrorNote error={error} />
      <div className="dialog-actions">
        <span className="settings-saved">
          {saved && (
            <>
              <Check size={14} />
              Saved
            </>
          )}
        </span>
        <button
          className="pill primary-button"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save settings"}
        </button>
      </div>
    </>
  );

  return (
    <MenuLayerAbove layer={300}>
    <div className="settings-page" role="region" aria-label="Settings"
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
      <nav className="settings-nav" aria-label="Settings sections">
        <button type="button" className="settings-back" onClick={onClose}>
          <ChevronLeft size={16} aria-hidden />
          Back
        </button>
        <h2>Settings</h2>
        <ul>
          {([
            { id: 'connection', label: 'Connection', Icon: Plug },
            { id: 'advanced', label: 'Advanced', Icon: SlidersHorizontal },
            { id: 'voice', label: 'Voice', Icon: AudioLines },
            { id: 'extensions', label: 'Extensions', Icon: Blocks },
            { id: 'app', label: 'App', Icon: AppWindow },
          ] as const).map(tab => (
            <li key={tab.id}>
              <button
                type="button"
                aria-current={section === tab.id ? 'true' : undefined}
                onClick={() => show(tab.id)}
              >
                <tab.Icon size={16} aria-hidden />
                {tab.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="settings-content">
      {section === 'extensions' ? (
        <ExtensionsSection />
      ) : section === 'voice' ? (
        <VoiceSection settings={settings} servers={voiceServers} onSaved={onSaved} />
      ) : section === 'app' ? (
        <AppAuditSection dataPath={dataPath} version={version} endpointUrl={settings.endpointUrl} extensionsLoaded={extensionsCount}
          appearance={settings.appearance ?? 'system'}
          onAppearance={appearance => void api.settings.save({ appearance }).then(onSaved).catch(reason => setError(errorText(reason)))} />
      ) : section === 'advanced' ? (
      <div className="settings-form">
        <div className="settings-numbers">
          <label>
            Temperature
            <input
              type="number"
              min="0"
              max="2"
              step="0.1"
              value={draft.temperature}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  temperature: Number(event.target.value),
                }))
              }
            />
          </label>
          <label>
            Context (tokens)
            <input
              type="number"
              min="20480"
              step="1"
              value={draft.contextWindow ?? 32768}
              onChange={event => { setLimitsEdited(true); setDraft(value => ({ ...value, contextWindow: Number(event.target.value) })); }}
            />
          </label>
          <label>
            Max output (tokens)
            <input
              type="number"
              min="512"
              step="1"
              value={draft.maxOutputTokens ?? 4096}
              onChange={event => { setLimitsEdited(true); setDraft(value => ({ ...value, maxOutputTokens: Number(event.target.value) })); }}
            />
          </label>
        </div>
        <p className="muted settings-note">
          Context and max output follow the model when its server publishes them.
          A number you type here stays with this model.
        </p>
        <div className="settings-choices">
          <div className="settings-field">
            <span>Reasoning effort</span>
            <MenuButton
              label="Reasoning effort"
              className="settings-select"
              align="start"
              items={reasoningOptions.map((option) => ({
                id: option.value,
                label: option.label,
                checked: (draft.reasoningEffort ?? "off") === option.value,
                action: () =>
                  setDraft((value) => ({
                    ...value,
                    reasoningEffort: option.value,
                  })),
              }))}
            >
              <span>
                {
                  reasoningOptions.find(
                    (option) =>
                      option.value === (draft.reasoningEffort ?? "off"),
                  )?.label
                }
              </span>
              <ChevronDown size={14} />
            </MenuButton>
            {/* What Low/Medium/High actually reaches this server as. On
                Automatic an OpenAI-compatible server (MTPLX, Kimi's endpoint)
                is sent no reasoning field at all, and the chat only looked as
                if thinking were on. The remedy is one choice below. */}
            {(draft.reasoningEffort ?? "off") !== "off" && (
              <span className="muted settings-note">{reasoningNote(reasoningReach(draft))}</span>
            )}
          </div>
          <div className="settings-field">
            <span>Tool approvals</span>
            <MenuButton
              label="Tool approvals"
              className="settings-select"
              align="start"
              items={approvalOptions.map(option => ({
                id: option.value,
                label: option.label,
                detail: option.detail,
                checked: (draft.approvals ?? 'all') === option.value,
                action: () => setDraft(value => ({ ...value, approvals: option.value })),
              }))}
            >
              <span>{approvalOptions.find(option => option.value === (draft.approvals ?? 'all'))?.label}</span>
              <ChevronDown size={14} />
            </MenuButton>
          </div>
          <div className="settings-field">
            <span>Model compatibility</span>
            <MenuButton
              label="Model compatibility"
              className="settings-select"
              align="start"
              items={compatibilityOptions.map(option => ({
                id: option.value,
                label: option.label,
                detail: option.detail,
                checked: (draft.modelCompatibility ?? 'auto') === option.value,
                action: () => setDraft(value => ({ ...value, modelCompatibility: option.value })),
              }))}
            >
              <span>{compatibilityOptions.find(option => option.value === (draft.modelCompatibility ?? 'auto'))?.label}</span>
              <ChevronDown size={14} />
            </MenuButton>
          </div>
        </div>
        <label>
          System instructions
          <textarea
            rows={4}
            value={draft.systemPrompt}
            onChange={(event) =>
              setDraft((value) => ({
                ...value,
                systemPrompt: event.target.value,
              }))
            }
            placeholder="Optional directions for the main chat"
          />
        </label>
        {actions}
      </div>
      ) : (
      <div className="settings-form">
        <section className="settings-servers" aria-label="On this Mac">
          <div className="settings-servers-head">
            <span>On this Mac</span>
            <IconButton label="Look for servers again" disabled={scanning} onClick={() => void scan()}>
              <RefreshCw size={13} className={scanning ? "spin" : undefined} aria-hidden />
            </IconButton>
          </div>
          {servers === null ? (
            <p className="muted">Looking for model servers…</p>
          ) : servers.length === 0 ? (
            <p className="muted">No model server is running on this Mac.</p>
          ) : (
            <div className="settings-server-list">
              {servers.map(server => (
                <button
                  key={server.endpointUrl}
                  type="button"
                  className="settings-server"
                  aria-pressed={inUse(server)}
                  disabled={busy}
                  title={server.endpointUrl}
                  onClick={() => use(server)}
                >
                  <span className="settings-server-dot" aria-hidden />
                  <span className="settings-server-name">{server.name}</span>
                  <span className="settings-server-models">{served(server.models)}</span>
                  <span className="settings-server-action">
                    {inUse(server) ? <Check size={14} aria-label="In use" /> : "Use"}
                  </span>
                </button>
              ))}
            </div>
          )}
          {voiceServers !== null && (
            <p className="muted" title={voiceServers.map(server => server.baseUrl).join("\n") || undefined}>
              {voiceServers.length
                ? `Voice: ${voiceServers.map(server => server.name).join(", ")}`
                : "No voice server is running on this Mac."}
            </p>
          )}
        </section>
        <div className="settings-model-row">
          <label>
            Endpoint URL
            <input
              value={draft.endpointUrl}
              placeholder="http://localhost:1234/v1"
              onChange={(event) => { typing.current = true; pointAt(event.target.value); }}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <MenuButton
            label="Providers"
            className="pill"
            items={ENDPOINT_PRESETS.map(item => ({
              id: item.id,
              label: item.name,
              detail: item.baseUrl,
              checked: preset?.id === item.id,
              action: () => pointAt(item.baseUrl),
            }))}
          >
            <Plug size={14} aria-hidden />
            Providers
            <ChevronDown size={14} />
          </MenuButton>
          <MenuButton
            label="Saved connections"
            className="pill"
            // The menu holds the whole idea: what is kept, and how to keep this.
            items={[
              ...settings.connections.map(entry => ({
                id: entry.endpointUrl,
                label: named(entry),
                detail: entry.model ? modelName(entry.model) : entry.endpointUrl,
                checked: endpointIdentity(entry.endpointUrl) === endpointIdentity(settings.endpointUrl),
                action: () => void run(() => api.settings.useConnection(entry.endpointUrl)),
              })),
              ...(settings.connections.length ? [{ id: 'keep-separator', label: '', separator: true }] : []),
              {
                id: 'keep',
                label: remembered ? `Update “${keepName}”` : 'Keep this connection',
                detail: remembered
                  ? 'Saves the endpoint, key and model as they are now'
                  : `Saves this endpoint, key and model as “${keepName || 'this connection'}”`,
                action: () => void run(async () => {
                  await api.settings.save(patch());
                  return api.settings.rememberConnection(keepName);
                }),
              },
              ...(settings.connections.some(entry => endpointIdentity(entry.endpointUrl) !== endpointIdentity(settings.endpointUrl))
                ? [{
                    id: 'forget',
                    label: 'Forget…',
                    children: settings.connections
                      .filter(entry => endpointIdentity(entry.endpointUrl) !== endpointIdentity(settings.endpointUrl))
                      .map(entry => ({
                        id: `forget:${entry.endpointUrl}`,
                        label: named(entry),
                        detail: 'Also deletes its saved key',
                        action: () => void run(() => api.settings.forgetConnection(entry.endpointUrl)),
                      })),
                  }]
                : []),
            ]}
          >
            <Star size={14} aria-hidden />
            {remembered ? named(remembered) : 'Saved'}
            <ChevronDown size={14} />
          </MenuButton>
        </div>
        {probe.state === 'idle' ? null : (
          <p className="settings-status" data-state={probe.state} role="status">
            {probe.state === 'checking'
              ? 'Checking…'
              : probe.state === 'ok'
                ? `Connected · ${served(probe.models)}`
                : probe.message}
            {/* A failed read is often the network, not the server: ask the
                same address again without it having to be retyped (nativ#690). */}
            {probe.state === 'error' ? (
              <button type="button" className="text-button" disabled={busy} onClick={() => setAskAgain(value => value + 1)}>
                Try again
              </button>
            ) : null}
            {probe.state === 'error' && elsewhere ? (
              <button type="button" className="text-button" disabled={busy} onClick={() => use(elsewhere)}>
                Use {elsewhere.name}
              </button>
            ) : null}
          </p>
        )}
        {keyShown ? (
          <label>
            API key
            <input
              type="password"
              value={key}
              placeholder={isLocal(draft.endpointUrl) ? "Only if your server asks for one" : "Paste the provider’s key"}
              onFocus={event => { if (keyMasked) event.currentTarget.select(); }}
              onClick={event => { if (keyMasked) event.currentTarget.select(); }}
              onKeyDown={event => {
                if (keyMasked && (event.key === "Backspace" || event.key === "Delete")) {
                  event.preventDefault();
                  setKey(""); setKeyMasked(false); setKeyEdited(true);
                }
              }}
              onChange={(event) => {
                setKey(keyMasked ? event.target.value.replaceAll("•", "") : event.target.value);
                setKeyMasked(false);
                setKeyEdited(true);
              }}
              autoComplete="new-password"
            />
            {keyMasked ? (
              <span className="muted">Saved securely. Clear to remove, or type to replace.</span>
            ) : keyEdited && !key ? (
              <span className="muted">The key will be removed when you save.</span>
            ) : preset?.requiresApiKey ? (
              <span className="muted">{preset.hint}</span>
            ) : null}
          </label>
        ) : (
          <button type="button" className="text-button settings-add-key" onClick={() => setKeyOpen(true)}>
            Add API key
          </button>
        )}
        <div className="settings-model-row">
          <label>
            Model
            <input
              value={draft.model}
              placeholder={preset ? preset.exampleModel : "Model identifier"}
              onChange={(event) =>
                setDraft((value) => ({ ...value, model: event.target.value }))
              }
            />
          </label>
          <MenuButton
            label="Available models"
            searchPlaceholder={'search models try "free"'}
            className="pill"
            items={
              models.length
                ? models.map((model) => ({
                    id: model.id,
                    label: modelName(model.id),
                    detail: model.contextWindow
                      ? `${model.contextWindow.toLocaleString('en')} tokens`
                      : undefined,
                    checked: draft.model === model.id,
                    // Only the choice. Main reads this model's published limits.
                    action: () => setDraft(value => ({ ...value, model: model.id })),
                  }))
                : [{ id: "empty", label: probe.state === 'checking' ? "Checking the server…" : probe.state === 'error' ? "Could not read this address" : "No models from this address", disabled: true }]
            }
          >
            <ChevronDown size={14} />
          </MenuButton>
        </div>
        {/* The model a plugin's subagents run on (pi-subagents): on this
            connection, or on another one the person kept — a local chat model
            with its subagents on a provider (user, 16.11). */}
        <div className="settings-model-row">
          <label>
            Model for subagents
            <input
              value={draft.subagentModel ?? ""}
              placeholder="Same as the chat"
              onChange={(event) => setDraft((value) => ({ ...value, subagentModel: event.target.value }))}
            />
            {subagentElsewhere && subagentUnlisted ? (
              <span className="settings-status" data-state="error" role="status">
                {subagentElsewhere.name} does not list that model. Subagents will use the chat’s model until it does.
              </span>
            ) : subagentElsewhere ? (
              <span className="muted">On {subagentElsewhere.name}, with that connection’s key. What the chat hands a subagent is sent there.</span>
            ) : probe.state === 'ok' && models.length > 0 && draft.subagentModel?.trim() &&
              !models.some(model => model.id === draft.subagentModel?.trim()) ? (
              <span className="settings-status" data-state="error" role="status">
                This address does not list that model. Subagents will use the chat’s model until it does.
              </span>
            ) : (
              <span className="muted">For plugins that start subagents, such as pi-subagents. Empty: they use the chat’s model. It can be a model of another connection you kept.</span>
            )}
          </label>
          <MenuButton
            label="Available models for subagents"
            searchPlaceholder={'search models try "free"'}
            className="pill"
            items={[
              { id: "same", label: "Same as the chat", checked: !draft.subagentModel?.trim(), action: () => setDraft(value => ({ ...value, subagentModel: "", subagentEndpointUrl: "" })) },
              ...models.map((model): MenuItem => ({
                id: `subagent:${model.id}`,
                label: modelName(model.id),
                ...(otherConnections.length ? { group: 'This connection' } : {}),
                checked: !subagentElsewhere && draft.subagentModel === model.id,
                action: () => setDraft(value => ({ ...value, subagentModel: model.id, subagentEndpointUrl: "" })),
              })),
              ...otherConnections.flatMap((connection): MenuItem[] => connection.models.length
                ? connection.models.map((model): MenuItem => ({
                  id: `subagent:${connection.endpointUrl} ${model.id}`,
                  label: modelName(model.id),
                  group: connection.name,
                  checked: subagentElsewhere?.endpointUrl === connection.endpointUrl && draft.subagentModel === model.id,
                  action: () => setDraft(value => ({ ...value, subagentModel: model.id, subagentEndpointUrl: connection.endpointUrl })),
                }))
                : [{ id: `subagent-unreachable:${connection.endpointUrl}`, label: connection.name, detail: connection.error ?? 'No models listed', group: connection.name, disabled: true }]),
            ]}
          >
            <ChevronDown size={14} />
          </MenuButton>
        </div>
        {actions}
      </div>
      )}
      </div>
    </div>
    </MenuLayerAbove>
  );
}
