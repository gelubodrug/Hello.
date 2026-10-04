// @vitest-environment jsdom
import { createElement, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogSkill } from '../src/shared/types';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  search: vi.fn(),
  use: vi.fn(),
  active: vi.fn(async () => [] as string[]),
  commands: vi.fn(async () => null as Array<{ name: string; description: string }> | null),
}));
vi.mock('../src/renderer/api', () => ({
  api: {
    skills: { list: mocks.list, search: mocks.search, use: mocks.use },
    extensions: { active: mocks.active, onChange: () => () => {} },
    chat: { commands: mocks.commands },
  },
}));

import { slashIntent, useSkillCommands } from '../src/renderer/chat/SkillCommands';

const skill = (name: string, origin: CatalogSkill['origin'] = 'local', id = `local:/skills/${name}`): CatalogSkill =>
  ({ id, name, description: `${name} steps`, source: origin === 'library' ? 'Hello library' : 'Claude Code', origin });

let host: HTMLDivElement;
let root: Root;
const sent: string[] = [];
const errors: unknown[] = [];

function Composer() {
  const [draft, setDraft] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const commands = useSkillCommands({ conversationId: 'c1', draft, setDraft, focus: () => field.current?.focus(), onError: reason => errors.push(reason) });
  return createElement('form', { className: 'composer' },
    commands.popup,
    createElement('textarea', {
      ref: field, 'aria-label': 'Message', value: draft,
      onChange: (event: { target: HTMLTextAreaElement }) => setDraft(event.target.value),
      onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (commands.onKeyDown(event)) return;
        if (event.key === 'Enter') { event.preventDefault(); sent.push(draft); }
      },
    }));
}

const textarea = () => host.querySelector('textarea')!;
const rows = () => [...host.querySelectorAll('[role="option"]')].map(row => row.textContent);
async function type(text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(textarea(), text);
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { await Promise.resolve(); });
}
async function press(key: string) {
  await act(async () => { textarea().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  // Node's own localStorage stands in front of jsdom's here: one of this test's.
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, String(value)); },
    removeItem: (key: string) => { stored.delete(key); }, clear: () => stored.clear(),
  });
  mocks.commands.mockResolvedValue(null);
  sent.length = 0; errors.length = 0;
  mocks.list.mockResolvedValue([skill('pdf', 'library', 'library:r1'), skill('frontend-design'), skill('xlsx')]);
  mocks.active.mockResolvedValue(['r1']);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(createElement(Composer)); });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('what the draft asks of the / menu', () => {
  it('reads a skill name or a search', () => {
    expect(slashIntent('/')).toEqual({ kind: 'pick', token: '' });
    expect(slashIntent('/Front')).toEqual({ kind: 'pick', token: 'front' });
    expect(slashIntent('/skill:front')).toEqual({ kind: 'pick', token: 'front' });
    expect(slashIntent('/find-skills')).toEqual({ kind: 'pick', token: 'find-skills' });
    expect(slashIntent('/find-skills ')).toEqual({ kind: 'find', query: '' });
    expect(slashIntent('/findskills pdf forms')).toEqual({ kind: 'find', query: 'pdf forms' });
    expect(slashIntent('look at /tmp')).toBeNull();
    expect(slashIntent('/skill:pdf fill this')).toBeNull();
  });
});

