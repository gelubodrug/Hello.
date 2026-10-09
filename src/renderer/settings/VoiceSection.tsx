import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, AlertCircle } from "lucide-react";
import type { AppSettings, MicrophoneAccess, VoiceServer, VoiceSettings } from "../../shared/types";
import { DEFAULT_TTS_VOICE, KOKORO_VOICES, voiceName, type VoiceSetupStatus } from '../../shared/voice-setup';
import { api } from "../api";
import { ErrorNote, MenuButton, errorText } from "../ui/primitives";
import './VoiceSection.css';

const MICROPHONE: Record<MicrophoneAccess, string> = {
  "granted": "Hello. may use the microphone.",
  "not-determined": "macOS asks the first time you speak to Hello.",
  "denied": "macOS refused the microphone. Allow Hello. in System Settings › Privacy & Security › Microphone.",
  "restricted": "The microphone is restricted on this Mac.",
  "unknown": "macOS did not say whether Hello. may use the microphone.",
};

/**
 * One click, three visible stages. Main owns installation even while Settings
 * is closed. Existing local servers remain available under Advanced.
 */
export function VoiceSection({ settings, servers, onSaved }: {
  settings: AppSettings;
  /** The voice servers the last look found; null while it looks. */
  servers: VoiceServer[] | null;
  onSaved: (settings: AppSettings) => void;
}) {
  const [draft, setDraft] = useState<VoiceSettings>(settings.voice ?? { enabled: false });
  const [microphone, setMicrophone] = useState<MicrophoneAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<VoiceSetupStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const alive = useRef(true);
  useEffect(() => { setDraft(settings.voice ?? { enabled: false }); }, [settings.voice]);
  useEffect(() => {
    alive.current = true;
    let receivedEvent = false;
    const off = api.voice?.onStatus?.(status => { receivedEvent = true; setSetup(status); });
    void api.voice?.status?.().then(status => { if (alive.current && status && !receivedEvent) setSetup(status); }, reason => { if (alive.current) setError(errorText(reason)); });
    void api.voice?.microphone?.().then(setMicrophone, () => setMicrophone("unknown"));
    return () => { alive.current = false; off?.(); };
  }, []);
  const preparing = installing || setup?.state === 'preparing';
  const install = async () => {
    if (!api.voice?.prepare || preparing) return;
    setInstalling(true); setError(null);
    try {
      const result = await api.voice.prepare(true);
      onSaved(result.settings);
      if (alive.current) { setSetup(result.status); setSaved(true); }
    } catch (reason) { if (alive.current) setError(errorText(reason)); }
    finally { if (alive.current) setInstalling(false); }
  };
  const speech = servers?.find(server => server.kind === "speech");
  const source = (url: string) => { void api.system.openExternal(url).catch(reason => setError(errorText(reason))); };
  const whisper = servers?.find(server => server.kind === "whisper.cpp");
  const field = (key: Exclude<keyof VoiceSettings, "enabled" | "autoSend">) => ({
    value: draft[key] ?? "",
    onChange: (event: { target: { value: string } }) => { setSaved(false); setDraft(value => ({ ...value, [key]: event.target.value })); },
  });
  const save = async (next: VoiceSettings) => {
    setBusy(true); setError(null); setSaved(false);
    // A model or voice left as it was goes with the server it came from: main
    // clears it when the server changes, unless one was typed for the new one.
    const kept = settings.voice;
    const moved = (server: string | undefined, before: string | undefined) => (server?.trim() || undefined) !== before;
    const sttModel = moved(next.sttEndpointUrl, kept?.sttEndpointUrl) && next.sttModel === kept?.sttModel ? undefined : next.sttModel ?? "";
    const ttsVoice = moved(next.ttsEndpointUrl, kept?.ttsEndpointUrl) && next.ttsVoice === kept?.ttsVoice ? undefined : next.ttsVoice ?? "";
    try {
      onSaved(await api.settings.save({ voice: {
        enabled: next.enabled,
        autoSend: next.autoSend === true,
        sttEndpointUrl: next.sttEndpointUrl ?? "", sourceLanguage: next.sourceLanguage ?? "", ttsEndpointUrl: next.ttsEndpointUrl ?? "",
        ...(sttModel !== undefined ? { sttModel } : {}),
        ...(ttsVoice !== undefined ? { ttsVoice } : {}),
      } }));
      setSaved(true);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  return (
    <div className="settings-form">
      <section className="voice-setup" aria-label="Install Voice" aria-busy={preparing}>
        <p className="voice-setup-title">Voice on this Mac</p>
        <p className="muted">Speak to Hello. and hear its replies. One click installs the engines and models in order on macOS 14 or later. Your audio stays on this Mac.</p>
        {setup && <ol className="voice-setup-steps">
          {setup.steps.map((step, index) => <li key={step.id} data-state={step.state}>
            <span className="voice-step-icon" aria-hidden="true">{step.state === 'done' ? <Check size={16} /> : step.state === 'working' ? <Loader2 size={16} className="spin" /> : step.state === 'error' ? <AlertCircle size={16} /> : index + 1}</span>
            <div className="voice-step-copy">
              <span className="voice-step-title">{step.title}<small>{step.state === 'done' ? 'Ready' : step.state === 'working' ? 'Installing' : step.state === 'error' ? 'Needs attention' : 'Waiting'}</small></span>
              <span className="muted" role={step.state === 'working' || step.state === 'error' ? 'status' : undefined}>{step.detail}</span>
              {step.total !== undefined && step.received !== undefined && <>
                <progress aria-label={`${step.title} download`} value={step.received} max={step.total} />
                <small className="muted">{(step.received / 1_000_000).toFixed(1)} / {(step.total / 1_000_000).toFixed(1)} MB</small>
              </>}
            </div>
          </li>)}
        </ol>}
        <p className="muted">{setup?.state === 'ready' ? 'Voice is ready. Use the microphone beside your message.'
          : setup?.installed ? 'Installed components are kept. Missing or damaged downloads can be repaired here.'
          : `Download up to ${((setup?.downloadBytes ?? 1_781_000_000) / 1_000_000_000).toFixed(2)} GB. Existing local servers are reused. Allow about 3 GB of free disk space.`}</p>
        {setup && !setup.supported && <p className="muted">Automatic installation requires macOS 14 or later on Apple Silicon or Intel. You can configure an existing local server below.</p>}
        <div className="dialog-actions">
          {preparing ? <button className="pill" onClick={() => void api.voice?.cancel?.().catch(reason => setError(errorText(reason)))}>Cancel installation</button>
            : setup?.state !== 'ready' && <button className="pill primary-button" disabled={busy || !api.voice?.prepare || !setup?.supported} onClick={() => void install()}>
              {setup?.state === 'error' ? 'Continue installation' : setup?.installed ? 'Start Voice' : 'Install Voice'}
            </button>}
        </div>
        <details className="voice-sources"><summary>Download sources</summary><p className="muted">
          <button className="text-button" onClick={() => source('https://github.com/sjoerdteunisse/whisper.cpp/releases/tag/v1.0.0')}>Whisper engine · OpenWhispr build</button><br />
          <button className="text-button" onClick={() => source('https://huggingface.co/ggerganov/whisper.cpp')}>Whisper model · ggerganov</button><br />
          <button className="text-button" onClick={() => source('https://github.com/k2-fsa/sherpa-onnx/releases')}>Kokoro and speech engine · sherpa-onnx</button>
        </p></details>
        <ErrorNote error={setup?.error ?? null} />
      </section>
      <label className="dialog-check">
        <input type="checkbox" checked={draft.enabled} disabled={busy || preparing || !api.voice}
          onChange={event => { const enabled = event.currentTarget.checked; setDraft(value => ({ ...value, enabled })); void save({ ...draft, enabled }); }} />
        Voice: use the microphone, and confirm a finished reply aloud in one line, in English.
      </label>
      {/* What happens when the words are written out (user, 09.10). */}
      <label className="dialog-check">
        <input type="checkbox" checked={draft.autoSend === true} disabled={busy || preparing || !api.voice || !draft.enabled}
          onChange={event => { const autoSend = event.currentTarget.checked; setDraft(value => ({ ...value, autoSend })); void save({ ...draft, autoSend }); }} />
        Auto Send
      </label>
      <p className="muted">
        {servers === null ? "Looking for voice servers…"
          : servers.length ? `Found on this Mac: ${servers.map(server => server.name).join(", ")}.`
            : "No external voice server found. Install Voice above to let Hello. manage it."}
      </p>
      <details className="voice-advanced"><summary>Advanced · existing servers and voice</summary>
      <div className="settings-form">
      <label>
        Speech server
        <input {...field("ttsEndpointUrl")} placeholder={speech?.baseUrl ?? "http://localhost:8880"} spellCheck={false} />
      </label>
      <div className="settings-field">
        <span>Voice</span>
        {/* Kokoro's voices by name; one set by hand for another server stays on the list. */}
        <MenuButton label="Voice" className="settings-select" align="start" searchPlaceholder="Search voices"
          items={[...new Set([...KOKORO_VOICES, draft.ttsVoice || DEFAULT_TTS_VOICE])].map(id => ({
            id, label: voiceName(id).name, group: voiceName(id).kind,
            checked: (draft.ttsVoice || DEFAULT_TTS_VOICE) === id,
            action: () => { setSaved(false); setDraft(value => ({ ...value, ttsVoice: id })); },
          }))}>
          <span>{voiceName(draft.ttsVoice || DEFAULT_TTS_VOICE).name} · {voiceName(draft.ttsVoice || DEFAULT_TTS_VOICE).kind}</span>
          <ChevronDown size={14} />
        </MenuButton>
      </div>
      <label>
        Speech-to-text server
        <input {...field("sttEndpointUrl")} placeholder={whisper?.baseUrl ?? "http://localhost:8080"} spellCheck={false} />
      </label>
      <div className="settings-numbers">
        <label>
          Speech-to-text model
          <input {...field("sttModel")} placeholder="large-v3-turbo" spellCheck={false} />
        </label>
        <label>
          Language you speak
          <input {...field("sourceLanguage")} placeholder="ro" spellCheck={false} />
        </label>
      </div>
      <div className="dialog-actions">
        <span className="settings-saved">{saved && (<><Check size={14} />Saved</>)}</span>
        <button className="pill primary-button" disabled={busy || preparing || !api.voice} onClick={() => void save(draft)}>
          {busy ? "Saving…" : "Save voice"}
        </button>
      </div>
      </div>
      </details>
      <p className="muted">Microphone: {microphone ? MICROPHONE[microphone] : "…"}</p>
      <ErrorNote error={error === setup?.error ? null : error} />
    </div>
  );
}
