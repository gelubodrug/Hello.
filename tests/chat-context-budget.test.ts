import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { preparePiLaunch } from '../src/main/chat/pi-session';
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
    bridgeEnv: {}, requestTimeoutMs: 1000, chatMode: 'chat',
  });
  const path = join(dataDir, 'pi-chat');
  const dir = join(path, (await import('node:fs')).readdirSync(path)[0], 'agent');
  const settingsFile = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')) as
    { compaction: { reserveTokens: number; keepRecentTokens: number } };
  const models = JSON.parse(await readFile(join(dir, 'models.json'), 'utf8')) as
    { providers: { hello: { models: Array<{ contextWindow: number }> } } };
  return { ...settingsFile, told: models.providers.hello.models[0].contextWindow };
}

describe('how much room Pi is told to keep', () => {
  it('keeps a large window compacting well before the provider sees it', async () => {
    // Pi decides when to compact from its own characters/4 estimate, which read
    // 28.3k for 41,349 real tokens in this app's traffic. A flat 16k reserve on
    // a 512,000 window means it compacts at an estimated 475k — past 700k in
    // fact, which is where the turn actually died.
    const big = await launch(512_000, 32_768);
    expect(big.compaction.reserveTokens).toBe(230_400);
    expect(512_000 - big.compaction.reserveTokens).toBeLessThan(300_000);
  });

  it('hands the runtime a smaller window once the provider says the estimate ran low', async () => {
    // The provider counts; the runtime guesses. When a finished turn reported
    // more input than the model holds, the guess was low and the runtime never
    // compacted — so it is told a smaller number rather than argued with.
    const scaled = await launch(512_000, 32_768, 0.7);
    expect(scaled.told).toBe(358_400);
    expect(scaled.compaction.reserveTokens).toBe(161_280);
    // Never below the profile's own minimum, however often it overflows.
    const floored = await launch(32_768, 4_096, 0.2);
    expect(floored.told).toBe(20_480);
  });

  it('leaves a small window exactly as it was', async () => {
    // A server loaded with 32k has no estimator headroom to give away.
    const small = await launch(32_768, 4_096);
    expect(small.compaction.reserveTokens).toBe(16_384);
  });
});

describe('the chat’s folder, as the extensions see it', () => {
  async function environment(folder: string | null) {
    const dataDir = await mkdtemp(join(tmpdir(), 'hello-folder-'));
    dirs.push(dataDir);
    const settings = { endpointUrl: 'https://example.test/v1', model: 'm', apiKeySet: false, systemPrompt: 'x', temperature: 0.7, connections: [], contextWindow: 32768, maxOutputTokens: 1024 } as AppSettings;
    return preparePiLaunch({ settings, dataDir, conversationId: 'chat', history: [], systemPrompt: 'x', key: '', bridgeEnv: {}, requestTimeoutMs: 1000, chatMode: 'chat', folder });
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
    await preparePiLaunch({ settings, dataDir, conversationId: 'chat', history: [], systemPrompt: 'x', key: '', bridgeEnv: {}, requestTimeoutMs: 1000, chatMode: 'chat' });
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
    await preparePiLaunch({ settings, dataDir, conversationId: 'chat', history: [], systemPrompt: 'x', key: '', bridgeEnv: {}, requestTimeoutMs: 1000, chatMode: 'chat' });
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
