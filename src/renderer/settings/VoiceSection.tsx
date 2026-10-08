import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import type { AppSettings, MicrophoneAccess, VoiceServer, VoiceSettings } from "../../shared/types";
import { api } from "../api";
import { ErrorNote, errorText } from "../ui/primitives";

const MICROPHONE: Record<MicrophoneAccess, string> = {
  "granted": "Hello. may use the microphone.",
  "not-determined": "macOS asks the first time you speak to Hello.",
  "denied": "macOS refused the microphone. Allow Hello. in System Settings › Privacy & Security › Microphone.",
  "restricted": "The microphone is restricted on this Mac.",
  "unknown": "macOS did not say whether Hello. may use the microphone.",
};

/**
 * Voice, in one place: the switch, the servers Hello found on this Mac (it
 * never starts one), which ones to use, and what macOS says about the
 * microphone. A model and a voice belong to their server: pointing at another
 * clears them.
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
  useEffect(() => { setDraft(settings.voice ?? { enabled: false }); }, [settings.voice]);
  useEffect(() => {
    void api.voice?.microphone?.().then(setMicrophone, () => setMicrophone("unknown"));
  }, []);
  const speech = servers?.find(server => server.kind === "speech");
  const whisper = servers?.find(server => server.kind === "whisper.cpp");
  const field = (key: Exclude<keyof VoiceSettings, "enabled">) => ({
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
      <label className="dialog-check">
        <input type="checkbox" checked={draft.enabled} disabled={busy || !api.voice}
          onChange={event => { const enabled = event.currentTarget.checked; setDraft(value => ({ ...value, enabled })); void save({ ...draft, enabled }); }} />
        Voice: read finished replies aloud, in English, through the voice server on this Mac.
      </label>
      <p className="muted">
        {servers === null ? "Looking for voice servers…"
          : servers.length ? `Found on this Mac: ${servers.map(server => server.name).join(", ")}.`
            : "No voice server is running on this Mac. Hello. finds one; it does not start one."}
      </p>
      <label>
        Speech server
        <input {...field("ttsEndpointUrl")} placeholder={speech?.baseUrl ?? "http://localhost:8880"} spellCheck={false} />
      </label>
      <label>
        Voice
        <input {...field("ttsVoice")} placeholder="af_heart" spellCheck={false} />
      </label>
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
      <p className="muted">Microphone: {microphone ? MICROPHONE[microphone] : "…"}</p>
      <ErrorNote error={error} />
      <div className="dialog-actions">
        <span className="settings-saved">{saved && (<><Check size={14} />Saved</>)}</span>
        <button className="pill primary-button" disabled={busy || !api.voice} onClick={() => void save(draft)}>
          {busy ? "Saving…" : "Save voice"}
        </button>
      </div>
    </div>
  );
}
