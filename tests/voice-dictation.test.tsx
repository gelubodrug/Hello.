// @vitest-environment jsdom
// Dictation (user, 09.10): what is heard is written in the composer while the
// person speaks, and waits there to be sent unless they asked for it to go at
// once. API mocks mirror tests/page-mode-annotate-composer.test.tsx.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, Conversation, HelloAPI } from '../src/shared/types';
import { voiceWav } from '../src/renderer/chat/voice-input';

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  transcribe: vi.fn<(audio: Uint8Array, language?: string) => Promise<{ text: string; language?: string }>>(),
  send: vi.fn(),
  queue: vi.fn(),
  settingsSave: vi.fn(),
  models: vi.fn(),
  notebookList: vi.fn(),
  conversationUpdate: vi.fn(),
  extensionsActive: vi.fn<HelloAPI['extensions']['active']>(async () => []),
}));
vi.mock('../src/renderer/chat/voice-input', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/renderer/chat/voice-input')>()),
  recordVoice: (...args: unknown[]) => mocks.record(...args),
}));
vi.mock('../src/renderer/api', () => ({
  api: {
    chat: { attach: vi.fn(), send: mocks.send, queue: mocks.queue, stop: vi.fn(), retry: vi.fn(), approve: vi.fn(), onEvent: vi.fn(() => () => {}) },
    voice: { transcribe: mocks.transcribe, speak: vi.fn(), microphone: vi.fn(), stopSpeech: vi.fn() },
    settings: { models: mocks.models, save: mocks.settingsSave, rememberConnection: vi.fn(), useConnection: vi.fn(), forgetConnection: vi.fn() },
    notebooks: { list: mocks.notebookList, save: vi.fn(), delete: vi.fn(), onChange: vi.fn(() => () => {}) },
    system: { pathsForFiles: vi.fn(), openExternal: vi.fn(), copy: vi.fn() },
    conversations: { update: mocks.conversationUpdate },
    extensions: { list: vi.fn(async () => []), active: mocks.extensionsActive, setActive: vi.fn(), status: vi.fn(async () => []), discover: vi.fn(async () => ({ mcp: [], skills: [] })), importDiscovered: vi.fn(), onChange: vi.fn(() => () => {}) },
  },
  onNativeBrowserFocus: vi.fn(() => () => {}),
}));
vi.mock('shiki', () => ({ codeToTokens: async (code: string) => ({ tokens: [[{ content: code, color: '#fff' }]] }) }));
import { ConversationView } from '../src/renderer/chat/ConversationView';

const conversation: Conversation = { id: 'voice-chat', title: 'Voice', folder: null, createdAt: 1, updatedAt: 1 };
const base: AppSettings = { endpointUrl: 'http://localhost:1234/v1', model: 'test-model', apiKeySet: false, temperature: 0.7, systemPrompt: '', connections: [] };
const clip = voiceWav([new Float32Array(1600)], 16000);
/** The recorder the composer is driving, as the test holds it. */
const turn: { partial?: (make: () => Uint8Array) => void; stop?: (audio: Uint8Array | null) => void; options?: { stopOnPause?: boolean } } = {};

let root: Root;
let host: HTMLDivElement;
const view = (settings: AppSettings) => createElement(ConversationView, {
  conversation, settings, messages: [], workers: [],
  onSettingsChange: vi.fn(), onFolderChange: vi.fn(), onTerminal: vi.fn(), onWorker: vi.fn(),
  quote: null, onQuoteConsumed: vi.fn(), reportError: vi.fn(), onEditMessage: vi.fn(),
});
const composer = () => host.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => (item.getAttribute('aria-label') ?? '').startsWith(name))!;
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const click = async (target: Element) => { await act(async () => { (target as HTMLElement).click(); }); await settle(); };
/** The microphone is held: pressed, spoken into, let go. `clock` is how long it was held. */
let clock = 0;
const press = async (target: Element) => { await act(async () => { target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); }); await settle(); };
const letGo = async (target: Element, heldMs = 1000) => {
  clock += heldMs;
  await act(async () => { target.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); });
  await settle();
};
const held = async (words: string, target = button('Hold to speak')) => {
  await press(target);
  if (words) await speak(words);
  return target;
};
const type = async (words: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer(), words);
    composer().dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const speak = async (words: string) => { mocks.transcribe.mockResolvedValueOnce({ text: words }); await act(async () => { turn.partial?.(() => clip); }); await settle(); };
