/** Incremental SSE decoder: split UTF-8, CRLF and multiline data are supported. */
export class SSEDecoder {
  private buffer = '';
  private data: string[] = [];
  private size = 0;
  private first = true;
  constructor(private readonly maxEventBytes = 2_000_000) {}
  push(chunk: string, final = false): string[] {
    if (this.first && chunk) {
      chunk = chunk.replace(/^\uFEFF/, '');
      this.first = false;
    }
    this.buffer += chunk;
    const events: string[] = [];
    let offset = 0;
    for (let index = 0; index < this.buffer.length; index++) {
      const char = this.buffer[index];
      if (char !== '\n' && char !== '\r') continue;
      if (char === '\r' && index === this.buffer.length - 1 && !final) break;
      this.line(this.buffer.slice(offset, index), events);
      if (char === '\r' && this.buffer[index + 1] === '\n') index++;
      offset = index + 1;
    }
    this.buffer = this.buffer.slice(offset);
    if (this.buffer.length + this.size > this.maxEventBytes)
      throw new Error('Model stream event exceeded the safe size limit.');
    if (final) {
      if (this.buffer) this.line(this.buffer, events);
      this.buffer = '';
      this.line('', events);
    }
    return events;
  }
  private line(line: string, output: string[]): void {
    if (!line) {
      if (this.data.length) output.push(this.data.join('\n'));
      this.data = [];
      this.size = 0;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      this.data.push(value);
      this.size += value.length;
    }
    if (this.size > this.maxEventBytes)
      throw new Error('Model stream event exceeded the safe size limit.');
  }
}

export async function* readSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const sse = new SSEDecoder();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        for (const event of sse.push(decoder.decode(), true)) yield event;
        break;
      }
      for (const event of sse.push(decoder.decode(value, { stream: true })))
        yield event;
    }
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Handles the optional <think> convention without showing partial tag tokens. */
export class ThinkingDecoder {
  private buffer = '';
  private thinking = false;
  push(
    text: string,
    final = false,
  ): Array<{ type: 'text' | 'thinking'; text: string }> {
    this.buffer += text;
    const result: Array<{ type: 'text' | 'thinking'; text: string }> = [];
    while (this.buffer) {
      const tag = this.thinking ? '</think>' : '<think>';
      const index = this.buffer.indexOf(tag);
      if (index >= 0) {
        if (index)
          result.push({
            type: this.thinking ? 'thinking' : 'text',
            text: this.buffer.slice(0, index),
          });
        this.buffer = this.buffer.slice(index + tag.length);
        this.thinking = !this.thinking;
        continue;
      }
      let held = 0;
      if (!final) {
        for (
          let length = Math.min(tag.length - 1, this.buffer.length);
          length > 0;
          length--
        ) {
          if (tag.startsWith(this.buffer.slice(-length))) {
            held = length;
            break;
          }
        }
      }
      const length = this.buffer.length - held;
      if (length)
        result.push({
          type: this.thinking ? 'thinking' : 'text',
          text: this.buffer.slice(0, length),
        });
      this.buffer = this.buffer.slice(length);
      break;
    }
    return result;
  }
}
