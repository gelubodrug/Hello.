import { describe, expect, it, vi } from 'vitest';
import { VoiceSpeaker, loopbackBase, speechBody, speechShape } from '../src/main/voice/speak';
import { speechChunks, spokenConfirmation, spokenProse } from '../src/shared/speech-text';
import { SpeechPlayer, replyFinished, spokenReply } from '../src/renderer/chat/voice-playback';
import type { Message, VoiceSpeech } from '../src/shared/types';

const wav = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

describe('speaking a reply through the Kokoro server', () => {
  it('tells mlx-audio from Kokoro-FastAPI by what it lists', () => {
    expect(speechShape(['mlx-community/Kokoro-82M-bf16', 'mlx-community/whisper-large-v3-turbo'])).toEqual({ kind: 'mlx-audio', model: 'mlx-community/Kokoro-82M-bf16' });
    expect(speechShape(['kokoro', 'tts-1', 'tts-1-hd'])).toEqual({ kind: 'kokoro-fastapi', model: 'kokoro' });
    expect(speechShape([])).toEqual({ kind: 'kokoro-fastapi', model: 'kokoro' });
    expect(speechBody({ kind: 'mlx-audio', model: 'm/Kokoro' }, 'Hello.', '')).toMatchObject({ model: 'm/Kokoro', input: 'Hello.', voice: 'af_heart', response_format: 'wav', lang_code: 'a' });
  });

  it('sends a reply only to a server on this Mac', () => {
    expect(loopbackBase('http://localhost:8880/v1')).toBe('http://localhost:8880');
    expect(loopbackBase('http://127.0.0.1:8000')).toBe('http://127.0.0.1:8000');
    expect(() => loopbackBase('https://api.example.com')).toThrow(/this Mac/);
    expect(() => loopbackBase('file:///tmp/x')).toThrow();
  });

  it('posts the chunk to /v1/audio/speech and hands back the audio', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/v1/models')) return Response.json({ data: [{ id: 'kokoro' }] });
      expect(String(url)).toBe('http://localhost:8880/v1/audio/speech');
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'kokoro', input: 'Hi there.', voice: 'bm_george' });
      return new Response(wav, { headers: { 'Content-Type': 'audio/wav' } });
    });
    const clip = await new VoiceSpeaker(fetcher as typeof fetch).speak('http://localhost:8880', 'Hi there.', 'bm_george');
    expect(clip.mime).toBe('audio/wav');
    expect([...clip.audio]).toEqual([...wav]);
  });

  it('says why a server refused', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/v1/models') ? Response.json({ data: [] }) : new Response('no', { status: 500 }));
    await expect(new VoiceSpeaker(fetcher as typeof fetch).speak('http://localhost:8880', 'Hi.', '')).rejects.toThrow('HTTP 500');
  });
});

