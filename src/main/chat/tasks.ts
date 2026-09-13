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

export function updateTaskStatus(body: string, line: number, expectedLine: string, status: TaskStatus): string {
  const task = taskLines(body).find(item => item.line === line);
  if (!task) throw new Error('That line is not a task. Read notebook_list again for current task line numbers.');
  if (task.source !== expectedLine) throw new Error('This task changed since you read it. Read notebook_list again before updating.');
  const rows = body.split(/\r?\n/);
  const prefix = checklist.exec(task.source)![1];
  rows[line - 1] = `${prefix}[${status === 'done' ? 'x' : ' '}] ${labels[status] ? `**${labels[status]}** — ` : ''}${task.text}`;
  return rows.join(body.includes('\r\n') ? '\r\n' : '\n');
}

/** The plan as the Tasks notebook writes it, so the human can edit it there and
 *  notebook_task_status keeps working on the same lines. */
export function planBody(steps: Array<{ step: string; status?: TaskStatus }>): string {
  return steps.map(({ step, status = 'pending' }) => {
    const text = step.trim().replace(/\s+/g, ' ').slice(0, 500);
    const label = labels[status];
    return `- [${status === 'done' ? 'x' : ' '}] ${label ? `**${label}** — ` : ''}${text}`;
  }).join('\n');
}
