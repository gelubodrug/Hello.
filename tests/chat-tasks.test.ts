import { describe, expect, it } from 'vitest';
import { findTask, updateTaskStatus } from '../src/main/chat/tasks';

// The exact source is the proof; the line is where to look first. A model
// with the right words and a line counted from the wrong place was refused
// "That line is not a task" twice (user, 28.09: "cred că avem un pseudo error").
describe('a task named by its exact source', () => {
  const body = [
    '# UI improvements — context meter, attention queue, message search',
    '',
    '## 1. Context meter',
    '',
    '- [ ] Subtask: Add context/usage state (tokens in/out, model, endpoint)',
    '- [ ] Subtask: Render compact meter bar under composer',
    '- [ ] Verify: typecheck passes',
    '',
    '## 2. Attention',
    '- [ ] Verify: typecheck passes',
  ].join('\n');
  const first = '- [ ] Subtask: Add context/usage state (tokens in/out, model, endpoint)';

  it('updates the task the words name when the line given is a heading or a blank', () => {
    for (const line of [1, 2, 3, undefined]) {
      expect(findTask(body, line, first).line).toBe(5);
      expect(updateTaskStatus(body, line, first, 'in_progress').split('\n')[4])
        .toBe('- [ ] **In progress** — Subtask: Add context/usage state (tokens in/out, model, endpoint)');
    }
  });

  it('still refuses a source that changed, and says what the line reads now', () => {
    const started = updateTaskStatus(body, 5, first, 'in_progress');
    expect(() => updateTaskStatus(started, 5, first, 'done')).toThrow(
      'This task changed since you read it: line 5 now reads "- [ ] **In progress** — Subtask: Add context/usage state (tokens in/out, model, endpoint)".');
  });

  it('asks which one when the same source is there twice, and lists the tasks when none reads it', () => {
    expect(() => findTask(body, 1, '- [ ] Verify: typecheck passes')).toThrow(
      '2 tasks read exactly "- [ ] Verify: typecheck passes", on lines 7, 10: give the line of the one you mean.');
    expect(findTask(body, 10, '- [ ] Verify: typecheck passes').line).toBe(10);
    expect(() => findTask(body, 2, '- [ ] Something else')).toThrow(
      /^No task in this entry reads "- \[ \] Something else"\. Its tasks now: 5: - \[ \] Subtask: Add context/);
  });
});
