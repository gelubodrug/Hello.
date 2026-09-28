// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { chatPagesFor } from '../src/renderer/workspace/Workspace';

// A shared page the human switched off is gone from the UI: it is switched
// back on from the chat's menu, never from a tab that is no longer there
// (user, 20.09: "le scoți din UI când sunt off… le activezi din meniu").
describe('the pages a chat shows', () => {
  it('shows both while both are on, including a chat that predates the switches', () => {
    expect(chatPagesFor({ runbook: true, tasks: true })).toEqual(['chat', 'runbook', 'tasks']);
    expect(chatPagesFor({})).toEqual(['chat', 'runbook', 'tasks']);
  });

  it('drops the one that is off, and keeps the chat itself whatever happens', () => {
    expect(chatPagesFor({ runbook: true, tasks: false })).toEqual(['chat', 'runbook']);
    expect(chatPagesFor({ runbook: false, tasks: true })).toEqual(['chat', 'tasks']);
    expect(chatPagesFor({ runbook: false, tasks: false })).toEqual(['chat']);
  });
});
