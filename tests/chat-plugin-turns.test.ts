import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PiRpcEvent, PiRpcProcessOptions } from '../src/main/chat/pi-rpc';
import type { PiToolBridgeOptions } from '../src/main/chat/pi-tool-bridge';
import type { ChatEvent, ExtensionUiState } from '../src/shared/types';

// Never a real Pi child: a fake that emits what Pi emits. This suite checks a
// turn Pi begins on its own — a plugin woke it (user, 29.09) — after a reply.
const harness = vi.hoisted(() => {
  class FakePi {
    readonly listeners = new Set<(event: PiRpcEvent) => void>();
    isRunning = true;
    constructor(readonly options: PiRpcProcessOptions) { instances.push(this); }
    start = vi.fn(async () => {
      const failure = state.nextStartError;
      state.nextStartError = undefined;
      if (!failure) return;
      // The real transport reports the exit first, then rejects start().
      this.isRunning = false;
      this.options.onExit?.({ code: 1, signal: null, expected: false, error: failure.message, stderr: '' });
      throw failure;
    });
    prompt = vi.fn(async () => {
      // What Pi does before it answers a prompt: a plugin command runs whole.
      for (const event of state.beforePromptAnswer ?? []) this.emit(event);
      return { type: 'response', id: 'fixture', command: 'prompt', success: true, ...(state.promptDisposition ? { data: { disposition: state.promptDisposition } } : {}) };
    });
    request = vi.fn(async (command: { type: string }) => command.type === 'get_commands'
      ? { type: 'response', id: 'fixture', command: 'get_commands', success: true, data: { commands: state.commands ?? [] } }
      : { type: 'response', id: 'fixture', command: 'noop', success: true });
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
  const bridges: Array<{ options: PiToolBridgeOptions }> = [];
  const state: { nextStartError?: Error; commands?: Array<{ name: string; source: string }>; beforePromptAnswer?: PiRpcEvent[]; promptDisposition?: string } = {};
  return { FakePi, instances, bridges, state };
});
vi.mock('../src/main/chat/pi-rpc', () => ({ PiRpcProcess: harness.FakePi }));
vi.mock('../src/main/chat/pi-tool-bridge', () => ({
  createPiToolBridge: vi.fn(async (options: PiToolBridgeOptions) => {
    harness.bridges.push({ options });
    return {
      env: { HELLO_PI_BRIDGE_URL: 'http://127.0.0.1:1/', HELLO_PI_BRIDGE_TOKEN: 'a'.repeat(64) },
      ready: true,
      close: vi.fn(async () => {}),
    };
  }),
}));

import { createDataStore, type DataStore } from '../src/main/data/store';
import { ChatService } from '../src/main/chat/service';

let directory: string;
let store: DataStore;
let service: ChatService;
let conversationId: string;
const events: ChatEvent[] = [];
const shown: ExtensionUiState[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  harness.instances.length = 0;
  harness.bridges.length = 0;
  harness.state.commands = undefined;
  harness.state.beforePromptAnswer = undefined;
  harness.state.promptDisposition = undefined;
  directory = mkdtempSync(path.join(tmpdir(), 'hello-plugin-turns-'));
  store = createDataStore(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  store.saveSettings({ model: 'test-model', endpointUrl: 'https://local-fixture.example/v1' });
  conversationId = store.createConversation().id;
  service = new ChatService({ store, emit: event => events.push(structuredClone(event)), emitExtensionUi: state => shown.push(structuredClone(state)) });
  events.length = 0;
  shown.length = 0;
});
afterEach(async () => {
  await service.dispose();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const say = (text: string) => ({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } } as unknown as PiRpcEvent);

async function reply(text: string) {
  const pending = service.send(conversationId, text);
  await vi.waitFor(() => expect(harness.instances.at(-1)?.prompt).toHaveBeenCalled());
  const pi = harness.instances.at(-1)!;
  pi.emit({ type: 'agent_start' } as PiRpcEvent);
  pi.emit(say('Started three subagents; their results will arrive.'));
  pi.emit({ type: 'agent_settled' } as PiRpcEvent);
  await pending;
  return pi;
}

describe('a turn Pi begins on its own', () => {
  it('is followed as a new reply, saying which plugin message woke it', async () => {
    const pi = await reply('compare Go, Rust and Python with subagents');
    expect(store.listMessages(conversationId).map(message => message.role)).toEqual(['user', 'assistant']);
    // pi-subagents: "Pi will wake you when this subagent completes".
    pi.emit({ type: 'agent_start' } as PiRpcEvent);
    pi.emit({ type: 'message_start', message: { role: 'custom', customType: 'subagent-result', display: true, content: 'Background run a5040b8e finished: 3 of 3 done.' } } as unknown as PiRpcEvent);
    // While it runs, it is the chat's reply: Hello's own tools answer for it.
    await vi.waitFor(async () => {
      const bridge = harness.bridges.at(-1)!.options;
      await expect(bridge.execute('notebook_list', { kind: 'runbook' }, new AbortController().signal, 'call-1')).resolves.toBeDefined();
    });
    pi.emit(say('All three subagents finished. Here is the table.'));
    pi.emit({ type: 'agent_settled' } as PiRpcEvent);
    await vi.waitFor(() => expect(store.listMessages(conversationId)[2]?.status).toBe('complete'));
    const adopted = store.listMessages(conversationId)[2];
    expect(adopted).toMatchObject({ role: 'assistant', status: 'complete', startedBy: 'A plugin started this reply: Background run a5040b8e finished: 3 of 3 done.' });
    expect(adopted.parts?.map(part => part.type === 'text' ? part.text : part.type)).toContain('All three subagents finished. Here is the table.');
    expect(events.some(event => event.message.id === adopted.id)).toBe(true);
  });

  it('leaves nothing behind when the turn says nothing', async () => {
    const pi = await reply('hello');
    pi.emit({ type: 'agent_start' } as PiRpcEvent);
    pi.emit({ type: 'message_start', message: { role: 'custom', customType: 'subagent-compaction-resume', display: false, content: 'Resume.' } } as unknown as PiRpcEvent);
    pi.emit({ type: 'agent_settled' } as PiRpcEvent);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(store.listMessages(conversationId)).toHaveLength(2);
  });

  it('waits for a reply of Hello’s that is still ending, then follows the turn', async () => {
    const pending = service.send(conversationId, 'one');
    await vi.waitFor(() => expect(harness.instances.at(-1)?.prompt).toHaveBeenCalled());
    const pi = harness.instances.at(-1)!;
    pi.emit({ type: 'agent_start' } as PiRpcEvent);
    pi.emit(say('First reply.'));
    pi.emit({ type: 'agent_settled' } as PiRpcEvent);
    // Before Hello's reply has finished ending, a plugin wakes Pi.
    pi.emit({ type: 'agent_start' } as PiRpcEvent);
    pi.emit(say('Woken reply.'));
    pi.emit({ type: 'agent_settled' } as PiRpcEvent);
    await pending;
    await vi.waitFor(() => expect(store.listMessages(conversationId)[2]?.status).toBe('complete'));
    expect(store.listMessages(conversationId)[1].parts).toEqual([{ type: 'text', text: 'First reply.' }]);
    expect(store.listMessages(conversationId)[2]).toMatchObject({ status: 'complete', startedBy: 'A plugin started this reply.', parts: [{ type: 'text', text: 'Woken reply.' }] });
  });

  it('can be stopped like any reply', async () => {
    const pi = await reply('go');
    pi.emit({ type: 'agent_start' } as PiRpcEvent);
    pi.emit({ type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: 'Working on the results' }] } } as unknown as PiRpcEvent);
    await vi.waitFor(() => expect(store.listMessages(conversationId)).toHaveLength(3));
    await service.stop(conversationId);
    await vi.waitFor(() => expect(store.listMessages(conversationId)[2].status).toBe('error'));
    expect(pi.dispose).toHaveBeenCalled();
  });
});

