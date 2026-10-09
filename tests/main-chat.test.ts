import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PiRpcEvent, PiRpcProcessOptions } from '../src/main/chat/pi-rpc';
import type { PiToolBridgeOptions } from '../src/main/chat/pi-tool-bridge';
import type { BrowserTab, ChatEvent, ChatQueueEvent, Message, MessagePart, PendingInput } from '../src/shared/types';

// This suite exercises Hello's lifecycle/tool policy, never a real Pi child,
// loopback listener, model server or CLI. Keep the transport mocks unconditional.
const harness = vi.hoisted(() => {
  class FakePi {
    readonly listeners = new Set<(event: PiRpcEvent) => void>();
    isRunning = true;
    constructor(readonly options: PiRpcProcessOptions) {
      instances.push(this);
    }
    start = vi.fn(async () => {});
    request = vi.fn(async (command: { type: string }) => ({
      type: 'response', id: 'fixture', command: command.type, success: true,
    }));
    prompt = vi.fn(async (_text: string) => ({
      type: 'response', id: 'fixture', command: 'prompt', success: true,
    }));
    /** Every command this fake was handed, and what Pi still holds unsaid. */
    readonly sent: Array<{ type: string; message?: string }> = [];
    queued: string[] = [];
    // Like Pi, announce the queue before acknowledging the command that changed it.
    steer = vi.fn(async (message: string) => {
      this.sent.push({ type: 'steer', message });
      this.queued.push(message);
      this.emit({ type: 'queue_update', steering: [...this.queued], followUp: [] });
      return { type: 'response', id: 'fixture', command: 'steer', success: true } as const;
    });
    clearQueue = vi.fn(async () => {
      this.sent.push({ type: 'clear_queue' });
      const steering = this.queued;
      this.queued = [];
      this.emit({ type: 'queue_update', steering: [], followUp: [] });
      return { type: 'response', id: 'fixture', command: 'clear_queue', success: true,
        data: { steering, followUp: [] } } as const;
    });
    /** Pi puts the oldest held steer into the conversation. */
    consumeSteer() {
      const message = this.queued.shift();
      this.emit({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: message }] } });
      this.emit({ type: 'queue_update', steering: [...this.queued], followUp: [] });
      this.emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: message }] } });
    }
    abort = vi.fn(async () => {});
    respondToExtension = vi.fn(async () => {});
    subscribe(listener: (event: PiRpcEvent) => void) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    emit(event: PiRpcEvent) {
      this.options.onEvent?.(event);
      for (const listener of this.listeners) listener(event);
    }
    dispose = vi.fn(async () => {
      if (!this.isRunning) return;
      this.isRunning = false;
      this.options.onExit?.({ code: 0, signal: null, expected: true, stderr: '' });
      this.listeners.clear();
    });
  }
  const instances: FakePi[] = [];
  const bridges: Array<{
    options: PiToolBridgeOptions;
    execute: ReturnType<typeof vi.fn<PiToolBridgeOptions['execute']>>;
    close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  }> = [];
  const forbiddenSpawn = vi.fn(() => {
    throw new Error('A main-chat fixture attempted to spawn a real process.');
  });
  const forbiddenFetch = vi.fn<typeof fetch>(async () => {
    throw new Error('A main-chat fixture attempted a real network request.');
  });
  return { FakePi, instances, bridges, forbiddenSpawn, forbiddenFetch };
});
vi.mock('../src/main/chat/pi-rpc', () => ({ PiRpcProcess: harness.FakePi }));
vi.mock('../src/main/chat/pi-tool-bridge', () => ({
  createPiToolBridge: vi.fn(async (options: PiToolBridgeOptions) => {
    const fixture = { options, execute: vi.fn(options.execute), close: vi.fn(async () => {}) };
    harness.bridges.push(fixture);
    return {
      env: { HELLO_PI_BRIDGE_URL: 'http://127.0.0.1:1/', HELLO_PI_BRIDGE_TOKEN: 'a'.repeat(64) },
      ready: true,
      close: fixture.close,
    };
  }),
}));
vi.mock('node:child_process', () => ({ spawn: harness.forbiddenSpawn }));

import { createDataStore, type DataStore } from '../src/main/data/store';
import { ChatService, LOOP_RESUME_PROMPT, REPLAYED_READ_CHARS, completionURL, modelsURL, wireHistory, type ChatServiceOptions } from '../src/main/chat/service';
import { piConversationDir } from '../src/main/chat/pi-session';
import { toolOutputText } from '../src/main/chat/tool-output';

let directory: string;
let store: DataStore;
let service: ChatService | undefined;
let conversationId: string;
const events: ChatEvent[] = [];
const queueEvents: ChatQueueEvent[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  harness.instances.length = 0;
  harness.bridges.length = 0;
  vi.stubGlobal('fetch', harness.forbiddenFetch);
  directory = mkdtempSync(path.join(tmpdir(), 'hello-chat-test-'));
  store = createDataStore(directory, {
    encrypt: text => Buffer.from(text.split('').reverse().join('')),
    decrypt: bytes => bytes.toString().split('').reverse().join(''),
  });
  store.saveSettings({
    model: 'test-model', endpointUrl: 'https://local-fixture.example/v1', reasoningEffort: 'off',
  });
  conversationId = store.createConversation().id;
  events.length = 0;
  queueEvents.length = 0;
});
afterEach(async () => {
  try {
    await service?.dispose();
    expect(harness.forbiddenSpawn).not.toHaveBeenCalled();
    expect(harness.forbiddenFetch).not.toHaveBeenCalled();
  } finally {
    service = undefined;
    store.close();
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllGlobals();
  }
});

function create(options: Pick<ChatServiceOptions, 'fetch' | 'browser' | 'localServers' | 'piEntry' | 'emitPending'> = {}): ChatService {
  // Never the real lsof and the real ports of the machine running the tests.
  service = new ChatService({ store, emit: event => events.push(structuredClone(event)),
    emitQueue: event => queueEvents.push(structuredClone(event)), localServers: async () => [],
    // Model capability lookup is metadata, still served entirely by this fixture.
    fetch: async () => new Response(JSON.stringify({ data: [{ id: store.getSettings().model }] })), ...options });
  return service;
}
function assistant() {
  return store.listMessages(conversationId).filter(message => message.role === 'assistant').at(-1)!;
}
function approval() {
  return events.flatMap(event => event.message.parts ?? [])
    .find(part => part.type === 'tool' && part.status === 'approval') as
    Extract<MessagePart, { type: 'tool' }> | undefined;
}
async function runtime(index = 0, promptCount = 1) {
  await vi.waitFor(() => {
    expect(harness.instances[index]).toBeDefined();
    expect(harness.instances[index].prompt).toHaveBeenCalledTimes(promptCount);
  });
  return { rpc: harness.instances[index], bridge: harness.bridges[index] };
}
type Runtime = Awaited<ReturnType<typeof runtime>>;
function answer(rpc: Runtime['rpc'], text: string, options: { error?: string; thinking?: string } = {}) {
  const content = [
    ...(options.thinking ? [{ type: 'thinking', thinking: options.thinking }] : []),
    { type: 'text', text },
  ];
  rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  rpc.emit({
    type: 'message_end',
    message: {
      role: 'assistant', content, stopReason: options.error ? 'error' : 'stop',
      ...(options.error ? { errorMessage: options.error } : {}),
      usage: { input: 12, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 19 },
    },
  });
}
function settle(rpc: Runtime['rpc'], text: string) {
  answer(rpc, text);
  rpc.emit({ type: 'agent_settled' });
}
function tool(
  current: Runtime, name: string, args: Record<string, unknown>, id: string,
): Promise<string> {
  current.rpc.emit({ type: 'tool_execution_start', toolCallId: id, toolName: name, args });
  return current.bridge.execute(name, args, new AbortController().signal, id).then(
    result => {
      const output = toolOutputText(result);
      current.rpc.emit({ type: 'tool_execution_end', toolCallId: id, toolName: name,
        result: { content: [{ type: 'text', text: output }] }, isError: false });
      return output;
    },
    error => {
      current.rpc.emit({ type: 'tool_execution_end', toolCallId: id, toolName: name,
        result: { content: [{ type: 'text', text: String(error) }] }, isError: true });
      throw error;
    },
  );
}
function tab(id: string, control: BrowserTab['control'], owner = conversationId): BrowserTab {
  return { id, conversationId: owner, control, title: 'Fixture page', url: 'https://example.test',
    loading: false, progress: null, canGoBack: false, canGoForward: false };
}

