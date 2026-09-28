import type { MessagePart } from '../../shared/types';
import { readWebResult } from '../../shared/web';

const meaningful = (part: MessagePart) => part.type === 'tool' || Boolean(part.text.trim());

/** Commentary before/between actions stays in the original timeline. Only text
 * after the last activity part is presented as the answer, never rearranged. */
export function activityLayout(parts: readonly MessagePart[], streaming: boolean) {
  let lastActivity = -1;
  let lastMeaningful = -1;
  let steps = 0;
  let tools = 0;
  parts.forEach((part, index) => {
    if (!meaningful(part)) return;
    lastMeaningful = index;
    if (part.type !== 'text') { lastActivity = index; steps++; }
    if (part.type === 'tool') tools++;
  });
  return {
    activity: parts.slice(0, lastActivity + 1),
    answer: parts.slice(lastActivity + 1),
    answerStart: lastActivity + 1,
    grouped: tools > 0 || steps > 1,
    activeThinking: streaming && parts[lastMeaningful]?.type === 'thinking' ? lastMeaningful : -1,
  };
}

/**
 * Where the live tail of the activity starts. While a reply is still arriving,
 * the whole list is noise — what matters is the work happening now. So the last
 * group of steps stays visible in place, and the one before it too when it is a
 * different kind of work, because "thought, then ran a tool" is one gesture.
 */
export function liveTail(rows: readonly { kind: string }[], maxRows = 4): number {
  if (rows.length <= 1) return 0;
  // A run is one row whether it holds three steps or twelve, so the budget is
  // counted in rows and never cuts into the middle of one.
  return Math.max(0, rows.length - maxRows, rows.length - 2);
}

export function activitySummary(parts: readonly MessagePart[]) {
  let searches = 0;
  let completedTools = 0;
  let failed = 0;
  let approvals = 0;
  let unfinished = 0;
  let web = false;
  const pages = new Set<string>();
  for (const part of parts) {
    if (part.type !== 'tool') continue;
    if (part.status === 'error') failed++;
    if (part.status === 'approval') approvals++;
    if (part.status === 'running') unfinished++;
    const isWeb = part.name === 'web_search' || part.name === 'fetch_url';
    web ||= isWeb;
    const result = readWebResult(part);
    if (result?.kind === 'web_search') searches++;
    if (result?.kind === 'fetch_url') pages.add(result.source.url);
    if (!isWeb && part.status === 'complete') completedTools++;
  }
  const counts = [
    searches ? `${searches} ${searches === 1 ? 'search' : 'searches'}` : '',
    pages.size ? `${pages.size} ${pages.size === 1 ? 'page' : 'pages'} read` : '',
    completedTools ? `${completedTools} ${completedTools === 1 ? 'tool' : 'tools'}` : '',
  ].filter(Boolean).join(' · ');
  return { title: web ? 'Research' : 'Activity', counts, failed, approvals, unfinished };
}

export function suppliedDuration(durationMs: number | undefined): number | null {
  return durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null;
}

export function thinkingTitle(active: boolean, durationMs?: number, elapsedMs?: number): string {
  // While it is thinking the count runs, because a number that moves is the
  // difference between "working" and "stuck", and it is the only thing the
  // reader has to judge that by.
  if (active) return elapsedMs !== undefined && elapsedMs >= 1000
    ? `Thinking ${Math.floor(elapsedMs / 1000)}s` : 'Thinking';
  const duration = suppliedDuration(durationMs);
  return duration === null ? 'Thought' : duration < 1000 ? 'Thought briefly' : `Thought ${Number((duration / 1000).toFixed(1))}s`;
}

type ToolStep = Extract<MessagePart, { type: 'tool' }>;

