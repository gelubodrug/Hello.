import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openReportChannel, type WorkerReport } from './report-channel';
import type { DataStore } from '../data/store';
import { createPiToolBridge } from '../chat/pi-tool-bridge';
import { executeTool, toolDefinitions } from '../chat/tools';

/** Which shared pages this chat still has. */
const pagesOf = (chat: { runbook?: boolean; tasks?: boolean }) =>
  ({ runbook: chat.runbook !== false, tasks: chat.tasks !== false });

export interface WorkerNotebookContext {
  env: Record<string, string>;
  instructionsPath: string;
  instructions: string;
  /** Every report, note and question this worker sends, until close(). */
  listen(handler: (report: WorkerReport) => void): void;
  /** Hands an answer back to a worker blocked on a question. */
  answer(askId: string, text: string): void;
  close(): Promise<void>;
}

const allowed = new Set(['notebook_list', 'notebook_task_status']);

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
    throw new Error('Hello notebook connection is unavailable. Open a new CLI from this chat.');
  const [command, kind] = process.argv.slice(2);
  if (!['info', 'list', 'status'].includes(command) || process.argv.length > (command === 'list' ? 4 : 3))
    throw new Error('Usage: info | list tasks | list runbook | status < request.json');
  if (command === 'list' && kind !== 'tasks' && kind !== 'runbook')
    throw new Error('Choose list tasks or list runbook.');
  const request = async (path, payload) => {
    const response = await fetch(base + path, {
      method: payload ? 'POST' : 'GET', redirect: 'error',
      headers: { Authorization: 'Bearer ' + token, ...(payload ? {'Content-Type': 'application/json'} : {}) },
      ...(payload ? {body: JSON.stringify(payload)} : {}),
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || 'Hello notebook request failed.');
    return result;
  };
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
main().then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(error => {
  // Do not print request headers, environment values or network error stacks.
  process.stderr.write((error instanceof Error ? error.message : 'Hello notebook request failed.') + '\n');
  process.exitCode = 1;
});
`;

/** One session, one conversation and two notebook operations; no shell/browser tools. */
export async function createWorkerNotebookContext(input: {
  store: DataStore;
  conversationId: string;
  cwd: string;
  userDataDir: string;
}): Promise<WorkerNotebookContext> {
  const { store, conversationId, cwd } = input;
  const launchSelectedFolder = store.getConversation(conversationId).folder;
  const bridge = await createPiToolBridge({
    getTools() {
      const chat = store.getConversation(conversationId);
      return toolDefinitions(false, false, undefined, false, false, pagesOf(chat))
        .filter(tool => allowed.has(tool.function.name));
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
      if (!allowed.has(name)) throw new Error('This CLI connection only supports notebook reads and task status updates.');
      const chat = store.getConversation(conversationId);
      if (name === 'notebook_task_status' && chat.folder !== launchSelectedFolder)
        throw new Error('The chat folder changed after this CLI started. Open a new CLI in the selected folder before updating Tasks.');
      return executeTool(name, args, {
        store, conversationId, signal,
        approve: async () => false,
      });
    },
  });
  let directory: string | undefined;
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
    const notebookLines = !pages.runbook && !pages.tasks ? [] : [
      `## Shared ${[pages.tasks ? 'Tasks' : '', pages.runbook ? 'Runbook' : ''].filter(Boolean).join(' and ')}`,
      `When the human mentions ${[pages.tasks ? 'Tasks, the tasks list' : '', pages.runbook ? 'Runbook' : ''].filter(Boolean).join(', ')}${pages.tasks ? ' or marking a task done' : ''}, they mean this conversation’s notebooks in Hello unless they explicitly name a repository file.`,
      [
        pages.runbook ? 'Before planning or executing a new request, read this chat’s Runbook for relevant project context and working rules, even if the human does not name it again.' : '',
        pages.tasks ? 'Read Tasks before selecting or updating planned work.' : '',
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
      '```',
      pages.tasks
        ? 'The connection reads the live Hello database and returns entry IDs, titles, Markdown bodies and checklist tasks with line, exact source and status. Read fresh before changing status.'
        : 'The connection reads the live Hello database and returns entry IDs, titles and Markdown bodies.',
      ...(pages.tasks ? [
        'For a single checklist task, pass JSON on standard input (use the actual id, line and exact source from list tasks):',
        '```sh',
        `${command} status <<'HELLO_TASK_STATUS'`,
        '{"id":"ENTRY_ID_FROM_LIST","line":1,"expectedLine":"- [ ] exact task text from list","status":"in_progress"}',
        'HELLO_TASK_STATUS',
        '```',
        'Valid statuses: pending, in_progress, done, canceled, blocked. Mark done only after completing and checking the requested work; canceled is not completed. Do not rewrite task descriptions just to change a checkbox. A stale line is rejected: list again and reconcile, never blindly retry.',
        'Successful status updates are saved in Hello and shown in Tasks.',
      ] : []),
      `${pages.runbook ? 'Runbook is read-only here. ' : ''}A note that is not a checklist has no task line to mark; report that rather than inventing a line.`,
      'The legacy HELLO_RUNBOOK_PATH and HELLO_RUNBOOK_TASKS_PATH environment variables point to read-only exports. Editing an export will NOT update Hello and can be overwritten. Use the live connection for task status.',
      'Never read/write Hello’s database directly. Do not print connection tokens or include environment dumps in prompts/reports. If the connection has ended, open a fresh CLI from Hello; do not fall back to searching repository tasks.',
      '',
    ];
    const instructions = [
      '# Hello workspace connection',
      'You are an interactive CLI opened by the human inside Hello. Wait for the human’s request; this connection does not assign or start work.',
      `Your launch working folder is ${JSON.stringify(cwd)}. Work in that folder unless the human explicitly directs otherwise.`,
      'The chat’s folder may later change. Your process keeps its original folder. The info/list responses include both folders; if they differ, explain that a new CLI can be opened in the selected folder.',
      '',
      ...notebookLines,
      channel.instructions,
    ].join('\n');
    writeFileSync(instructionsPath, instructions, { mode: 0o600 });
    writeFileSync(clientPath, client, { mode: 0o600 });
    let closing: Promise<void> | undefined;
    return {
      instructionsPath, instructions,
      listen: channel.listen,
      answer: channel.answer,
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