describe('Pi-backed chat lifecycle with in-memory transport', () => {
  it('counts only running replies for close, not queued messages or warm runtimes', async () => {
    const chat = create();
    expect(chat.runningReplyCount).toBe(0);
    const pending = chat.send(conversationId, 'hello');
    const current = await runtime();
    expect(chat.runningReplyCount).toBe(1);
    await chat.queue(conversationId, 'keep this as a draft', 'later');
    expect(chat.runningReplyCount).toBe(1);
    settle(current.rpc, 'Done.');
    await pending;
    expect(current.rpc.isRunning).toBe(true);
    expect(chat.runningReplyCount).toBe(0);
    expect(chat.listQueued(conversationId)).toHaveLength(1);
  });
  it('waits past prompt acceptance and agent_end before completing the response', async () => {
    store.saveNotebook({ conversationId, kind: 'tasks', title: 'Private planning',
      body: 'DO NOT INJECT THIS NOTEBOOK' });
    const chat = create();
    const running = chat.send(conversationId, 'Hi');
    const { rpc } = await runtime();

    // prompt() has acknowledged the command but produced no agent output.
    expect(chat.isRunning(conversationId)).toBe(true);
    expect(assistant().status).toBe('streaming');
    answer(rpc, 'Hello world.', { thinking: 'Checking carefully.' });
    rpc.emit({ type: 'agent_end', willRetry: false });
    await Promise.resolve();
    expect(chat.isRunning(conversationId)).toBe(true);
    expect(assistant().status).toBe('streaming');
    rpc.emit({ type: 'agent_settled' });
    await running;

    expect(assistant()).toMatchObject({ status: 'complete', content: 'Hello world.',
      usage: { input: 12, output: 7 }, error: null });
    expect(assistant().parts).toEqual([
      expect.objectContaining({ type: 'thinking', text: 'Checking carefully.' }),
      { type: 'text', text: 'Hello world.' },
    ]);
    expect(rpc.prompt).toHaveBeenCalledWith('Hi');
    // How long it worked, kept with the reply for its activity header.
    expect(assistant().workedMs).toEqual(expect.any(Number));
    const root = piConversationDir(directory, conversationId);
    expect(readFileSync(path.join(root, 'system-prompt.md'), 'utf8')).not.toContain('DO NOT INJECT');
    expect(readFileSync(path.join(root, 'session.jsonl'), 'utf8')).not.toContain('DO NOT INJECT');
    expect(assistant()).not.toHaveProperty('runtimePhase');
  });

  it('keeps the same warm Pi process for the next explicit message', async () => {
    const chat = create();
    const first = chat.send(conversationId, 'First question');
    const current = await runtime();
    settle(current.rpc, 'First answer');
    await first;

    const second = chat.send(conversationId, 'Follow-up question');
    await runtime(0, 2);
    expect(harness.instances).toHaveLength(1);
    expect(harness.bridges).toHaveLength(1);
    expect(current.rpc.dispose).not.toHaveBeenCalled();
    settle(current.rpc, 'Second answer');
    await second;
    expect(current.rpc.prompt.mock.calls.map(([text]) => text)).toEqual(['First question', 'Follow-up question']);
    expect(store.listMessages(conversationId).map(message => message.content)).toEqual([
      'First question', 'First answer', 'Follow-up question', 'Second answer',
    ]);
  });

  // User, 04.10 (both design audits): the context meter offers "Summarise now".
  it('summarises the conversation on the person\'s word, with Pi\'s own compaction', async () => {
    const chat = create();
    const first = chat.send(conversationId, 'First question');
    const current = await runtime();
    settle(current.rpc, 'First answer');
    await first;
    current.rpc.request.mockImplementationOnce(async (command: { type: string }) =>
      ({ type: 'response', id: 'fixture', command: command.type, success: true, data: { tokensBefore: 150_000, estimatedTokensAfter: 32_000 } }));
    const summarising = chat.compact(conversationId);
    // Nothing is sent into a chat while Pi summarises it.
    await expect(chat.send(conversationId, 'Too soon')).rejects.toThrow('being summarised');
    await expect(summarising).resolves.toEqual({ tokensBefore: 150_000, tokensAfter: 32_000 });
    expect(current.rpc.request).toHaveBeenCalledWith({ type: 'compact' }, 15 * 60_000);
    // The same warm Pi did it: no second process for a summary.
    expect(harness.instances).toHaveLength(1);
  });

  // User, 01.10: "update" in the sidebar installs a newer Pi beside the bundled
  // one; a chat moves to it at its next message, and back the same way.
  it('starts Pi from the engine in use, and moves the chat to an updated one at its next message', async () => {
    let entry = '/app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/rpc-entry.js';
    const chat = create({ piEntry: () => entry });
    const first = chat.send(conversationId, 'First question');
    const current = await runtime();
    expect(current.rpc.options.args?.[0]).toBe(entry);
    settle(current.rpc, 'First answer');
    await first;

    entry = '/data/pi/runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/rpc-entry.js';
    const second = chat.send(conversationId, 'Follow-up question');
    const next = await runtime(1);
    expect(next.rpc.options.args?.[0]).toBe(entry);
    expect(current.rpc.dispose).toHaveBeenCalled();
    settle(next.rpc, 'Second answer');
    await second;
  });

  it('runs notebook tools in Hello and records one result card', async () => {
    store.updateConversation(conversationId, { runbook: true });
    store.saveNotebook({ conversationId, kind: 'runbook', title: 'Decision', body: 'Use SQLite.' });
    const running = create().send(conversationId, 'Read the runbook');
    const current = await runtime();
    const result = await tool(current, 'notebook_list', { kind: 'runbook' }, 'read-note');
    expect(result).toContain('Use SQLite.');
    settle(current.rpc, 'The decision is SQLite.');
    await running;
    expect(assistant().parts?.filter(part => part.type === 'tool')).toEqual([
      expect.objectContaining({ id: 'read-note', name: 'notebook_list', status: 'complete',
        output: expect.stringContaining('Use SQLite.') }),
    ]);
  });

  it.each([true, false])('delegates file writes to the real per-call approval gate (allow=%s)', async allow => {
    store.updateConversation(conversationId, { folder: directory });
    store.saveSettings({ approvals: 'ask' });
    const running = create().send(conversationId, 'Write a file');
    const current = await runtime();
    const write = tool(current, 'file_write', { path: 'approval.txt', content: 'approved only' }, 'write-approved');
    const result = allow ? expect(write).resolves.toContain('Wrote')
      : expect(write).rejects.toThrow(/declined/);
    await vi.waitFor(() => expect(approval()).toBeDefined());
    expect(existsSync(path.join(directory, 'approval.txt'))).toBe(false);
    service!.approve(approval()!.approvalId!, allow);
    await result;
    settle(current.rpc, allow ? 'The file was written.' : 'The write was declined.');
    await running;
    expect(existsSync(path.join(directory, 'approval.txt'))).toBe(allow);
    expect(assistant().parts?.filter(part => part.type === 'tool')).toEqual([
      expect.objectContaining({ id: 'write-approved', status: allow ? 'complete' : 'error' }),
    ]);
  });

  it.each([
    { approvals: 'all', tool: 'file_write', asks: false },
    { approvals: 'all', tool: 'command_run', asks: false },
    { approvals: 'writes', tool: 'file_write', asks: false },
    { approvals: 'writes', tool: 'command_run', asks: true },
    { approvals: 'ask', tool: 'file_write', asks: true },
  ] as const)('approval mode $approvals asks before $tool: $asks', async ({ approvals, tool: name, asks }) => {
    store.updateConversation(conversationId, { folder: directory });
    store.saveSettings({ approvals });
    const running = create().send(conversationId, 'Do the work');
    const current = await runtime();
    const input = name === 'file_write'
      ? { path: `${approvals}-${name}.txt`, content: 'written' }
      : { command: 'printf ok' };
    const call = tool(current, name, input, `${approvals}-${name}`);
    // This fixture refuses to spawn: a command reaching that refusal proves it
    // was never held for a human, which is what these modes are about.
    const spawns = name === 'command_run';
    if (asks) {
      await vi.waitFor(() => expect(approval()).toBeDefined());
      service!.approve(approval()!.approvalId!, false);
      await expect(call).rejects.toThrow(/declined/);
    } else if (spawns) {
      // Reaching the fixture's spawn refusal IS the assertion: the call was
      // never held for a human. Clear it so the suite-wide "nothing spawned"
      // check still means what it says for every other test.
      await expect(call).rejects.toThrow(/spawn a real process/);
      expect(approval()).toBeUndefined();
      expect(harness.forbiddenSpawn).toHaveBeenCalledTimes(1);
      harness.forbiddenSpawn.mockClear();
    } else {
      await expect(call).resolves.toContain('Wrote');
      expect(approval()).toBeUndefined();
    }
    settle(current.rpc, 'Done.');
    await running;
    expect(assistant().parts?.filter(part => part.type === 'tool')).toEqual([
      expect.objectContaining({
        id: `${approvals}-${name}`,
        status: asks || spawns ? 'error' : 'complete',
      }),
    ]);
  });

  // Audit A1: what waits for the person is told from main's registers, under a rising revision.
  it('tells the window which approval waits, and takes it away once answered', async () => {
    store.updateConversation(conversationId, { folder: directory });
    store.saveSettings({ approvals: 'ask' });
    const told: PendingInput[] = [];
    const chat = create({ emitPending: state => told.push(structuredClone(state)) });
    const running = chat.send(conversationId, 'Write a file');
    const current = await runtime();
    const write = tool(current, 'file_write', { path: 'pending.txt', content: 'x' }, 'write-pending');
    const allowed = expect(write).resolves.toContain('Wrote');
    await vi.waitFor(() => expect(told.at(-1)?.requests).toHaveLength(1));
    const [request] = told.at(-1)!.requests;
    expect(request).toMatchObject({ conversationId, kind: 'approval', label: 'file_write',
      target: { messageId: expect.any(String), toolPartId: 'write-pending' } });
    expect(request.expiresAt! - request.createdAt).toBe(5 * 60_000);
    expect(chat.pendingInput().requests).toEqual([request]);
    chat.approve(request.requestId, true);
    await allowed;
    await vi.waitFor(() => expect(told.at(-1)?.requests).toEqual([]));
    expect(told.at(-1)!.revision).toBeGreaterThan(told[0].revision);
    settle(current.rpc, 'Done.');
    await running;
  });

  it('Stop cancels pending approvals and closes the runtime before releasing the run', async () => {
    store.updateConversation(conversationId, { folder: directory });
    store.saveSettings({ approvals: 'ask' });
    const chat = create();
    const running = chat.send(conversationId, 'Write a file');
    const current = await runtime();
    const write = tool(current, 'file_write', { path: 'cancelled.txt', content: 'no' }, 'write-cancelled');
    const rejected = expect(write).rejects.toThrow(/Stopped/);
    await vi.waitFor(() => expect(approval()).toBeDefined());
    const id = approval()!.approvalId!;
    await chat.stop(conversationId);
    await Promise.all([running, rejected]);
    expect(chat.isRunning(conversationId)).toBe(false);
    expect(current.rpc.dispose).toHaveBeenCalledOnce();
    expect(current.bridge.close).toHaveBeenCalledOnce();
    expect(assistant()).toMatchObject({ status: 'error', error: expect.stringContaining('Stopped') });
    expect(() => chat.approve(id, true)).toThrow(/no longer/);
    expect(existsSync(path.join(directory, 'cancelled.txt'))).toBe(false);
  });

  it('keeps per-tab browser permissions even when another tab grants Full control', async () => {
    const hooks = {
      getTabs: () => [tab('blocked', 'off'), tab('allowed', 'full'), tab('foreign', 'full', 'other-chat')],
      read: vi.fn(), navigate: vi.fn(), click: vi.fn(), type: vi.fn(), scroll: vi.fn(),
    };
    const running = create({ browser: hooks }).send(conversationId, 'Read the blocked tab');
    const current = await runtime();
    await expect(tool(current, 'browser_read',
      { tabId: 'blocked' }, 'denied-browser'))
      .rejects.toThrow(/Agent control off/i);
    expect(hooks.read).not.toHaveBeenCalled();
    const context = await current.bridge.options.getContext!();
    expect(context).not.toContain('foreign');
    settle(current.rpc, 'That tab has Agent control Off.');
    await running;
    expect(assistant().parts?.find(part => part.type === 'tool')).toMatchObject({ status: 'error' });
  });

  it('lets the chat open a requested page without tabs or granting access to its contents', async () => {
    const opened = tab('new-preview', 'off');
    let available = false;
    const hooks = {
      getTabs: () => available ? [opened] : [],
      open: vi.fn(async () => { available = true; return opened; }),
      read: vi.fn(), navigate: vi.fn(), click: vi.fn(), type: vi.fn(), scroll: vi.fn(),
    };
    const running = create({ browser: hooks }).send(conversationId, 'Open the preview in the browser');
    const current = await runtime();
    const result = await tool(current, 'browser_open', { url: 'http://localhost:5173' }, 'open-preview');
    expect(JSON.parse(result)).toMatchObject({ id: 'new-preview', control: 'off' });
    expect(hooks.open).toHaveBeenCalledOnce();
    expect(approval()).toBeUndefined();
    await expect(tool(current, 'browser_read', { tabId: opened.id }, 'no-implicit-read'))
      .rejects.toThrow(/Agent control off/i);
    expect(hooks.read).not.toHaveBeenCalled();
    settle(current.rpc, 'The preview is open.');
    await running;
    expect(assistant().parts?.filter(part => part.type === 'tool')).toEqual([
      expect.objectContaining({ id: 'open-preview', status: 'complete' }),
      expect.objectContaining({ id: 'no-implicit-read', status: 'error' }),
    ]);
  });

  it('hands a screenshot to the model through the bridge and stores only its summary', async () => {
    const data = Buffer.from('pixels').toString('base64');
    const hooks = {
      getTabs: () => [tab('canvas', 'read')],
      read: vi.fn(), navigate: vi.fn(), click: vi.fn(), type: vi.fn(), scroll: vi.fn(),
      screenshot: vi.fn(async () => ({ frames: [{ mimeType: 'image/png' as const, data, width: 800, height: 600 }],
        viewport: { width: 800, height: 600 } })),
    };
    const running = create({ browser: hooks }).send(conversationId, 'Check the canvas');
    const current = await runtime();
    const output = await current.bridge.execute('browser_screenshot', { tabId: 'canvas' }, new AbortController().signal, 'shot');
    expect(output).toMatchObject({ text: expect.stringMatching(/^Screenshot 800x600, 1 frame/), images: [{ mimeType: 'image/png', data }] });
    settle(current.rpc, 'The canvas draws.');
    await running;
    const part = assistant().parts?.find(item => item.type === 'tool') as Extract<MessagePart, { type: 'tool' }>;
    expect(part).toMatchObject({ id: 'shot', status: 'complete', output: expect.stringMatching(/^Screenshot 800x600/) });
    expect(JSON.stringify(store.listMessages(conversationId))).not.toContain(data);
  });

  it('cancels a browser read that never resolves instead of holding the session open', async () => {
    const read = vi.fn(() => new Promise<never>(() => {}));
    const chat = create({ browser: {
      getTabs: () => [tab('readable', 'read')], read, navigate: vi.fn(), click: vi.fn(),
      type: vi.fn(), scroll: vi.fn(),
    } });
    const running = chat.send(conversationId, 'Read the page');
    const current = await runtime();
    const reading = tool(current, 'browser_read', { tabId: 'readable' }, 'pending-browser');
    const rejected = expect(reading).rejects.toThrow(/Stopped/);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    await chat.stop(conversationId);
    await Promise.all([running, rejected]);
    expect(chat.isRunning(conversationId)).toBe(false);
    expect(assistant().parts?.find(part => part.type === 'tool')).toMatchObject({ status: 'error' });
    expect(current.rpc.dispose).toHaveBeenCalledOnce();
  });

  it('Retry keeps the same bubble and observed completed effects without executing them again', async () => {
    store.updateConversation(conversationId, { folder: directory });
    store.saveSettings({ approvals: 'ask' });
    const chat = create();
    const running = chat.send(conversationId, 'Write once');
    const current = await runtime();
    const write = tool(current, 'file_write', { path: 'kept.txt', content: 'once' }, 'write-once');
    await vi.waitFor(() => expect(approval()).toBeDefined());
    chat.approve(approval()!.approvalId!, true);
    const output = await write;
    answer(current.rpc, 'Partial answer.', { error: 'Fixture provider failed.' });
    current.rpc.emit({ type: 'agent_settled' });
    await running;
    const id = assistant().id;
    expect(assistant().status).toBe('error');
    expect(readFileSync(path.join(directory, 'kept.txt'), 'utf8')).toBe('once');

    const retry = chat.retry(conversationId);
    const next = await runtime(1);
    expect(next.rpc.prompt.mock.calls[0][0]).toContain('Do not repeat completed actions');
    settle(next.rpc, 'The previous write succeeded.');
    await retry;
    expect(assistant()).toMatchObject({ id, status: 'complete', error: null });
    expect(assistant().parts?.filter(part => part.type === 'tool')).toEqual([
      expect.objectContaining({ id: 'write-once', status: 'complete', output }),
    ]);
    expect(current.bridge.execute).toHaveBeenCalledOnce();
    expect(next.bridge.execute).not.toHaveBeenCalled();
    expect(store.listMessages(conversationId)).toHaveLength(2);
  });

  it('deleteSession closes a warm engine and deletes only its private Pi session directory', async () => {
    const chat = create();
    const running = chat.send(conversationId, 'Hi');
    const current = await runtime();
    settle(current.rpc, 'Hello');
    await running;
    const root = piConversationDir(directory, conversationId);
    expect(existsSync(path.join(root, 'session.jsonl'))).toBe(true);
    await chat.deleteSession(conversationId);
    expect(current.rpc.dispose).toHaveBeenCalledOnce();
    expect(current.bridge.close).toHaveBeenCalledOnce();
    expect(existsSync(root)).toBe(false);
    // The IPC owner removes conversation storage after this lifecycle barrier.
    expect(store.getConversation(conversationId).id).toBe(conversationId);
    expect(store.listMessages(conversationId)).toHaveLength(2);
  });

  // Fresh for the model, nothing lost for the person (user, 24.09: "reload,
  // reset, să reîncarce tot fresh fără să pierd taburile deschise").
  it('restart stops the turn, drops the Pi session, and hands the next turn only what is said from then on', async () => {
    const chat = create();
    const first = chat.send(conversationId, 'Download the invoices');
    const current = await runtime();
    settle(current.rpc, 'Working on it.');
    await first;
    const root = piConversationDir(directory, conversationId);
    expect(existsSync(path.join(root, 'session.jsonl'))).toBe(true);
    const running = chat.send(conversationId, 'Keep going');
    const second = await runtime(0, 2);
    const restarted = await chat.restart(conversationId);
    await running;
    expect(assistant().error).toBe('Stopped: the chat was restarted.');
    expect(second.rpc.dispose).toHaveBeenCalled();
    expect(current.bridge.close).toHaveBeenCalled();
    expect(existsSync(root)).toBe(false);
    // The stopped answer is above the line now: it is not the model's to retry.
    await expect(chat.retry(conversationId)).rejects.toThrow('The chat was restarted after this response. Send a new message instead.');
    expect(restarted.freshFrom).toEqual(expect.any(Number));
    // Everything said stays for the person.
    expect(store.listMessages(conversationId).map(message => message.content)).toEqual(
      expect.arrayContaining(['Download the invoices', 'Working on it.', 'Keep going']));
    // The next turn runs on a new Pi with nothing from before the restart.
    await new Promise(resolve => setTimeout(resolve, 2));
    const after = chat.send(conversationId, 'Start again: open the billing page');
    const fresh = await runtime(1);
    const seeded = readFileSync(path.join(root, 'session.jsonl'), 'utf8');
    expect(seeded).not.toContain('Download the invoices');
    expect(seeded).not.toContain('Working on it.');
    expect(fresh.rpc.prompt.mock.calls[0][0]).toBe('Start again: open the billing page');
    settle(fresh.rpc, 'Opened.');
    await after;
    expect(assistant().status).toBe('complete');
  });

  it('reset empties the chat — messages, queue, attachments, Pi session — and the next turn starts with nothing', async () => {
    const chat = create();
    const first = chat.send(conversationId, 'Download the invoices');
    const current = await runtime();
    settle(current.rpc, 'Working on it.');
    await first;
    store.queueMessage(conversationId, 'then ElevenLabs', 'later');
    queueEvents.length = 0;
    const running = chat.send(conversationId, 'Keep going');
    const second = await runtime(0, 2);
    // Nothing new starts while the reset is under way.
    const resetting = chat.reset(conversationId, { notes: true });
    await expect(chat.send(conversationId, 'too soon')).rejects.toThrow('This chat is restarting. Send it again in a moment.');
    const done = await resetting;
    await running;
    expect(done.id).toBe(conversationId);
    expect(second.rpc.dispose).toHaveBeenCalled();
    expect(existsSync(piConversationDir(directory, conversationId))).toBe(false);
    expect(store.listMessages(conversationId)).toEqual([]);
    expect(store.listQueued(conversationId)).toEqual([]);
    expect(queueEvents.at(-1)).toEqual({ conversationId, items: [] });
    const after = chat.send(conversationId, 'Open the Neon billing page');
    const fresh = await runtime(1);
    const seeded = readFileSync(path.join(piConversationDir(directory, conversationId), 'session.jsonl'), 'utf8');
    expect(seeded).not.toContain('Download the invoices');
    expect(seeded).not.toContain('Keep going');
    expect(fresh.rpc.prompt.mock.calls[0][0]).toBe('Open the Neon billing page');
    settle(fresh.rpc, 'Opened.');
    await after;
    expect(store.listMessages(conversationId).map(message => message.content)).toEqual(['Open the Neon billing page', 'Opened.']);
  });

  it('sends a message written mid-turn to the run already going, and lets it be taken back', async () => {
    const chat = create();
    const send = chat.send(conversationId, 'build a page');
    const current = await runtime();
    await chat.queue(conversationId, 'make the bars thinner', 'steer');
    // A steer is for the turn in flight: Pi gets it now, not after.
    expect(current.rpc.sent.some(line => line.type === 'steer' && line.message === 'make the bars thinner')).toBe(true);
    const [held] = chat.listQueued(conversationId);
    expect(held).toMatchObject({ text: 'make the bars thinner', mode: 'steer' });
    // Changing your mind: Pi hands back what it has not said yet, and we hand
    // back only what survives — never the sentence that was withdrawn.
    expect(current.rpc.queued).toEqual(['make the bars thinner']);
    await chat.dropQueued(held.id);
    expect(current.rpc.sent.filter(line => line.type === 'clear_queue')).toHaveLength(1);
    expect(current.rpc.sent.filter(line => line.type === 'steer')).toHaveLength(1);
    expect(chat.listQueued(conversationId)).toEqual([]);
    settle(current.rpc, 'done');
    await send;
  });

  it('removes a steer once Pi has said it, and tells the renderer without being asked', async () => {
    const chat = create();
    const send = chat.send(conversationId, 'build a page');
    const current = await runtime();
    await chat.queue(conversationId, 'first correction', 'steer');
    await chat.queue(conversationId, 'second correction', 'steer');
    // Announcing what it holds is not saying it.
    expect(chat.listQueued(conversationId).map(item => item.text)).toEqual(['first correction', 'second correction']);
    expect(queueEvents).toEqual([]);

    current.rpc.consumeSteer();
    expect(chat.listQueued(conversationId).map(item => item.text)).toEqual(['second correction']);
    expect(queueEvents.at(-1)).toMatchObject({ conversationId, items: [{ text: 'second correction', mode: 'steer' }] });

    // Rewording what Pi still holds hands it the new words, never the old ones.
    const [second] = chat.listQueued(conversationId);
    await chat.reviseQueued(second.id, { text: 'second, reworded' });
    expect(current.rpc.queued).toEqual(['second, reworded']);
    current.rpc.consumeSteer();
    expect(chat.listQueued(conversationId)).toEqual([]);
    expect(queueEvents.at(-1)).toMatchObject({ conversationId, items: [] });

    // The X on a row that was said a moment ago is not an error.
    await expect(chat.dropQueued(second.id, conversationId)).resolves.toEqual([]);
    settle(current.rpc, 'done');
    await send;
    // Nothing said is ever said twice.
    expect(current.rpc.prompt).toHaveBeenCalledTimes(1);
  });

  it('turns a steer the reply never reached into the next turn, and a stopped one into a held next', async () => {
    const chat = create();
    const send = chat.send(conversationId, 'build a page');
    const current = await runtime();
    await chat.queue(conversationId, 'and then the footer', 'steer');
    // The reply settles while Pi still holds it: taken back, and said on its own.
    settle(current.rpc, 'done');
    await send;
    const next = await runtime(0, 2);
    expect(current.rpc.sent.filter(line => line.type === 'clear_queue')).toHaveLength(1);
    expect(next.rpc.prompt).toHaveBeenLastCalledWith('and then the footer');
    expect(next.rpc.queued).toEqual([]);
    expect(chat.listQueued(conversationId)).toEqual([]);

    await chat.queue(conversationId, 'stop halfway', 'steer');
    await chat.stop(conversationId);
    // A stopped reply is the person's to look at: the words wait, as the next turn.
    expect(chat.listQueued(conversationId)).toMatchObject([{ text: 'stop halfway', mode: 'next' }]);
    expect(queueEvents.at(-1)).toMatchObject({ items: [{ text: 'stop halfway', mode: 'next' }] });
  });

  it('never loses or re-sends a steer that no running reply owns', async () => {
    const chat = create();
    // Left behind by an earlier app session: it may already have been said.
    const orphan = store.queueMessage(conversationId, 'from yesterday', 'steer');
    expect(chat.listQueued(conversationId)).toMatchObject([{ id: orphan.id, mode: 'later' }]);
    // A row that is gone comes back as the current list, not as an error.
    await expect(chat.dropQueued('missing-row', conversationId)).resolves.toMatchObject([{ id: orphan.id }]);
    await expect(chat.dropQueued(orphan.id, conversationId)).resolves.toEqual([]);
    await expect(chat.dropQueued(orphan.id)).rejects.toThrow(/no longer waiting/);

    // A steer typed just after the reply ended is said as the next turn.
    await chat.queue(conversationId, 'one more thing', 'steer');
    const current = await runtime();
    expect(current.rpc.prompt).toHaveBeenLastCalledWith('one more thing');
    expect(current.rpc.sent.filter(line => line.type === 'steer')).toEqual([]);
    settle(current.rpc, 'ok');
    await vi.waitFor(() => expect(chat.isRunning(conversationId)).toBe(false));
  });

  it('says a held message on its own turn, but never into a turn that failed', async () => {
    const chat = create();
    const first = chat.send(conversationId, 'one');
    const current = await runtime();
    await chat.queue(conversationId, 'and now the table', 'next');
    expect(chat.listQueued(conversationId)).toHaveLength(1);
    settle(current.rpc, 'done');
    await first;
    // It became a turn of its own, on the same runtime, and left the waiting list.
    const second = await runtime(0, 2);
    expect(second.rpc.prompt).toHaveBeenLastCalledWith('and now the table');
    expect(chat.listQueued(conversationId)).toEqual([]);
    settle(second.rpc, 'and here it is');
    await vi.waitFor(() => expect(chat.isRunning(conversationId)).toBe(false));

    const failing = chat.send(conversationId, 'again');
    const third = await runtime(0, 3);
    await chat.queue(conversationId, 'do not send me into a wall', 'next');
    answer(third.rpc, '', { error: 'Provider finish_reason: error' });
    third.rpc.emit({ type: 'agent_settled' });
    await failing;
    // The turn failed, so the held sentence stays held and the person decides.
    expect(chat.listQueued(conversationId)).toHaveLength(1);
  });

  it('shrinks the window it hands the runtime when the provider reports an overflow', async () => {
    store.saveSettings({ contextWindow: 512_000, maxOutputTokens: 32_768 });
    const chat = create();
    const send = chat.send(conversationId, 'a long one');
    const current = await runtime();
    // The provider counted more input than the model holds: the runtime never
    // compacted, so it is told less next time.
    current.rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    current.rpc.emit({ type: 'message_end', message: {
      role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop',
      usage: { input: 715_635, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 715_735 },
    } });
    current.rpc.emit({ type: 'agent_settled' });
    await send;
    expect(store.getSettings().contextScale).toBe(0.7);
    // The published window itself is untouched — that is a fact about the model.
    expect(store.getSettings().contextWindow).toBe(512_000);
  });

  // The reply's input adds the context once per tool step; the window is about
  // one call. Three steps of 200k each on a 512k window fit, and the window
  // must stay as it is — before, their 600k total shrank it every such turn.
  it('keeps the window when only the reply’s total, not one call, is over it — and records size, cost and model', async () => {
    store.saveSettings({ contextWindow: 512_000, maxOutputTokens: 32_768, model: 'qwen3.6-27b' });
    const chat = create();
    const send = chat.send(conversationId, 'three steps');
    const current = await runtime();
    for (const [index, input] of [180_000, 195_000, 205_000].entries()) {
      current.rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
      current.rpc.emit({ type: 'message_end', message: {
        role: 'assistant', content: [{ type: 'text', text: `step ${index}` }], stopReason: index < 2 ? 'toolUse' : 'stop',
        usage: { input, output: 50, cacheRead: 1_000, cacheWrite: 0, totalTokens: input + 1_050, cost: { total: 0.002 } },
      } });
    }
    current.rpc.emit({ type: 'agent_settled' });
    await send;
    expect(store.getSettings().contextScale).toBeUndefined();
    const reply = assistant();
    expect(reply.model).toBe('qwen3.6-27b');
    expect(reply.usage).toMatchObject({ input: 583_000, output: 150, context: 206_000 });
    expect(reply.usage?.cost).toBeCloseTo(0.006, 6);
    // Read back from the database with it.
    expect(store.listMessages(conversationId).at(-1)).toMatchObject({ model: 'qwen3.6-27b', usage: { context: 206_000 } });
  });

  it('leaves the window alone when the reported usage fits', async () => {
    store.saveSettings({ contextWindow: 512_000, maxOutputTokens: 32_768 });
    const chat = create();
    const send = chat.send(conversationId, 'a short one');
    const current = await runtime();
    settle(current.rpc, 'done');
    await send;
    expect(store.getSettings().contextScale).toBeUndefined();
  });

  it('says what a provider error was, and that a tool it cut off never ran', async () => {
    const chat = create();
    const send = chat.send(conversationId, 'draw me something');
    const current = await runtime();
    // A provider that dies mid-stream flushes the tool call it was writing, with
    // no arguments: the model asked for the tool, the tool never happened.
    current.rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    current.rpc.emit({ type: 'message_update', assistantMessageEvent: {
      type: 'toolcall_start', contentIndex: 0, id: 'call-1', name: 'browser_show_html' } });
    current.rpc.emit({ type: 'message_end', message: {
      role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'browser_show_html', arguments: '{}' }],
      stopReason: 'error', errorMessage: 'Provider finish_reason: error',
    } });
    current.rpc.emit({ type: 'agent_settled' });
    await send;
    const message = assistant();
    expect(message.error).toBe(
      'The provider ended this response with an error before it finished (finish_reason: error). Retry, or pick another model.');
    const part = (message.parts ?? []).find(item => item.type === 'tool');
    expect(part && 'output' in part && part.output).toBe('The response ended before this tool ran.');
  });

});
describe('endpoint discovery and legacy-history import helpers', () => {
  it('lists models using only the selected endpoint key and rejects credential redirects', async () => {
    store.saveSettings({ apiKey: 'old-endpoint-key' });
    store.saveSettings({ endpointUrl: 'https://second-fixture.example/v1', apiKey: 'selected-endpoint-key' });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }],
    }), { headers: { 'content-type': 'application/json' } }));
    expect(await create({ fetch: fetcher }).models()).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(fetcher).toHaveBeenCalledWith('https://second-fixture.example/v1/models',
      expect.objectContaining({ redirect: 'error',
        headers: { Authorization: 'Bearer selected-endpoint-key', Accept: 'application/json' } }));
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('old-endpoint-key');
    expect(harness.instances).toHaveLength(0);
  });

  it('takes the limits a provider publishes for a model, and invents none', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: [
        { id: 'big', context_length: 262144, top_provider: { max_completion_tokens: 32768 } },
        { id: 'silent' },
        { id: 'odd', context_length: 'nonsense' },
      ],
    }), { headers: { 'content-type': 'application/json' } }));
    expect(await create({ fetch: fetcher }).models()).toEqual([
      { id: 'big', contextWindow: 262144, maxOutputTokens: 32768 },
      { id: 'odd' },
      { id: 'silent' },
    ]);
  });

  it('prefers the window a server actually loaded over the one a model was trained with', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: [{ id: 'loaded', context_length: 131072, meta: { n_ctx: 8192 } }],
    }), { headers: { 'content-type': 'application/json' } }));
    // A llama.cpp server started with -c 8192 holds 8,192 tokens whatever the
    // weights were trained for; believing the larger figure truncates every reply.
    expect(await create({ fetch: fetcher }).models()).toEqual([{ id: 'loaded', contextWindow: 8192 }]);
  });

  it('carries each model’s published image capability through the existing catalog', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [
      { id: 'image', architecture: { input_modalities: ['text', 'image'] } },
      { id: 'text', type: 'llm', max_context_length: 32768 },
      { id: 'unknown' },
    ] })));
    expect(await create({ fetch: fetcher }).models()).toEqual([
      { id: 'image', vision: true }, { id: 'text', vision: false, contextWindow: 32768 }, { id: 'unknown' },
    ]);
  });

  it('settles the stored limits against the provider, once per selection', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: [{ id: 'roomy', context_length: 512000, top_provider: { max_completion_tokens: 460800 } }],
    }), { headers: { 'content-type': 'application/json' } }));
    store.saveSettings({ model: 'roomy' });
    expect(store.getSettings().contextWindow).toBe(32768);
    const chat = create({ fetch: fetcher });
    await chat.settleModelLimits();
    // The window is the model's own; the output budget is capped well below the
    // published ceiling, because it has to be a budget and not a boast.
    expect(store.getSettings().contextWindow).toBe(512000);
    expect(store.getSettings().maxOutputTokens).toBe(32768);
    await chat.settleModelLimits();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('never replaces a number the person chose for the model in front of them', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: [{ id: 'roomy', context_length: 512000, top_provider: { max_completion_tokens: 460800 } }],
    }), { headers: { 'content-type': 'application/json' } }));
    store.saveSettings({ model: 'roomy', contextWindow: 40960, maxOutputTokens: 8192 });
    await create({ fetch: fetcher }).settleModelLimits();
    expect(store.getSettings().contextWindow).toBe(40960);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps the stored numbers when the provider publishes nothing, and when it cannot be reached', async () => {
    const silent = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ id: 'plain' }] }),
      { headers: { 'content-type': 'application/json' } }));
    store.saveSettings({ model: 'plain' });
    await create({ fetch: silent }).settleModelLimits();
    expect(store.getSettings().contextWindow).toBe(32768);
    expect(store.getSettings().maxOutputTokens).toBe(4096);
    store.saveSettings({ model: 'offline-model' });
    const failing = vi.fn<typeof fetch>(async () => { throw new Error('ECONNREFUSED'); });
    await expect(create({ fetch: failing }).settleModelLimits()).resolves.toBeUndefined();
    expect(store.getSettings().contextWindow).toBe(32768);
    // The claim never reaches this model, so a server that was merely starting
    // up is asked again on the next attempt rather than written off.
    expect(store.getSettings().limitsFor).not.toContain('offline-model');
  });

  it('redacts discovery errors and leaves local endpoints without an Authorization header', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: 'local' }] })))
      .mockResolvedValueOnce(new Response('bad unit-test-key-123 Bearer also-secret', { status: 401 }));
    const chat = create({ fetch: fetcher });
    expect(await chat.models()).toEqual([{ id: 'local' }]);
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({ Accept: 'application/json' });
    store.saveSettings({ apiKey: 'unit-test-key-123' });
    const error = await chat.models().then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('[redacted]');
    expect((error as Error).message).not.toContain('unit-test-key-123');
    expect((error as Error).message).not.toContain('also-secret');
    expect(fetcher.mock.calls[1][1]).toMatchObject({ redirect: 'error' });
    expect(harness.instances).toHaveLength(0);
  });

  it('uses consistent completion and model URLs', () => {
    expect(completionURL('http://localhost:1234/v1/')).toBe('http://localhost:1234/v1/chat/completions');
    expect(modelsURL('http://localhost:1234/v1/chat/completions')).toBe('http://localhost:1234/v1/models');
  });

  it('imports observed tool exchanges in order without hidden thinking or replayed actions', () => {
    const history = wireHistory([{
      id: 'legacy', conversationId, role: 'assistant', content: 'Result', createdAt: 1, status: 'complete',
      parts: [
        { type: 'thinking', text: 'private thinking' },
        { type: 'tool', id: 'read', name: 'file_read', input: '{}', output: 'observed text', status: 'complete' },
        { type: 'text', text: 'Result' },
        { type: 'tool', id: 'pending', name: 'file_write', input: '{}', status: 'approval' },
      ],
    }]);
    expect(history.map(item => item.role)).toEqual(['assistant', 'tool', 'assistant', 'tool']);
    expect(history[1]).toMatchObject({ tool_call_id: 'read', content: 'observed text' });
    expect(history[3]).toMatchObject({ tool_call_id: 'pending', content: 'Approval was not granted; action did not run.' });
    expect(JSON.stringify(history)).not.toContain('private thinking');
    expect(harness.instances).toHaveLength(0);
  });

  // A page read is up to 45,000 characters of somebody else's page, and a thread
  // that visited a few pages replayed all of them whole on every round trip that
  // followed. The one in hand stays whole; the ones before it become the page's
  // name, its address, its opening — and an instruction to read it again.
  it('replays the latest page read whole and shortens the earlier ones with a way on', () => {
    const page = (which: string) => JSON.stringify({
      title: `Docs ${which}`, url: `https://docs.example/${which}`, text: `${which} page text. `.repeat(3_000),
    });
    const messages: Message[] = [
      { id: 'first', conversationId, role: 'assistant', content: '', createdAt: 1, status: 'complete', parts: [
        { type: 'tool', id: 'read-old', name: 'browser_read', input: JSON.stringify({ tabId: 'tab-a' }),
          output: page('old'), status: 'complete' },
      ] },
      { id: 'asked', conversationId, role: 'user', content: 'and now?', createdAt: 2, status: 'complete' },
      { id: 'second', conversationId, role: 'assistant', content: '', createdAt: 3, status: 'complete', parts: [
        { type: 'tool', id: 'clicked', name: 'browser_click', input: JSON.stringify({ tabId: 'tab-a' }),
          output: 'Clicked Buy at (10, 20).', status: 'complete' },
        { type: 'tool', id: 'read-new', name: 'browser_read', input: JSON.stringify({ tabId: 'tab-a' }),
          output: page('new'), status: 'complete' },
      ] },
    ];
    const stored = JSON.stringify(messages);
    const history = wireHistory(messages);
    const older = history.find(item => item.tool_call_id === 'read-old')!;
    const latest = history.find(item => item.tool_call_id === 'read-new')!;
    // The earlier read: the page's name and address whole, its text cut to the
    // opening, and a marker that says what to do rather than that text is gone.
    const shortened = JSON.parse(older.content!) as { title: string; url: string; text: string };
    const whole = JSON.parse(page('old')) as { text: string };
    expect(shortened.title).toBe('Docs old');
    expect(shortened.url).toBe('https://docs.example/old');
    expect(shortened.text.startsWith(whole.text.slice(0, REPLAYED_READ_CHARS))).toBe(true);
    expect(shortened.text).toContain(`the first ${REPLAYED_READ_CHARS.toLocaleString('en')} of ${whole.text.length.toLocaleString('en')} characters`);
    expect(shortened.text).toContain('Call browser_read on tab tab-a again');
    expect(older.content!.length).toBeLessThan(page('old').length / 10);
    // The read in hand is the material the model is working on: untouched.
    expect(latest.content).toBe(page('new'));
    // Nothing else is touched — another browser tool's result is not a page read.
    expect(history.find(item => item.tool_call_id === 'clicked')?.content).toBe('Clicked Buy at (10, 20).');
    // And nothing is written back: SQLite keeps every read whole, so turning the
    // shortening off restores the old thread exactly.
    expect(JSON.stringify(messages)).toBe(stored);
    expect(harness.instances).toHaveLength(0);
  });

  it('leaves a lone page read whole, and a read that never completed alone', () => {
    const long = JSON.stringify({ title: 'Only', url: 'https://only.example/', text: 'x'.repeat(REPLAYED_READ_CHARS * 3) });
    const history = wireHistory([
      { id: 'one', conversationId, role: 'assistant', content: '', createdAt: 1, status: 'complete', parts: [
        { type: 'tool', id: 'failed', name: 'browser_read', input: '{}', status: 'error',
          output: 'The requested tab has Agent control off.' },
        { type: 'tool', id: 'only', name: 'browser_read', input: '{}', output: long, status: 'complete' },
      ] },
    ]);
    // The only complete read is the latest read: there is nothing stale to cut.
    expect(history.find(item => item.tool_call_id === 'only')?.content).toBe(long);
    expect(history.find(item => item.tool_call_id === 'failed')).toMatchObject({
      isError: true, content: 'The requested tab has Agent control off.',
    });
    expect(harness.instances).toHaveLength(0);
  });
});