const ui = (fields: Record<string, unknown>) => ({ type: 'extension_ui_request', id: `ui-${Math.random()}`, ...fields } as unknown as PiRpcEvent);

describe('what a chat’s plugins show, while Pi runs headless', () => {
  it('keeps a plugin’s text widgets, statuses and notices, and clears a widget it takes back', async () => {
    const pi = await reply('go');
    pi.emit(ui({ method: 'setWidget', widgetKey: 'subagents', widgetLines: ['Subagents 2/3', '✓ go', '… rust'] }));
    pi.emit(ui({ method: 'setWidget', widgetKey: 'below', widgetLines: ['footer line'], widgetPlacement: 'belowEditor' }));
    pi.emit(ui({ method: 'setStatus', statusKey: 'subagents', statusText: 'fan-out running' }));
    pi.emit(ui({ method: 'notify', message: 'Run a5040b8e finished', notifyType: 'warning' }));
    pi.emit(ui({ method: 'setTitle', title: 'pi - project' }));
    const state = service.extensionUiState(conversationId);
    expect(state.widgets).toEqual([
      { key: 'subagents', lines: ['Subagents 2/3', '✓ go', '… rust'], placement: 'aboveEditor' },
      { key: 'below', lines: ['footer line'], placement: 'belowEditor' },
    ]);
    expect(state.statuses).toEqual([{ key: 'subagents', text: 'fan-out running' }]);
    expect(state.notices).toMatchObject([{ message: 'Run a5040b8e finished', kind: 'warning' }]);
    expect(shown.at(-1)).toEqual(state);
    pi.emit(ui({ method: 'setWidget', widgetKey: 'subagents' }));
    pi.emit(ui({ method: 'setStatus', statusKey: 'subagents' }));
    expect(service.extensionUiState(conversationId)).toMatchObject({ widgets: [{ key: 'below' }], statuses: [] });
    pi.emit(ui({ method: 'set_editor_text', text: 'suggested prompt' }));
    expect(service.extensionUiState(conversationId).editorText).toMatchObject({ text: 'suggested prompt' });
  });

  it('asks the person a plugin’s question and hands the answer to the Pi that asked', async () => {
    const pi = await reply('go');
    pi.emit({ type: 'extension_ui_request', id: 'ask-1', method: 'select', title: 'Allow dangerous command?', options: ['Allow', 'Block'] } as unknown as PiRpcEvent);
    pi.emit({ type: 'extension_ui_request', id: 'ask-2', method: 'confirm', title: 'Clear session?', message: 'All messages will be lost.' } as unknown as PiRpcEvent);
    expect(service.extensionUiState(conversationId).dialogs).toEqual([
      { id: 'ask-1', method: 'select', title: 'Allow dangerous command?', options: ['Allow', 'Block'] },
      { id: 'ask-2', method: 'confirm', title: 'Clear session?', message: 'All messages will be lost.' },
    ]);
    // No longer declined for the person.
    expect(pi.respondToExtension).not.toHaveBeenCalled();
    await service.answerExtension(conversationId, 'ask-1', { value: 'Block' });
    expect(pi.respondToExtension).toHaveBeenCalledWith({ id: 'ask-1', value: 'Block' });
    await service.answerExtension(conversationId, 'ask-2', { confirmed: false });
    expect(pi.respondToExtension).toHaveBeenLastCalledWith({ id: 'ask-2', confirmed: false });
    expect(service.extensionUiState(conversationId).dialogs).toEqual([]);
    await expect(service.answerExtension(conversationId, 'ask-1', { value: 'Allow' })).rejects.toThrow(/no longer waiting/);
  });

  it('lets a question with a timeout go when Pi answers it by itself', async () => {
    const pi = await reply('go');
    pi.emit({ type: 'extension_ui_request', id: 'ask-t', method: 'input', title: 'Name?', placeholder: 'type', timeout: 15 } as unknown as PiRpcEvent);
    expect(service.extensionUiState(conversationId).dialogs[0]).toMatchObject({ id: 'ask-t', method: 'input', placeholder: 'type' });
    await vi.waitFor(() => expect(service.extensionUiState(conversationId).dialogs).toEqual([]));
  });

  it('goes with the Pi process that drew it', async () => {
    const pi = await reply('go');
    pi.emit(ui({ method: 'setWidget', widgetKey: 'todo', widgetLines: ['1. step'] }));
    pi.emit({ type: 'extension_ui_request', id: 'ask-3', method: 'editor', title: 'Edit', prefill: 'x' } as unknown as PiRpcEvent);
    await pi.dispose();
    expect(service.extensionUiState(conversationId)).toMatchObject({ widgets: [], dialogs: [], statuses: [] });
    await expect(service.answerExtension(conversationId, 'ask-3', { cancelled: true })).rejects.toThrow(/no longer waiting/);
  });
});