describe('what of a reply is read aloud', () => {
  it('reads prose, never code, tables or addresses', () => {
    const prose = spokenProse([
      '## Done', '', 'I changed **two** files, see [the diff](https://example.com/d).', '',
      '```ts', 'const x = 1;', '```', '', '| a | b |', '|---|---|', '| 1 | 2 |', '',
      '- Run `pnpm test` next.', 'More at https://example.com/x.',
    ].join('\n'));
    expect(prose).not.toMatch(/const x|\||https?:|```|\*\*|##/);
    expect(prose).toContain('I changed two files, see the diff.');
    expect(prose).toContain('Run pnpm test next.');
  });

  it('cuts prose into sentences, the first one short', () => {
    const chunks = speechChunks('First. Second sentence here. Third one. ' + 'word '.repeat(120).trim() + '.', 120);
    expect(chunks[0]).toBe('First.');
    expect(chunks.every(chunk => chunk.length <= 120)).toBe(true);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toContain('Second sentence here. Third one.');
  });
});

describe('the spoken reply', () => {
  const clip: VoiceSpeech = { audio: wav, mime: 'audio/wav' };

  it('plays chunk after chunk, and a stop drains the rest with the mic told at once', async () => {
    const played: string[] = [];
    let endFirst = () => {};
    const stops: string[] = [];
    const speak = vi.fn(async (text: string) => ({ ...clip, mime: text }));
    const player = new SpeechPlayer({
      speak,
      play: spoken => {
        played.push(spoken.mime);
        return { done: new Promise<void>(resolve => { endFirst = resolve; }), stop: () => { stops.push(spoken.mime); endFirst(); } };
      },
    });
    const changes: boolean[] = [];
    player.onChange(speaking => changes.push(speaking));
    const saying = player.say('One. Two. Three.');
    await vi.waitFor(() => expect(played).toEqual(['One.']));
    expect(player.speaking).toBe(true);
    player.stop();
    await saying;
    expect(stops).toEqual(['One.']);
    expect(played).toEqual(['One.']);
    expect(player.speaking).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('speaks a reply only when it ends now, not one that was already done', () => {
    const reply = { role: 'assistant', status: 'complete' } as Message;
    expect(replyFinished('streaming', reply)).toBe(true);
    expect(replyFinished(undefined, reply)).toBe(false);
    expect(replyFinished('complete', reply)).toBe(false);
    // One that ended badly is spoken too: it says it did not finish.
    expect(replyFinished('streaming', { ...reply, status: 'error' })).toBe(true);
    expect(replyFinished('streaming', { ...reply, role: 'user' })).toBe(false);
  });
});

// What the voice says of a finished reply (user, 09.10): one line, never the reply.
describe('the line a reply is confirmed with', () => {
  it('is the first sentence of the closing paragraph, not the whole answer', () => {
    const reply = [
      '## Marked', '', 'I opened the directory and went through the table.', '',
      '| # | Skill |', '|---|---|', '| 1 | Find Skills |', '',
      'All 14 S-RANK skills are marked on the page. The YouTube updates and the 2026 lineup are there for your reference.',
    ].join('\n');
    expect(spokenConfirmation(reply)).toBe('All 14 S-RANK skills are marked on the page.');
  });

  it('passes over a goodbye and a line that only introduces a list, and speaks a closing question', () => {
    expect(spokenConfirmation('Here is the page you requested.\n\nLet me know if you need anything else.'))
      .toBe('Here is the page you requested.');
    expect(spokenConfirmation('The tests pass.\n\nStill to do:\n\n- [ ] package the app\n- [ ] check the icon'))
      .toBe('The tests pass.');
    expect(spokenConfirmation('I stopped before writing. Should I overwrite the file?'))
      .toBe('Should I overwrite the file?');
  });

  it('says nothing for a reply with no prose, and keeps code and addresses out of what it says', () => {
    expect(spokenConfirmation('```ts\nconst x = 1;\n\nconst y = 2;\n```')).toBe('');
    expect(spokenConfirmation('- one\n- two')).toBe('');
    expect(spokenConfirmation('')).toBe('');
    expect(spokenConfirmation('The page is at [the directory](https://example.com/a) now.'))
      .toBe('The page is at the directory now.');
  });

  it('cuts a very long closing sentence at a pause, and keeps a goodbye only when it is all there is', () => {
    const long = `I marked every skill on the page${', one after another'.repeat(12)}, and the table is now complete.`;
    const said = spokenConfirmation(long);
    expect(said.length).toBeLessThanOrEqual(180);
    expect(said.startsWith('I marked every skill on the page, one after another')).toBe(true);
    expect(spokenConfirmation('Let me know if you need anything else.')).toBe('Let me know if you need anything else.');
  });

  it('a reply that ended badly says so, instead of going quiet', () => {
    const reply = { role: 'assistant', status: 'complete', content: 'The file is written.' } as Message;
    expect(spokenReply(reply)).toBe('The file is written.');
    expect(spokenReply({ ...reply, status: 'error', error: 'HTTP 500 from the endpoint' })).toBe('That did not finish.');
  });
});