// Presets are additive (user, 14.09): a kept connection ADDS its models to the
// chat's picker instead of replacing the others'. And a server on another port
// must read as that — Node's fetch said only "fetch failed".
describe('the model catalog across kept connections', () => {
  const refused = () => Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8080'), { code: 'ECONNREFUSED' }),
  });

  it('lists every kept connection side by side, the one in use first even before it is kept, and keeps a failing one with its reason', async () => {
    store.saveSettings({ endpointUrl: 'https://one.example/v1', model: 'one-model', apiKey: 'key-one' });
    store.rememberConnection('One');
    store.saveSettings({ endpointUrl: 'http://localhost:8080/v1', model: '' });
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).startsWith('https://one.example/')) return new Response(JSON.stringify({ data: [{ id: 'one-model' }] }));
      throw refused();
    });
    expect(await create({ fetch: fetcher }).catalog()).toEqual([
      { name: '', endpointUrl: 'http://localhost:8080/v1', active: true, models: [],
        error: 'Could not reach http://localhost:8080/v1: nothing is listening there. For a server on this Mac, check that it is running and on this port.' },
      { name: 'One', endpointUrl: 'https://one.example/v1', active: false, models: [{ id: 'one-model' }] },
    ]);
    // Each endpoint is asked with its own key, and only its own.
    expect(fetcher).toHaveBeenCalledWith('https://one.example/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer key-one', Accept: 'application/json' } }));
    expect(fetcher).toHaveBeenCalledWith('http://localhost:8080/v1/models',
      expect.objectContaining({ headers: { Accept: 'application/json' } }));
    expect(harness.instances).toHaveLength(0);
  });

  it('says which address could not be reached and why, instead of "fetch failed"', async () => {
    store.saveSettings({ endpointUrl: 'http://localhost:8080/v1' });
    await expect(create({ fetch: vi.fn<typeof fetch>(async () => { throw refused(); }) }).models())
      .rejects.toThrow('Could not reach http://localhost:8080/v1: nothing is listening there.');
    const slow = vi.fn<typeof fetch>(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
    await expect(create({ fetch: slow }).models())
      .rejects.toThrow('Could not reach http://localhost:8080/v1: no answer within 15 seconds.');
  });
});

