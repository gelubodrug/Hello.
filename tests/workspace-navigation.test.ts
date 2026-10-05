import { describe, expect, it } from 'vitest';
import { navigationShown, transcriptShown } from '../src/renderer/workspace/navigation';
import type { WorkspacePrefs } from '../src/renderer/workspace/Workspace';

const chat = { toolsOpen: false, chatOpen: true, expanded: false, toolsExpanded: false };
const tools = { ...chat, toolsOpen: true };
const focused = { ...tools, expanded: true };

describe('the chats sidebar', () => {
  it('shows by the person’s choice, or on Auto by the room the chat leaves it', () => {
    expect(navigationShown('auto', chat, 900, false)).toBe(true);
    expect(navigationShown('auto', tools, 1100, false)).toBe(false);
    expect(navigationShown('auto', tools, 1300, false)).toBe(true);
    expect(navigationShown('auto', focused, 1600, false)).toBe(false);
    expect(navigationShown('shown', focused, 1600, false)).toBe(false);
    expect(navigationShown('shown', chat, 600, false)).toBe(true);
    expect(navigationShown('hidden', chat, 1600, false)).toBe(false);
  });

  // User, 01.10: with the chat's pane expanded, the DSH surface took the whole
  // window, under the window's own buttons, with no way back to the chats.
  it('stays beside the DSH surface, whatever the chat behind it is doing', () => {
    expect(navigationShown('auto', focused, 1100, true)).toBe(true);
    expect(navigationShown('auto', tools, 1100, true)).toBe(true);
    expect(navigationShown('shown', focused, 600, true)).toBe(true);
    // The person's own choice, and a window too narrow for it, still hide it.
    expect(navigationShown('hidden', chat, 1600, true)).toBe(false);
    expect(navigationShown('auto', chat, 700, true)).toBe(false);
  });
});

// Audit A1: a chat is seen only when its transcript is what its workspace shows.
describe('whether a chat’s transcript is in front', () => {
  const ui: WorkspacePrefs = { chatOpen: true, toolsOpen: false, minimized: false, expanded: false, toolsMinimized: false,
    toolsExpanded: false, chatTab: 'chat', notebookTabs: ['runbook', 'tasks'], toolId: null, focus: 'chat', split: 0.35 };
  it('is, with the Chat page of an open, unminimized pane', () => {
    expect(transcriptShown(ui, false)).toBe(true);
    expect(transcriptShown({ ...ui, toolsOpen: true, expanded: true }, false)).toBe(true);
  });
  it('is not behind the Notebook, a terminal tab, expanded tools, a minimized pane or a compact Tools view', () => {
    expect(transcriptShown({ ...ui, chatTab: 'notebook' }, false)).toBe(false);
    expect(transcriptShown({ ...ui, chatTerminal: 'term-1' }, false)).toBe(false);
    expect(transcriptShown({ ...ui, toolsOpen: true, toolsExpanded: true }, false)).toBe(false);
    expect(transcriptShown({ ...ui, minimized: true }, false)).toBe(false);
    expect(transcriptShown({ ...ui, chatOpen: false }, false)).toBe(false);
    expect(transcriptShown({ ...ui, toolsOpen: true, focus: 'tools' }, true)).toBe(false);
    expect(transcriptShown({ ...ui, toolsOpen: true, focus: 'tools' }, false)).toBe(true);
  });
});
