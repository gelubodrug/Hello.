export const taskStatuses = ['pending', 'in_progress', 'done', 'canceled', 'blocked'] as const;
export type TaskStatus = typeof taskStatuses[number];
const labels: Partial<Record<TaskStatus, string>> = {
  in_progress: 'In progress', canceled: 'Canceled', blocked: 'Blocked',
};
const checklist = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX-])\]\s+(.*)$/;
const statusPrefix = /^\*\*(In progress|Canceled|Blocked)\*\* — /;

/** Line numbers and exact source let an agent update one task without rewriting its siblings. */
export function taskLines(body: string) {
  let fence: { char: string; length: number } | null = null;
  return body.split(/\r?\n/).flatMap((source, index) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(source);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length) fence = null;
      return [];
    }
    if (fence) return [];
    const match = checklist.exec(source);
    if (!match) return [];
    const label = statusPrefix.exec(match[3])?.[1];
    const status: TaskStatus = label === 'Canceled' ? 'canceled' : label === 'Blocked' ? 'blocked'
      : label === 'In progress' || match[2] === '-' ? 'in_progress' : /x/i.test(match[2]) ? 'done' : 'pending';
    return [{ line: index + 1, source, text: match[3].replace(statusPrefix, ''), status }];
  });
}

/**
 * The task an update means. The line given, when it still reads as expected;
 * otherwise the one task whose source is exactly the expected one, wherever it
 * is. The exact source is the proof; the line is only where to look first. A
 * model that counted lines from the wrong place, with the right words, was
 * refused "That line is not a task" twice before it guessed the number (user,
 * 28.09: "cred că avem un pseudo error"). A source that no longer matches any
 * task is still refused: someone changed it since it was read.
 */
export function findTask(body: string, line: number | undefined, expectedLine: string) {
  const tasks = taskLines(body);
  const atLine = line === undefined ? undefined : tasks.find(item => item.line === line);
  if (atLine && atLine.source === expectedLine) return atLine;
  const exact = tasks.filter(item => item.source === expectedLine);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1)
    throw new Error(`${exact.length} tasks read exactly ${JSON.stringify(expectedLine)}, on lines ${exact.map(item => item.line).join(', ')}: give the line of the one you mean.`);
  if (atLine)
    throw new Error(`This task changed since you read it: line ${atLine.line} now reads ${JSON.stringify(atLine.source)}. Update it with that source if it is still the task you mean.`);
  const listed = tasks.slice(0, 20).map(item => `${item.line}: ${item.source}`).join(' | ');
  throw new Error(`No task in this entry reads ${JSON.stringify(expectedLine)}. Its tasks now: ${listed || 'none'}.`);
}

export function updateTaskStatus(body: string, line: number | undefined, expectedLine: string, status: TaskStatus): string {
  const task = findTask(body, line, expectedLine);
  line = task.line;
  const rows = body.split(/\r?\n/);
  const prefix = checklist.exec(task.source)![1];
  rows[line - 1] = `${prefix}[${status === 'done' ? 'x' : ' '}] ${labels[status] ? `**${labels[status]}** — ` : ''}${task.text}`;
  return rows.join(body.includes('\r\n') ? '\r\n' : '\n');
}

/** The plan as the notebook writes checklists, so the human can edit it in
 *  Plans and notebook_task_status keeps working on the same lines. */
export function planBody(steps: Array<{ step: string; status?: TaskStatus }>): string {
  return steps.map(({ step, status = 'pending' }) => {
    const text = step.trim().replace(/\s+/g, ' ').slice(0, 500);
    const label = labels[status];
    return `- [${status === 'done' ? 'x' : ' '}] ${label ? `**${label}** — ` : ''}${text}`;
  }).join('\n');
}