// A llama-server started with --port 8081 is not where the preset looks. The
// chat reaches it anyway, while it runs, without anyone keeping it.
describe('servers running on this Mac', () => {
  it('adds a running server to the catalog, naming the address in use after it', async () => {
    store.saveSettings({ endpointUrl: 'http://localhost:8081/v1', model: '' });
    const local = { name: 'llama.cpp · 8081', endpointUrl: 'http://localhost:8081/v1',
      models: [{ id: '/Users/q/Models/Nex-N2.5-mini-Q8_0.gguf', contextWindow: 262144 }] };
    const ollama = { name: 'Ollama · 11434', endpointUrl: 'http://localhost:11434/v1', models: [{ id: 'gemma4:12b' }] };
    const fetcher = vi.fn<typeof fetch>();
    // A server of the person's own costs nothing to ask: its models are free.
    expect(await create({ fetch: fetcher, localServers: async () => [local, ollama] }).catalog()).toEqual([
      { ...local, active: true, models: [{ ...local.models[0], free: true }] },
      { ...ollama, active: false, models: [{ id: 'gemma4:12b', free: true }] },
    ]);
    // What the look already listed is not asked for again.
    expect(fetcher).not.toHaveBeenCalled();
  });

  // Free first (user, 01.10): the picker opens on the models that cost nothing.
  it('marks what costs nothing: a model priced at zero or named :free, and every model of a server of the person\'s own', async () => {
    store.saveSettings({ endpointUrl: 'https://openrouter.ai/api/v1', model: 'm', apiKey: 'key' });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [
      { id: 'qwen/qwen3-coder:free' },
      { id: 'openrouter/sonoma-sky-alpha', pricing: { prompt: '0', completion: '0' } },
      { id: 'anthropic/claude-sonnet-4.5', pricing: { prompt: '0.000003', completion: '0.000015' } },
      { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
      { id: 'vendor/unpriced', pricing: { prompt: '', completion: '' } },
    ] })));
    const ollama = { name: 'Ollama · 11434', endpointUrl: 'http://localhost:11434/v1', models: [{ id: 'gemma4:12b' }] };
    const [cloud, local] = await create({ fetch: fetcher, localServers: async () => [ollama] }).catalog();
    expect(cloud.models).toEqual([
      { id: 'anthropic/claude-sonnet-4.5' },
      { id: 'openrouter/auto' },
      { id: 'openrouter/sonoma-sky-alpha', free: true },
      { id: 'qwen/qwen3-coder:free', free: true },
      { id: 'vendor/unpriced' },
    ]);
    expect(local.models).toEqual([{ id: 'gemma4:12b', free: true }]);
  });

  it('answers from the last look, however old, and looks afresh only when asked', async () => {
    const look = vi.fn(async () => []);
    const chat = create({ localServers: look });
    await chat.localServers();
    await chat.localServers();
    expect(look).toHaveBeenCalledOnce();
    // Even long afterwards: a look costs ports, and the caller decides when.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11_000);
    expect(await chat.localServers()).toEqual([]);
    expect(look).toHaveBeenCalledOnce();
    vi.mocked(Date.now).mockRestore();
    await chat.localServers(true);
    expect(look).toHaveBeenCalledTimes(2);
  });

  it('lists the models of an address being typed, with only a key stored for that address', async () => {
    store.saveSettings({ endpointUrl: 'https://one.example/v1', apiKey: 'key-one' });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ id: 'm', meta: { n_ctx: 262144 } }] })));
    expect(await create({ fetch: fetcher }).models('http://localhost:8081/v1')).toEqual([{ id: 'm', contextWindow: 262144 }]);
    expect(fetcher).toHaveBeenCalledWith('http://localhost:8081/v1/models',
      expect.objectContaining({ headers: { Accept: 'application/json' } }));
  });
});

