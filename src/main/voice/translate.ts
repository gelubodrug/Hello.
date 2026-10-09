import { loopbackBase } from './speak';
import { isWhisperServer } from './servers';

export const VOICE_INPUT_LIMIT = 12 * 1024 * 1024;
export function voiceAudio(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 44 || value.byteLength > VOICE_INPUT_LIMIT)
    throw new Error('Voice audio must be a WAV clip smaller than 12 MB.');
  if (Buffer.from(value.subarray(0, 4)).toString() !== 'RIFF' || Buffer.from(value.subarray(8, 12)).toString() !== 'WAVE')
    throw new Error('Voice audio must be a WAV clip.');
  return value;
}

/** Audio stays on this Mac. No default model is selected before the P4 comparison. */
export async function translateVoice(server: string, audio: Uint8Array, options: { model?: string; language?: string }, fetcher: typeof fetch = fetch): Promise<string> {
  voiceAudio(audio);
  const base = loopbackBase(server);
  const whisper = await isWhisperServer(base, '', fetcher);
  if (!whisper && !options.model) throw new Error('Choose the speech-to-text model in Settings › Voice.');
  const form = new FormData();
  form.set('file', new Blob([audio as BlobPart], { type: 'audio/wav' }), 'voice.wav');
  form.set('response_format', 'json');
  if (whisper) {
    form.set('translate', 'true');
    if (options.language) form.set('language', options.language);
  } else form.set('model', options.model!);
  const response = await fetcher(`${base}${whisper ? '/inference' : '/v1/audio/translations'}`, {
    method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`The speech-to-text server answered HTTP ${response.status}.`);
  // Bound the response while reading, not only after allocating it.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The speech-to-text server sent no text.');
  let text = ''; let bytes = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 100_000) throw new Error('The speech-to-text response is too long.');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel(); }
  const result = JSON.parse(text) as { text?: unknown };
  if (typeof result.text !== 'string') throw new Error('The speech-to-text server sent no text.');
  return result.text.trim().replace(/^\[(?:blank_audio|silence|no speech)\]$/i, '');
}
