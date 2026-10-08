import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDataStore, type DataStore } from '../src/main/data/store';

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

  it('refuses a voice server off this Mac', () => {
    directory = mkdtempSync(join(tmpdir(), 'hello-voice-'));
    expect(() => open().saveSettings({ voice: { enabled: true, ttsEndpointUrl: 'https://tts.example.com' } })).toThrow(/this Mac/);
    expect(() => open().saveSettings({ voice: { enabled: true, sourceLanguage: 'romanian' } })).toThrow(/short code/);
  });
});