describe('the composer’s / menu', () => {
  it('lists every skill, filters by name, and turns the picked one on', async () => {
    await type('/');
    expect(rows()[0]).toContain('/find-skills');
    expect(rows().slice(1).map(row => row?.split(/Hello library|Claude Code/)[0])).toEqual(['pdf', 'frontend-design', 'xlsx']);
    // Already on in this chat.
    expect(host.querySelector('[aria-label="On in this chat"]')).not.toBeNull();
    await type('/fr');
    expect(rows()).toHaveLength(1);
    mocks.use.mockResolvedValue({ name: 'frontend-design', resourceId: 'r2', imported: true, source: 'Claude Code' });
    await press('Enter');
    expect(mocks.use).toHaveBeenCalledWith('local:/skills/frontend-design', 'c1');
    expect(textarea().value).toBe('/skill:frontend-design ');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(sent).toEqual([]);
  });

  it('searches this Mac and skills.sh for a task, then uses a result', async () => {
    mocks.search.mockResolvedValue({ local: [], online: [{ ...skill('deck-builder', 'online', 'skills.sh:acme/decks/deck-builder'), source: 'skills.sh · acme/decks', installs: 1200 }] });
    await type('/find');
    await press('Enter');
    expect(textarea().value).toBe('/find-skills ');
    await type('/find-skills slide decks');
    expect(rows()[0]).toContain('Search for “slide decks”');
    await press('Enter');
    expect(mocks.search).toHaveBeenCalledWith('slide decks', true);
    expect(rows()[0]).toContain('deck-builder');
    expect(rows()[0]).toContain('1.2k installs');
    mocks.use.mockResolvedValue({ name: 'deck-builder', resourceId: 'r3', imported: true, source: 'skills.sh · acme/decks' });
    await press('Enter');
    expect(mocks.use).toHaveBeenCalledWith('skills.sh:acme/decks/deck-builder', 'c1');
    expect(textarea().value).toBe('/skill:deck-builder ');
  });

  it('stays out of the way of a message that only starts with a slash', async () => {
    await type('/Users/q/notes.md');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    await press('Enter');
    expect(sent).toEqual(['/Users/q/notes.md']);
  });

  it('closes on Escape until the draft changes', async () => {
    await type('/p');
    expect(rows()).toHaveLength(1);
    await press('Escape');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    await type('/pd');
    expect(rows()).toHaveLength(1);
    // Closed for that draft only: typed again later, it opens again.
    await press('Escape');
    await type('');
    await type('/pd');
    expect(rows()).toHaveLength(1);
  });

  it('never sends a search command as a message', async () => {
    await type('/find-skills ');
    await press('Enter');
    let resolve!: (value: unknown) => void;
    mocks.search.mockReturnValue(new Promise(done => { resolve = done; }));
    await type('/find-skills slides');
    await press('Enter');
    // Searching: nothing to pick yet, and Enter still is not a send.
    await press('Enter');
    expect(mocks.search).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ local: [], online: [] }); });
    expect(host.textContent).toContain('No skill fits that');
    await press('Enter');
    expect(sent).toEqual([]);
  });

  it('leaves Shift+Tab to move focus', async () => {
    await type('/p');
    await press('Tab');
    expect(mocks.use).toHaveBeenCalledTimes(1);
    mocks.use.mockClear();
    await type('/x');
    await act(async () => { textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })); });
    expect(mocks.use).not.toHaveBeenCalled();
  });

  it('keeps words written while a skill was being copied', async () => {
    let resolve!: (value: unknown) => void;
    mocks.use.mockReturnValue(new Promise(done => { resolve = done; }));
    await type('/xl');
    await press('Enter');
    await type('make a budget sheet');
    await act(async () => { resolve({ name: 'xlsx', resourceId: 'r4', imported: true, source: 'Claude Code' }); });
    expect(textarea().value).toBe('/skill:xlsx make a budget sheet');
  });

  it('reports a skill that could not be turned on, and keeps the draft', async () => {
    mocks.use.mockRejectedValue(new Error('No SKILL.md for xlsx was found.'));
    await type('/xl');
    await press('Enter');
    await act(async () => { await Promise.resolve(); });
    expect(errors.map(String)).toEqual(['Error: No SKILL.md for xlsx was found.']);
    expect(textarea().value).toBe('/xl');
  });
});

// The chat's plugin commands too (user, 30.09: "/sub… should offer /subagents").
describe('plugin commands in the / menu', () => {
  it('offers the chat’s plugin commands by name and writes the one picked', async () => {
    mocks.commands.mockResolvedValue([
      { name: 'subagents', description: 'Administer subagents: inspect metadata and update models' },
      { name: 'run', description: 'Run one subagent through workflowScript' },
    ]);
    await type('/sub');
    expect(rows()[0]).toBe('/subagentsPlugin command · Administer subagents: inspect metadata and update models');
    expect(rows().some(row => row?.startsWith('/run'))).toBe(false);
    await press('Enter');
    expect(textarea().value).toBe('/subagents ');
    expect(sent).toEqual([]);
  });

  it('keeps offering what the chat’s Pi last said while it does not run', async () => {
    mocks.commands.mockResolvedValueOnce([{ name: 'subagents', description: 'Administer subagents' }]);
    await type('/sub');
    await type('');
    // After a restart, before Pi runs again: nothing to ask, the last list stands.
    mocks.commands.mockResolvedValue(null);
    await type('/sub');
    expect(rows()[0]).toBe('/subagentsPlugin command · Administer subagents');
  });
});
