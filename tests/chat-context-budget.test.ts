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