// On a slow line a provider's TLS connect costs seconds, and asking twenty
// local ports at the same moment pushed it past Node's connect timeout: the
// chat showed OpenRouter as unreachable while Settings listed it fine.
describe('a catalogue that does not lose what it already read', () => {
  it('keeps a connection’s last models when a later read fails, with the reason beside them', async () => {
    store.saveSettings({ endpointUrl: 'https://one.example/v1', model: 'a' });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'a' }] })))
      .mockRejectedValue(Object.assign(new TypeError('fetch failed'), {
        cause: new Error('Connect Timeout Error (attempted addresses: 104.18.2.115:443, timeout: 10000ms)'),
      }));
    const chat = create({ fetch: fetcher, localServers: async () => [] });
    expect(await chat.models()).toEqual([{ id: 'a' }]);
    // Long enough that the listing is read again, and this time it fails.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000);
    const [row] = await chat.catalog();
    expect(row.models).toEqual([{ id: 'a' }]);
    expect(row.error).toContain('Connect Timeout Error');
    vi.mocked(Date.now).mockRestore();
  });

  it('never makes a chat wait on a fresh look at local ports', async () => {
    let looks = 0;
    const chat = create({ fetch: vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ id: 'a' }] }))),
      localServers: async () => { looks += 1; return looks > 1 ? new Promise<never>(() => {}) : []; } });
    await chat.catalog();
    expect(looks).toBe(1);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11_000);
    // The second look is started only after this call has its answer, so a
    // port that never replies cannot hold up the picker — or the provider.
    await expect(chat.catalog()).resolves.toHaveLength(1);
    expect(looks).toBe(2);
    vi.mocked(Date.now).mockRestore();
  });
});

