import { describe, expect, it } from 'vitest';
import { PiEventMapper } from '../src/main/chat/pi-events';
import { runtimeReport, type MeasuredCall } from '../src/main/chat/runtime-status';
import type { Message } from '../src/shared/types';

// Qwen in kapitsa on this Mac could not say how fast it wrote: it guessed the
// cloud, then tried fetch_url and curl on its own endpoint (user, 12.11).
// Hello streams every reply, so Hello times it.
const reply = (): Message => ({ id: 'a', conversationId: 'c', role: 'assistant', content: '', parts: [], status: 'streaming', createdAt: 0 });
const delta = (type: string, contentIndex = 0) => ({ type: 'message_update', assistantMessageEvent: { type, contentIndex, delta: 'x' } });
const end = (output: number, stopReason = 'stop') => ({
  type: 'message_end',
  message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input: 1000, cacheRead: 200, output }, stopReason, timestamp: output },
});

function mapperAt(times: number[]) {
  let index = 0;
  return new PiEventMapper(reply(), () => times[Math.min(index++, times.length - 1)]);
}

describe('timing a reply as it streams in', () => {
  it('measures from the first token to the last, and the wait before the first', () => {
    const mapper = mapperAt([0, 500, 1500, 3500]);
    mapper.apply({ type: 'message_start', message: { role: 'assistant', content: [] } });
    mapper.apply(delta('thinking_delta', 0));
    mapper.apply(delta('text_delta', 1));
    mapper.apply(end(200));
    expect(mapper.takeMeasured()).toEqual([{ at: 3500, input: 1200, output: 200, streamMs: 3000, firstTokenMs: 500 }]);
    // Taken once: the next take holds only what ended since.
    expect(mapper.takeMeasured()).toEqual([]);
  });

  it('does not time a reply that arrived whole, or one cut off', () => {
    const whole = mapperAt([0, 10]);
    whole.apply({ type: 'message_start', message: { role: 'assistant', content: [] } });
    whole.apply(end(300));
    expect(whole.takeMeasured()).toEqual([]);
    const cut = mapperAt([0, 100, 2000]);
    cut.apply({ type: 'message_start', message: { role: 'assistant', content: [] } });
    cut.apply(delta('text_delta'));
    cut.apply(end(150, 'aborted'));
    expect(cut.takeMeasured()).toEqual([]);
  });
});

describe('what runtime_status says', () => {
  const at = new Date(2026, 10, 12, 22, 54, 12).getTime();
  const base = { model: 'qwen3.8-flash-next', endpointUrl: 'http://localhost:8000/v1', serverName: 'kapitsa · 8000', contextWindow: 65536, published: true };

  it('names the model and the server, and lists only the calls long enough to time', () => {
    const calls: MeasuredCall[] = [
      { at: at - 60_000, input: 2400, output: 10, streamMs: 40, firstTokenMs: 3700 },
      { at, input: 12326, output: 826, streamMs: 12_000, firstTokenMs: 8200 },
    ];
    const report = runtimeReport({ ...base, calls });
    expect(report).toContain('Model: qwen3.8-flash-next');
    expect(report).toContain('Server: kapitsa · 8000, at http://localhost:8000/v1: a server on this Mac');
    expect(report).toContain('Context window: 65,536 tokens, as the server publishes it.');
    expect(report).toContain('826 tokens in 12.0 s = 68.8 tokens/s; prompt 12,326 tokens, first token after 8.2 s');
    // Ten tokens in forty milliseconds is a burst, not 250 tokens a second: not listed at all.
    expect(report).not.toContain('2,400');
    expect(report).not.toContain('250.0 tokens/s');
    expect(report).toContain('Over this call: 68.8 tokens/s.');
  });

  // Qwen called it twenty times running, 15 tokens each, every answer a little
  // longer and saying "ask again" (user, 12.11). With nothing new timed, the
  // answer is word for word the same, so the repeat guard can stop the loop.
  it('answers the same, word for word, until a long enough call has been timed', () => {
    const timed: MeasuredCall = { at, input: 9000, output: 400, streamMs: 5_000, firstTokenMs: 900 };
    const short = (n: number): MeasuredCall => ({ at: at + n * 1000, input: 9000 + n * 600, output: 15, streamMs: 190, firstTokenMs: 9000 + n * 600 });
    const first = runtimeReport({ ...base, calls: [timed, short(1)] });
    expect(runtimeReport({ ...base, calls: [timed, short(1), short(2), short(3)] })).toBe(first);
    expect(first).toContain('measures nothing new');
    expect(first).not.toContain('ask again');
    expect(runtimeReport({ ...base, calls: [] })).toContain('No call in this chat has been long enough to time yet.');
    expect(runtimeReport({ ...base, calls: [short(1)] })).toBe(runtimeReport({ ...base, calls: [short(1), short(2)] }));
  });
});
