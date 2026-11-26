import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { preparePiLaunch } from '../src/main/chat/pi-session';
import { reasoningReach } from '../src/shared/reasoning';
import type { AppSettings } from '../src/shared/types';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))); dirs.length = 0; });

async function launch(contextWindow: number, maxOutputTokens: number, contextScale?: number) {
  const dataDir = await mkdtemp(join(tmpdir(), 'hello-budget-'));
  dirs.push(dataDir);
  const settings = {
    endpointUrl: 'https://example.test/v1', model: 'm', apiKeySet: false,
    systemPrompt: 'x', temperature: 0.7, connections: [], contextWindow, maxOutputTokens,
    ...(contextScale === undefined ? {} : { contextScale }),
  } as AppSettings;
  await preparePiLaunch({
    settings, dataDir, conversationId: 'chat', history: [], systemPrompt: 'x', key: '',
    bridgeEnv: {}, requestTimeoutMs: 1000,
  });
  const path = join(dataDir, 'pi-chat');
  const dir = join(path, (await import('node:fs')).readdirSync(path)[0], 'agent');
  const settingsFile = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')) as
    { compaction: { reserveTokens: number; keepRecentTokens: number } };
  const models = JSON.parse(await readFile(join(dir, 'models.json'), 'utf8')) as
    { providers: { hello: { models: Array<{ contextWindow: number; maxTokens: number }> } } };
  return { ...settingsFile, told: models.providers.hello.models[0].contextWindow, maxTokens: models.providers.hello.models[0].maxTokens, settings };
}

// User, 26.11: the context in the chat was "calculat aleatoriu… față de pi nativ
// cli; aș vrea… să fie 1:1 cu cli-ul". Hello held 45% of the window free and
// scaled the window down after an overflow; now Pi is handed its own defaults.
describe('how much room Pi is told to keep', () => {
  it('is Pi’s own: the published window, its 16,384 reserve and its 20,000 kept, on any window with room', async () => {
    for (const window of [131_072, 512_000, 1_048_576]) {
      const launched = await launch(window, 32_768);
      expect(launched.told).toBe(window);
      expect(launched.compaction).toMatchObject({ reserveTokens: 16_384, keepRecentTokens: 20_000 });
    }
  });

  it('no longer shrinks the window by what an older Hello learned', async () => {
    expect((await launch(512_000, 32_768, 0.7)).told).toBe(512_000);
    expect((await launch(32_768, 4_096, 0.2)).told).toBe(32_768);
  });

  it('leaves a small window the same reserve, and keeps less than 20,000 only where 20,000 would not fit', async () => {
    const small = await launch(32_768, 4_096);
    expect(small.compaction.reserveTokens).toBe(16_384);
    // 16,384 usable: a summary that kept 20,000 would be over the line at once.
    expect(small.compaction.keepRecentTokens).toBe(5_461);
  });

  /**
   * An output budget is a ceiling for one answer, not a floor held free for
   * every turn (24.11): saved as 32,768 on a 65,536 window it is a quarter of
   * the window for this launch, and the reserve stays Pi's.
   */
  it('does not let an output budget hold back the window', async () => {
    const theirs = await launch(65_536, 32_768);
    expect(theirs.maxTokens).toBe(16_384);
    expect(theirs.compaction.reserveTokens).toBe(16_384);
    expect(theirs.told - theirs.compaction.reserveTokens).toBe(49_152);
    expect(theirs.compaction.keepRecentTokens).toBe(16_384);
    expect(theirs.compaction.keepRecentTokens).toBeLessThan((theirs.told - theirs.compaction.reserveTokens) / 2);
    // The person's setting is never rewritten; only this launch is shortened.
    expect(theirs.settings.maxOutputTokens).toBe(32_768);
  });

  it('answers shorter rather than refusing to start on a small window', async () => {
    // Saved as 32,768 / 16,384 — a pair Settings accepts (nativ#684).
    const small = await launch(32_768, 16_384);
    expect(small.told).toBe(32_768);
    expect(small.maxTokens).toBe(8_192);
    expect(small.told - small.compaction.reserveTokens).toBeGreaterThanOrEqual(4096);
    expect(small.settings.maxOutputTokens).toBe(16_384);
    // A pair that fits keeps its output budget whole.
    expect((await launch(512_000, 32_768)).maxTokens).toBe(32_768);
  });
});

