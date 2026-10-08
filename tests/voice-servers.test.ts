import { describe, expect, it, vi } from 'vitest';
import { detectServers } from '../src/main/chat/local-servers';
import { isSpeechServer, isVoiceModelId, isWhisperServer } from '../src/main/voice/servers';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

describe('voice servers on this Mac', () => {
  it('keeps a speech server on 8000 out of the chat list, even though it lists Kokoro as models', async () => {
    const list = vi.fn(async (endpointUrl: string) => {
      if (endpointUrl.includes(':8000/')) return [{ id: 'kokoro' }];
      if (endpointUrl.includes(':11434/')) return [{ id: 'gemma4:12b' }];
      throw new Error('Model listing returned HTTP 404');
    });
    const found = await detectServers({
      ports: async () => [
        { pid: 1, command: 'python3.12', port: 8000 },
        { pid: 2, command: 'ollama', port: 11434 },
        { pid: 3, command: 'whisper-server', port: 8178 },
        { pid: 4, command: 'node', port: 3000 },
      ],
      list,
      speech: async baseUrl => baseUrl.endsWith(':8000'),
      whisper: async (baseUrl, command) => baseUrl.endsWith(':8178') && command === 'whisper-server',
    });
    expect(found.chat.map(server => server.name)).toEqual(['Ollama · 11434']);
    expect(found.voice).toEqual([
      { name: 'whisper.cpp · 8178', baseUrl: 'http://localhost:8178', kind: 'whisper.cpp' },
      { name: 'python3.12 · 8000', baseUrl: 'http://localhost:8000', kind: 'speech' },
    ]);
  });

  it('finds none when nothing speaks or listens', async () => {
    const found = await detectServers({
      ports: async () => [{ pid: 1, command: 'node', port: 3000 }],
      list: async () => { throw new Error('no'); },
      speech: async () => false,
      whisper: async () => false,
    });
    expect(found).toEqual({ chat: [], voice: [] });
  });

  it('tells voice and speech model ids from chat models', () => {
    for (const id of ['kokoro', 'tts-1', 'tts-1-hd', 'af_heart', 'bm_george', 'mlx-community/Kokoro-82M-bf16', 'mlx-community/whisper-large-v3-turbo', 'whisper-1'])
      expect(isVoiceModelId(id), id).toBe(true);
    for (const id of ['gemma4:12b', 'gpt-4o', 'qwen/qwen3-coder:free', 'llama-3.3-70b-instruct', '/Users/q/Models/Nex-N2.5-mini-Q8_0.gguf'])
      expect(isVoiceModelId(id), id).toBe(false);
  });

  it('asks GET /v1/audio/voices for a speech server', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/v1/audio/voices')
      ? json({ voices: ['af_heart', 'bm_george'] }) : json({}, 404));
    expect(await isSpeechServer('http://localhost:8880', fetcher as typeof fetch)).toBe(true);
    const empty = vi.fn(async () => json({ voices: [] }));
    expect(await isSpeechServer('http://localhost:8880', empty as typeof fetch)).toBe(false);
    const html = vi.fn(async () => new Response('<html>app</html>', { status: 200 }));
    expect(await isSpeechServer('http://localhost:3000', html as typeof fetch)).toBe(false);
  });

  it('takes whisper.cpp by its /inference route and its name, never a server that answers everything', async () => {
    const whisperPage = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'OPTIONS' && String(url).endsWith('/inference')) return new Response(null, { status: 200 });
      if (String(url).endsWith('/')) return new Response('<title>Whisper.cpp Server</title>', { status: 200 });
      return new Response('', { status: 404 });
    });
    expect(await isWhisperServer('http://localhost:8080', 'llama-server-ish', whisperPage as typeof fetch)).toBe(true);
    const anything = vi.fn(async () => new Response('<html>dev server</html>', { status: 200 }));
    expect(await isWhisperServer('http://localhost:3000', 'node', anything as typeof fetch)).toBe(false);
    const nothing = vi.fn(async () => new Response('', { status: 404 }));
    expect(await isWhisperServer('http://localhost:8178', 'whisper-server', nothing as typeof fetch)).toBe(false);
  });
});
