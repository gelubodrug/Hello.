import { loopbackBase } from './speak';
import { isWhisperServer } from './servers';
import type { VoiceTranscript } from '../../shared/types';

export const VOICE_INPUT_LIMIT = 12 * 1024 * 1024;
/** The most a transcription answer may be: a minute of speech with its segments, words and tokens. */
const ANSWER_LIMIT = 1024 * 1024;
export function voiceAudio(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 44 || value.byteLength > VOICE_INPUT_LIMIT)
    throw new Error('Voice audio must be a WAV clip smaller than 12 MB.');
  if (Buffer.from(value.subarray(0, 4)).toString() !== 'RIFF' || Buffer.from(value.subarray(8, 12)).toString() !== 'WAVE')
    throw new Error('Voice audio must be a WAV clip.');
  return value;
}

/**
 * What was said, written out in the language it was said in — never
 * translated: large-v3-turbo, the model Hello installs, was not trained to
 * translate, and asking it to mangles the words (user, 09.10). The prompt goes
 * to a model that reads the person's language anyway. Audio stays on this Mac.
 * `language` pins the language once a turn knows it, so a pass over a few
 * English product names does not switch the rest of it to English.
 */
export async function transcribeVoice(server: string, audio: Uint8Array, options: { model?: string; language?: string }, fetcher: typeof fetch = fetch): Promise<VoiceTranscript> {
  voiceAudio(audio);
  const base = loopbackBase(server);
  const whisper = await isWhisperServer(base, '', fetcher);
  if (!whisper && !options.model) throw new Error('Choose the speech-to-text model in Settings › Voice.');
  const form = new FormData();
  form.set('file', new Blob([audio as BlobPart], { type: 'audio/wav' }), 'voice.wav');
  if (options.language) form.set('language', options.language);
  if (whisper) {
    form.set('translate', 'false');
    // Segments with how sure the model was there was speech, and the language it heard.
    form.set('response_format', 'verbose_json');
    // No [music], ♪ or (applause) in a prompt.
    form.set('suppress_nst', 'true');
  } else {
    form.set('model', options.model!);
    form.set('response_format', 'json');
  }
  const response = await fetcher(`${base}${whisper ? '/inference' : '/v1/audio/transcriptions'}`, {
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
      if (bytes > ANSWER_LIMIT) throw new Error('The speech-to-text response is too long.');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel(); }
  return heardText(JSON.parse(text));
}

/** Whisper's own sign-offs, learned from captions: what it writes over a clip with no speech in it. */
const SIGN_OFFS = new Set(['thank you', 'thanks for watching', 'thank you for watching', 'you', 'bye', 'mulțumesc', 'mulțumim', 'mulțumesc pentru vizionare', 'vă mulțumesc']);
const fold = (text: string) => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

/**
 * The words of an answer, without what the model wrote over silence. A segment
 * it was sure held no speech, and was unsure of its own words in, is dropped —
 * Whisper's own test (no-speech probability over 0.6, mean log-probability
 * under −1). A whole answer that is only a caption sign-off ("Thank you.") is
 * dropped when the model doubted there was speech at all. The language comes
 * from the likeliest of the codes the server weighed.
 */
export function heardText(result: unknown): VoiceTranscript {
  const answer = (result && typeof result === 'object' ? result : {}) as {
    text?: unknown; segments?: unknown; language_probabilities?: unknown;
  };
  if (typeof answer.text !== 'string') throw new Error('The speech-to-text server sent no text.');
  const segments = Array.isArray(answer.segments)
    ? answer.segments.filter((segment): segment is { text: string; no_speech_prob?: number; avg_logprob?: number } =>
      !!segment && typeof (segment as { text?: unknown }).text === 'string')
    : null;
  const silent = (segment: { no_speech_prob?: number; avg_logprob?: number }) =>
    typeof segment.no_speech_prob === 'number' && segment.no_speech_prob > 0.6 && (segment.avg_logprob ?? 0) < -1;
  let text = (segments ? segments.filter(segment => !silent(segment)).map(segment => segment.text).join('') : answer.text)
    .trim().replace(/^\[(?:blank_audio|silence|no speech)\]$/i, '');
  const doubted = !segments || segments.some(segment => (segment.no_speech_prob ?? 0) > 0.2);
  if (doubted && SIGN_OFFS.has(fold(text))) text = '';
  const weighed = answer.language_probabilities && typeof answer.language_probabilities === 'object'
    ? Object.entries(answer.language_probabilities as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    : [];
  const likeliest = weighed.sort((a, b) => b[1] - a[1])[0]?.[0];
  return { text, ...(likeliest && /^[a-z]{2,3}$/.test(likeliest) ? { language: likeliest } : {}) };
}
