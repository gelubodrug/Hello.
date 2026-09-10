import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, link, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppSettings } from '../../shared/types';
import { normalizeEndpoint } from '../data/store';

export interface ImportedChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  isError?: boolean;
}

/**
 * Electron and Node resolve the package's export map directly. A test runner
 * that rewrites `import.meta` falls back to the installed file, so the command
 * a test inspects is the one production launches. The package is ESM-only with
 * import-condition exports, so `require.resolve` cannot be the fallback.
 */
export function piRpcEntry(): string {
  const resolver = (import.meta as ImportMeta & { resolve?(specifier: string): string }).resolve;
  if (typeof resolver === 'function')
    return fileURLToPath(resolver('@earendil-works/pi-coding-agent/rpc-entry'));
  const suffix = join('node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'rpc-entry.js');
  for (let directory = dirname(fileURLToPath(import.meta.url)); ; directory = dirname(directory)) {
    const candidate = join(directory, suffix);
    if (existsSync(candidate)) return candidate;
    if (dirname(directory) === directory) break;
  }
  throw new Error('The bundled Pi runtime could not be located next to this build.');
}

export function piConversationDir(dataDir: string, conversationId: string): string {
  return join(dataDir, 'pi-chat', createHash('sha256').update(conversationId).digest('hex'));
}

/** Import existing Hello history once. Pi owns subsequent append/compaction. */
export async function seedPiSession(file: string, cwd: string, history: ImportedChatMessage[]): Promise<void> {
  try { await access(file); return; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const timestamp = Date.now();
  const lines: unknown[] = [{
    type: 'session', version: 3, id: randomUUID(), timestamp: new Date(timestamp).toISOString(), cwd,
  }];
  let parentId: string | null = null;
  const tools = new Map<string, string>();
  for (const item of history) {
    if (item.role === 'system') continue;
    let message: Record<string, unknown>;
    if (item.role === 'user') {
      message = { role: 'user', content: [{ type: 'text', text: item.content ?? '' }], timestamp };
    } else if (item.role === 'tool') {
      message = {
        role: 'toolResult', toolCallId: item.tool_call_id, toolName: tools.get(item.tool_call_id ?? '') ?? 'unknown',
        content: [{ type: 'text', text: item.content ?? '' }], isError: item.isError ?? false, timestamp,
      };
    } else {
      const content: unknown[] = item.content ? [{ type: 'text', text: item.content }] : [];
      for (const call of item.tool_calls ?? []) {
        let args: unknown;
        try { args = JSON.parse(call.function.arguments); } catch { args = {}; }
        content.push({ type: 'toolCall', id: call.id, name: call.function.name, arguments: args });
        tools.set(call.id, call.function.name);
      }
      if (!content.length) continue;
      message = {
        role: 'assistant', content, api: 'openai-completions', provider: 'hello-history', model: 'imported',
        // Legacy turn totals stay in SQLite. Zero means unknown to Pi's estimator,
        // which falls back to estimating the imported text, not a fictitious bill.
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: item.tool_calls?.length ? 'toolUse' : 'stop', timestamp,
      };
    }
    const id = randomUUID().replaceAll('-', '').slice(0, 16);
    lines.push({ type: 'message', id, parentId, timestamp: new Date(timestamp).toISOString(), message });
    parentId = id;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, lines.map(line => JSON.stringify(line)).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    // Atomic create without overwriting an already established Pi session.
    try { await link(temporary, file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally { await unlink(temporary).catch(() => {}); }
}

export interface PiLaunchConfiguration {
  dataDir: string;
  conversationId: string;
  settings: AppSettings;
  key: string;
  systemPrompt: string;
  history: ImportedChatMessage[];
  bridgeEnv: Record<string, string>;
  requestTimeoutMs: number;
  chatMode: 'chat' | 'coder';
  /** Verified skill folders activated for this conversation. */
  skillPaths?: string[];
  /** Verified Pi extension entry files from activated plugins. */
  extensionPaths?: string[];
  promptPaths?: string[];
}

/** Isolated resources and credentials; no global Pi config or project discovery. */
export async function preparePiLaunch(options: PiLaunchConfiguration) {
  const { settings } = options;
  const root = piConversationDir(options.dataDir, options.conversationId);
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'work');
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const sessionFile = join(root, 'session.jsonl');
  await seedPiSession(sessionFile, cwd, options.history);
  const contextWindow = settings.contextWindow ?? 32768;
  const maxTokens = settings.maxOutputTokens ?? 4096;
  // Pi also keeps a 4,096-token provider-side safety margin. Preserve its
  // native 16k reserve, increasing it for larger configured output budgets.
  const reserveTokens = Math.max(16384, maxTokens + 4096);
  if (!Number.isInteger(contextWindow) || !Number.isInteger(maxTokens) ||
      maxTokens < 512 || contextWindow - reserveTokens < 4096)
    throw new Error('This context/output combination leaves too little room for Pi and the Hello tools. Increase the server context and match it in Settings, or lower the output budget.');
  const baseUrl = normalizeEndpoint(settings.endpointUrl).replace(/\/chat\/completions$/, '');
  const hostname = new URL(baseUrl).hostname;
  const compatibility = settings.modelCompatibility ?? 'auto';
  const openai = hostname === 'api.openai.com';
  const openrouter = compatibility === 'auto' && hostname === 'openrouter.ai';
  const deepseek = compatibility === 'auto' && hostname === 'api.deepseek.com';
  const qwen = compatibility === 'qwen-chat-template';
  const effort = settings.reasoningEffort ?? 'off';
  const compat = {
    supportsStore: false,
    supportsDeveloperRole: openai,
    supportsReasoningEffort: !qwen && !deepseek && !openrouter && (openai || compatibility === 'openai'),
    maxTokensField: openai ? 'max_completion_tokens' : 'max_tokens',
    ...(openrouter ? { thinkingFormat: 'openrouter' } : {}),
    ...(deepseek ? { thinkingFormat: 'deepseek' } : {}),
    ...(qwen ? { thinkingFormat: 'qwen-chat-template' } : {}),
  };
  const models = { providers: { hello: {
    baseUrl, api: 'openai-completions', apiKey: '$HELLO_PI_API_KEY',
    // This custom endpoint descriptor must preserve submitted image blocks.
    // The selected endpoint/model still decides whether vision is supported;
    // declaring text-only here would silently discard user attachments in Pi.
    models: [{ id: settings.model, name: settings.model, input: ['text', 'image'],
      reasoning: effort !== 'off' || qwen || deepseek, contextWindow, maxTokens, compat,
      // Keep the configured temperature except families that reject it.
      ...(/^(?:o[134](?:-|$)|gpt-5)/i.test(settings.model) ? {} : {
        samplingParams: { temperature: settings.temperature },
      }),
    }],
  } } };
  const piSettings = {
    defaultProvider: 'hello', defaultModel: settings.model, defaultThinkingLevel: effort,
    quietStartup: true, enableInstallTelemetry: false, enableAnalytics: false,
    // Discovery stays off: only paths Hello passes explicitly are ever loaded.
    packages: [], extensions: [], skills: [], prompts: [],
    // `/skill:name` expansion for skills the human activated in this chat.
    enableSkillCommands: true,
    compaction: { enabled: true, reserveTokens,
      keepRecentTokens: Math.min(20000, Math.floor(contextWindow / 4), Math.floor((contextWindow - reserveTokens) / 2)) },
    retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000,
      provider: { maxRetries: 0, timeoutMs: options.requestTimeoutMs, maxRetryDelayMs: 60000 } },
    httpIdleTimeoutMs: options.requestTimeoutMs,
  };
  const promptFile = join(root, 'system-prompt.md');
  await Promise.all([
    writeFile(join(agentDir, 'models.json'), JSON.stringify(models, null, 2), { mode: 0o600 }),
    writeFile(join(agentDir, 'settings.json'), JSON.stringify(piSettings, null, 2), { mode: 0o600 }),
    writeFile(promptFile, options.systemPrompt, { mode: 0o600 }),
  ]);
  const env: NodeJS.ProcessEnv = {};
  // Do not inherit other provider keys, Pi config or code-injection environment.
  for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot', 'WINDIR', 'USERPROFILE']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, options.bridgeEnv, {
    ELECTRON_RUN_AS_NODE: '1', PI_CODING_AGENT_DIR: agentDir,
    PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1', HELLO_PI_API_KEY: options.key || 'hello-local',
  });
  return {
    command: process.execPath, cwd, env, sessionFile,
    args: [
      piRpcEntry(),
      '--offline', '-nc', '-ne', '-ns', '-np', '--no-themes', '--no-builtin-tools',
      '--exclude-tools', 'read,bash,edit,write,grep,find,ls,powershell',
      '-e', join(dirname(fileURLToPath(import.meta.url)), 'pi-extension.js'),
      // Activated plugin extensions load beside Hello's own, never instead of it.
      ...(options.extensionPaths ?? []).flatMap(file => ['-e', file]),
      // `--skill` stays additive under `-ns`, so nothing else on disk is discovered.
      ...(options.skillPaths ?? []).flatMap(directory => ['--skill', directory]),
      ...(options.promptPaths ?? []).flatMap(file => ['--prompt-template', file]),
      '--session', sessionFile, '--provider', 'hello', '--model', `hello/${settings.model}`,
      '--session-dir', root,
      '--thinking', effort, options.chatMode === 'coder' ? '--append-system-prompt' : '--system-prompt', promptFile,
    ],
  };
}
