import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PiRpcEvent, PiRpcProcessOptions } from '../src/main/chat/pi-rpc';
import type { PiToolBridgeOptions } from '../src/main/chat/pi-tool-bridge';
import type { BrowserTab, ChatEvent, ChatQueueEvent, MessagePart } from '../src/shared/types';

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
import { ChatService, completionURL, modelsURL, wireHistory, type ChatServiceOptions } from '../src/main/chat/service';
import { piConversationDir } from '../src/main/chat/pi-session';

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

function create(options: Pick<ChatServiceOptions, 'fetch' | 'browser'> = {}): ChatService {
  service = new ChatService({ store, emit: event => events.push(structuredClone(event)),
    emitQueue: event => queueEvents.push(structuredClone(event)), ...options });
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
    output => {
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
    loading: false, canGoBack: false, canGoForward: false };
}

describe('Pi-backed chat lifecycle with in-memory transport', () => {
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

  it('runs notebook tools in Hello and records one result card', async () => {
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
});
