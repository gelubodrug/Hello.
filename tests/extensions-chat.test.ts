import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PiRpcEvent, PiRpcProcessOptions } from '../src/main/chat/pi-rpc';
import type { PiToolBridgeOptions } from '../src/main/chat/pi-tool-bridge';
import type { ChatEvent } from '../src/shared/types';

// Same policy as the other chat suites: never a real Pi child, listener,
// model server or CLI. This one checks what activation does to the launch.
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
    prompt = vi.fn(async () => ({ type: 'response', id: 'fixture', command: 'prompt', success: true }));
    request = vi.fn(async () => ({ type: 'response', id: 'fixture', command: 'noop', success: true }));
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
  const state: { nextStartError?: Error } = {};
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
import { ResourceLibrary, resourceDirectory } from '../src/main/extensions/library';

let directory: string;
let source: string;
let store: DataStore;
let service: ChatService;
let library: ResourceLibrary;
let conversationId: string;
const events: ChatEvent[] = [];

function writeSkill(name: string, description: string): string {
  const folder = path.join(source, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps here.\n`);
  return folder;
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.instances.length = 0;
  harness.bridges.length = 0;
  directory = mkdtempSync(path.join(tmpdir(), 'hello-ext-chat-'));
  source = mkdtempSync(path.join(tmpdir(), 'hello-ext-src-'));
  store = createDataStore(directory, {
    encrypt: text => Buffer.from(text.split('').reverse().join('')),
    decrypt: bytes => bytes.toString().split('').reverse().join(''),
  });
  store.saveSettings({ model: 'test-model', endpointUrl: 'https://local-fixture.example/v1' });
  conversationId = store.createConversation().id;
  library = new ResourceLibrary(store);
  service = new ChatService({ store, emit: event => events.push(structuredClone(event)), library });
  events.length = 0;
});
afterEach(async () => {
  await service.dispose();
  store.close();
  rmSync(directory, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
});

async function send(text = 'hello') {
  // A changed selection starts a new child, so wait for the newest runtime's
  // prompt rather than the first one's.
  const startedWith = harness.instances.length;
  const previousPrompts = harness.instances.at(-1)?.prompt.mock.calls.length ?? 0;
  const pending = service.send(conversationId, text);
  await vi.waitFor(() => {
    const last = store.listMessages(conversationId).at(-1);
    if (last?.status === 'error') throw new Error(`run failed: ${last.error}`);
    const current = harness.instances.at(-1);
    expect(current).toBeDefined();
    const calls = current!.prompt.mock.calls.length;
    expect(calls).toBeGreaterThan(harness.instances.length > startedWith ? 0 : previousPrompts);
  });
  const current = harness.instances.at(-1)!;
  current.emit({ type: 'agent_settled' } as PiRpcEvent);
  current.emit({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  } as unknown as PiRpcEvent);
  await pending.catch(() => {});
}

describe('activated resources reach the Pi launch', () => {
  it('passes --skill for an active skill and lists it for skill_load', async () => {
    const imported = await library.importPath('skill', writeSkill('demo-skill', 'Demonstrates activation.'));
    store.setResourceActive(conversationId, imported.id, true);
    await send();
    const args = [...(harness.instances[0].options.args ?? [])];
    const copy = resourceDirectory(store.dataDir, { id: imported.id, kind: 'skill' });
    expect(args).toContain('--skill');
    expect(args[args.indexOf('--skill') + 1]).toBe(copy);
    // Discovery stays disabled: only the paths Hello passes are loaded.
    expect(args).toContain('-ns');
    const tools = await harness.bridges.at(-1)!.options.getTools();
    const skillTool = tools.find(tool => tool.function.name === 'skill_load');
    expect(skillTool?.function.description).toContain('demo-skill');
    // The launch cwd is <conversation>/work; the prompt sits beside it.
    const prompt = readFileSync(path.join(path.dirname(harness.instances[0].options.cwd), 'system-prompt.md'), 'utf8');
    expect(prompt).toContain('demo-skill');
    expect(prompt).toContain('skill_load');
  });

  it('expands /skill:<name> itself, by the library name, and leaves the transcript as typed', async () => {
    const lastPrompt = () => String((harness.instances.at(-1)!.prompt.mock.calls.at(-1) as unknown[])[0]);
    const folder = path.join(source, 'folder-name');
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: PDF Tools\ndescription: Fills PDF forms.\n---\n\nStep one: read the form.\n');
    const imported = await library.importPath('skill', folder);
    store.setResourceActive(conversationId, imported.id, true);
    await send('/skill:pdf tools fill this form');
    const sent = lastPrompt();
    expect(sent).toMatch(/^<skill name="PDF Tools">/);
    expect(sent).toContain('Step one: read the form.');
    expect(sent).not.toContain('description: Fills PDF forms.');
    expect(sent.endsWith('</skill>\n\nfill this form')).toBe(true);
    expect(store.listMessages(conversationId).find(message => message.role === 'user')?.content).toBe('/skill:pdf tools fill this form');
    // A name no active skill has is left to Pi, as typed. (This fixture ends
    // the reply as failed, so the next message is a wrapped follow-up.)
    await send('/skill:unknown hi');
    const wrapped = lastPrompt();
    expect(wrapped).toMatch(/Current user request:\n\n\/skill:unknown hi$/);
    // Wrapped in Hello's words, a known skill still arrives expanded.
    await send('/skill:PDF Tools again');
    expect(lastPrompt()).toMatch(/Current user request:\n\n<skill name="PDF Tools">[\s\S]*<\/skill>\n\nagain$/);
  });

  it('offers no skill tool when nothing is active', async () => {
    await send();
    const tools = await harness.bridges.at(-1)!.options.getTools();
    expect(tools.some(tool => tool.function.name === 'skill_load')).toBe(false);
  });

  it('passes -e for an active plugin extension', async () => {
    const folder = path.join(source, 'plugin');
    mkdirSync(path.join(folder, 'extensions'), { recursive: true });
    writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0' }));
    writeFileSync(path.join(folder, 'extensions', 'tool.ts'), 'export default function () {}\n');
    const imported = await library.importPath('plugin', folder);
    store.setResourceActive(conversationId, imported.id, true);
    await send();
    const args = [...(harness.instances[0].options.args ?? [])];
    const entries = args.filter((value, index) => args[index - 1] === '-e');
    // Hello's own extension stays first; the plugin is added, not substituted.
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatch(/pi-extension\.js$/);
    expect(entries[1]).toMatch(/extensions\/tool\.ts$/);
  });

  it('loads prompt templates from an activated package', async () => {
    const folder = path.join(source, 'templates');
    mkdirSync(path.join(folder, 'prompts'), { recursive: true });
    writeFileSync(path.join(folder, 'package.json'), '{"name":"templates","pi":{"prompts":["./prompts"]}}');
    writeFileSync(path.join(folder, 'prompts/review.md'), 'Review $1 carefully.');
    const imported = await library.importPath('plugin', folder);
    store.setResourceActive(conversationId, imported.id, true);
    await send();
    const args = [...(harness.instances[0].options.args ?? [])];
    expect(args[args.indexOf('--prompt-template') + 1]).toMatch(/prompts\/review.md$/);
    store.setResourceActive(conversationId, imported.id, false);
    await send('again');
    expect(harness.instances[1].options.args).not.toContain('--prompt-template');
  });

  it('restarts the runtime when the selection changes, keeping one session file', async () => {
    await send('first');
    const imported = await library.importPath('skill', writeSkill('demo-skill', 'Demonstrates activation.'));
    store.setResourceActive(conversationId, imported.id, true);
    await send('second');
    expect(harness.instances).toHaveLength(2);
    const sessionOf = (index: number) => {
      const args = [...(harness.instances[index].options.args ?? [])];
      return args[args.indexOf('--session') + 1];
    };
    expect(sessionOf(1)).toBe(sessionOf(0));
    expect(harness.instances[0].dispose).toHaveBeenCalled();
  });

  it('restarts the runtime after a re-import, so a warm session cannot keep stale code', async () => {
    const folder = writeSkill('demo-skill', 'First description.');
    const imported = await library.importPath('skill', folder);
    store.setResourceActive(conversationId, imported.id, true);
    await send('first');
    expect(harness.instances).toHaveLength(1);
    // Same id, same paths: only the fingerprint changes, and that must be enough.
    writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: demo-skill\ndescription: Second description.\n---\n\nNew steps.\n');
    await library.update(imported.id);
    await send('second');
    expect(harness.instances).toHaveLength(2);
    const prompt = readFileSync(path.join(path.dirname(harness.instances[1].options.cwd), 'system-prompt.md'), 'utf8');
    expect(prompt).toContain('Second description.');
  });

  it('refuses to start when an approved copy changed, naming the resource', async () => {
    const imported = await library.importPath('skill', writeSkill('demo-skill', 'Demonstrates activation.'));
    store.setResourceActive(conversationId, imported.id, true);
    const copy = resourceDirectory(store.dataDir, { id: imported.id, kind: 'skill' });
    writeFileSync(path.join(copy, 'SKILL.md'), '---\nname: demo-skill\ndescription: tampered\n---\nrewritten');
    await service.send(conversationId, 'hello').catch(() => {});
    await vi.waitFor(() => {
      const last = store.listMessages(conversationId).at(-1)!;
      expect(last.status).toBe('error');
      expect(last.error).toMatch(/demo-skill/);
      expect(last.error).toMatch(/changed since you approved it/);
    });
    expect(harness.instances).toHaveLength(0);
  });
});

describe('an activated extension that fails', () => {
  async function activePlugin() {
    const folder = path.join(source, 'memory');
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: 'memory-plugin', version: '1.0.0' }));
    writeFileSync(path.join(folder, 'index.ts'), 'export default function () {}\n');
    const imported = await library.importPath('plugin', folder);
    store.setResourceActive(conversationId, imported.id, true);
    return path.join(resourceDirectory(directory, { id: imported.id, kind: 'plugin' }), 'index.ts');
  }

  it('is named, with Pi’s reason, when Pi cannot load it', async () => {
    const entry = await activePlugin();
    harness.state.nextStartError = Object.assign(new Error(`Pi could not load the extension ${entry}: Cannot find module 'x'`), {
      name: 'PiExtensionLoadError', extensionPath: entry, reason: "Cannot find module 'x'",
    });
    await service.send(conversationId, 'salut').catch(() => {});
    await vi.waitFor(() => expect(store.listMessages(conversationId).at(-1)?.status).toBe('error'));
    expect(store.listMessages(conversationId).at(-1)?.error).toBe(
      "The extension “memory-plugin” could not load, so this chat could not start: Cannot find module 'x'. Turn it off for this chat from the composer’s Extensions menu, or fix it and re-import it in Settings › Extensions.");
  });

  it('does not end the reply when its handler throws, and the warning says which one it was', async () => {
    const entry = await activePlugin();
    const pending = service.send(conversationId, 'salut');
    await vi.waitFor(() => expect(harness.instances.at(-1)?.prompt).toHaveBeenCalled());
    const pi = harness.instances.at(-1)!;
    const event = { type: 'extension_error', extensionPath: entry, event: 'context', error: 'recall failed' } as unknown as PiRpcEvent;
    pi.emit(event);
    expect((event as unknown as { error: string }).error).toBe('memory-plugin: recall failed');
    pi.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } as unknown as PiRpcEvent);
    pi.emit({ type: 'agent_settled' } as PiRpcEvent);
    await pending.catch(() => {});
    expect(store.listMessages(conversationId).at(-1)).toMatchObject({ status: 'complete', content: 'done' });
  });

  it('still ends the reply when Hello’s own tool extension fails', async () => {
    const pending = service.send(conversationId, 'salut');
    await vi.waitFor(() => expect(harness.instances.at(-1)?.prompt).toHaveBeenCalled());
    const pi = harness.instances.at(-1)!;
    const own = [...(pi.options.args ?? [])].find(value => /pi-extension\.js$/.test(value))!;
    pi.emit({ type: 'extension_error', extensionPath: own, event: 'tool_call', error: 'bridge gone' } as unknown as PiRpcEvent);
    await pending.catch(() => {});
    await vi.waitFor(() => expect(store.listMessages(conversationId).at(-1)?.status).toBe('error'));
  });
});

