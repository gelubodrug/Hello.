import { describe, expect, it } from 'vitest';
import { navigationShown } from '../src/renderer/workspace/navigation';

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
