import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { modelVision } from '../src/main/chat/model-vision';
import { preparePiLaunch, piConversationDir } from '../src/main/chat/pi-session';

describe('published model vision', () => {
  it('uses input modalities, not output images or a name that looks multimodal', () => {
    expect(modelVision({ architecture: { input_modalities: ['text', 'image'] } })).toBe(true);
    expect(modelVision({ architecture: { input_modalities: ['text'], output_modalities: ['image'] } })).toBe(false);
    expect(modelVision({ id: 'vision-model' })).toBeUndefined();
    expect(modelVision({ architecture: { input_modalities: null } })).toBeUndefined();
  });
  it('reads LM Studio capability and model-type metadata', () => {
    expect(modelVision({ type: 'vlm' })).toBe(true);
    expect(modelVision({ type: 'llm' })).toBe(false);
    expect(modelVision({ capabilities: { vision: false } })).toBe(false);
    expect(modelVision({ capabilities: ['vision', 'tool_use'] })).toBe(true);
    expect(modelVision({ capabilities: ['tool_use'] })).toBe(false);
  });
  it('writes per-model Pi input, keeping unknown subagent capability independent', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hello-vision-'));
    try {
      await preparePiLaunch({ dataDir, conversationId: 'chat', settings: {
        endpointUrl: 'https://example.test/v1', model: 'text', subagentModel: 'unknown',
        apiKeySet: false, systemPrompt: '', temperature: 0.7, connections: [],
      }, key: '', systemPrompt: '', history: [], bridgeEnv: {}, requestTimeoutMs: 1000, chatMode: 'chat', vision: false });
      const written = JSON.parse(await readFile(join(piConversationDir(dataDir, 'chat'), 'agent/models.json'), 'utf8'));
      expect(written.providers.hello.models.map((model: { input: string[] }) => model.input)).toEqual([['text'], ['text', 'image']]);
    } finally { await rm(dataDir, { recursive: true, force: true }); }
  });
});