describe('the chat’s folder, as the extensions see it', () => {
  async function environment(folder: string | null) {
    const dataDir = await mkdtemp(join(tmpdir(), 'hello-folder-'));
    dirs.push(dataDir);
    const settings = { endpointUrl: 'https://example.test/v1', model: 'm', apiKeySet: false, systemPrompt: 'x', temperature: 0.7, connections: [], contextWindow: 32768, maxOutputTokens: 1024 } as AppSettings;
    return preparePiLaunch({ settings, dataDir, conversationId: 'chat', history: [], systemPrompt: 'x', key: '', bridgeEnv: {}, requestTimeoutMs: 1000, folder });
  }

  it('is handed to the extensions, while Pi itself starts in its private directory', async () => {
    const launch = await environment('/Users/someone/project');
    expect(launch.env.HELLO_CHAT_FOLDER).toBe('/Users/someone/project');
    expect(launch.cwd).toMatch(/pi-chat\/[a-f0-9]{64}\/work$/);
  });

  it('is absent without a folder, and never relative', async () => {
    expect((await environment(null)).env.HELLO_CHAT_FOLDER).toBeUndefined();
    expect((await environment('project')).env.HELLO_CHAT_FOLDER).toBeUndefined();
  });
});

// The model plugins' subagents run on (user, 29.09), on the chat's connection.
describe('the model for subagents', () => {
  async function written(subagentModel?: string) {
    const dataDir = await mkdtemp(join(tmpdir(), 'hello-subagents-'));
    dirs.push(dataDir);
    const settings = { endpointUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-27b', apiKeySet: false, systemPrompt: 'x', temperature: 0.7, connections: [], contextWindow: 32768, maxOutputTokens: 1024, ...(subagentModel === undefined ? {} : { subagentModel }) } as AppSettings;
    await preparePiLaunch({ settings, dataDir, conversationId: 'chat', history: [], systemPrompt: 'x', key: '', bridgeEnv: {}, requestTimeoutMs: 1000 });
    const root = join(dataDir, 'pi-chat');
    const dir = join(root, (await import('node:fs')).readdirSync(root)[0], 'agent');
    return {
      settings: JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')) as { subagents?: { defaultModel: string } },
      models: (JSON.parse(await readFile(join(dir, 'models.json'), 'utf8')) as { providers: { hello: { models: Array<{ id: string }> } } }).providers.hello.models.map(model => model.id),
    };
  }

  it('is pi-subagents’ default, as a second model of the same provider', async () => {
    const launch = await written('google/gemini-3-flash:free');
    expect(launch.models).toEqual(['qwen/qwen3-27b', 'google/gemini-3-flash:free']);
    expect(launch.settings.subagents).toEqual({ defaultModel: 'hello/google/gemini-3-flash:free' });
  });

  // A local chat model with its subagents on a provider (user, 16.11).
  it('can be on another kept connection: a second provider for Pi, with that connection’s address, dialect and key', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hello-subagents-'));
    dirs.push(dataDir);
    const settings = { endpointUrl: 'http://127.0.0.1:8000/v1', model: 'qwen3.8-flash-next', apiKeySet: false, systemPrompt: 'x', temperature: 0.7, connections: [],
      contextWindow: 262144, maxOutputTokens: 4096, subagentModel: 'google/gemini-3-flash', subagentEndpointUrl: 'https://openrouter.ai/api/v1' } as AppSettings;
    const launch = await preparePiLaunch({ settings, dataDir, conversationId: 'chat', history: [], systemPrompt: 'x', key: '', subagentKey: 'sk-or-secret', bridgeEnv: {}, requestTimeoutMs: 1000,
      subagentLimits: { contextWindow: 1_000_000, maxOutputTokens: 8192 } });
    const root = join(dataDir, 'pi-chat');
    const dir = join(root, (await import('node:fs')).readdirSync(root)[0], 'agent');
    const models = JSON.parse(await readFile(join(dir, 'models.json'), 'utf8')) as { providers: Record<string, { baseUrl: string; apiKey: string; models: Array<{ id: string; contextWindow: number; compat: Record<string, unknown> }> }> };
    expect(Object.keys(models.providers)).toEqual(['hello', 'hello-subagents']);
    // The chat's provider holds only the chat's model; the key is named, never written.
    expect(models.providers.hello.models.map(model => model.id)).toEqual(['qwen3.8-flash-next']);
    expect(models.providers['hello-subagents']).toMatchObject({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: '$HELLO_PI_SUBAGENT_API_KEY' });
    expect(models.providers['hello-subagents'].models).toMatchObject([{ id: 'google/gemini-3-flash', contextWindow: 1_000_000, compat: { thinkingFormat: 'openrouter' } }]);
    expect(models.providers.hello.models[0].compat).not.toHaveProperty('thinkingFormat', 'openrouter');
    expect(JSON.stringify(models)).not.toContain('sk-or-secret');
    expect((JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')) as { subagents: unknown }).subagents).toEqual({ defaultModel: 'hello-subagents/google/gemini-3-flash' });
    expect(launch.env.HELLO_PI_SUBAGENT_API_KEY).toBe('sk-or-secret');
    // The same model id as the chat's is still a different model when it is on another server.
    const same = await preparePiLaunch({ settings: { ...settings, subagentModel: 'qwen3.8-flash-next' }, dataDir, conversationId: 'chat-2', history: [], systemPrompt: 'x', key: '', bridgeEnv: {}, requestTimeoutMs: 1000 });
    expect(same.env.HELLO_PI_SUBAGENT_API_KEY).toBe('hello-local');
    // On the chat's own connection nothing of this appears.
    const here = await written('google/gemini-3-flash:free');
    expect(here.settings.subagents).toEqual({ defaultModel: 'hello/google/gemini-3-flash:free' });
  });

  it('leaves the chat’s own model to them when it is unset or the same', async () => {
    for (const unset of [undefined, '', '  ', 'qwen/qwen3-27b']) {
      const launch = await written(unset);
      expect(launch.models).toEqual(['qwen/qwen3-27b']);
      expect(launch.settings.subagents).toBeUndefined();
    }
  });
});

// Reasoning Off never reached a local Qwen server on Auto (user, 29.09): the
// model thought 157 s before one click. Qwen's thinking switch goes with it.
describe('how thinking is switched for the model', () => {
  async function compat(endpointUrl: string, model: string, modelCompatibility?: AppSettings['modelCompatibility']) {
    const dataDir = await mkdtemp(join(tmpdir(), 'hello-thinking-'));
    dirs.push(dataDir);
    const settings = { endpointUrl, model, apiKeySet: false, systemPrompt: 'x', temperature: 0.7, connections: [], contextWindow: 32768, maxOutputTokens: 1024, reasoningEffort: 'off', ...(modelCompatibility ? { modelCompatibility } : {}) } as AppSettings;
    await preparePiLaunch({ settings, dataDir, conversationId: 'chat', history: [], systemPrompt: 'x', key: '', bridgeEnv: {}, requestTimeoutMs: 1000 });
    const root = join(dataDir, 'pi-chat');
    const dir = join(root, (await import('node:fs')).readdirSync(root)[0], 'agent');
    const [described] = (JSON.parse(await readFile(join(dir, 'models.json'), 'utf8')) as { providers: { hello: { models: Array<{ reasoning: boolean; compat: { thinkingFormat?: string } }> } } }).providers.hello.models;
    return { reasoning: described.reasoning, thinkingFormat: described.compat.thinkingFormat };
  }

  it('sends Qwen’s switch to a Qwen model on a server of the person’s own', async () => {
    for (const endpoint of ['http://127.0.0.1:18090/v1', 'http://localhost:8000/v1', 'http://192.168.1.20:8080/v1', 'http://[::1]:8000/v1', 'http://studio.local:8000/v1'])
      expect(await compat(endpoint, 'mlx-community/Qwen3.8-27B-4bit')).toEqual({ reasoning: true, thinkingFormat: 'qwen-chat-template' });
  });

  it('leaves other models, remote servers and an explicit choice as they were', async () => {
    expect(await compat('http://127.0.0.1:18090/v1', 'gemma-4-31b')).toEqual({ reasoning: false, thinkingFormat: undefined });
    expect(await compat('https://api.example.test/v1', 'qwen3-27b')).toEqual({ reasoning: false, thinkingFormat: undefined });
    expect(await compat('http://127.0.0.1:18090/v1', 'qwen3-27b', 'openai')).toEqual({ reasoning: false, thinkingFormat: undefined });
    expect(await compat('https://api.example.test/v1', 'any-model', 'qwen-chat-template')).toEqual({ reasoning: true, thinkingFormat: 'qwen-chat-template' });
  });
});

/**
 * Low/Medium/High reached MTPLX and Kimi's endpoint only as "thinking on", and
 * Settings said nothing about it. Pi sends the level only where the launch
 * config declares supportsReasoningEffort, or where the provider's own thinking
 * format carries it (OpenRouter's `reasoning: { effort }`); with neither, the
 * request has no reasoning field at all, while `reasoning: true` still makes
 * the chat look as if thinking were on. reasoningReach() is what Settings shows
 * under the control, so it has to say exactly what the launch config does.
 */
describe('how far Low/Medium/High reaches', () => {
  async function declared(endpointUrl: string, model: string, modelCompatibility?: AppSettings['modelCompatibility']) {
    const dataDir = await mkdtemp(join(tmpdir(), 'hello-effort-'));
    dirs.push(dataDir);
    const settings = { endpointUrl, model, apiKeySet: false, systemPrompt: 'x', temperature: 0.7, connections: [], contextWindow: 32768, maxOutputTokens: 1024, reasoningEffort: 'high', ...(modelCompatibility ? { modelCompatibility } : {}) } as AppSettings;
    await preparePiLaunch({ settings, dataDir, conversationId: 'chat', history: [], systemPrompt: 'x', key: '', bridgeEnv: {}, requestTimeoutMs: 1000 });
    const root = join(dataDir, 'pi-chat');
    const dir = join(root, (await import('node:fs')).readdirSync(root)[0], 'agent');
    const [described] = (JSON.parse(await readFile(join(dir, 'models.json'), 'utf8')) as {
      providers: { hello: { models: Array<{ reasoning: boolean; compat: { supportsReasoningEffort: boolean; thinkingFormat?: string } }> } };
    }).providers.hello.models;
    // What Pi's request builder does with those two: the level travels when the
    // flag is declared, or inside OpenRouter's own thinking format.
    const sends = described.compat.supportsReasoningEffort || described.compat.thinkingFormat === 'openrouter'
      ? 'level'
      : described.compat.thinkingFormat ? 'switch' : 'nothing';
    return { sends, reach: reasoningReach(settings), reasoning: described.reasoning };
  }

  it('agrees with the launch config, connection by connection', async () => {
    expect(await declared('https://api.openai.com/v1', 'gpt-5')).toMatchObject({ sends: 'level', reach: 'level' });
    expect(await declared('https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-4')).toMatchObject({ sends: 'level', reach: 'level' });
    expect(await declared('https://api.deepseek.com/v1', 'deepseek-chat')).toMatchObject({ sends: 'switch', reach: 'switch' });
    expect(await declared('http://127.0.0.1:18090/v1', 'mlx-community/Qwen3.8-27B-4bit')).toMatchObject({ sends: 'switch', reach: 'switch' });
    expect(await declared('https://api.example.test/v1', 'any-model', 'qwen-chat-template')).toMatchObject({ sends: 'switch', reach: 'switch' });
    // MTPLX, Kimi's endpoint, any other OpenAI-compatible server on Automatic.
    expect(await declared('http://127.0.0.1:18090/v1', 'kimi-k2')).toMatchObject({ sends: 'nothing', reach: 'nothing', reasoning: true });
    // The remedy Settings now names.
    expect(await declared('http://127.0.0.1:18090/v1', 'kimi-k2', 'openai')).toMatchObject({ sends: 'level', reach: 'level' });
  });

  it('needs no server to answer for a connection', () => {
    expect(reasoningReach({ endpointUrl: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5' })).toBe('level');
    expect(reasoningReach({ endpointUrl: 'not a url', model: 'm' })).toBe('nothing');
    expect(reasoningReach({ endpointUrl: 'https://openrouter.ai/api/v1', model: 'm', modelCompatibility: 'openai' })).toBe('level');
    expect(reasoningReach({ endpointUrl: 'https://api.deepseek.com/v1', model: 'm', modelCompatibility: 'openai' })).toBe('level');
  });
});
