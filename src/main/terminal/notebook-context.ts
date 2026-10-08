import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openReportChannel, type WorkerReport } from './report-channel';
import type { DataStore } from '../data/store';
import { createPiToolBridge } from '../chat/pi-tool-bridge';
import { helloToolGroups } from '../chat/tool-groups';
import type { ToolOutput } from '../chat/tool-output';
import { executeTool, executeToolOutput, toolDefinitions, type BrowserHooks } from '../chat/tools';

/** Which notebook sections this chat has on: Plans follows Plan. */
const pagesOf = (chat: { runbook?: boolean; tasks?: boolean; planning?: boolean }) =>
  ({ runbook: chat.runbook === true, tasks: chat.tasks === true, plan: chat.planning === true });

export interface WorkerNotebookContext {
  env: Record<string, string>;
  instructionsPath: string;
  instructions: string;
  /** Every report, note and question this worker sends, until close(). */
  listen(handler: (report: WorkerReport) => void): void;
  /** Hands an answer back to a worker blocked on a question. */
  answer(askId: string, text: string): void;
  /**
   * Hello's own Pi extension, for a Pi CLI (user, 30.09): the connection's
   * tools become Pi's own tools. Its environment carries this connection only.
   */
  piExtension?: { path: string; env: Record<string, string> };
  /**
   * The same connection as an MCP server (user, 30.09), for Claude Code and
   * Codex: `server` runs with `runtime` as Node; `config` is Claude's
   * --mcp-config. No secret is in either: the server reads this connection's
   * address and token from its environment, which the CLI hands on by name.
   */
  mcp?: { runtime: string; server: string; config: string };
  close(): Promise<void>;
}

const notebookTools = new Set(['notebook_list', 'notebook_task_status']);
/**
 * Hello's browser, for a CLI (user, 30.09: it could not see it, and read the
 * human's own Chrome through osascript instead, Gmail included). The chat's
 * own tools, bound to this chat's tabs and to each tab's Agent control, which
 * main checks on every call exactly as it does for the chat.
 */
const browserTools = new Set([
  'browser_tabs', 'browser_open', 'browser_show_html', 'browser_read', 'browser_screenshot',
  'browser_navigate', 'browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_wait', 'browser_mark',
]);
const BROWSER_ACTIONS = [...browserTools].map(name => name.slice('browser_'.length));
/** Pictures a CLI took and has not been handed again: the newest stay. */
const KEPT_SCREENSHOTS = 20;

