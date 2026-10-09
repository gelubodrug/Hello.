import { describe, expect, it, vi } from 'vitest';
import { heardText, transcribeVoice, voiceAudio, VOICE_INPUT_LIMIT } from '../src/main/voice/transcribe';
import { VoiceActivity, voiceWav, recordVoice } from '../src/renderer/chat/voice-input';
import { SpeechPlayer } from '../src/renderer/chat/voice-playback';

const wav = voiceWav([new Float32Array(1600)], 16000);
describe('automatic voice turns', () => {
  it('lets a pause be thinking, and closes a button held over nothing', () => {
    // The person holding the microphone ends the turn (user, 09.10): a pause
    // in the middle of it — half a minute of it — is them thinking.
    const vad = new VoiceActivity();
    expect(vad.push(new Float32Array(3200).fill(0.1), 16000)).toBe(false);
    expect(vad.heard).toBe(true);
    expect(vad.push(new Float32Array(16000 * 30), 16000)).toBe(false);
    expect(vad.push(new Float32Array(16000 * 31), 16000)).toBe(true);
    const empty = new VoiceActivity();
    expect(empty.push(new Float32Array(128000), 16000)).toBe(true);
    expect(empty.heard).toBe(false);
  });
  it('refuses invalid and oversized audio', () => {
    expect(() => voiceAudio(new Uint8Array(VOICE_INPUT_LIMIT + 1))).toThrow();
    expect(() => voiceAudio(new Uint8Array(44))).toThrow();
    expect(voiceAudio(wav)).toBe(wav);
  });
  // Transcribed in the language spoken, never translated: large-v3-turbo was
  // not trained to translate, and asked to, it mangled Romanian (user, 09.10).
  it.each([true, false])('transcribes, never translates, in the server\'s own shape: whisper=%s', async whisper => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(String(url)).toMatch(whisper ? /\/inference$/ : /\/v1\/audio\/transcriptions$/);
        const body = init.body as FormData;
        expect(body.get('file')).toBeInstanceOf(Blob);
        expect(body.get('language')).toBe('ro');
        if (whisper) {
          expect(body.get('translate')).toBe('false');
          expect(body.get('response_format')).toBe('verbose_json');
          expect(body.get('suppress_nst')).toBe('true');
        } else expect(body.get('model')).toBe('chosen-model');
        return Response.json({ text: ' Caută cel mai ieftin MacBook. ' });
      }
      return whisper ? new Response('whisper server') : new Response('', { status: 404 });
    });
    expect(await transcribeVoice('http://127.0.0.1:8080', wav, { model: 'chosen-model', language: 'ro' }, fetcher as typeof fetch))
      .toEqual({ text: 'Caută cel mai ieftin MacBook.' });
  });
  it('keeps audio local and does not invent a model default', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 404 }));
    await expect(transcribeVoice('https://example.org', wav, {}, fetcher)).rejects.toThrow(/this Mac/);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(transcribeVoice('http://localhost:8080', wav, {}, fetcher)).rejects.toThrow(/Choose/);
  });
  it('drops what the model wrote over silence, and says the language it heard', () => {
    // Whisper's own test: sure there was no speech, and unsure of its words there.
    expect(heardText({
      text: ' Caută cel mai ieftin MacBook. Thank you.',
      language: 'romanian',
      language_probabilities: { en: 0.12, ro: 0.86, it: 0.02 },
      segments: [
        { text: ' Caută cel mai ieftin MacBook.', no_speech_prob: 0.01, avg_logprob: -0.2 },
        { text: ' Thank you.', no_speech_prob: 0.82, avg_logprob: -1.4 },
      ],
    })).toEqual({ text: 'Caută cel mai ieftin MacBook.', language: 'ro' });
    // A clip that is only a caption sign-off, where the model doubted there was speech, is nothing.
    expect(heardText({ text: ' Thank you.', segments: [{ text: ' Thank you.', no_speech_prob: 0.4, avg_logprob: -0.5 }] }).text).toBe('');
    // Said clearly, it stays: people do say thank you.
    expect(heardText({ text: ' Thank you.', segments: [{ text: ' Thank you.', no_speech_prob: 0.01, avg_logprob: -0.2 }] }).text).toBe('Thank you.');
    expect(heardText({ text: '[BLANK_AUDIO]' }).text).toBe('');
    expect(() => heardText({})).toThrow(/no text/);
  });
  it('propagates microphone denial without constructing an audio context', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(new Error('Permission denied')) } });
    try { await expect(recordVoice(new AbortController().signal, vi.fn())).rejects.toThrow('Permission denied'); }
    finally { vi.unstubAllGlobals(); }
  });
  it('stops TTS and prevents playback during microphone capture', async () => {
    const speak = vi.fn(); const player = new SpeechPlayer({ speak, play: vi.fn() });
    const release = SpeechPlayer.listen();
    try { await player.say('Hello.'); expect(speak).not.toHaveBeenCalled(); }
    finally { release(); }
  });
});