// A notebook section switches while a reply runs too (user, 30.09); the
// instructions, written when a session starts, follow at the next turn.
describe('a notebook section switched between turns', () => {
  const instructions = (pi: InstanceType<typeof harness.FakePi>) => {
    const args = pi.options.args ?? [];
    const at = args.findIndex(arg => arg === '--system-prompt' || arg === '--append-system-prompt');
    return readFileSync(args[at + 1], 'utf8');
  };

  /** One turn, answered by the session that is the given one in order, on its given prompt. */
  async function answer(text: string, sessions: number, prompts: number) {
    const pending = service.send(conversationId, text);
    await vi.waitFor(() => {
      expect(harness.instances).toHaveLength(sessions);
      expect(harness.instances.at(-1)!.prompt).toHaveBeenCalledTimes(prompts);
    });
    const pi = harness.instances.at(-1)!;
    pi.emit({ type: 'agent_start' } as PiRpcEvent);
    pi.emit(say('Done.'));
    pi.emit({ type: 'agent_settled' } as PiRpcEvent);
    await pending;
    return pi;
  }

  it('starts the next turn in a session whose instructions say so', async () => {
    const first = await answer('one', 1, 1);
    expect(instructions(first)).toContain('This chat has Plan off');
    store.updateConversation(conversationId, { planning: true });
    const second = await answer('two', 2, 1);
    expect(first.dispose).toHaveBeenCalled();
    expect(instructions(second)).not.toContain('This chat has Plan off');
    expect(instructions(second)).toContain('plan_write');
    // Nothing switched: the same session carries on.
    expect(await answer('three', 2, 2)).toBe(second);
  });
});

