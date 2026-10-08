import type { VoiceSpeech } from '../../shared/types';

/**
 * A reply, spoken by the Kokoro server the person runs on this Mac. Both
 * servers Hello knows take the OpenAI request at POST /v1/audio/speech, and
 * differ in one thing: Kokoro-FastAPI calls its model `kokoro`, mlx-audio wants
 * the repository it loads (`mlx-community/Kokoro-82M-bf16`). Which one answers
 * is read from its /v1/models; nothing is guessed beyond that. English only:
 * the chat model replies in English and Kokoro is asked for American English.
 */

type Fetch = typeof globalThis.fetch;

export const DEFAULT_TTS_VOICE = 'af_heart';
/** Kokoro-FastAPI's model name, and what is asked when a server lists none. */
const FASTAPI_MODEL = 'kokoro';
/** One spoken sentence is a few hundred kilobytes of WAV; this is far past it. */
export const SPEECH_BYTE_LIMIT = 16 * 1024 * 1024;
/** What one request may carry: a chunk, not a reply. */
export const SPEECH_TEXT_LIMIT = 2_000;
const SPEECH_TIMEOUT_MS = 60_000;

export type SpeechShape = { kind: 'kokoro-fastapi' | 'mlx-audio'; model: string };

/** Speech goes only to a server on this Mac: a reply is never sent off it to be read aloud. */
export function loopbackBase(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('The voice server address is not a URL.'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('The voice server address must be http.');
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(parsed.hostname)) throw new Error('The voice server must run on this Mac.');
  return `${parsed.protocol}//${parsed.host}`;
}

/** The two shapes, from the ids a server lists: a Kokoro repository id is mlx-audio's. */
export function speechShape(modelIds: readonly string[]): SpeechShape {
  const repository = modelIds.find(id => id.includes('/') && /kokoro/i.test(id));
  if (repository) return { kind: 'mlx-audio', model: repository };
  return { kind: 'kokoro-fastapi', model: modelIds.find(id => /^kokoro$/i.test(id)) ?? FASTAPI_MODEL };
}

export function speechBody(shape: SpeechShape, text: string, voice: string): Record<string, unknown> {
  return {
    model: shape.model,
    input: text,
    voice: voice || DEFAULT_TTS_VOICE,
    response_format: 'wav',
    // American English, the one language a reply is spoken in.
    lang_code: 'a',
    ...(shape.kind === 'kokoro-fastapi' ? { stream: false } : {}),
  };
}

async function listedIds(fetcher: Fetch, base: string): Promise<string[]> {
  try {
    const response = await fetcher(`${base}/v1/models`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3_000), redirect: 'error' });
    if (!response.ok) return [];
    const body = await response.json() as { data?: Array<{ id?: unknown }>; models?: Array<{ id?: unknown }> };
    const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
    return rows.map(row => (typeof row?.id === 'string' ? row.id : '')).filter(Boolean);
  } catch {
    return [];
  }
}

export class VoiceSpeaker {
  private readonly shapes = new Map<string, Promise<SpeechShape>>();
  constructor(private readonly fetcher: Fetch = globalThis.fetch) {}

  /** One chunk of prose as audio, from the server at `serverUrl`. */
  async speak(serverUrl: string, text: string, voice: string, signal?: AbortSignal): Promise<VoiceSpeech> {
    const input = text.trim();
    if (!input) throw new Error('There is nothing to say.');
    if (input.length > SPEECH_TEXT_LIMIT) throw new Error('That is too long to say at once.');
    const base = loopbackBase(serverUrl);
    let shape = this.shapes.get(base);
    if (!shape) this.shapes.set(base, shape = listedIds(this.fetcher, base).then(speechShape));
    const response = await this.fetcher(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/wav, audio/*' },
      body: JSON.stringify(speechBody(await shape, input, voice)),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(SPEECH_TIMEOUT_MS)]) : AbortSignal.timeout(SPEECH_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok) {
      // The shape may have been read from a server since replaced: ask again next time.
      this.shapes.delete(base);
      throw new Error(`The voice server answered HTTP ${response.status}.`);
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > SPEECH_BYTE_LIMIT) throw new Error('The voice server sent more audio than one sentence.');
    const audio = new Uint8Array(await response.arrayBuffer());
    if (audio.byteLength > SPEECH_BYTE_LIMIT) throw new Error('The voice server sent more audio than one sentence.');
    if (!audio.byteLength) throw new Error('The voice server sent no audio.');
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim();
    return { audio, mime: mime.startsWith('audio/') ? mime : 'audio/wav' };
  }
}
