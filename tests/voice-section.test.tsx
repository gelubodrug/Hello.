// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../src/shared/types';

const mocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('../src/renderer/api', () => ({
  api: {
    voice: { status: vi.fn(async () => undefined), onStatus: vi.fn(() => () => {}), microphone: vi.fn(async () => 'granted'), prepare: vi.fn() },
    settings: { save: mocks.save },
    system: { openExternal: vi.fn() },
  },
  onNativeBrowserFocus: () => () => {},
}));
import { VoiceSection } from '../src/renderer/settings/VoiceSection';
import { voiceName } from '../src/shared/voice-setup';

const base: AppSettings = { endpointUrl: 'http://localhost:1234/v1', model: 'm', apiKeySet: false, temperature: 0.7, systemPrompt: '', connections: [] };
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

// The voice is picked from Kokoro's voices by name, not typed as an id (user, 09.10).
describe('the voice in Settings › Voice', () => {
  it('names a voice the way a person reads it', () => {
    expect(voiceName('af_heart')).toEqual({ name: 'Heart', kind: 'American female' });
    expect(voiceName('bm_george')).toEqual({ name: 'George', kind: 'British male' });
    expect(voiceName('custom-voice')).toEqual({ name: 'custom-voice', kind: 'Other' });
  });

  it('is chosen from the list, and saved with the rest of the form', async () => {
    mocks.save.mockImplementation(async (patch: { voice: object }) => ({ ...base, voice: patch.voice }));
    await act(async () => { root.render(createElement(VoiceSection, { settings: { ...base, voice: { enabled: true } }, servers: [], onSaved: vi.fn() })); });
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Voice"]')!;
    expect(trigger.textContent).toBe('Heart · American female');
    await act(async () => { trigger.click(); });
    const george = [...document.querySelectorAll<HTMLElement>('.menu-popup [role^="menuitem"]')].find(row => row.textContent === 'George')!;
    await act(async () => { george.click(); });
    expect(trigger.textContent).toBe('George · British male');
    await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === 'Save voice')!.click(); });
    expect(mocks.save).toHaveBeenCalledWith({ voice: expect.objectContaining({ ttsVoice: 'bm_george' }) });
  });
});
