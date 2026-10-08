/** Silence closes a turn only after some speech. Empty recordings expire separately. */
export class VoiceActivity {
  heard = false;
  private voicedMs = 0;
  private quietMs = 0;
  elapsedMs = 0;
  push(samples: Float32Array, sampleRate: number): boolean {
    const ms = samples.length / sampleRate * 1000;
    this.elapsedMs += ms;
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    if (rms > 0.015) { this.voicedMs += ms; this.quietMs = 0; this.heard = this.voicedMs >= 160; }
    else this.quietMs += ms;
    return (this.heard && this.quietMs >= 900) || (!this.heard && this.elapsedMs >= 8_000) || this.elapsedMs >= 60_000;
  }
}

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

/** Capture mono PCM, accepted by whisper.cpp without a server-side codec dependency. */
export async function recordVoice(signal: AbortSignal, listening: () => void): Promise<Uint8Array | null> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  let context: AudioContext | undefined;
  try {
    if (signal.aborted) return null;
    context = new AudioContext({ sampleRate: 16000 });
    await context.resume();
    if (signal.aborted) return null;
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(2048, 1, 1);
    const mute = context.createGain(); mute.gain.value = 0;
    const activity = new VoiceActivity();
    const chunks: Float32Array[] = [];
    const rate = context.sampleRate;
    return await new Promise(resolve => {
      let done = false;
      const finish = (cancelled: boolean) => {
        if (done) return; done = true;
        clearTimeout(timeout); signal.removeEventListener('abort', abort);
        processor.disconnect(); source.disconnect(); mute.disconnect();
        resolve(cancelled || !activity.heard ? null : voiceWav(chunks, rate));
      };
      const abort = () => finish(true);
      const timeout = setTimeout(() => finish(false), 61_000);
      signal.addEventListener('abort', abort, { once: true });
      processor.onaudioprocess = event => {
        const samples = new Float32Array(event.inputBuffer.getChannelData(0));
        chunks.push(samples);
        if (activity.push(samples, rate)) finish(false);
      };
      source.connect(processor); processor.connect(mute); mute.connect(context!.destination);
      listening();
    });
  } finally { stream.getTracks().forEach(track => track.stop()); await context?.close(); }
}
