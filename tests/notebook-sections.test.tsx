// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, NotebookChange, NotebookEntry, NotebookKind } from '../src/shared/types';

const state = vi.hoisted(() => ({
  rows: [] as NotebookEntry[],
  listeners: new Set<(event: NotebookChange) => void>(),
}));
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  share: vi.fn(),
  update: vi.fn(),
}));
vi.mock('../src/renderer/api', () => ({
  api: {
    notebooks: {
      list: mocks.list, save: mocks.save, share: mocks.share, delete: vi.fn(), paths: vi.fn(),
      onChange: (listener: (event: NotebookChange) => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener); },
    },
    conversations: { update: mocks.update },
    chat: { onEvent: () => () => {} },
    system: { copy: vi.fn() },
  },
}));

import { Notebook, sectionOn } from '../src/renderer/notebook/Notebook';

const entry = (id: string, kind: NotebookKind, title: string, shared = true, createdAt = 1): NotebookEntry =>
  ({ id, conversationId: 'c1', kind, title, body: '', createdAt, updatedAt: createdAt, shared });
const chat = (patch: Partial<Conversation> = {}): Conversation =>
  ({ id: 'c1', title: 'Chat', folder: null, createdAt: 1, updatedAt: 1, runbook: true, tasks: true, planning: false, ...patch });

let host: HTMLDivElement;
let root: Root;
const changed: Conversation[] = [];

async function render(conversation = chat()) {
  await act(async () => {
    root.render(createElement(Notebook, { conversation, onConversationChange: value => changed.push(value), reportError: vi.fn() }));
  });
  await act(async () => { await Promise.resolve(); });
}
const section = (title: string) => [...host.querySelectorAll<HTMLElement>('.notebook-section')]
  .find(node => node.querySelector('.notebook-section-title')?.textContent === title)!;
const switchOf = (node: Element) => node.querySelector<HTMLButtonElement>('[role="switch"]')!;
const chapter = (title: string) => [...host.querySelectorAll<HTMLElement>('.notebook-entry-row')]
  .find(node => node.querySelector('.notebook-entry')?.textContent === title)!;
