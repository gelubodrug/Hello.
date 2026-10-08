import type { VoiceServer } from '../../shared/types';

/**
 * Voice servers running on this Mac, found the way model servers are: Hello
 * asks the ports someone is listening on, and never starts a server itself.
 * Two shapes answer. An OpenAI-shaped speech server (Kokoro-FastAPI, mlx-audio)
 * lists its voices at GET /v1/audio/voices; whisper.cpp's whisper-server takes
 * audio at POST /inference and says so on its own page. A speech server often
 * also publishes /v1/models — Kokoro's ids — which is why the voice probe is
 * asked first and wins: its "models" are not something a chat can talk to.
 */

type Fetch = typeof globalThis.fetch;

/** A port is asked no longer than this per probe; a local server answers in milliseconds. */
export const VOICE_PROBE_MS = 1_000;

/** Model ids that speak or listen, never chat: Kokoro and its voices, TTS and STT models. */
const VOICE_MODEL = /kokoro|whisper|piper|parakeet|orpheus|(^|[-_/.])tts([-_/.]|$)/i;
/** Kokoro's voice ids — language letter, gender letter, name: af_heart, bm_george. */
const KOKORO_VOICE = /^[a-z][fm]_[a-z0-9]+$/i;

/** Whether a listed model id is a voice or a speech model rather than one to chat with. */
export function isVoiceModelId(id: string): boolean {
  return VOICE_MODEL.test(id) || KOKORO_VOICE.test(id);
}

async function ask(fetcher: Fetch, url: string, method: 'GET' | 'OPTIONS', timeoutMs: number): Promise<Response | null> {
  try {
    return await fetcher(url, { method, headers: { Accept: 'application/json, text/html;q=0.5' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  } catch {
    return null;
  }
}

async function body(response: Response, limit = 256_000): Promise<string> {
  try { return (await response.text()).slice(0, limit); } catch { return ''; }
}

/** (a) An OpenAI-shaped speech server: GET /v1/audio/voices answers with a list of voices. */
export async function isSpeechServer(base: string, fetcher: Fetch, timeoutMs = VOICE_PROBE_MS): Promise<boolean> {
  const response = await ask(fetcher, `${base}/v1/audio/voices`, 'GET', timeoutMs);
  if (!response?.ok) return false;
  try {
    const parsed: unknown = JSON.parse(await body(response));
    if (Array.isArray(parsed)) return parsed.length > 0;
    if (!parsed || typeof parsed !== 'object') return false;
    const { voices, data } = parsed as { voices?: unknown; data?: unknown };
    return (Array.isArray(voices) && voices.length > 0) || (Array.isArray(data) && data.length > 0);
  } catch {
    return false;
  }
}

/**
 * (b) whisper.cpp's server: /inference accepts a request (OPTIONS, or GET /load
 * where OPTIONS is not answered) and the process or its page names whisper. A
 * dev server that answers everything with 200 is not taken for one.
 */
export async function isWhisperServer(base: string, command: string, fetcher: Fetch, timeoutMs = VOICE_PROBE_MS): Promise<boolean> {
  const [options, load] = await Promise.all([
    ask(fetcher, `${base}/inference`, 'OPTIONS', timeoutMs),
    ask(fetcher, `${base}/load`, 'GET', timeoutMs),
  ]);
  const route = !!options?.ok || (!!load && load.status !== 404 && load.status < 500);
  if (!route) return false;
  if (/whisper/i.test(command)) return true;
  const page = await ask(fetcher, `${base}/`, 'GET', timeoutMs);
  return !!page?.ok && /whisper/i.test(await body(page, 64_000));
}

/** What a voice server is called: its product where the shape says it, else the process. */
export function voiceServerName(kind: VoiceServer['kind'], command: string, port: number): string {
  const label = kind === 'whisper.cpp' ? 'whisper.cpp'
    : /kokoro/i.test(command) ? 'Kokoro'
      : /mlx/i.test(command) ? 'mlx-audio'
        : command || 'Speech';
  return `${label} · ${port}`;
}
