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

/** A stretch of a reply: words, which stay as written, or steps, which fold under one line. */
export type ReplySegment =
  | { kind: 'prose'; index: number }
  | { kind: 'activity'; start: number; end: number; grouped: boolean; last: boolean };

/**
 * A reply in the order it was made, by one rule a reader can see: what the
 * model SAYS is always on the page, where it said it; what the model DOES —
 * thinking, tool calls — folds. No length decides it and nothing said is
 * ever moved into the fold (user, 16.11: an answer read on screen vanished
 * into the activity list when a tool call followed; then a rule by length
 * kept some lines and folded others, and nobody could tell which).
 *
 * Steps between two things said are one list; a single step is simply its own
 * row, since a list of one would be a wrapper around nothing.
 */
export function replySegments(parts: readonly MessagePart[]): ReplySegment[] {
  const segments: ReplySegment[] = [];
  let start = -1, steps = 0;
  const close = (end: number) => {
    if (start >= 0 && steps) segments.push({ kind: 'activity', start, end, grouped: steps > 1, last: false });
    start = -1;
    steps = 0;
  };
  parts.forEach((part, index) => {
    if (part.type === 'text') {
      if (!meaningful(part)) return;
      close(index);
      segments.push({ kind: 'prose', index });
    } else {
      if (start < 0) start = index;
      steps++;
    }
  });
  close(parts.length);
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index];
    if (segment.kind === 'activity') { segment.last = true; break; }
  }
  return segments;
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

