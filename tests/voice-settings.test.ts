import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDataStore, voicePatch, type DataStore } from '../src/main/data/store';

const codec = { encrypt: (text: string) => Buffer.from(text), decrypt: (bytes: Buffer) => bytes.toString() };
let directory = '';
let store: DataStore | undefined;
const open = () => { store?.close(); store = createDataStore(directory, codec); return store; };

describe('the one Voice switch', () => {
  afterEach(() => { store?.close(); store = undefined; if (directory) rmSync(directory, { recursive: true, force: true }); });

  it('is off until turned on, and stays as set after a restart', () => {
    directory = mkdtempSync(join(tmpdir(), 'hello-voice-'));
    expect(open().getSettings().voice).toBeUndefined();
    open().saveSettings({ voice: { enabled: true, sttEndpointUrl: 'http://localhost:8080', sttModel: 'large-v3-turbo', sourceLanguage: 'RO', ttsEndpointUrl: 'http://127.0.0.1:8880', ttsVoice: 'af_heart' } });
    expect(open().getSettings().voice).toEqual({ enabled: true, sttEndpointUrl: 'http://localhost:8080', sttModel: 'large-v3-turbo', sourceLanguage: 'ro', ttsEndpointUrl: 'http://127.0.0.1:8880', ttsVoice: 'af_heart' });
    open().saveSettings({ voice: { enabled: false } });
    expect(open().getSettings().voice).toMatchObject({ enabled: false, sttModel: 'large-v3-turbo', ttsVoice: 'af_heart' });
  });

  it('drops a model and a voice when their server changes, unless given anew', () => {
    directory = mkdtempSync(join(tmpdir(), 'hello-voice-'));
    const data = open();
    data.saveSettings({ voice: { enabled: true, sttEndpointUrl: 'http://localhost:8080', sttModel: 'large-v3-turbo', ttsEndpointUrl: 'http://localhost:8880', ttsVoice: 'bm_george' } });
    expect(data.saveSettings({ voice: { enabled: true, sttEndpointUrl: 'http://localhost:8178', ttsEndpointUrl: 'http://localhost:8000' } }).voice)
      .toEqual({ enabled: true, sttEndpointUrl: 'http://localhost:8178', ttsEndpointUrl: 'http://localhost:8000' });
    expect(data.saveSettings({ voice: { enabled: true, ttsEndpointUrl: 'http://localhost:8880', ttsVoice: 'af_heart' } }).voice)
      .toMatchObject({ ttsEndpointUrl: 'http://localhost:8880', ttsVoice: 'af_heart' });
  });

  it('sends what was said only when asked to, and remembers that (user, 09.10)', () => {
    directory = mkdtempSync(join(tmpdir(), 'hello-voice-'));
    expect(open().saveSettings({ voice: { enabled: true } }).voice).toEqual({ enabled: true });
    expect(open().saveSettings({ voice: { enabled: true, autoSend: true } }).voice).toEqual({ enabled: true, autoSend: true });
    // Turning Voice off and on again does not start sending by itself.
    expect(open().saveSettings({ voice: { enabled: true, autoSend: false } }).voice).toEqual({ enabled: true });
  });

  it('turns Auto Send off as surely as on, the way the window asks for it', () => {
    // The window's patch passes through voicePatch, then the store — as Settings.save does.
    directory = mkdtempSync(join(tmpdir(), 'hello-voice-'));
    const data = open();
    const save = (raw: unknown) => data.saveSettings({ voice: voicePatch(raw, data.getSettings().voice) }).voice;
    expect(save({ enabled: true, sttEndpointUrl: 'http://localhost:8080' })).toEqual({ enabled: true, sttEndpointUrl: 'http://localhost:8080' });
    expect(save({ enabled: true, autoSend: true })).toEqual({ enabled: true, autoSend: true, sttEndpointUrl: 'http://localhost:8080' });
    // Off was once dropped on the way, and the old on stayed (user, 09.10).
    expect(save({ enabled: true, autoSend: false })).toEqual({ enabled: true, sttEndpointUrl: 'http://localhost:8080' });
    // A save that does not mention it leaves it as it is.
    save({ enabled: true, autoSend: true });
    expect(save({ enabled: true, ttsVoice: 'af_heart' })).toMatchObject({ autoSend: true, ttsVoice: 'af_heart' });
    expect(() => voicePatch({ autoSend: 'yes' }, undefined)).toThrow(/Invalid voice setting/);
  });

  it('refuses a voice server off this Mac', () => {
    directory = mkdtempSync(join(tmpdir(), 'hello-voice-'));
    expect(() => open().saveSettings({ voice: { enabled: true, ttsEndpointUrl: 'https://tts.example.com' } })).toThrow(/this Mac/);
    expect(() => open().saveSettings({ voice: { enabled: true, sourceLanguage: 'romanian' } })).toThrow(/short code/);
  });
});
