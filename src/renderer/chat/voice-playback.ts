import type { Message, VoiceSpeech } from '../../shared/types';
import { speechChunks, spokenProse } from '../../shared/speech-text';

/**
 * A reply read aloud, sentence by sentence: the next chunk is made while the
 * one before it plays, and a stop drains everything — the chunk playing, the
 * one being made and the ones waiting. While it speaks the microphone stays
 * closed (half duplex): a voice turn listens only when Hello is silent, so it
 * never hears itself. `speaking` and `onChange` are what the mic reads.
 */

export interface SpeechOutput {
  /** One chunk of prose as audio. */
  speak(text: string): Promise<VoiceSpeech>;
  /** Plays one clip; resolves when it ends. The returned stop ends it early. */
  play(clip: VoiceSpeech): { done: Promise<void>; stop: () => void };
}

export class SpeechPlayer {
  private static microphones = new Set<symbol>();
  private static playing = new Set<SpeechPlayer>();
  static listen(): () => void {
    const lease = Symbol();
    SpeechPlayer.microphones.add(lease);
    for (const player of SpeechPlayer.playing) player.stop();
    return () => { SpeechPlayer.microphones.delete(lease); };
  }
  private generation = 0;
  private current?: () => void;
  private listeners = new Set<(speaking: boolean) => void>();
  private active = false;

  constructor(private readonly output: SpeechOutput, private readonly failed: (error: unknown) => void = () => {}) {}

  get speaking(): boolean { return this.active; }

  onChange(listener: (speaking: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Reads a reply's prose aloud, replacing whatever was being said. */
  async say(markdown: string): Promise<void> {
    this.stop();
    if (SpeechPlayer.microphones.size) return;
    const chunks = speechChunks(spokenProse(markdown));
    if (!chunks.length) return;
    const turn = ++this.generation;
    this.set(true);
    try {
      let next: Promise<VoiceSpeech> | undefined = this.output.speak(chunks[0]);
      for (let index = 0; index < chunks.length && next; index++) {
        const clip = await next;
        if (turn !== this.generation) return;
        next = index + 1 < chunks.length ? this.output.speak(chunks[index + 1]) : undefined;
        // An unread failure of the chunk being made must not escape while this one plays.
        next?.catch(() => {});
        const playing = this.output.play(clip);
        this.current = playing.stop;
        await playing.done;
        if (turn !== this.generation) return;
      }
    } catch (error) {
      if (turn === this.generation) this.failed(error);
    } finally {
      if (turn === this.generation) { this.current = undefined; this.set(false); }
    }
  }

  /** Silence now: the clip playing ends, and nothing queued is played. */
  stop(): void {
    this.generation++;
    const stop = this.current;
    this.current = undefined;
    stop?.();
    this.set(false);
  }

  private set(speaking: boolean): void {
    if (speaking) SpeechPlayer.playing.add(this); else SpeechPlayer.playing.delete(this);
    if (this.active === speaking) return;
    this.active = speaking;
    for (const listener of this.listeners) listener(speaking);
  }
}

/** A clip through an <audio> element, from a blob: URL the window's CSP admits. */
export function playClip(clip: VoiceSpeech): { done: Promise<void>; stop: () => void } {
  const url = URL.createObjectURL(new Blob([clip.audio as BlobPart], { type: clip.mime }));
  const audio = new Audio(url);
  let finish = () => {};
  const done = new Promise<void>((resolve, reject) => {
    finish = () => { URL.revokeObjectURL(url); resolve(); };
    audio.onended = finish;
    audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error('The spoken reply could not be played.')); };
  });
  void audio.play().catch(() => finish());
  return { done, stop: () => { audio.pause(); audio.removeAttribute('src'); finish(); } };
}

/** Whether this change of a reply is it finishing well: streaming before, complete now. */
export function replyFinished(previous: Message['status'] | undefined, message: Message): boolean {
  return message.role === 'assistant' && previous === 'streaming' && message.status === 'complete';
}