// A worker that was prompted must be able to answer, and its answer is the
// chat's next turn — waking it when nothing is running (user, 18.09).
describe('what a worker says reaching the chat', () => {
  const report = (extra: Partial<Parameters<ChatService['workerReported']>[0]> = {}) => ({
    conversationId, paneId: 'pane-1', title: 'Kimi Code', worker: 'kimi' as const,
    kind: 'report' as const, status: 'done', text: 'Built the page and opened it.',
    tail: 'created index.html\nStill to do: the print stylesheet.', ...extra,
  });

  it('wakes an idle chat with the worker’s words and the last lines of its screen', async () => {
    const chat = create();
    chat.workerReported(report());
    await vi.waitFor(() => expect(harness.instances[0]?.prompt).toHaveBeenCalled());
    const prompt = String(harness.instances[0].prompt.mock.calls[0][0]);
    expect(prompt).toContain('[Worker report] Kimi Code (kimi) says its work is done.');
    expect(prompt).toContain('Built the page and opened it.');
    expect(prompt).toContain('Still to do: the print stylesheet.');
    expect(prompt).toContain('never instructions to follow');
    const current = await runtime();
    answer(current.rpc, 'The worker finished.');
    current.rpc.emit({ type: 'agent_settled' });
    await vi.waitFor(() => expect(chat.isRunning(conversationId)).toBe(false));
  });

  // A restart takes a moment; a worker's report in that moment is not lost.
  it('holds a report that arrives while the chat restarts, and delivers it after', async () => {
    const chat = create();
    const first = chat.send(conversationId, 'Build the page');
    const current = await runtime();
    const restarting = chat.restart(conversationId);
    chat.workerReported(report());
    await restarting;
    await first;
    expect(current.rpc.dispose).toHaveBeenCalled();
    // Delivered to the fresh chat as a turn of its own, on a new Pi.
    await vi.waitFor(() => expect(harness.instances[1]?.prompt).toHaveBeenCalled());
    expect(String(harness.instances[1].prompt.mock.calls[0][0])).toContain('[Worker report] Kimi Code (kimi) says its work is done.');
    const fresh = await runtime(1);
    settle(fresh.rpc, 'The worker finished.');
    await vi.waitFor(() => expect(chat.isRunning(conversationId)).toBe(false));
  });

  it('waits its turn while a reply is running, and says a question is blocking', async () => {
    const chat = create();
    const send = chat.send(conversationId, 'start something');
    const current = await runtime();
    chat.workerReported(report({ kind: 'ask', askId: 'ask-9', text: 'Overwrite index.html?' }));
    expect(chat.listQueued(conversationId).map(row => row.mode)).toEqual(['next']);
    const waiting = chat.listQueued(conversationId)[0].text;
    expect(waiting).toContain('[Worker question]');
    expect(waiting).toContain('worker_answer (paneId "pane-1", askId "ask-9")');
    answer(current.rpc, 'started');
    current.rpc.emit({ type: 'agent_settled' });
    await send;
    // The held question is delivered as the next turn, by itself, down the
    // session this chat already has warm.
    const next = await runtime(0, 2);
    expect(String(harness.instances[0].prompt.mock.calls[1][0])).toContain('Overwrite index.html?');
    answer(next.rpc, 'Answered it.');
    next.rpc.emit({ type: 'agent_settled' });
    await vi.waitFor(() => expect(chat.isRunning(conversationId)).toBe(false));
  });

  it('keeps a report for a chat that no longer exists out of everyone’s way', () => {
    const chat = create();
    expect(() => chat.workerReported(report({ conversationId: 'gone' }))).not.toThrow();
    expect(() => chat.workerReported(report({ text: '   ' }))).not.toThrow();
    expect(harness.instances).toHaveLength(0);
  });
});