// A standalone Node client, written beside the launch instructions. It uses
// Electron's bundled Node, so native CLIs need no extra Node installation.
// Credentials are inherited from the child environment, never embedded here.
const client = String.raw`'use strict';
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
async function main() {
  const base = process.env.HELLO_NOTEBOOK_BRIDGE_URL;
  const token = process.env.HELLO_NOTEBOOK_BRIDGE_TOKEN;
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(base || '') || !token)
    throw new Error('Hello connection is unavailable. Open a new CLI from this chat.');
  const [command, kind, extra] = process.argv.slice(2);
  const actions = ${JSON.stringify(BROWSER_ACTIONS)};
  if (command === 'browser') {
    if (!actions.includes(kind) || process.argv.length > 5)
      throw new Error('Usage: browser <' + actions.join('|') + '> [JSON arguments]');
  } else if (!['info', 'list', 'status'].includes(command) || process.argv.length > (command === 'list' ? 4 : 3))
    throw new Error('Usage: info | list tasks | list runbook | list plan | status < request.json | browser <action> [JSON arguments]');
  if (command === 'list' && kind !== 'tasks' && kind !== 'runbook' && kind !== 'plan')
    throw new Error('Choose list tasks, list runbook or list plan.');
  const request = async (path, payload, ms) => {
    const response = await fetch(base + path, {
      method: payload ? 'POST' : 'GET', redirect: 'error',
      headers: { Authorization: 'Bearer ' + token, ...(payload ? {'Content-Type': 'application/json'} : {}) },
      ...(payload ? {body: JSON.stringify(payload)} : {}),
      signal: AbortSignal.timeout(ms || 10000),
    });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || 'Hello request failed.');
    return result;
  };
  if (command === 'browser') {
    // Arguments are one JSON object, as the chat's own tool takes them. Only a
    // page's HTML may come on standard input instead: a CLI's shell can hold
    // standard input open forever, so nothing else waits on it.
    const raw = extra !== undefined ? extra : kind === 'show_html' ? readFileSync(0, 'utf8') : '';
    if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error('Browser request is too large.');
    let args = {};
    if (kind === 'show_html' && raw.trim() && !raw.trim().startsWith('{')) args = { html: raw };
    else if (raw.trim()) {
      args = JSON.parse(raw);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected one JSON object of arguments.');
    } else if (kind !== 'tabs') throw new Error('Give the arguments as one JSON object, e.g. browser ' + kind + ' \'{"tabId":"…"}\'.');
    const response = await request('/execute', { name: 'browser_' + kind, args, toolCallId: randomUUID() }, 180000);
    let result = response.result;
    if (typeof result === 'string') { try { result = JSON.parse(result); } catch { return result; } }
    // A page is printed as text, its words and controls one per line, not as
    // one escaped JSON string (user, 30.09: eBay read as a single line of escapes).
    // A picture's pixels stay out of the terminal: its saved path is in the text.
    if (result && typeof result === 'object' && !Array.isArray(result) && typeof result.text === 'string') {
      const { text, images, ...rest } = result;
      return Object.entries(rest).map(([key, value]) => key + ': ' + (typeof value === 'string' ? value : JSON.stringify(value))).concat('', text).join('\n');
    }
    return result;
  }
  const workspace = JSON.parse((await request('/context')).context);
  if (command === 'info') return {workspace};
  let args = {kind};
  if (command === 'status') {
    const input = readFileSync(0, 'utf8');
    if (Buffer.byteLength(input) > 2000000) throw new Error('Status request is too large.');
    args = JSON.parse(input);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected a JSON status object.');
  }
  const response = await request('/execute', {
    name: command === 'list' ? 'notebook_list' : 'notebook_task_status',
    args, toolCallId: randomUUID(),
  });
  const result = JSON.parse(response.result);
  if (result && result.error) throw new Error(result.error);
  return {workspace, [command === 'list' ? 'entries' : 'updated']: result};
}
main().then(result => process.stdout.write((typeof result === 'string' ? result : JSON.stringify(result, null, 2)) + '\n')).catch(error => {
  // Do not print request headers, environment values or network error stacks.
  process.stderr.write((error instanceof Error ? error.message : 'Hello request failed.') + '\n');
  process.exitCode = 1;
});
`;

