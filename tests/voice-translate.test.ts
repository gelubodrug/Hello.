import { describe, expect, it, vi } from 'vitest';
import { translateVoice, voiceAudio, VOICE_INPUT_LIMIT } from '../src/main/voice/translate';
import { VoiceActivity, voiceWav, recordVoice } from '../src/renderer/chat/voice-input';
import { SpeechPlayer } from '../src/renderer/chat/voice-playback';

const wav = voiceWav([new Float32Array(1600)], 16000);
describe('automatic voice turns', () => {
  it('closes after 900 ms silence, never sends an empty recording', () => {
    const vad = new VoiceActivity();
    expect(vad.push(new Float32Array(3200).fill(0.1), 16000)).toBe(false);
    expect(vad.heard).toBe(true);
    expect(vad.push(new Float32Array(12800), 16000)).toBe(false);
    expect(vad.push(new Float32Array(1600), 16000)).toBe(true);
    const empty = new VoiceActivity();
    expect(empty.push(new Float32Array(128000), 16000)).toBe(true);
    expect(empty.heard).toBe(false);
  });
  it('refuses invalid and oversized audio', () => {
    expect(() => voiceAudio(new Uint8Array(VOICE_INPUT_LIMIT + 1))).toThrow();
    expect(() => voiceAudio(new Uint8Array(44))).toThrow();
    expect(voiceAudio(wav)).toBe(wav);
  });
  it.each([true, false])('sends multipart to the correct server shape: whisper=%s', async whisper => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(String(url)).toMatch(whisper ? /\/inference$/ : /\/v1\/audio\/translations$/);
        const body = init.body as FormData;
        expect(body.get('file')).toBeInstanceOf(Blob);
        expect(body.get(whisper ? 'translate' : 'model')).toBe(whisper ? 'true' : 'chosen-model');
        if (whisper) expect(body.get('language')).toBe('ro');
        return Response.json({ text: ' Hello. ' });
      }
      return whisper ? new Response('whisper server') : new Response('', { status: 404 });
    });
    expect(await translateVoice('http://127.0.0.1:8080', wav, { model: 'chosen-model', language: 'ro' }, fetcher as typeof fetch)).toBe('Hello.');
  });
  it('keeps audio local and does not invent a model default', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 404 }));
    await expect(translateVoice('https://example.org', wav, {}, fetcher)).rejects.toThrow(/this Mac/);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(translateVoice('http://localhost:8080', wav, {}, fetcher)).rejects.toThrow(/Choose/);
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
