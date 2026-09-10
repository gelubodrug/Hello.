import { describe, expect, it } from 'vitest';
import { readSSE, SSEDecoder, ThinkingDecoder } from '../src/main/chat/sse';

describe('SSE parsing', () => {
  it('handles CRLF split across chunks, BOM, comments and multiline data', () => {
    const parser = new SSEDecoder();
    expect(parser.push('\uFEFF: keep alive\r')).toEqual([]);
    expect(parser.push('\ndata: one\r\ndata:two\r')).toEqual([]);
    expect(parser.push('\n\r\ndata: [DONE]\n\n')).toEqual([
      'one\ntwo',
      '[DONE]',
    ]);
  });
  it('flushes an event at EOF and ignores event metadata', () => {
    const parser = new SSEDecoder();
    expect(
      parser.push('event: message\nid: 5\ndata: {"ok":true}', true),
    ).toEqual(['{"ok":true}']);
  });
  it('rejects unbounded lines/events', () => {
    expect(() => new SSEDecoder(8).push('data: xxxxxxxxx')).toThrow(/limit/);
    expect(() => new SSEDecoder(8).push('data: xxxx\ndata: xxxxx\n')).toThrow(
      /limit/,
    );
  });
  it('preserves split UTF-8', async () => {
    const bytes = new TextEncoder().encode('data: bună ☀️\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const received: string[] = [];
    for await (const event of readSSE(stream, new AbortController().signal))
      received.push(event);
    expect(received).toEqual(['bună ☀️']);
  });
  it('cancels a reader when aborted', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>();
    const events = readSSE(stream, controller.signal);
    const waiting = events.next();
    controller.abort(new Error('Stopped'));
    await expect(waiting).rejects.toThrow('Stopped');
  });
});

describe('optional thinking tags', () => {
  it('separates tags split over chunks without leaking partial markup', () => {
    const parser = new ThinkingDecoder();
    expect(parser.push('<thi')).toEqual([]);
    expect(parser.push('nk>Reason')).toEqual([
      { type: 'thinking', text: 'Reason' },
    ]);
    expect(parser.push('ing</thi')).toEqual([
      { type: 'thinking', text: 'ing' },
    ]);
    expect(parser.push('nk>Answer')).toEqual([
      { type: 'text', text: 'Answer' },
    ]);
    expect(parser.push('', true)).toEqual([]);
  });
  it('preserves a literal incomplete token at EOF', () => {
    const parser = new ThinkingDecoder();
    expect(parser.push('x <thi')).toEqual([{ type: 'text', text: 'x ' }]);
    expect(parser.push('', true)).toEqual([{ type: 'text', text: '<thi' }]);
  });
});