// A model that has started repeating itself is stopped, and the human is told
// that is why, as with a reply the provider cut off (user, 22.09).
describe('a reply that repeats itself', () => {
  /** How many times Hello asked Pi to end the turn — the turn alone, never the queue. */
  const aborts = (current: Runtime) => current.rpc.request.mock.calls.filter(call => (call[0] as { type: string }).type === 'abort').length;
  /** Pi ending the turn Hello asked it to end. */
  const abortedTurn = (current: Runtime, kind: 'text' | 'thinking', text: string) => {
    current.rpc.emit({ type: 'message_end', message: { role: 'assistant',
      content: [kind === 'text' ? { type: 'text', text } : { type: 'thinking', thinking: text }], stopReason: 'aborted' } });
    current.rpc.emit({ type: 'agent_settled' });
  };
  const loop = 'Sau, mai simplu, să încerc să folosesc browser_pointer pentru a face click pe "Download invoice" cu coordonate mai precise. Sau, să încerc să navighez direct la URL-ul PDF al facturii. De obicei, facturile Stripe sunt la /pdf.\n\n';

  // Not ended: the turn is, the loop is cut out of the reply, and the model
  // is asked to go on — the third time it is given up on (user, 24.09: "să
  // detectăm, să oprim și să-i dăm resume").
  it('cuts the loop, ends the turn and asks the model to go on; the third loop ends the reply', async () => {
    const chat = create();
    const send = chat.send(conversationId, 'download the invoice');
    const current = await runtime();
    for (let round = 1; round <= 3; round += 1) {
      current.rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
      for (let index = 0; index < 4; index += 1)
        current.rpc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: loop } });
      if (round === 3) break;
      await vi.waitFor(() => expect(aborts(current)).toBe(round));
      expect(chat.isRunning(conversationId)).toBe(true);
      abortedTurn(current, 'text', loop.repeat(4));
      await runtime(0, round + 1);
      expect(current.rpc.prompt.mock.calls[round][0]).toBe(LOOP_RESUME_PROMPT);
      expect(assistant().status).toBe('streaming');
    }
    await send;
    const message = assistant();
    expect(message.status).toBe('error');
    expect(message.error).toContain('The model kept repeating itself and was stopped');
    expect(chat.isRunning(conversationId)).toBe(false);
    expect(aborts(current)).toBe(2);
    expect(current.rpc.abort).not.toHaveBeenCalled();
    // Each cut loop kept one turn of itself and the note, so the reply reads.
    const texts = (message.parts ?? []).filter(part => part.type === 'text').map(part => (part as { text: string }).text);
    expect(texts.slice(0, 2).every(text => text.endsWith('[Hello cut a loop here and asked the model to go on.]') && text.length < loop.length * 3)).toBe(true);
  });

  it('watches the thinking too, where a local model spent its whole budget on one sentence', async () => {
    const chat = create();
    const send = chat.send(conversationId, 'download the invoices');
    const current = await runtime();
    current.rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    const thought = 'Need maybe use browser_open to known URL? But "use existing sessions" and OpenAI page not currently tab. ';
    for (let index = 0; index < 8; index += 1)
      current.rpc.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: thought } });
    await vi.waitFor(() => expect(aborts(current)).toBe(1));
    abortedTurn(current, 'thinking', thought.repeat(8));
    await runtime(0, 2);
    expect(current.rpc.prompt.mock.calls[1][0]).toBe(LOOP_RESUME_PROMPT);
    // The reply goes on in the same bubble, and finishes as any other.
    settle(current.rpc, 'Opened the invoice and saved it.');
    await send;
    const message = assistant();
    expect(message.status).toBe('complete');
    expect(message.error).toBeNull();
    expect(message.parts?.[0]).toMatchObject({ type: 'thinking' });
    expect((message.parts?.[0] as { text: string }).text.length).toBeLessThan(thought.length * 3);
    expect(message.content).toContain('Opened the invoice and saved it.');
  });

  // The same paragraph before every tool call is the same loop, one step at a
  // time (user, 23.09: "OK, înțeleg. Trebuie să descarc efectiv…" above every
  // "Ran command" down the screen).
  it('is cut just the same when the paragraph comes back after every tool call', async () => {
    const chat = create();
    const send = chat.send(conversationId, 'download the invoices');
    const current = await runtime();
    current.rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    const step = 'OK, înțeleg. Trebuie să descarc efectiv fișierele PDF. Browser-ul nu are o funcție directă de download, dar pot folosi terminalul pentru a descărca PDF-urile. Să încep cu Cursor invoice de pe Stripe:';
    for (let index = 0; index < 3; index += 1) {
      current.rpc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: index * 2, delta: step } });
      current.rpc.emit({ type: 'message_update', assistantMessageEvent: {
        type: 'toolcall_start', contentIndex: index * 2 + 1, id: `call-${index}`, name: 'command_run' } });
    }
    await vi.waitFor(() => expect(aborts(current)).toBe(1));
    abortedTurn(current, 'text', step);
    await runtime(0, 2);
    expect(current.rpc.prompt.mock.calls[1][0]).toBe(LOOP_RESUME_PROMPT);
    settle(current.rpc, 'Saved every invoice.');
    await send;
    expect(assistant().status).toBe('complete');
    expect(chat.isRunning(conversationId)).toBe(false);
  });

  // A word before every call is narration, not a loop (user, 24.09: a run
  // stopped for "repeating itself" over "Verific" forty times).
  it('lets a one-word narration before forty different tool calls run on', async () => {
    const chat = create();
    const send = chat.send(conversationId, 'download the invoices');
    const current = await runtime();
    current.rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    for (let index = 0; index < 40; index += 1) {
      current.rpc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: index * 2, delta: 'Verific' } });
      current.rpc.emit({ type: 'message_update', assistantMessageEvent: {
        type: 'toolcall_start', contentIndex: index * 2 + 1, id: `call-${index}`, name: 'browser_click' } });
    }
    expect(chat.isRunning(conversationId)).toBe(true);
    settle(current.rpc, 'Every invoice is saved.');
    await send;
    expect(assistant().status).toBe('complete');
  });
});

