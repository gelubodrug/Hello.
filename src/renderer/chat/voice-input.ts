/**
 * What the microphone is hearing. The person holding the button says when the
 * turn ends (user, 09.10), so a pause in the middle of it is thinking, not the
 * end: only a button held over nothing, or held far too long, closes a turn by
 * itself — after eight seconds with no speech at all, and at a minute.
 */
export class VoiceActivity {
  heard = false;
  /** Whether the last chunk pushed held speech. */
  voiced = false;
  private voicedMs = 0;
  elapsedMs = 0;
  push(samples: Float32Array, sampleRate: number): boolean {
    const ms = samples.length / sampleRate * 1000;
    this.elapsedMs += ms;
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    this.voiced = rms > 0.015;
    if (this.voiced) { this.voicedMs += ms; this.heard = this.voicedMs >= 160; }
    return (!this.heard && this.elapsedMs >= 8_000) || this.elapsedMs >= 60_000;
  }
}

/** How long the microphone keeps listening after it is let go: people let go on their last syllable. */
export const RELEASE_TAIL_MS = 250;
/** The silence kept on either side of the speech in a clip. Whisper fills long silence with words that were never said. */
export const SILENCE_KEPT_MS = 300;
/** Samples the microphone hands over at a time: 128 ms at 16 kHz. */
const CHUNK = 2048;

export function voiceWav(chunks: Float32Array[], rate: number): Uint8Array {
  const count = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(44 + count * 2);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) => { for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i); };
  tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, 'data'); view.setUint32(40, count * 2, true);
  let offset = 44;
  for (const chunk of chunks) for (const sample of chunk) {
    const value = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, value * (value < 0 ? 32768 : 32767), true); offset += 2;
  }
  return bytes;
}

/**
 * Speech heard before the words so far are offered the first time. A whisper
 * model pads what it is given to its own thirty-second window, so a pass over
 * two seconds costs about what a pass over twenty does: asking early and often
 * buys nothing and spends the Mac, and a pass that lands mid-word only writes
 * itself over a moment later.
 */
export const PARTIAL_AFTER_MS = 4000;
/**
 * And the speech between the passes after it. The recorder never queues work:
 * a pass slower than this simply misses the next offer, so a loaded Mac or a
 * long turn widens the gap by itself instead of falling behind.
 */
export const PARTIAL_EVERY_MS = 3000;

/**
 * Capture mono PCM, accepted by whisper.cpp without a server-side codec
 * dependency. Recording and writing out run together: `partial` is offered the
 * whole clip so far, every few seconds, so the person sees their words while
 * they speak (user, 09.10). It is an offer, not a call — a caller still
 * writing out the previous one takes nothing, and the audio is only copied
 * into a WAV for a caller that asks for it. Every pass covers the turn from
 * its start, so the words are never stitched out of pieces: the final pass,
 * after the last word, is the one that counts.
 */
export async function recordVoice(signal: AbortSignal, listening: () => void, options: {
  partial?: (clip: () => Uint8Array) => void;
  /** The button let go: ends the turn and keeps what was said, where `signal` throws it away. */
  until?: AbortSignal;
} = {}): Promise<Uint8Array | null> {
  const { partial, until } = options;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  let context: AudioContext | undefined;
  try {
    if (signal.aborted) return null;
    context = new AudioContext({ sampleRate: 16000 });
    await context.resume();
    if (signal.aborted) return null;
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(CHUNK, 1, 1);
    const mute = context.createGain(); mute.gain.value = 0;
    const activity = new VoiceActivity();
    const chunks: Float32Array[] = [];
    const rate = context.sampleRate;
    // The speech in what was recorded, with a little silence either side of it.
    let first = -1; let last = -1;
    const speech = () => {
      const margin = Math.ceil(SILENCE_KEPT_MS / 1000 * rate / CHUNK);
      return voiceWav(chunks.slice(Math.max(0, first - margin), last + 1 + margin), rate);
    };
    return await new Promise(resolve => {
      let done = false;
      let released: ReturnType<typeof setTimeout> | undefined;
      const finish = (cancelled: boolean) => {
        if (done) return; done = true;
        clearTimeout(timeout); clearTimeout(released); signal.removeEventListener('abort', abort); until?.removeEventListener('abort', stop);
        processor.disconnect(); source.disconnect(); mute.disconnect();
        resolve(cancelled || !activity.heard ? null : speech());
      };
      const abort = () => finish(true);
      const stop = () => { released ??= setTimeout(() => finish(false), RELEASE_TAIL_MS); };
      const timeout = setTimeout(() => finish(false), 61_000);
      signal.addEventListener('abort', abort, { once: true });
      until?.addEventListener('abort', stop, { once: true });
      let offered = 0;
      processor.onaudioprocess = event => {
        const samples = new Float32Array(event.inputBuffer.getChannelData(0));
        chunks.push(samples);
        const over = activity.push(samples, rate);
        if (activity.voiced) { if (first < 0) first = chunks.length - 1; last = chunks.length - 1; }
        if (over) { finish(false); return; }
        // Let go, the turn is over: what is still coming in is its last syllable, not more words to show.
        const due = offered ? PARTIAL_EVERY_MS : PARTIAL_AFTER_MS;
        if (partial && !released && activity.heard && activity.elapsedMs - offered >= due) {
          offered = activity.elapsedMs;
          partial(speech);
        }
      };
      source.connect(processor); processor.connect(mute); mute.connect(context!.destination);
      listening();
    });
  } finally { stream.getTracks().forEach(track => track.stop()); await context?.close(); }
}
