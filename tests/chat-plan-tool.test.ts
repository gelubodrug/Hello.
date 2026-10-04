import { describe, expect, it, vi } from 'vitest';
import { executeTool, toolDefinitions } from '../src/main/chat/tools';
import type { DataStore } from '../src/main/data/store';
import type { NotebookEntry } from '../src/shared/types';

function fixture(existing: NotebookEntry[] = []) {
  const saveNotebook = vi.fn((input: { title: string; body: string; id?: string }) =>
    ({ id: input.id ?? 'plan-1', conversationId: 'chat', kind: 'plan', ...input, createdAt: 1, updatedAt: 2, shared: true }));
  const store = {
    // Plans is on while Plan is.
    getConversation: vi.fn(() => ({ id: 'chat', folder: null, planning: true })),
    listNotebooks: vi.fn(() => existing),
    saveNotebook,
  } as unknown as DataStore;
  return { store, saveNotebook, context: { store, conversationId: 'chat', signal: new AbortController().signal, approve: vi.fn(async () => false) } };
}
const body = (save: ReturnType<typeof fixture>['saveNotebook']) => save.mock.calls.at(-1)![0].body;

describe('the plan a chat works from', () => {
  it('is offered only when the human turns Plan on', () => {
    // A model that can see a plan tool reaches for it, and a two-line request
    // answered with a written plan costs a turn (user, 17.09). Off is default.
    expect(toolDefinitions(false, false).some(item => item.function.name === 'plan_write')).toBe(false);
    expect(toolDefinitions(false, true, { skills: [], mcp: [] }, true)
      .some(item => item.function.name === 'plan_write')).toBe(true);
  });

  it('carries its own policy, including when not to make one', () => {
    const plan = toolDefinitions(false, false, { skills: [], mcp: [] }, true)
      .find(item => item.function.name === 'plan_write');
    // opencode's planning is entirely prompt-driven and works; what carries it
    // is a tool whose description is the policy, not a line in a system prompt.
    expect(plan?.function.description).toContain('Do NOT use it when');
    expect(plan?.function.description).toContain('three trivial ones');
    expect(plan?.function.description).toContain('exactly one step in_progress');
    expect(plan?.function.description).toContain('never on intent');
  });

  it('writes the whole list into the notebook’s Plans, where the human can edit it', async () => {
    const { saveNotebook, context } = fixture();
    const result = JSON.parse(await executeTool('plan_write', { steps: [
      { step: 'Add the toggle', status: 'done' },
      { step: 'Wire the preference', status: 'in_progress' },
      { step: 'Run the tests' },
    ] }, context));
    expect(saveNotebook).toHaveBeenCalledWith(expect.objectContaining({ kind: 'plan', title: 'Plan' }));
    // The format the notebook already reads, so notebook_task_status and
    // the human's own editing keep working on the same lines.
    expect(body(saveNotebook)).toBe(
      '- [x] Add the toggle\n- [ ] **In progress** — Wire the preference\n- [ ] Run the tests');
    expect(result).toMatchObject({ steps: 3, working: 'Wire the preference' });
  });

  it('replaces the plan instead of leaving two, and refuses two things at once', async () => {
    const existing = [{ id: 'old', conversationId: 'chat', kind: 'plan', title: 'Plan', body: 'x', createdAt: 1, updatedAt: 1, shared: true }] as NotebookEntry[];
    const { saveNotebook, context } = fixture(existing);
    await executeTool('plan_write', { steps: [{ step: 'Only this' }] }, context);
    expect(saveNotebook).toHaveBeenCalledWith(expect.objectContaining({ id: 'old' }));
    // Two plans: the one worked most recently is the plan.
    const two = fixture([{ ...existing[0], id: 'older', updatedAt: 1 }, { ...existing[0], id: 'newer', createdAt: 2, updatedAt: 9 }]);
    await executeTool('plan_write', { steps: [{ step: 'Carry on' }] }, two.context);
    expect(two.saveNotebook.mock.calls.at(-1)![0]).toMatchObject({ id: 'newer' });
    // Plans have no switch per chapter (user, 29.09): an old off flag does not hide the plan.
    const flagged = fixture([{ ...existing[0], shared: false }]);
    await executeTool('plan_write', { steps: [{ step: 'Same plan' }] }, flagged.context);
    expect(flagged.saveNotebook.mock.calls.at(-1)![0]).toMatchObject({ id: 'old' });
    await expect(executeTool('plan_write', { steps: [
      { step: 'One', status: 'in_progress' }, { step: 'Two', status: 'in_progress' },
    ] }, context)).rejects.toThrow('Only one step may be in_progress');
  });
});
