export type VoiceStepId = 'server' | 'model' | 'speech';
export interface VoiceSetupStep {
  id: VoiceStepId;
  title: string;
  state: 'pending' | 'working' | 'done' | 'error';
  detail: string;
  received?: number;
  total?: number;
}
export interface VoiceSetupStatus {
  state: 'idle' | 'preparing' | 'ready' | 'error';
  supported: boolean;
  installed: boolean;
  downloadBytes: number;
  steps: VoiceSetupStep[];
  error?: string;
}

/** The voices of Kokoro v1.0, the speech model Hello installs; the speaker id is the place in this list. */
export const KOKORO_VOICES: readonly string[] = ['af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa', 'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily', 'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis'];
export const DEFAULT_TTS_VOICE = 'af_heart';
/** A voice as a person reads it: af_heart is Heart, an American female voice. */
export function voiceName(id: string): { name: string; kind: string } {
  const match = /^([ab])([fm])_(\w+)$/.exec(id);
  if (!match) return { name: id, kind: 'Other' };
  return {
    name: match[3].charAt(0).toUpperCase() + match[3].slice(1),
    kind: `${match[1] === 'a' ? 'American' : 'British'} ${match[2] === 'f' ? 'female' : 'male'}`,
  };
}