/** A span of work as people say it: 8s, 1m 05s, 1h 02m. */
export function workDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
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
/** A list of words from the step's input, such as the groups tools_find loaded. */
const words = (part: ToolStep, key: string): string[] => {
  try {
    const value = (JSON.parse(part.input) as Record<string, unknown>)[key];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').slice(0, 6) : [];
  } catch { return []; }
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
 * Every tool Hello can call, named the way it would be said out loud. A
 * plugin's tool has no name in Hello's words: it is said by its own name,
 * "Used subagent", because "Ran a step" said nothing a reader could use
 * (user, 29.09). An MCP server's tool stays "a connected tool".
 */
const NAMES: Record<string, Naming> = {
  // The groups it loaded, by the names people know them by: a plugin's, an
  // MCP server's, or an area of Hello's own tools.
  tools_find: {
    one: part => {
      const groups = words(part, 'groups').map(id => id.replace(/^(?:plugin|mcp):/, ''));
      if (groups.length) return `${past(part) ? 'Loaded' : 'Load'} ${groups.join(', ')} tools`;
      return past(part) ? 'Looked for tools' : 'Look for tools';
    },
    many: count => `Loaded tools ${count} times`,
  },
  web_search: named('Search web', 'Searched web', count => `Ran ${count} searches`),
  fetch_url: {
    one: part => { const where = site(field(part, 'url')); return where ? `Read ${where}` : past(part) ? 'Read web page' : 'Read web page'; },
    many: count => `Read ${count} pages`,
  },
  plan_write: named('Write the plan', 'Wrote the plan', count => `Updated the plan ${count} times`),
  // The chat's Workbook page; a sheet tool's "workbook" is an Excel file.
  notebook_list: named('Open Workbook page', 'Read Workbook page', count => `Read the Workbook page ${count} times`),
  notebook_save: named('Save note', 'Saved note', count => `Saved ${count} notes`),
  notebook_task_status: named('Update task', 'Updated task', count => `Updated ${count} tasks`),
  notebook_paths: named('Find Workbook files', 'Found Workbook files', count => `Looked for Workbook files ${count} times`),
  file_list: named('List files', 'Listed files', count => `Listed ${count} folders`),
  file_search: named('Search files', 'Searched files', count => `Searched files ${count} times`),
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
  bash: named('Run command', 'Ran command', count => `Ran ${count} commands`),
  // Steps saved before the shell took its usual name.
  command_run: named('Run command', 'Ran command', count => `Ran ${count} commands`),
  sheet_list: named('Check workbooks', 'Checked workbooks', count => `Checked workbooks ${count} times`),
  sheet_new: named('Make workbook', 'Made workbook', count => `Made ${count} workbooks`),
  sheet_open: {
    one: part => { const name = leaf(field(part, 'path')); return name ? (past(part) ? `Opened ${name}` : `Open ${name}`) : past(part) ? 'Opened workbook' : 'Open workbook'; },
    many: count => `Opened ${count} workbooks`,
  },
  sheet_read: named('Read workbook', 'Read workbook', count => `Read the workbook ${count} times`),
  sheet_write: named('Write to workbook', 'Wrote to workbook', count => `Wrote to the workbook ${count} times`),
  sheet_save: {
    one: part => { const name = leaf(field(part, 'path')); return name ? (past(part) ? `Saved ${name}` : `Save ${name}`) : past(part) ? 'Saved workbook' : 'Save workbook'; },
    many: count => `Saved ${count} workbooks`,
  },
  pdf_read: {
    one: part => { const name = leaf(field(part, 'path')); return name ? (past(part) ? `Read ${name}` : `Read ${name}`) : 'Read PDF'; },
    many: count => `Read PDFs ${count} times`,
  },
  pdf_inspect: {
    one: part => { const name = leaf(field(part, 'path')); return name ? (past(part) ? `Looked at ${name}` : `Look at ${name}`) : past(part) ? 'Looked at PDF' : 'Look at PDF'; },
    many: count => `Looked at ${count} PDFs`,
  },
  pdf_compress: {
    one: part => { const name = leaf(field(part, 'path')); return name ? (past(part) ? `Compressed ${name}` : `Compress ${name}`) : past(part) ? 'Compressed PDF' : 'Compress PDF'; },
    many: count => `Compressed ${count} PDFs`,
  },
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
  browser_mark: named('Mark the page for you', 'Marked the page for you', count => `Marked pages for you ${count} times`),
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
  runtime_status: named('Check model and speed', 'Checked model and speed', count => `Checked model and speed ${count} times`),
  skills_find: {
    one: part => { const need = field(part, 'need'); return need ? (past(part) ? `Looked for a skill for “${need.slice(0, 40)}”` : 'Look for a skill') : past(part) ? 'Looked for a skill' : 'Look for a skill'; },
    many: count => `Looked for skills ${count} times`,
  },
  skill_load: {
    // A found skill arrives by id: its last segment is its name.
    one: part => { const name = field(part, 'name') ?? field(part, 'id')?.split(/[/:]/).filter(Boolean).at(-1); return name ? `Read ${name} skill` : 'Read skill'; },
    many: count => `Read ${count} skills`,
  },
};
const UNNAMED: Naming = {
  one: part => (part.name.startsWith('mcp_')
    ? (past(part) ? 'Used a connected tool' : 'Use a connected tool')
    : `${past(part) ? 'Used' : 'Use'} ${part.name}`),
  many: (count, parts) => parts[0]?.name.startsWith('mcp_')
    ? `Used ${count} connected tools` : `Used ${parts[0]?.name ?? 'a tool'} ${count} times`,
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

/**
 * What a streaming reply says it is doing, under the activity — or nothing,
 * when something on screen already says it.
 *
 * Every moment of a streaming reply says what it is doing. With text already
 * on the page it used to say nothing, so the minutes between tool calls — the
 * model reading a long conversation — looked stuck (user, 12.11). But the
 * thinking row of the activity says "Thinking" and counts the seconds itself,
 * and under it this line said the same words with the same count (user,
 * 18.11): while that row is live, the line stays out of the way.
 */
export function runtimeLine(message: { status: string; runtimePhase?: string; parts?: readonly MessagePart[] }, hasVisibleContent: boolean): string | null {
  if (message.status !== 'streaming') return null;
  const parts = message.parts ?? [];
  const phase = message.runtimePhase;
  const runningTool = [...parts].reverse().find((part): part is Extract<MessagePart, { type: 'tool' }> =>
    part.type === 'tool' && (part.status === 'running' || part.status === 'approval'));
  const at = activityLayout(parts, true).activeThinking;
  const thinking = at >= 0 ? parts[at] : undefined;
  const thinkingShown = thinking?.type === 'thinking' && thinking.durationMs === undefined;
  if (phase === 'compacting') return 'Compacting conversation…';
  if (phase === 'retrying') return 'Retrying response…';
  if (phase === 'starting') return 'Starting chat…';
  if (runningTool?.status === 'approval') return 'Waiting for your approval…';
  if (runningTool) return `${stepLabel([runningTool], true)}…`;
  if (phase === 'thinking') return thinkingShown ? null : 'Thinking…';
  if (phase === 'writing') return 'Writing…';
  if (phase === 'tool') return 'Writing a tool call…';
  return hasVisibleContent ? 'Waiting for the model…' : 'Waiting for response…';
}