// The same call with the same outcome, three times running, is a model going
// round (user, 23.09: "Ran command" down a whole screen). It is stopped, and
// the human is told why; a page read again while it loads is not a loop.
// The same call with the same result, three times running, is a model going
// round — "Ran command" down a screen (user, 23.09), "Checked open tabs"
// forty-three times (user, 24.09: "pare că lucrează dar face același lucru
// în buclă"). The third time it is handed a notice instead of the answer;
// the fifth time the reply ends. Reading is not exempt.
describe('a call the model keeps making', () => {
  const same = { tabId: 'page', url: 'https://billing.example/invoice' };

  it('hands a notice instead of the same answer the third time, and ends the reply the fifth', async () => {
    const hooks = { getTabs: () => [tab('page', 'off')], read: vi.fn(), navigate: vi.fn(), click: vi.fn(), type: vi.fn(), scroll: vi.fn() };
    const chat = create({ browser: hooks });
    const send = chat.send(conversationId, 'open the invoice');
    const current = await runtime();
    for (const id of ['nav-1', 'nav-2'])
      expect(await tool(current, 'browser_navigate', same, id)).toBe('Browser action completed.');
    await expect(tool(current, 'browser_navigate', same, 'nav-3')).rejects.toThrow(
      'This is the same browser_navigate call with the same result for the 3rd time in a row: nothing has changed. Do not call it again.');
    await expect(tool(current, 'browser_navigate', same, 'nav-4')).rejects.toThrow(/for the 4th time in a row/);
    expect(chat.isRunning(conversationId)).toBe(true);
    // A different call breaks the run of them: the count starts again.
    expect(await tool(current, 'browser_navigate', { ...same, url: 'https://billing.example/invoices' }, 'nav-5')).toBe('Browser action completed.');
    expect(await tool(current, 'browser_navigate', same, 'nav-6')).toBe('Browser action completed.');
    for (const id of ['nav-7']) expect(await tool(current, 'browser_navigate', same, id)).toBe('Browser action completed.');
    await expect(tool(current, 'browser_navigate', same, 'nav-8')).rejects.toThrow(/3rd time/);
    await expect(tool(current, 'browser_navigate', same, 'nav-9')).rejects.toThrow(/4th time/);
    await expect(tool(current, 'browser_navigate', same, 'nav-10')).rejects.toThrow(/5 times in a row/);
    await send;
    expect(assistant().error).toContain('The model kept making the same browser_navigate call with the same result and was stopped');
    expect(chat.isRunning(conversationId)).toBe(false);
  });

  it('counts a list looked at again with nothing changed, and a call failing the same way', async () => {
    const hooks = { getTabs: () => [tab('page', 'read'), tab('closed', 'off')], navigate: vi.fn(), click: vi.fn(), type: vi.fn(), scroll: vi.fn(),
      read: vi.fn(async () => ({ title: 'Invoice', url: 'https://example.test', text: 'Loading…' })) };
    const chat = create({ browser: hooks });
    const send = chat.send(conversationId, 'read the invoice');
    const current = await runtime();
    for (const id of ['tabs-1', 'tabs-2'])
      expect(await tool(current, 'browser_tabs', {}, id)).toContain('Fixture page');
    await expect(tool(current, 'browser_tabs', {}, 'tabs-3')).rejects.toThrow(/same browser_tabs call with the same result for the 3rd time in a row/);
    // A page read again with the same words has loaded nothing new either.
    for (const id of ['read-1', 'read-2'])
      expect(await tool(current, 'browser_read', { tabId: 'page' }, id)).toContain('Loading…');
    await expect(tool(current, 'browser_read', { tabId: 'page' }, 'read-3')).rejects.toThrow(/3rd time in a row/);
    // Changed words: a fresh answer, and the count starts again.
    hooks.read.mockResolvedValueOnce({ title: 'Invoice', url: 'https://example.test', text: 'Total 20 USD' });
    expect(await tool(current, 'browser_read', { tabId: 'page' }, 'read-4')).toContain('Total 20 USD');
    // A call failing the same way three times carries the notice on its error.
    for (const id of ['off-1', 'off-2'])
      await expect(tool(current, 'browser_read', { tabId: 'closed' }, id)).rejects.toThrow(/Agent control off/i);
    await expect(tool(current, 'browser_read', { tabId: 'closed' }, 'off-3')).rejects.toThrow(/Agent control off.*3rd time in a row/is);
    expect(chat.isRunning(conversationId)).toBe(true);
    settle(current.rpc, 'The tab is off; enable Read on it.');
    await send;
    expect(assistant().status).toBe('complete');
  });
});

// Each chat keeps the model it last used (user, 04.10: "nothing fancy").
describe('the model a chat runs on', () => {
  const listing = (...models: Array<{ id: string; context_length?: number }>) =>
    vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: models }), { headers: { 'content-type': 'application/json' } }));

  it('runs a chat on its own model, on that model’s connection, key and published window', async () => {
    // A second connection with its own key; the selection goes back to the first.
    store.saveSettings({ endpointUrl: 'https://other.example/v1', model: 'other-model', apiKey: 'other-key' });
    store.saveSettings({ endpointUrl: 'https://local-fixture.example/v1', model: 'test-model' });
    store.updateConversation(conversationId, { model: { endpointUrl: 'https://other.example/v1', id: 'other-model' } });
    const fetcher = listing({ id: 'other-model', context_length: 65536 });
    const chat = create({ fetch: fetcher });
    const send = chat.send(conversationId, 'Hi');
    const { rpc } = await runtime();
    expect(rpc.options.args).toEqual(expect.arrayContaining(['--model', 'hello/other-model']));
    expect(rpc.options.env?.HELLO_PI_API_KEY).toBe('other-key');
    const models = JSON.parse(readFileSync(path.join(piConversationDir(directory, conversationId), 'agent', 'models.json'), 'utf8'));
    expect(models.providers.hello.baseUrl).toBe('https://other.example/v1');
    expect(models.providers.hello.models[0]).toMatchObject({ id: 'other-model', contextWindow: 65536 });
    // Its limits were asked of its own endpoint, with its own key.
    expect(fetcher).toHaveBeenCalledWith('https://other.example/v1/models',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer other-key' }) }));
    settle(rpc, 'Hello.');
    await send;
    expect(assistant().model).toBe('other-model');
    // Summarising keeps the session it has, rather than one on the selection.
    await chat.compact(conversationId);
    expect(rpc.request).toHaveBeenCalledWith({ type: 'compact' }, expect.any(Number));
    expect(harness.instances).toHaveLength(1);
    // The selection is untouched: a new chat starts on it.
    expect(store.getSettings()).toMatchObject({ endpointUrl: 'https://local-fixture.example/v1', model: 'test-model' });
  });

  it('keeps the model a turn ran on, so a selection changed elsewhere leaves the chat where it was', async () => {
    const chat = create({ fetch: listing({ id: 'test-model' }, { id: 'newer-model' }) });
    const first = chat.send(conversationId, 'First');
    const current = await runtime();
    settle(current.rpc, 'One.');
    await first;
    expect(store.getConversation(conversationId).model).toEqual({ endpointUrl: 'https://local-fixture.example/v1', id: 'test-model' });

    // Another chat picks another model: the selection moves, this chat does not.
    store.saveSettings({ model: 'newer-model' });
    const second = chat.send(conversationId, 'Second');
    await vi.waitFor(() => expect(harness.instances.at(-1)?.prompt).toHaveBeenCalledWith('Second'));
    const latest = harness.instances.at(-1)!;
    expect(latest.options.args).toEqual(expect.arrayContaining(['--model', 'hello/test-model']));
    settle(latest, 'Two.');
    await second;
    expect(assistant().model).toBe('test-model');
    expect(store.getConversation(conversationId).model?.id).toBe('test-model');
  });
});