/** Letting the microphone go: the last pass over the whole turn, then what follows. */
const release = async (words: string) => {
  mocks.transcribe.mockResolvedValueOnce({ text: words });
  await letGo(button('Listening'));
  await settle();
};

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.transcribe.mockReset();
  clock = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  delete turn.partial; delete turn.stop; delete turn.options;
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); }, clear: () => store.clear(), key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size; },
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  mocks.record.mockImplementation((signal: AbortSignal, listening: () => void, options: { partial?: (make: () => Uint8Array) => void; stopOnPause?: boolean; until?: AbortSignal }) =>
    new Promise(resolve => {
      listening();
      turn.partial = options.partial; turn.stop = resolve; turn.options = options;
      // The square keeps what was said; Escape, and leaving the chat, throw it away.
      options.until?.addEventListener('abort', () => resolve(clip), { once: true });
      signal.addEventListener('abort', () => resolve(null), { once: true });
    }));
  mocks.send.mockResolvedValue(undefined);
  mocks.models.mockResolvedValue([{ id: 'test-model' }]);
  mocks.notebookList.mockResolvedValue([]);
  mocks.conversationUpdate.mockImplementation(async (id: string, patch: object) => ({ ...conversation, id, ...patch }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('what is heard while the person speaks', () => {
  it('writes the words in the composer as they come, and leaves them there to be sent', async () => {
    await act(async () => { root.render(view({ ...base, voice: { enabled: true } })); });
    await held('Open the');
    expect(composer().value).toBe('Open the');
    // Each pass is the whole turn again: it replaces the words before it, never follows them.
    await speak('Open the directory');
    expect(composer().value).toBe('Open the directory');
    await release('Open the directory page.');
    expect(composer().value).toBe('Open the directory page.');
    expect(mocks.send).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(composer());
  });

  it('sends it the moment the last words are written out, when the person asked for that', async () => {
    await act(async () => { root.render(view({ ...base, voice: { enabled: true, autoSend: true } })); });
    await held('Open the');
    // Let go, and nothing is sent until the last pass comes back — no waiting on a clock.
    let written!: (said: { text: string }) => void;
    mocks.transcribe.mockReturnValueOnce(new Promise(resolve => { written = resolve; }));
    await letGo(button('Listening'));
    expect(mocks.send).not.toHaveBeenCalled();
    expect(button('Writing out what you said')).toBeTruthy();
    await act(async () => { written({ text: 'Open the directory page.' }); });
    await settle();
    expect(mocks.send).toHaveBeenCalledWith(conversation.id, 'Open the directory page.', []);
    expect(composer().value).toBe('');
  });

  it('adds the words after what was already typed, and typing during the turn wins', async () => {
    await act(async () => { root.render(view({ ...base, voice: { enabled: true } })); });
    await type('Before.');
    await held('then this');
    expect(composer().value).toBe('Before. then this');
    await type('Before. Typed while speaking.');
    await release('then this, said.');
    expect(composer().value).toBe('Before. Typed while speaking. then this, said.');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('skips an offer while the one before it is still being written out, and a failed pass says nothing', async () => {
    await act(async () => { root.render(view({ ...base, voice: { enabled: true } })); });
    await held('');
    let answer!: (said: { text: string }) => void;
    mocks.transcribe.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));
    await act(async () => { turn.partial?.(() => clip); });
    await act(async () => { turn.partial?.(() => clip); });
    expect(mocks.transcribe).toHaveBeenCalledTimes(1);
    await act(async () => { answer({ text: 'Heard.' }); });
    await settle();
    expect(composer().value).toBe('Heard.');
    mocks.transcribe.mockRejectedValueOnce(new Error('the server went away'));
    await act(async () => { turn.partial?.(() => clip); });
    await settle();
    expect(composer().value).toBe('Heard.');
    expect(host.textContent).not.toContain('went away');
    await release('Heard it all.');
    expect(composer().value).toBe('Heard it all.');
  });

  it('keeps what was held long enough, drops a slip of a press, and Escape drops the turn', async () => {
    await act(async () => { root.render(view({ ...base, voice: { enabled: true } })); });
    await press(button('Hold to speak'));
    // Let go within a moment: no word fits in it, so nothing is written out.
    await letGo(button('Listening'), 100);
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('No speech was heard');
    await held('Half a thought');
    expect(composer().value).toBe('Half a thought');
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await settle();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(button('Hold to speak')).toBeTruthy();
  });

  it('with Voice off, the microphone offers the switch, and Auto Send waits for Voice', async () => {
    mocks.settingsSave.mockResolvedValue({ ...base, voice: { enabled: true } });
    await act(async () => { root.render(view({ ...base, voice: { enabled: false } })); });
    await click(button('Voice off'));
    const rows = [...document.querySelectorAll<HTMLButtonElement>('.menu-popup [role^="menuitem"]')];
    expect(rows.map(row => [row.textContent, row.getAttribute('aria-checked'), row.disabled])).toEqual([
      ['Voice', 'false', false],
      ['Auto Send', 'false', true],
    ]);
    await click(rows[0]);
    expect(mocks.settingsSave).toHaveBeenCalledWith({ voice: { enabled: true } });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('offers the chevron beside the microphone, which switches sending on', async () => {
    mocks.settingsSave.mockResolvedValue({ ...base, voice: { enabled: true, autoSend: true } });
    await act(async () => { root.render(view({ ...base, voice: { enabled: true } })); });
    await click(button('Voice options'));
    const item = [...document.querySelectorAll<HTMLElement>('.menu-popup [role^="menuitem"]')]
      .find(row => row.textContent === 'Auto Send')!;
    // A switch, not a sentence: the name, and its state.
    expect(item.getAttribute('role')).toBe('menuitemcheckbox');
    expect(item.getAttribute('aria-checked')).toBe('false');
    expect(item.querySelector('.menu-switch')?.getAttribute('data-on')).toBe('false');
    expect(item.querySelector('small')).toBeNull();
    await click(item);
    expect(mocks.settingsSave).toHaveBeenCalledWith({ voice: { enabled: true, autoSend: true } });
  });
});

describe('holding Space', () => {
  /** A key the system repeats while it is held, as macOS does. */
  const key = async (type: 'keydown' | 'keyup', repeat = false) => {
    const event = new KeyboardEvent(type, { key: ' ', code: 'Space', repeat, bubbles: true, cancelable: true });
    await act(async () => { composer().dispatchEvent(event); });
    await settle();
    return event;
  };
  /** Space pressed in the composer: the browser types its space, then the system starts repeating it. */
  const holdSpace = async (typed: string) => {
    composer().focus();
    await key('keydown');
    await type(`${typed} `);
    return key('keydown', true);
  };
  const letGoOfSpace = async (words: string) => {
    mocks.transcribe.mockResolvedValueOnce({ text: words });
    clock += 1000;
    await key('keyup');
    await settle();
  };

  it('starts at the first repeat, takes back the space it typed, and ends when Space is let go', async () => {
    await act(async () => { root.render(view({ ...base, voice: { enabled: true } })); });
    await type('Hi');
    const repeat = await holdSpace('Hi');
    expect(repeat.defaultPrevented).toBe(true);
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(composer().value).toBe('Hi');
    // Held on, the key types nothing more.
    expect((await key('keydown', true)).defaultPrevented).toBe(true);
    await speak('open the page');
    expect(composer().value).toBe('Hi open the page');
    await letGoOfSpace('open the page.');
    expect(composer().value).toBe('Hi open the page.');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('is a hold after a quarter of a second, before the system repeats anything', async () => {
    await act(async () => { root.render(view({ ...base, voice: { enabled: true } })); });
    composer().focus();
    await key('keydown');
    await type(' ');
    // Real time: the decision is a timer, and every moment of it is speech not being recorded.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    await settle();
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(composer().value).toBe('');
  });

  it('sends on letting go when Auto Send is on', async () => {
    await act(async () => { root.render(view({ ...base, voice: { enabled: true, autoSend: true } })); });
    await holdSpace('');
    await speak('open the');
    await letGoOfSpace('Open the page.');
    expect(mocks.send).toHaveBeenCalledWith(conversation.id, 'Open the page.', []);
  });

  it('leaves a tapped space a space, and Space alone when Voice is off', async () => {
    await act(async () => { root.render(view({ ...base, voice: { enabled: true } })); });
    composer().focus();
    await key('keydown');
    await key('keyup');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(mocks.record).not.toHaveBeenCalled();
    await act(async () => { root.render(view({ ...base, voice: { enabled: false } })); });
    const repeat = await holdSpace('Typing');
    expect(repeat.defaultPrevented).toBe(false);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(composer().value).toBe('Typing ');
  });
});

describe('the language of a turn', () => {
  it('is pinned to the one the first pass heard, so English names do not turn the rest English', async () => {
    await act(async () => { root.render(view({ ...base, voice: { enabled: true } })); });
    await held('');
    mocks.transcribe.mockResolvedValueOnce({ text: 'Caută cel mai ieftin', language: 'ro' });
    await act(async () => { turn.partial?.(() => clip); });
    await settle();
    expect(mocks.transcribe.mock.calls[0][1]).toBeUndefined();
    mocks.transcribe.mockResolvedValueOnce({ text: 'Caută cel mai ieftin MacBook Pro', language: 'en' });
    await act(async () => { turn.partial?.(() => clip); });
    await settle();
    expect(mocks.transcribe.mock.calls[1][1]).toBe('ro');
    await release('Caută cel mai ieftin MacBook Pro.');
    expect(mocks.transcribe.mock.calls[2][1]).toBe('ro');
  });

  it('is the one set in Settings › Voice from the first pass on', async () => {
    await act(async () => { root.render(view({ ...base, voice: { enabled: true, sourceLanguage: 'ro' } })); });
    await held('Caută');
    expect(mocks.transcribe.mock.calls[0][1]).toBe('ro');
  });
});

describe('the recorder itself', () => {
  /** A microphone that hands over what the test pushes, 100 ms at a time. */
  const microphone = async () => {
    const processor: { onaudioprocess?: (event: { inputBuffer: { getChannelData(): Float32Array } }) => void } = {};
    const node = { connect() {}, disconnect() {} };
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
    vi.stubGlobal('AudioContext', class {
      sampleRate = 16000;
      destination = {};
      async resume() {}
      async close() {}
      createMediaStreamSource() { return node; }
      createScriptProcessor() { return Object.assign(processor, node); }
      createGain() { return { gain: { value: 0 }, ...node }; }
    });
    // The recorder itself, not the stand-in this file gives the composer.
    const recorder = await vi.importActual<typeof import('../src/renderer/chat/voice-input')>('../src/renderer/chat/voice-input');
    const push = (samples: Float32Array, times: number) => {
      for (let at = 0; at < times; at++) processor.onaudioprocess!({ inputBuffer: { getChannelData: () => samples } });
    };
    const ready = () => vi.waitFor(() => expect(processor.onaudioprocess).toBeTypeOf('function'));
    return { recorder, push, ready, speech: new Float32Array(1600).fill(0.1), quiet: new Float32Array(1600) };
  };
  afterEach(() => { vi.unstubAllGlobals(); });

  it('offers the words so far every few seconds, and only to a caller that takes them', async () => {
    const { recorder: { PARTIAL_AFTER_MS, PARTIAL_EVERY_MS, recordVoice }, push, ready, speech, quiet } = await microphone();
    const offers: number[] = [];
    const letGoOf = new AbortController();
    const recorded = recordVoice(new AbortController().signal, () => {}, { partial: make => { offers.push(make().length); }, until: letGoOf.signal });
    await ready();
    // Nothing is asked for in the first seconds: a whisper pass over two
    // seconds costs what a pass over twenty does.
    push(speech, PARTIAL_AFTER_MS / 100 - 1);
    expect(offers).toEqual([]);
    push(speech, 1);
    expect(offers).toHaveLength(1);
    push(speech, Math.ceil(PARTIAL_EVERY_MS / 100) - 1);
    expect(offers).toHaveLength(1);
    push(speech, 1);
    expect(offers).toHaveLength(2);
    // What is offered is the whole turn so far, as a WAV: it only grows.
    expect(offers[1]).toBeGreaterThan(offers[0]);
    // A pause is thinking, not the end: only letting go ends the turn.
    push(quiet, 20);
    expect(offers).toHaveLength(2);
    letGoOf.abort();
    const audio = await recorded;
    expect(audio).not.toBeNull();
    expect(audio!.length).toBeGreaterThan(offers[1]);
  });

  it('keeps only a little of the silence around the speech, and hears the last syllable after letting go', async () => {
    const { recorder: { recordVoice }, push, ready, speech, quiet } = await microphone();
    const letGoOf = new AbortController();
    const offers: number[] = [];
    const recorded = recordVoice(new AbortController().signal, () => {}, { partial: make => { offers.push(make().length); }, until: letGoOf.signal });
    await ready();
    // Two seconds of silence before the first word: Whisper writes words that were never said into silence.
    push(quiet, 20);
    push(speech, 40);
    letGoOf.abort();
    // People let go on their last syllable; it is still heard, and no more words are offered.
    push(speech, 2);
    push(quiet, 20);
    const audio = await recorded;
    // A WAV header, then 2 bytes a sample: the speech, with 300 ms of the silence either side.
    expect((audio!.length - 44) / 2).toBe((3 + 42 + 3) * 1600);
    expect(offers).toHaveLength(1);
    expect((offers[0] - 44) / 2).toBeLessThan((20 + 40) * 1600);
  });
});