// A plugin's slash command runs without a model turn, so Pi settles none
// (user, 30.09: /subagents delegate asks which change to make). Pi answers its
// prompt once the command has run; that ends the reply.
describe('a plugin’s slash command', () => {
  it('ends the reply once Pi has run it, with what the command posted', async () => {
    harness.state.commands = [{ name: 'subagents', source: 'extension' }, { name: 'skill:review', source: 'skill' }];
    harness.state.beforePromptAnswer = [
      { type: 'message_end', message: { role: 'custom', customType: 'subagents-admin', display: true, content: 'delegate (builtin): model inherits the session.' } } as unknown as PiRpcEvent,
      { type: 'message_end', message: { role: 'custom', customType: 'hidden-note', display: false, content: 'not for the person' } } as unknown as PiRpcEvent,
    ];
    await service.send(conversationId, '/subagents delegate');
    const [, reply] = store.listMessages(conversationId);
    expect(reply).toMatchObject({ role: 'assistant', status: 'complete', content: 'delegate (builtin): model inherits the session.' });
  });

  it('says it ran when the command posted nothing', async () => {
    harness.state.commands = [{ name: 'subagents-doctor', source: 'extension' }];
    await service.send(conversationId, '/subagents-doctor');
    expect(store.listMessages(conversationId)[1]).toMatchObject({ status: 'complete', content: '/subagents-doctor ran.' });
  });

  it('ends a reply Pi says a plugin handled, even without a command by that name', async () => {
    harness.state.promptDisposition = 'handled';
    await service.send(conversationId, 'take this');
    expect(store.listMessages(conversationId)[1]).toMatchObject({ status: 'complete', content: 'A plugin took this message; no reply follows.' });
  });

  it('leaves any other slash text to a model turn', async () => {
    harness.state.commands = [{ name: 'review', source: 'prompt' }];
    const pending = service.send(conversationId, '/review this file');
    await vi.waitFor(() => expect(harness.instances.at(-1)?.prompt).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(store.listMessages(conversationId)[1]?.status).toBe('streaming');
    const pi = harness.instances.at(-1)!;
    pi.emit({ type: 'agent_start' } as PiRpcEvent);
    pi.emit(say('Reviewed.'));
    pi.emit({ type: 'agent_settled' } as PiRpcEvent);
    await pending;
    expect(store.listMessages(conversationId)[1]).toMatchObject({ status: 'complete' });
  });
});

describe('the chat’s plugin commands, for the / menu', () => {
  it('are what its running Pi says, only the plugins’ own, and the last list while none runs', async () => {
    expect(await service.pluginCommands(conversationId)).toBeNull();
    harness.state.commands = [
      { name: 'subagents', source: 'extension', description: 'Administer subagents' } as { name: string; source: string },
      { name: 'skill:review', source: 'skill' },
      { name: 'fix-tests', source: 'prompt' },
      { name: 'bad name; rm', source: 'extension' },
    ];
    await reply('hello');
    expect(await service.pluginCommands(conversationId)).toEqual([{ name: 'subagents', description: 'Administer subagents' }]);
    // Its Pi stopped: the last list it gave.
    harness.instances.at(-1)!.isRunning = false;
    harness.state.commands = [];
    expect(await service.pluginCommands(conversationId)).toEqual([{ name: 'subagents', description: 'Administer subagents' }]);
  });
});