// Hello's connection as a stdio MCP server, for a CLI that speaks MCP (Claude
// Code, Codex): the connection's own tools — this chat's notebook and browser —
// relayed to Hello, which checks every call as it does for the chat. Written
// beside the shell client and run with Electron's Node; its address and token
// come from the environment the CLI hands it, never from this file.
const mcpServer = String.raw`'use strict';
const { randomUUID } = require('node:crypto');
const readline = require('node:readline');
const base = process.env.HELLO_NOTEBOOK_BRIDGE_URL;
const token = process.env.HELLO_NOTEBOOK_BRIDGE_TOKEN;
const connected = /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(base || '') && Boolean(token);
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
async function request(path, payload, ms) {
  const response = await fetch(base + path, {
    method: payload ? 'POST' : 'GET', redirect: 'error',
    headers: { Authorization: 'Bearer ' + token, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(ms || 10000),
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.error || 'Hello request failed.');
  return result;
}
async function handle(method, params) {
  if (method === 'initialize') return {
    protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: 'hello', version: '1.0.0' },
    instructions: connected
      ? 'Tools of the Hello chat this CLI was opened from: its notebook and the tabs of its browser, each as far as its Agent control allows.'
      : 'The Hello connection is unavailable here. Open a new CLI from Hello.',
  };
  if (method === 'ping') return {};
  if (method === 'tools/list') {
    if (!connected) return { tools: [] };
    const { tools } = await request('/tools');
    return { tools: tools.map(tool => ({ name: tool.function.name, description: tool.function.description, inputSchema: tool.function.parameters })) };
  }
  if (method === 'tools/call') {
    try {
      if (!connected) throw new Error('The Hello connection is unavailable here. Open a new CLI from Hello.');
      const args = params && typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {};
      const { result } = await request('/execute', { name: String(params?.name ?? ''), args, toolCallId: randomUUID() }, 30 * 60000);
      if (typeof result === 'string') return { content: [{ type: 'text', text: result }] };
      return { content: [{ type: 'text', text: result.text },
        ...result.images.map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType }))] };
    } catch (error) {
      // A refused call is the tool's answer, not a broken server.
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Hello request failed.' }], isError: true };
    }
  }
  throw Object.assign(new Error('Method not found: ' + method), { code: -32601 });
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  // A notification (initialized, cancelled) wants no answer.
  if (!message || message.id === undefined || message.id === null) return;
  handle(message.method, message.params).then(
    result => send({ jsonrpc: '2.0', id: message.id, result }),
    error => send({ jsonrpc: '2.0', id: message.id, error: { code: error.code || -32603, message: error.message } }),
  );
}).on('close', () => process.exit(0));
`;

/**
 * One session and one conversation: its notebook's reads and task status, and
 * Hello's browser for this chat's tabs. No shell or file tools: a CLI has its own.
 */
