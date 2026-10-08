import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, link, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppSettings } from '../../shared/types';
import { normalizeEndpoint } from '../data/store';
import { usesQwenThinkingSwitch } from './qwen-thinking';

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

/** Hello's own Pi extension, bundled beside main: the bridge to Hello's tools. */
export function helloPiExtensionPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'pi-extension.js');
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
  /** The chat's attached folder, which extensions see as their working directory. */
  folder?: string | null;
  promptPaths?: string[];
  /** The Pi to start: an update installed from the sidebar. Absent, the bundled one. */
  piEntry?: string;
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
  // What the model holds, and what the runtime is told it holds. Pi decides
  // when to compact from its own characters/4 estimate; when the provider's
  // reported usage shows that estimate ran low, main hands it a smaller number
  // rather than arguing with it. Never below the profile's own minimum.
  const published = settings.contextWindow ?? 32768;
  const contextWindow = Math.max(20480, Math.floor(published * (settings.contextScale ?? 1)));
  // The output budget is what the person saved, unless the window main hands
  // the runtime is now too small for it: a learned scale shrinks the window
  // behind their back, and a chat that answers shorter beats one that refuses
  // to start (nativ#684). The setting itself is never rewritten. 8,192 = Pi's
  // 4,096 provider-side margin plus the 4,096 the profile needs to work in.
  const maxTokens = Math.min(settings.maxOutputTokens ?? 4096, contextWindow - 8192);
  // Pi also keeps a 4,096-token provider-side safety margin. Preserve its
  // native 16k reserve, increasing it for larger configured output budgets.
  //
  // And keep a proportion of a large window free, because Pi decides when to
  // compact from its own estimate of characters/4, which undercounts code and
  // non-Latin text badly: measured against this app's traffic it read 28.3k for
  // 41,349 real tokens and 28.7k for 56,658 — low by 1.5 to 2 times. On a
  // 512,000-token window a flat 16k reserve means it would compact at an
  // estimated 475k, which is past 700k in fact, and the turn dies at the
  // provider instead. A small window keeps its old behaviour untouched.
  const reserveTokens = Math.max(16384, maxTokens + 4096, Math.floor(contextWindow * 0.45));
  if (!Number.isInteger(contextWindow) || !Number.isInteger(maxTokens) ||
      maxTokens < 512 || contextWindow - reserveTokens < 4096)
    throw new Error('This context/output combination leaves too little room for Pi and the Hello tools. Increase the server context and match it in Settings, or lower the output budget.');
  const baseUrl = normalizeEndpoint(settings.endpointUrl).replace(/\/chat\/completions$/, '');
  const hostname = new URL(baseUrl).hostname;
  const compatibility = settings.modelCompatibility ?? 'auto';
  const openai = hostname === 'api.openai.com';
  const openrouter = compatibility === 'auto' && hostname === 'openrouter.ai';
  const deepseek = compatibility === 'auto' && hostname === 'api.deepseek.com';
  // Auto, for a Qwen model on a server of the person's own: Qwen's thinking
  // switch, so Reasoning Off reaches the server (qwen-thinking.ts).
  const qwenFor = (id: string) => usesQwenThinkingSwitch(baseUrl, id, compatibility);
  const effort = settings.reasoningEffort ?? 'off';
  const compatFor = (id: string) => {
    const qwen = qwenFor(id);
    return {
      supportsStore: false,
      supportsDeveloperRole: openai,
      supportsReasoningEffort: !qwen && !deepseek && !openrouter && (openai || compatibility === 'openai'),
      maxTokensField: openai ? 'max_completion_tokens' : 'max_tokens',
      ...(openrouter ? { thinkingFormat: 'openrouter' } : {}),
      ...(deepseek ? { thinkingFormat: 'deepseek' } : {}),
      ...(qwen ? { thinkingFormat: 'qwen-chat-template' } : {}),
    };
  };
  // This custom endpoint descriptor must preserve submitted image blocks.
  // The selected endpoint/model still decides whether vision is supported;
  // declaring text-only here would silently discard user attachments in Pi.
  const describe = (id: string) => ({ id, name: id, input: ['text', 'image'],
    reasoning: effort !== 'off' || qwenFor(id) || deepseek, contextWindow, maxTokens, compat: compatFor(id),
    // Keep the configured temperature except families that reject it.
    ...(/^(?:o[134](?:-|$)|gpt-5)/i.test(id) ? {} : {
      samplingParams: { temperature: settings.temperature },
    }),
  });
  // The model plugins' subagents run on (user, 29.09), on this same
  // connection: a second model of the same provider, which pi-subagents takes
  // as its default. Its children read this folder too.
  const subagentModel = settings.subagentModel?.trim() && settings.subagentModel.trim() !== settings.model ? settings.subagentModel.trim() : undefined;
  const models = { providers: { hello: {
    baseUrl, api: 'openai-completions', apiKey: '$HELLO_PI_API_KEY',
    models: [describe(settings.model), ...(subagentModel ? [describe(subagentModel)] : [])],
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
    // pi-subagents: provider/model, which wins exactly.
    ...(subagentModel ? { subagents: { defaultModel: `hello/${subagentModel}` } } : {}),
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
    // Pi itself starts in the private directory above, where it reads its
    // settings and keeps the session: a folder's own .pi files never load.
    // Hello's extension, loaded first, moves the process into the folder, so
    // the extensions a person activated see the project the way they would
    // if Pi ran in it (a memory plugin scopes by its git remote).
    ...(options.folder && isAbsolute(options.folder) ? { HELLO_CHAT_FOLDER: options.folder } : {}),
  });
  return {
    command: process.execPath, cwd, env, sessionFile,
    args: [
      options.piEntry ?? piRpcEntry(),
      '--offline', '-nc', '-ne', '-ns', '-np', '--no-themes', '--no-builtin-tools',
      '--exclude-tools', 'read,bash,edit,write,grep,find,ls,powershell',
      '-e', helloPiExtensionPath(),
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
