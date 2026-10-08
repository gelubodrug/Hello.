import { describe, expect, it } from 'vitest';
import { allowsAppMicrophone, isAppPage, type MediaGrantRequest } from '../src/main/media-permission';

const appUrls = ['hello://app/', 'http://localhost:5173'];
const microphone: MediaGrantRequest = { permission: 'media', fromAppWindow: true, isMainFrame: true, mediaTypes: ['audio'], requestingUrl: 'hello://app/index.html' };

describe('the app window media grant', () => {
  it('opens the microphone for the app window main frame on its own page', () => {
    expect(allowsAppMicrophone(microphone, appUrls)).toBe(true);
    expect(allowsAppMicrophone({ ...microphone, requestingUrl: 'http://localhost:5173/' }, appUrls)).toBe(true);
  });

  it('never opens the camera, screen or an unnamed device', () => {
    expect(allowsAppMicrophone({ ...microphone, mediaTypes: ['video'] }, appUrls)).toBe(false);
    expect(allowsAppMicrophone({ ...microphone, mediaTypes: ['audio', 'video'] }, appUrls)).toBe(false);
    expect(allowsAppMicrophone({ ...microphone, mediaTypes: [] }, appUrls)).toBe(false);
    expect(allowsAppMicrophone({ ...microphone, mediaTypes: ['unknown'] }, appUrls)).toBe(false);
  });

  it('refuses guests, frames, other pages and other permissions', () => {
    expect(allowsAppMicrophone({ ...microphone, fromAppWindow: false }, appUrls)).toBe(false);
    expect(allowsAppMicrophone({ ...microphone, isMainFrame: false }, appUrls)).toBe(false);
    expect(allowsAppMicrophone({ ...microphone, requestingUrl: 'https://example.com/' }, appUrls)).toBe(false);
    expect(allowsAppMicrophone({ ...microphone, requestingUrl: 'http://localhost:5174/' }, appUrls)).toBe(false);
    expect(allowsAppMicrophone({ ...microphone, requestingUrl: 'hello://other/index.html' }, appUrls)).toBe(false);
    expect(allowsAppMicrophone({ ...microphone, requestingUrl: 'not a url' }, appUrls)).toBe(false);
    for (const permission of ['notifications', 'geolocation', 'display-capture', 'clipboard-read', 'fullscreen'])
      expect(allowsAppMicrophone({ ...microphone, permission }, appUrls)).toBe(false);
  });

  it('matches the app by scheme and host only', () => {
    expect(isAppPage('hello://app/deep/path?x=1', appUrls)).toBe(true);
    expect(isAppPage('file:///app/index.html', appUrls)).toBe(false);
  });
});