export async function createWorkerNotebookContext(input: {
  store: DataStore;
  conversationId: string;
  cwd: string;
  userDataDir: string;
  /** Hello's browser, as the chat reaches it. Without it, the notebook only. */
  browser?: BrowserHooks;
  /** Where Hello's own Pi extension is, for a Pi CLI to load. */
  piExtension?: string;
}): Promise<WorkerNotebookContext> {
  const { store, conversationId, cwd, browser } = input;
  const launchSelectedFolder = store.getConversation(conversationId).folder;
  const allowed = (name: string) => notebookTools.has(name) || (Boolean(browser) && browserTools.has(name));
  let directory: string | undefined;
  // A picture goes to a file the CLI opens with its own image reader: the path
  // is what the shell client prints, never pixels in a terminal. A Pi CLI,
  // through Hello's extension, gets the pictures themselves as well.
  const handOver = (output: ToolOutput): ToolOutput => {
    if (typeof output === 'string') return output;
    if (!directory) throw new Error('This CLI connection has ended. Open a new CLI from Hello.');
    const shots = join(directory, 'screenshots');
    mkdirSync(shots, { recursive: true, mode: 0o700 });
    const saved = output.images.map(image => {
      const file = join(shots, `${Date.now()}-${randomUUID().slice(0, 8)}.${image.mimeType === 'image/png' ? 'png' : 'jpg'}`);
      writeFileSync(file, Buffer.from(image.data, 'base64'), { mode: 0o600 });
      return file;
    });
    const all = readdirSync(shots).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEPT_SCREENSHOTS))) rmSync(join(shots, old), { force: true });
    return {
      text: [output.text, '', `Saved ${saved.length === 1 ? 'the picture' : `${saved.length} pictures`} — open ${saved.length === 1 ? 'it' : 'them'} with your image-reading tool if you do not see ${saved.length === 1 ? 'it' : 'them'} here:`, ...saved].join('\n'),
      images: output.images,
    };
  };
  const bridge = await createPiToolBridge({
    getTools() {
      const chat = store.getConversation(conversationId);
      const pages = pagesOf(chat);
      return toolDefinitions(false, Boolean(browser), undefined, pages.plan, false, pages)
        .filter(tool => allowed(tool.function.name));
    },
    // The same groups a chat gets: a Pi CLI loads browser or notebook with
    // tools_find instead of carrying every tool from the start (nativ #490).
    getCatalog(tools) {
      const chat = store.getConversation(conversationId);
      const pages = pagesOf(chat);
      return {
        groups: helloToolGroups(tools, {
          chatMode: 'chat', notebooks: { runbook: pages.runbook, tasks: pages.tasks }, planning: pages.plan, mcp: [],
        }),
        plugins: [],
      };
    },
    getContext() {
      const chat = store.getConversation(conversationId);
      // The chat's TITLE is not in here. It is the first thing the human ever
      // typed in that conversation, and a worker was reading it as if it were
      // part of its task (user, 20.09) — it has nothing to do with the work it
      // was given.
      return JSON.stringify({
        conversationId, launchFolder: cwd,
        selectedFolder: chat.folder, launchSelectedFolder,
        folderChanged: chat.folder !== launchSelectedFolder,
        tasksSource: 'Hello Tasks for this conversation, stored by the app. Not a repository tasks directory.',
      });
    },
    async execute(name, args, signal) {
      signal.throwIfAborted();
      if (!allowed(name)) throw new Error('This CLI connection supports notebook reads, task status updates and Hello’s browser.');
      if (browserTools.has(name))
        return handOver(await executeToolOutput(name, args, { store, conversationId, signal, browser, approve: async () => false }));
      const chat = store.getConversation(conversationId);
      if (name === 'notebook_task_status' && chat.folder !== launchSelectedFolder)
        throw new Error('The chat folder changed after this CLI started. Open a new CLI in the selected folder before updating Tasks.');
      return executeTool(name, args, {
        store, conversationId, signal,
        approve: async () => false,
      });
    },
  });
  try {
    const root = join(input.userDataDir, 'cli-notebooks');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    directory = mkdtempSync(join(root, 'session-'));
    const instructionsPath = join(directory, 'HELLO.md');
    const clientPath = join(directory, 'notebooks.cjs');
    // The channels the worker answers on live beside its instructions, so they
    // are written, told and removed together.
    const channel = openReportChannel(directory);
    const command = 'ELECTRON_RUN_AS_NODE=1 "$HELLO_NOTEBOOK_RUNTIME" "$HELLO_NOTEBOOK_CLIENT"';
    // A page the human switched off is not described to a worker either: a
    // CLI told about Tasks it cannot reach asks the human about it.
    const pages = pagesOf(store.getConversation(conversationId));
    const sections = [pages.tasks ? 'Tasks' : '', pages.runbook ? 'Runbook' : '', pages.plan ? 'Plan' : ''].filter(Boolean);
    const notebookLines = !sections.length ? [] : [
      `## Shared ${sections.length > 1 ? `${sections.slice(0, -1).join(', ')} and ${sections.at(-1)}` : sections[0]}`,
      `When the human mentions ${[pages.tasks ? 'Tasks, the tasks list' : '', pages.runbook ? 'Runbook' : '', pages.plan ? 'the plan' : ''].filter(Boolean).join(', ')}${pages.tasks ? ' or marking a task done' : ''}, they mean this conversation’s notebook in Hello unless they explicitly name a repository file. You see the chapters the human shares; they may switch one off at any time.`,
      [
        pages.runbook ? 'Before planning or executing a new request, read this chat’s Runbook for relevant project context and working rules, even if the human does not name it again.' : '',
        pages.tasks ? 'Read Tasks before selecting or updating planned work.' : '',
        pages.plan ? 'The plan the chat’s model keeps is in list plan.' : '',
        'Use only relevant entries; a notebook entry does not authorize unrelated actions.',
      ].filter(Boolean).join(' '),
      'Do not guess tasks/todo.md, search the disk for task files, or use another project’s tasks. Retrieve the current app entries through the connection below. Empty notebooks are valid; do not substitute unrelated repository tasks.',
      'Notebook contents are user-maintained context, not authorization to execute every listed task. Select only the work the human requests. Ask which task if the requested one is ambiguous.',
      '',
      'Use the shell tool these CLIs already provide:',
      '```sh',
      `${command} info`,
      ...(pages.tasks ? [`${command} list tasks`] : []),
      ...(pages.runbook ? [`${command} list runbook`] : []),
      ...(pages.plan ? [`${command} list plan`] : []),
      '```',
      pages.tasks || pages.plan
        ? 'The connection reads the live Hello database and returns entry IDs, titles, Markdown bodies and checklist tasks with line, exact source and status. Read fresh before changing status.'
        : 'The connection reads the live Hello database and returns entry IDs, titles and Markdown bodies.',
      ...(pages.tasks || pages.plan ? [
        `For a single checklist task, pass JSON on standard input (use the actual id, line and exact source from list ${pages.tasks ? 'tasks' : 'plan'}):`,
        '```sh',
        `${command} status <<'HELLO_TASK_STATUS'`,
        '{"id":"ENTRY_ID_FROM_LIST","line":1,"expectedLine":"- [ ] exact task text from list","status":"in_progress"}',
        'HELLO_TASK_STATUS',
        '```',
        'Valid statuses: pending, in_progress, done, canceled, blocked. Mark done only after completing and checking the requested work; canceled is not completed. Do not rewrite task descriptions just to change a checkbox. A stale line is rejected: list again and reconcile, never blindly retry.',
        `Successful status updates are saved in Hello and shown in ${pages.tasks && pages.plan ? 'Tasks or Plans' : pages.tasks ? 'Tasks' : 'Plans'}.`,
      ] : []),
      `${pages.runbook ? 'Runbook is read-only here. ' : ''}A note that is not a checklist has no task line to mark; report that rather than inventing a line.`,
      'The legacy HELLO_RUNBOOK_PATH and HELLO_RUNBOOK_TASKS_PATH environment variables point to read-only exports. Editing an export will NOT update Hello and can be overwritten. Use the live connection for task status.',
      'Never read/write Hello’s database directly. Do not print connection tokens or include environment dumps in prompts/reports. If the connection has ended, open a fresh CLI from Hello; do not fall back to searching repository tasks.',
      '',
    ];
    const browserLines = !browser ? [] : [
      '## The browser in Hello',
      'The browser this conversation shares with the human is the one in Hello, beside you. When the human says the browser, a tab or a page, they mean it. It is never the human’s own browsers: do not script Chrome, Safari or any other app (osascript/AppleScript, remote debugging, their profiles, cookies or history) to read tabs or pages. That is the human’s private browsing, not this workspace.',
      'Browser tools of any other MCP server you may have — another app’s browser bridge, such as open_browser or list_browser_panes — do not reach this chat’s browser. Never use them for it: only Hello’s tools (the hello server’s, or the commands below) do.',
      'Each tab has Agent control, which the human sets: Off (you cannot read it or act in it), Read (read it and take screenshots), Full (also click, type, press, scroll). A page you open yourself starts at Full. Hello checks this on every call; do not ask for another level or work around it.',
      '',
      '```sh',
      `${command} browser tabs`,
      `${command} browser open '{"url":"https://example.com"}'`,
      `${command} browser read '{"tabId":"TAB_ID"}'`,
      `${command} browser click '{"tabId":"TAB_ID","ref":"e12","label":"words on it"}'`,
      `${command} browser type '{"tabId":"TAB_ID","ref":"e4","text":"words"}'`,
      `${command} browser press '{"tabId":"TAB_ID","key":"Enter"}'`,
      `${command} browser scroll '{"tabId":"TAB_ID","deltaY":600}'`,
      `${command} browser wait '{"tabId":"TAB_ID","text":"words the page should show"}'`,
      `${command} browser navigate '{"tabId":"TAB_ID","url":"https://example.com/next"}'`,
      `${command} browser screenshot '{"tabId":"TAB_ID"}'`,
      `${command} browser mark '{"tabId":"TAB_ID","marks":[{"ref":"e12","label":"words on it","note":"what the human should see there"}]}'`,
      `${command} browser show_html < page.html`,
      '```',
      'read returns the page’s text, then its controls, each with a ref (e1, e2 …). Refs hold until the page changes: after a click that opened or changed something, read again. wait takes one of text, ref, label, selector, url, load or ms. screenshot saves a picture and prints its path: open it with your own image-reading tool. show_html shows a page you wrote in Hello’s browser, and prints the artifact handle that reopens it. mark shows the human where to look: numbered pins with your notes on the page (at most six; an empty list clears them), each named by the words it shows on that page (label); then say what each number is. Mark only what that page shows: something found elsewhere is marked on its own page, after you open and read it.',
      'Opening a page proves only that it opened, never that its content is right: read it or look at it before saying so.',
      '',
    ];
    const instructions = [
      '# Hello workspace connection',
      'You are an interactive CLI opened by the human inside Hello. Wait for the human’s request; this connection does not assign or start work.',
      `Your launch working folder is ${JSON.stringify(cwd)}. Work in that folder unless the human explicitly directs otherwise.`,
      'The chat’s folder may later change. Your process keeps its original folder. The info/list responses include both folders; if they differ, explain that a new CLI can be opened in the selected folder.',
      'If your own tools already include notebook_list, notebook_task_status or browser_tabs, browser_read and the rest — a Pi opened from Hello has them, and Claude Code, Codex, Kimi, Qwen Code or OpenCode as the tools of the hello MCP server (mcp__hello__browser_read and the like) — call those: they are this same connection. The shell commands below are for a CLI without them.',
      '',
      ...notebookLines,
      ...browserLines,
      channel.instructions,
    ].join('\n');
    writeFileSync(instructionsPath, instructions, { mode: 0o600 });
    writeFileSync(clientPath, client, { mode: 0o600 });
    // Claude Code expands ${…} in --mcp-config from its own environment, so
    // the token is named here, never written.
    const mcpServerPath = join(directory, 'hello-mcp.cjs');
    const mcpConfigPath = join(directory, 'hello-mcp.json');
    writeFileSync(mcpServerPath, mcpServer, { mode: 0o600 });
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { hello: {
      type: 'stdio', command: process.execPath, args: [mcpServerPath],
      env: { ELECTRON_RUN_AS_NODE: '1', HELLO_NOTEBOOK_BRIDGE_URL: '${HELLO_NOTEBOOK_BRIDGE_URL}', HELLO_NOTEBOOK_BRIDGE_TOKEN: '${HELLO_NOTEBOOK_BRIDGE_TOKEN}' },
    } } }, null, 2), { mode: 0o600 });
    let closing: Promise<void> | undefined;
    return {
      instructionsPath, instructions,
      listen: channel.listen,
      answer: channel.answer,
      mcp: { runtime: process.execPath, server: mcpServerPath, config: mcpConfigPath },
      ...(input.piExtension ? { piExtension: { path: input.piExtension, env: {
        HELLO_PI_BRIDGE_URL: bridge.env.HELLO_PI_BRIDGE_URL,
        HELLO_PI_BRIDGE_TOKEN: bridge.env.HELLO_PI_BRIDGE_TOKEN,
        HELLO_PI_EXTENSION_ROLE: 'cli',
      } } } : {}),
      env: {
        ...channel.env,
        HELLO_NOTEBOOK_BRIDGE_URL: bridge.env.HELLO_PI_BRIDGE_URL,
        HELLO_NOTEBOOK_BRIDGE_TOKEN: bridge.env.HELLO_PI_BRIDGE_TOKEN,
        HELLO_NOTEBOOK_RUNTIME: process.execPath,
        HELLO_NOTEBOOK_CLIENT: clientPath,
        HELLO_WORKSPACE_CONTEXT: instructionsPath,
        HELLO_WORKSPACE_FOLDER: cwd,
      },
      close() {
        if (!closing) closing = bridge.close().finally(() => {
          channel.close();
          if (directory) rmSync(directory, { recursive: true, force: true });
        });
        return closing;
      },
    };
  } catch (error) {
    await bridge.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