async function click(node: Element) {
  await act(async () => { node.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  // Node ≥ 25 exposes its own (unconfigured, undefined) localStorage over jsdom's; give the notebook a real one.
  const kept = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, String(value)); },
    removeItem: (key: string) => { kept.delete(key); }, clear: () => kept.clear(), key: (i: number) => [...kept.keys()][i] ?? null,
    get length() { return kept.size; },
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  changed.length = 0;
  state.listeners.clear();
  state.rows = [
    entry('r1', 'runbook', 'Chapter 1'),
    entry('r2', 'runbook', 'Chapter 2', false),
    entry('t1', 'tasks', 'Tasks 1'),
  ];
  mocks.list.mockImplementation(async (_id: string, kind: NotebookKind) => state.rows.filter(row => row.kind === kind));
  mocks.share.mockImplementation(async (id: string, shared: boolean) => {
    state.rows = state.rows.map(row => row.id === id ? { ...row, shared } : row);
    return state.rows.find(row => row.id === id);
  });
  mocks.save.mockImplementation(async (input: { kind: NotebookKind; title: string; body: string }) => {
    const saved = entry(`new-${state.rows.length}`, input.kind, input.title, true, 50 + state.rows.length);
    state.rows = [...state.rows, saved];
    return saved;
  });
  mocks.update.mockImplementation(async (_id: string, patch: Partial<Conversation>) => chat(patch));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

describe('one notebook with three sections', () => {
  it('lists Runbooks, Tasks and Plans with their chapters, each section and chapter with its own switch', async () => {
    await render();
    const titles = [...host.querySelectorAll('.notebook-section-title')].map(node => node.textContent);
    expect(titles).toEqual(['Runbooks', 'Tasks', 'Plans']);
    expect(switchOf(section('Runbooks').querySelector('.notebook-section-header')!).getAttribute('aria-checked')).toBe('true');
    // Plans follows Plan, off in this chat: shown, quieter, and says what turning it on does.
    expect(section('Plans').dataset.on).toBe('false');
    expect(section('Plans').textContent).toContain('Turn Plans on and the model keeps a plan here');
    expect(switchOf(chapter('Chapter 1')).getAttribute('aria-checked')).toBe('true');
    expect(switchOf(chapter('Chapter 2')).getAttribute('aria-label')).toBe('“Chapter 2” off — hidden from the model');
    expect(chapter('Chapter 2').dataset.shared).toBe('false');
    // Only a Runbook chapter has a switch: Tasks and Plans follow their section (user, 29.09).
    expect(chapter('Tasks 1').querySelector('[role="switch"]')).toBeNull();
    // The first chapter opens in the editor.
    expect(host.querySelector<HTMLInputElement>('[aria-label="Entry title"]')!.value).toBe('Chapter 1');
  });

  it('switches a chapter without opening it, and a section through the chat’s own setting', async () => {
    await render();
    await click(switchOf(chapter('Chapter 2')));
    expect(mocks.share).toHaveBeenCalledWith('r2', true);
    expect(chapter('Chapter 2').dataset.shared).toBe('true');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Entry title"]')!.value).toBe('Chapter 1');
    await click(switchOf(section('Tasks').querySelector('.notebook-section-header')!));
    expect(mocks.update).toHaveBeenCalledWith('c1', { tasks: false });
    await click(switchOf(section('Plans').querySelector('.notebook-section-header')!));
    expect(mocks.update).toHaveBeenLastCalledWith('c1', { planning: true });
    expect(changed.map(value => value.planning)).toEqual([false, true]);
  });

  it('puts the switch back when the chapter could not be switched', async () => {
    mocks.share.mockRejectedValueOnce(new Error('Notebook entry not found.'));
    await render();
    await click(switchOf(chapter('Chapter 1')));
    expect(chapter('Chapter 1').dataset.shared).toBe('true');
    expect(host.textContent).toContain('Notebook entry not found.');
  });

  it('adds a chapter to the section whose + was pressed, and opens it', async () => {
    await render(chat({ planning: true }));
    await click(section('Plans').querySelector('[aria-label="New chapter in Plans"]')!);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ kind: 'plan', title: 'Untitled' }));
    expect(section('Plans').textContent).toContain('Untitled');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Entry title"]')!.value).toBe('Untitled');
  });

  it('folds a section, shows six chapters before “Show more”, and remembers both', async () => {
    state.rows = Array.from({ length: 8 }, (_, index) => entry(`r${index}`, 'runbook', `Chapter ${index + 1}`, true, index + 1));
    await render();
    expect(section('Runbooks').querySelectorAll('.notebook-entry-row')).toHaveLength(6);
    await click([...section('Runbooks').querySelectorAll('button')].find(node => node.textContent === 'Show more')!);
    expect(section('Runbooks').querySelectorAll('.notebook-entry-row')).toHaveLength(8);
    await click(section('Tasks').querySelector('.notebook-section-title')!);
    expect(section('Tasks').querySelector('.notebook-section-entries')).toBeNull();
    expect(JSON.parse(localStorage.getItem('hello.notebookView.c1')!)).toMatchObject({ collapsed: ['tasks'], expanded: ['runbook'] });
  });

  it('restores a draft kept before its chapter moved from Tasks to Plans', async () => {
    state.rows = [entry('p1', 'plan', 'Plan')];
    localStorage.setItem('hello.notebook.p1', JSON.stringify({ ...entry('p1', 'tasks', 'Plan, edited'), expectedUpdatedAt: 1 }));
    mocks.save.mockImplementation(async (input: NotebookEntry) => {
      const saved = { ...input, updatedAt: 2, shared: true };
      state.rows = state.rows.map(row => row.id === saved.id ? saved : row);
      return saved;
    });
    await render(chat({ planning: true }));
    expect(section('Plans').textContent).toContain('Plan, edited');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Entry title"]')!.value).toBe('Plan, edited');
    // Saved back into the section it is in now.
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1', kind: 'plan', title: 'Plan, edited' }));
  });

  it('reopens the chapter that was being read', async () => {
    localStorage.setItem('hello.notebookView.c1', JSON.stringify({ selected: 't1' }));
    await render();
    expect(host.querySelector<HTMLInputElement>('[aria-label="Entry title"]')!.value).toBe('Tasks 1');
  });

  it('knows which sections are on: Plans is on while Plan is', () => {
    expect(sectionOn({ runbook: undefined, tasks: undefined, planning: undefined }, 'runbook')).toBe(true);
    expect(sectionOn({ runbook: true, tasks: false, planning: false }, 'tasks')).toBe(false);
    expect(sectionOn({ runbook: true, tasks: true, planning: undefined }, 'plan')).toBe(false);
    expect(sectionOn({ runbook: true, tasks: true, planning: true }, 'plan')).toBe(true);
  });
});
