// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { CHAT_PAGES, normalizeChatTab } from '../src/renderer/workspace/Workspace';

// One notebook pill beside Chat, not one per section (user, 29.09): Runbooks,
// Tasks and Plans are sections inside it, switched there.
describe('the pages a chat shows', () => {
  it('are the chat and its notebook, whatever is switched on', () => {
    expect(CHAT_PAGES).toEqual(['chat', 'notebook']);
  });

  it('open a page saved before the notebook was one on the notebook', () => {
    expect(normalizeChatTab('runbook')).toBe('notebook');
    expect(normalizeChatTab('tasks')).toBe('notebook');
    expect(normalizeChatTab('notebook')).toBe('notebook');
    expect(normalizeChatTab('chat')).toBe('chat');
    expect(normalizeChatTab(undefined)).toBe('chat');
    expect(normalizeChatTab(42)).toBe('chat');
  });
});
