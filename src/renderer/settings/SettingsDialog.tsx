import { useEffect, useState } from "react";
import { Blocks, Check, ChevronDown, Plug, RefreshCw, SlidersHorizontal, Star, AppWindow } from "lucide-react";
import type { AppSettings, SettingsPatch } from "../../shared/types";
import { api } from "../api";
import { Dialog, ErrorNote, MenuButton, errorText } from "../ui/primitives";
import { ExtensionsSection } from "./ExtensionsSection";
import { AppAuditSection } from "./AppAuditSection";
import { ENDPOINT_PRESETS, presetFor, suggestedName } from "./presets";

const reasoningOptions = [
  { value: "off", label: "Provider default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
] as const;
const approvalOptions = [
  { value: 'all', label: 'Work without asking', detail: 'Writes in the chat folder and shell commands run straight away' },
  { value: 'writes', label: 'Ask before commands', detail: 'Files in the chat folder are written; a shell command waits for you' },
  { value: 'ask', label: 'Ask every time', detail: 'Every file write and every command waits for you' },
] as const;
const compatibilityOptions = [
  { value: 'auto', label: 'Automatic' },
  { value: 'openai', label: 'OpenAI-compatible' },
  { value: 'qwen-chat-template', label: 'Local Qwen chat template' },
] as const;
const SAVED_KEY_MASK = "•".repeat(24);
const endpointIdentity = (value: string) => value.trim().replace(/\/+$/, "");

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
  const [keyMasked, setKeyMasked] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [section, setSection] = useState<'connection' | 'extensions' | 'app'>('connection');
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) {
      setSection('connection');
      setDraft(settings);
      setKey(settings.apiKeySet ? SAVED_KEY_MASK : "");
      setKeyMasked(settings.apiKeySet);
      setKeyEdited(false);
      setError(null);
      setSaved(false);
      setName("");
      setModels([]);
    }
  }, [open]);
  const remembered = settings.connections.find(
    entry => endpointIdentity(entry.endpointUrl) === endpointIdentity(draft.endpointUrl));
  const preset = presetFor(draft.endpointUrl);
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
    setModels([]);
    setName("");
  };
  const run = async (operation: () => Promise<AppSettings>) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try { adopt(await operation()); }
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
    contextWindow: draft.contextWindow ?? 32768,
    maxOutputTokens: draft.maxOutputTokens ?? 4096,
    modelCompatibility: draft.modelCompatibility ?? 'auto',
    approvals: draft.approvals ?? 'all',
    ...(keyEdited ? { apiKey: key } : {}),
  });
  const save = async (loadModels = false) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const result = await api.settings.save(patch());
      onSaved(result);
      setDraft(result);
      setKey(result.apiKeySet ? SAVED_KEY_MASK : "");
      setKeyMasked(result.apiKeySet);
      setKeyEdited(false);
      setSaved(true);
      if (loadModels) setModels(await api.settings.models());
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} title="Settings" onClose={onClose} wide>
<div className="settings-tabs" role="tablist" aria-label="Settings sections">
          {([
            { id: 'connection', label: 'Connection', Icon: SlidersHorizontal },
            { id: 'extensions', label: 'Extensions', Icon: Blocks },
            { id: 'app', label: 'App', Icon: AppWindow },
          ] as const).map(tab => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={section === tab.id}
              className="pill"
              onClick={() => setSection(tab.id)}
            >
              <tab.Icon size={14} aria-hidden />
              {tab.label}
            </button>
          ))}
        </div>
      {section === 'extensions' ? (
        <>
          <ExtensionsSection />
          <div className="dialog-actions">
            <button className="pill" onClick={onClose}>Close</button>
          </div>
        </>
      ) : section === 'app' ? (
        <>
          <AppAuditSection dataPath={dataPath} version={version} endpointUrl={settings.endpointUrl} extensionsLoaded={extensionsCount} />
          <div className="dialog-actions">
            <button className="pill" onClick={onClose}>Close</button>
          </div>
        </>
      ) : (
      <div className="settings-form">
        <p className="muted">
          Connect an OpenAI-compatible endpoint. Credentials stay in this app’s
          local settings.
        </p>
        <div className="settings-model-row">
          <label>
            Endpoint URL
            <input
              value={draft.endpointUrl}
              placeholder="http://localhost:1234/v1"
              onChange={(event) => pointAt(event.target.value)}
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
            items={
              settings.connections.length
                ? [
                    ...settings.connections.map(entry => ({
                      id: entry.endpointUrl,
                      label: entry.name,
                      detail: entry.model || entry.endpointUrl,
                      checked: endpointIdentity(entry.endpointUrl) === endpointIdentity(settings.endpointUrl),
                      action: () => void run(() => api.settings.useConnection(entry.endpointUrl)),
                    })),
                    { id: 'forget-separator', label: '', separator: true },
                    {
                      id: 'forget',
                      label: 'Forget…',
                      children: settings.connections
                        .filter(entry => endpointIdentity(entry.endpointUrl) !== endpointIdentity(settings.endpointUrl))
                        .map(entry => ({
                          id: `forget:${entry.endpointUrl}`,
                          label: entry.name,
                          detail: 'Also deletes its saved key',
                          action: () => void run(() => api.settings.forgetConnection(entry.endpointUrl)),
                        })),
                    },
                  ]
                : [{ id: 'empty', label: 'Nothing saved yet', disabled: true }]
            }
          >
            <Star size={14} aria-hidden />
            {remembered ? remembered.name : 'Saved'}
            <ChevronDown size={14} />
          </MenuButton>
        </div>
        {preset ? <span className="muted">{preset.hint}</span> : null}
        <label>
          API key
          <input
            type="password"
            value={key}
            placeholder="Optional for local servers"
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
          <span className="muted">{keyMasked ? "Saved securely. Clear to remove, or type to replace." : keyEdited && !key ? "The key will be removed when you save." : "Changes apply when you save."}</span>
        </label>
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
                    id: model,
                    label: model,
                    checked: draft.model === model,
                    action: () => setDraft((value) => ({ ...value, model })),
                  }))
                : [{ id: "empty", label: "Load models first", disabled: true }]
            }
          >
            <ChevronDown size={14} />
          </MenuButton>
        </div>
        <button
          className="text-button"
          disabled={busy}
          onClick={() => void save(true)}
        >
          <RefreshCw size={14} />
          Save connection & load models
        </button>
        <div className="settings-model-row">
          <label>
            Keep this connection as
            <input
              value={name}
              placeholder={remembered ? remembered.name : suggestedName(draft.endpointUrl) || "A name you will recognise"}
              onChange={event => setName(event.target.value)}
              autoComplete="off"
            />
          </label>
          <button
            className="pill"
            disabled={busy}
            title="Saves this endpoint, key and model, then keeps them under this name"
            onClick={() =>
              void run(async () => {
                // Keep what is on screen, not a stale save from before the edit.
                await api.settings.save(patch());
                return api.settings.rememberConnection(
                  name.trim() || remembered?.name || suggestedName(draft.endpointUrl));
              })
            }
          >
            {remembered ? 'Update' : 'Keep'}
          </button>
        </div>
        <div className="settings-two-columns">
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
        </div>
        <p className="muted">
          A file write is confined to this chat’s attached folder. A shell command is not:
          it runs with your account’s access. Choose “Ask every time” if this chat’s folder
          holds anything you would not hand to the model.
        </p>
        <div className="settings-two-columns">
          <label>
            Context window (tokens)
            <input
              type="number"
              min="20480"
              step="1"
              value={draft.contextWindow ?? 32768}
              onChange={event => setDraft(value => ({ ...value, contextWindow: Number(event.target.value) }))}
            />
          </label>
          <label>
            Maximum output (tokens)
            <input
              type="number"
              min="512"
              step="1"
              value={draft.maxOutputTokens ?? 4096}
              onChange={event => setDraft(value => ({ ...value, maxOutputTokens: Number(event.target.value) }))}
            />
          </label>
        </div>
        <p className="muted">
          Set the context window loaded by your server, which may be smaller than
          the model’s advertised maximum. The defaults are not detected values.
          Pi compacts automatically, reserving at least 16,384 tokens for output
          and request overhead. Maximum output includes reasoning tokens.
          This initial profile needs at least 20,480 context tokens.
        </p>
        <div className="settings-field">
          <span>Model compatibility</span>
          <MenuButton
            label="Model compatibility"
            className="settings-select"
            align="start"
            items={compatibilityOptions.map(option => ({
              id: option.value,
              label: option.label,
              checked: (draft.modelCompatibility ?? 'auto') === option.value,
              action: () => setDraft(value => ({ ...value, modelCompatibility: option.value })),
            }))}
          >
            <span>{compatibilityOptions.find(option => option.value === (draft.modelCompatibility ?? 'auto'))?.label}</span>
            <ChevronDown size={14} />
          </MenuButton>
          <span className="muted">
            Automatic uses known cloud-provider formatting. Select the local Qwen
            option when your server accepts Qwen chat-template parameters.
          </span>
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
        <div className="settings-storage">
          <span className="muted">App data</span>
          <button
            className="text-button truncate"
            title={dataPath}
            onClick={() => {
              void api.system
                .revealPath(dataPath)
                .catch((reason) => setError(errorText(reason)));
            }}
          >
            {dataPath}
          </button>
        </div>
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
          <button className="pill" onClick={onClose}>
            Close
          </button>
          <button
            className="pill primary-button"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save settings"}
          </button>
        </div>
      </div>
      )}
    </Dialog>
  );
}
