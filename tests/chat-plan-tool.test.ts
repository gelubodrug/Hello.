import { describe, expect, it, vi } from 'vitest';
import { executeTool, toolDefinitions } from '../src/main/chat/tools';
import type { DataStore } from '../src/main/data/store';
import type { NotebookEntry } from '../src/shared/types';

function fixture(existing: NotebookEntry[] = []) {
  const saveNotebook = vi.fn((input: { title: string; body: string; id?: string }) =>
    ({ id: input.id ?? 'plan-1', conversationId: 'chat', kind: 'tasks', ...input, createdAt: 1, updatedAt: 2 }));
  const store = {
    getConversation: vi.fn(() => ({ id: 'chat', folder: null })),
    listNotebooks: vi.fn(() => existing),
    saveNotebook,
  } as unknown as DataStore;
  return { store, saveNotebook, context: { store, conversationId: 'chat', signal: new AbortController().signal, approve: vi.fn(async () => false) } };
}
const body = (save: ReturnType<typeof fixture>['saveNotebook']) => save.mock.calls.at(-1)![0].body;

describe('the plan a chat works from', () => {
  it('carries its own policy, including when not to make one', () => {
    const plan = toolDefinitions(false, false).find(item => item.function.name === 'plan_write');
    // opencode's planning is entirely prompt-driven and works; what carries it
    // is a tool whose description is the policy, not a line in a system prompt.
    expect(plan?.function.description).toContain('Do NOT use it when');
    expect(plan?.function.description).toContain('three trivial ones');
    expect(plan?.function.description).toContain('exactly one step in_progress');
    expect(plan?.function.description).toContain('never on intent');
  });

  it('writes the whole list into the notebook the human can edit', async () => {
    const { saveNotebook, context } = fixture();
    const result = JSON.parse(await executeTool('plan_write', { steps: [
      { step: 'Add the toggle', status: 'done' },
      { step: 'Wire the preference', status: 'in_progress' },
      { step: 'Run the tests' },
    ] }, context));
    expect(saveNotebook).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tasks', title: 'Plan' }));
    // The format the Tasks notebook already reads, so notebook_task_status and
    // the human's own editing keep working on the same lines.
    expect(body(saveNotebook)).toBe(
      '- [x] Add the toggle\n- [ ] **In progress** — Wire the preference\n- [ ] Run the tests');
    expect(result).toMatchObject({ steps: 3, working: 'Wire the preference' });
  });

  it('replaces the plan instead of leaving two, and refuses two things at once', async () => {
    const existing = [{ id: 'old', conversationId: 'chat', kind: 'tasks', title: 'Plan', body: 'x', createdAt: 1, updatedAt: 1 }] as NotebookEntry[];
    const { saveNotebook, context } = fixture(existing);
    await executeTool('plan_write', { steps: [{ step: 'Only this' }] }, context);
    expect(saveNotebook).toHaveBeenCalledWith(expect.objectContaining({ id: 'old' }));
    await expect(executeTool('plan_write', { steps: [
      { step: 'One', status: 'in_progress' }, { step: 'Two', status: 'in_progress' },
    ] }, context)).rejects.toThrow('Only one step may be in_progress');
  });
});