const field = (part: ToolStep, key: string): string | undefined => {
  try {
    const value = (JSON.parse(part.input) as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim() ? value : undefined;
  } catch { return undefined; }
};
const site = (url?: string): string | undefined => {
  try { return new URL(url!).hostname.replace(/^www\./, ''); } catch { return undefined; }
};
const leaf = (path?: string): string | undefined =>
  path?.split(/[\\/]/).filter(Boolean).at(-1);
const past = (part: ToolStep) => part.status === 'complete' || part.status === 'error';

/** What a person would say happened, in one form and in many. */
interface Naming {
  one(part: ToolStep): string;
  many(count: number, parts: readonly ToolStep[]): string;
}
const named = (run: string, ran: string, plural: (count: number) => string): Naming => ({
  one: part => (past(part) ? ran : run),
  many: count => plural(count),
});

/**
 * Every tool Hello can call, named the way it would be said out loud. A tool
 * with no entry here still never shows its identifier: it says what little is
 * true — that a step ran — and carries the raw name after it as detail, where
 * an identifier is data rather than a name.
 */
const NAMES: Record<string, Naming> = {
  web_search: named('Search web', 'Searched web', count => `Ran ${count} searches`),
  fetch_url: {
    one: part => { const where = site(field(part, 'url')); return where ? `Read ${where}` : past(part) ? 'Read web page' : 'Read web page'; },
    many: count => `Read ${count} pages`,
  },
  plan_write: named('Write the plan', 'Wrote the plan', count => `Updated the plan ${count} times`),
  notebook_list: named('Open notebook', 'Read notebook', count => `Read notebook ${count} times`),
  notebook_save: named('Save note', 'Saved note', count => `Saved ${count} notes`),
  notebook_task_status: named('Update task', 'Updated task', count => `Updated ${count} tasks`),
  notebook_paths: named('Find notebook files', 'Found notebook files', count => `Looked for notebook files ${count} times`),
  file_list: named('List files', 'Listed files', count => `Listed ${count} folders`),
  file_read: {
    one: part => { const name = leaf(field(part, 'path')); return name ? `Read ${name}` : 'Read file'; },
    many: count => `Read ${count} files`,
  },
  file_edit: {
    one: part => { const name = leaf(field(part, 'path')); return name ? (past(part) ? `Edited ${name}` : `Edit ${name}`) : past(part) ? 'Edited file' : 'Edit file'; },
    many: count => `Edited ${count} files`,
  },
  file_write: {
    one: part => { const name = leaf(field(part, 'path')); return name ? (past(part) ? `Wrote ${name}` : `Write ${name}`) : past(part) ? 'Wrote file' : 'Write file'; },
    many: count => `Wrote ${count} files`,
  },
  command_run: named('Run command', 'Ran command', count => `Ran ${count} commands`),
  browser_show_html: {
    // Parts of one document are not several documents: a run of them is the
    // writing of a single page, and saying otherwise would count wrong.
    one: part => (field(part, 'more') !== undefined || part.input.includes('"more":true')
      ? 'Writing the document' : past(part) ? 'Created visual' : 'Create visual'),
    many: (count, parts) => parts.some(part => part.input.includes('"more":true'))
      ? `Wrote the document in ${count} parts` : `Created ${count} visuals`,
  },
  browser_open: named('Open in browser', 'Opened in browser', count => `Opened ${count} pages`),
  browser_tabs: named('Check open tabs', 'Checked open tabs', count => `Checked open tabs ${count} times`),
  browser_read: named('Read open page', 'Read open page', count => `Read ${count} open pages`),
  browser_note: named('Note about this site', 'Noted about this site', count => `Noted about ${count} sites`),
  browser_navigate: {
    one: part => { const where = site(field(part, 'url')); return where ? (past(part) ? `Went to ${where}` : `Go to ${where}`) : past(part) ? 'Went to page' : 'Go to page'; },
    many: count => `Went to ${count} pages`,
  },
  browser_click: {
    // The words the model clicked by are the words a person would use too.
    one: part => { const what = field(part, 'label')?.slice(0, 40); return what ? (past(part) ? `Clicked “${what}”` : `Click “${what}”`) : past(part) ? 'Clicked on page' : 'Click on page'; },
    many: count => `Clicked ${count} times`,
  },
  browser_type: named('Type text', 'Typed text', count => `Typed ${count} times`),
  browser_scroll: named('Scroll page', 'Scrolled page', count => `Scrolled ${count} times`),
  browser_wait: named('Wait for page', 'Waited for page', count => `Waited for pages ${count} times`),
  browser_press: {
    one: part => { const key = field(part, 'key'); return past(part) ? `Pressed ${key ?? 'a key'}` : `Press ${key ?? 'a key'}`; },
    many: count => `Pressed ${count} keys`,
  },
  browser_pointer: {
    one: part => {
      const action = field(part, 'action');
      if (action === 'drag') return past(part) ? 'Dragged on page' : 'Drag on page';
      if (action === 'hover') return past(part) ? 'Pointed at page' : 'Point at page';
      return past(part) ? 'Clicked on page' : 'Click on page';
    },
    many: count => `Used the pointer ${count} times`,
  },
  browser_screenshot: named('Look at page', 'Looked at page', count => `Looked at page ${count} times`),
  browser_download: named('Save file from page', 'Saved file from page', count => `Saved ${count} files from pages`),
  browser_downloads: named('Check downloads', 'Checked downloads', count => `Checked downloads ${count} times`),
  worker_list: named('Check workers', 'Checked workers', count => `Checked workers ${count} times`),
  worker_read: named('Read worker pane', 'Read worker pane', count => `Read worker panes ${count} times`),
  worker_key: {
    one: part => { const key = field(part, 'key'); return past(part) ? `Pressed ${key ?? 'a key'}` : `Press ${key ?? 'a key'}`; },
    many: count => `Pressed ${count} keys`,
  },
  worker_wait: named('Wait for the worker', 'Waited for the worker', count => `Waited ${count} times`),
  worker_start: {
    one: part => { const which = field(part, 'worker'); return past(part) ? `Opened ${which ?? 'a terminal'}` : `Open ${which ?? 'a terminal'}`; },
    many: count => `Opened ${count} panes`,
  },
  worker_answer: named('Answer the worker', 'Answered the worker', count => `Answered workers ${count} times`),
  worker_say: {
    one: part => { const said = field(part, 'text'); return said ? (past(part) ? `Said “${said.slice(0, 40)}” to a worker` : 'Talk to worker') : past(part) ? 'Talked to worker' : 'Talk to worker'; },
    many: count => `Talked to workers ${count} times`,
  },
  skill_load: {
    one: part => { const name = field(part, 'name'); return name ? `Read ${name} skill` : 'Read skill'; },
    many: count => `Read ${count} skills`,
  },
};
const UNNAMED: Naming = {
  one: part => (part.name.startsWith('mcp_')
    ? (past(part) ? 'Used a connected tool' : 'Use a connected tool')
    : (past(part) ? 'Ran a step' : 'Run a step')),
  many: (count, parts) => parts[0]?.name.startsWith('mcp_')
    ? `Used ${count} connected tools` : `Ran ${count} steps`,
};

/** The label for one step or for a run of them. Never a tool identifier. */
export function stepLabel(parts: readonly MessagePart[], active = false): string {
  const tools = parts.filter((part): part is ToolStep => part.type === 'tool');
  if (!tools.length) {
    const thinking = parts.filter(part => part.type === 'thinking');
    const total = thinking.reduce((sum, part) =>
      sum + (suppliedDuration(part.type === 'thinking' ? part.durationMs : undefined) ?? 0), 0);
    return thinkingTitle(active, thinking.some(part => part.type === 'thinking' && part.durationMs !== undefined) ? total : undefined);
  }
  const naming = NAMES[tools[0].name] ?? UNNAMED;
  return tools.length === 1 ? naming.one(tools[0]) : naming.many(tools.length, tools);
}

/** The identifier a step carries as detail, when its name could not say it. */
export function stepDetail(parts: readonly MessagePart[]): string | undefined {
  const first = parts[0];
  if (first?.type !== 'tool' || NAMES[first.name]) return undefined;
  return first.name;
}

/** One row of the timeline: a run of consecutive steps that are the same work. */
export interface ActivityRow {
  key: string;
  kind: string;
  start: number;
  parts: MessagePart[];
  count: number;
  status: 'approval' | 'error' | 'running' | 'complete';
}

const rank = { approval: 3, error: 2, running: 1, complete: 0 } as const;

/**
 * Consecutive identical steps are one row. Commentary never merges — two
 * remarks are never the same words — and neither do steps with anything
 * between them.
 */
export function activityRows(parts: readonly MessagePart[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  parts.forEach((part, index) => {
    if (!meaningful(part)) return;
    const kind = part.type === 'tool' ? `tool:${part.name}` : part.type === 'thinking' ? 'thinking' : `text:${index}`;
    const last = rows.at(-1);
    if (last && last.kind === kind) {
      last.parts.push(part);
      last.count += 1;
    } else {
      rows.push({
        key: part.type === 'tool' ? part.id : `${kind}:${index}`,
        kind, start: index, parts: [part], count: 1, status: 'complete',
      });
    }
  });
  for (const row of rows) {
    row.status = row.parts.reduce<ActivityRow['status']>((worst, part) => {
      const state = part.type === 'tool' ? part.status : 'complete';
      return rank[state] > rank[worst] ? state : worst;
    }, 'complete');
  }
  return rows;
}
