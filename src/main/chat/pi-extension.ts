// A headless Pi extension, adapted to Hello's existing tool host.
// Bundle this entry separately; it runs inside the Pi child, never in Electron's
// renderer. No direct filesystem, command, browser or orchestrator tools here.
import type { ExtensionAPI, ToolDefinition as PiToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiBridgeContextResponse, PiBridgeExecuteRequest } from './pi-tool-bridge';
import type { ToolDefinition } from './tools';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { readToolOutput } from './tool-output';
import {
  activeToolNames, firstSentence, matchGroups, pluginToolGroups, toolsFindDescription, TOOLS_FIND,
  type ToolCatalog, type ToolGroup,
} from './tool-groups';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const CONTEXT_TYPE = 'hello-live-browser-context';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A tool call's arguments as its schema names them, before Pi checks them
 * (user, 30.09: a model sent tab_id for tabId, and every browser call failed
 * validation). A snake_case key its schema knows in camelCase is renamed,
 * unless both came; arguments sent as one JSON string are parsed. Anything
 * else is left for the schema to judge.
 */
export function schemaArguments(args: unknown, parameters: Record<string, unknown>): unknown {
  let value = args;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return args; }
  }
  if (!object(value)) return value;
  const known = object(parameters.properties) ? parameters.properties : {};
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const camel = key.includes('_') ? key.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase()) : key;
    const name = !(key in known) && camel in known && !(camel in value) ? camel : key;
    out[name] = item;
  }
  return out;
}

function rejectChildFetchRedirects(): void {
  const fetcher = globalThis.fetch as typeof globalThis.fetch & { helloRejectRedirects?: boolean };
  if (fetcher.helloRejectRedirects) return;
  // Pi 0.85.1 creates its OpenAI client per request using the current global
  // fetch. Its HTTP dispatcher preserves deliberate overrides installed here.
  // This also protects compaction requests without changing Pi's tool loop.
  const guarded: typeof globalThis.fetch = (input, init) =>
    fetcher.call(globalThis, input, { ...init, redirect: 'error' });
  Object.defineProperty(guarded, 'helloRejectRedirects', { value: true });
  globalThis.fetch = guarded;
}

/**
 * The extensions a person activated in a chat see its folder as their working
 * directory, as they would if Pi ran in the project. Pi itself started in the
 * chat's private directory and keeps its session and settings there; this
 * extension loads before the others, so every one of them starts here.
 */
function enterChatFolder(): void {
  const folder = process.env.HELLO_CHAT_FOLDER;
  if (!folder || !isAbsolute(folder)) return;
  try {
    if (statSync(folder).isDirectory()) process.chdir(folder);
  } catch {
    // A folder that is gone leaves them in the private directory.
  }
}

export default async function helloTools(pi: ExtensionAPI): Promise<void> {
  // A Pi CLI the person opened from Hello (user, 30.09) loads this too, for
  // the connection's tools as its own. That process is the person's: it keeps
  // its folder, its fetch and its context; only the tools are added.
  const cli = process.env.HELLO_PI_EXTENSION_ROLE === 'cli';
  if (!cli) enterChatFolder();
  const address = process.env.HELLO_PI_BRIDGE_URL;
  const token = process.env.HELLO_PI_BRIDGE_TOKEN;
  if (!address || !token || !/^[a-f0-9]{64}$/.test(token))
    throw new Error('Hello tool bridge configuration is missing.');
  const url = new URL(address);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Hello tool bridge must use its private loopback address.');
  // The bridge's own requests refuse redirects either way.
  if (!cli) rejectChildFetchRedirects();

  async function request<T>(
    route: string,
    body?: PiBridgeExecuteRequest,
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason ?? new Error('Hello tool call cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error('Hello tool bridge request timed out.')),
      body ? 30 * 60_000 : 10_000);
    timer.unref();
    try {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      if (encoded !== undefined && Buffer.byteLength(encoded) > MAX_BODY_BYTES)
        throw new Error('Hello tool arguments exceed the bridge size limit.');
      const response = await fetch(new URL(route, url), {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: encoded,
        redirect: 'error',
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Hello tool bridge returned an empty response.');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > MAX_BODY_BYTES) {
            await reader.cancel();
            throw new Error('Hello tool result exceeds the bridge size limit.');
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new Error('Hello tool bridge returned invalid JSON.');
      }
      if (!response.ok) {
        const message = object(payload) && typeof payload.error === 'string'
          ? payload.error : 'Hello tool bridge request failed.';
        throw new Error(message);
      }
      return payload as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  const registered = new Map<string, string>();
  const descriptions = new Map<string, string>();
  // Tools are prompt-context driven: the groups main describes, one group per
  // plugin extension, and which of them the model has loaded in this chat.
  let catalog: ToolCatalog | undefined;
  const loaded = new Set<string>();
  const knownGroups = new Set<string>();
  let findSignature = '';
  // Pi binds its action methods (getAllTools among them) only after every
  // extension has loaded; until session_start only registration is legal.
  let bound = false;

  /** Every tool Pi knows, once it can be asked; plugins register theirs later. */
  function piTools(): ReturnType<ExtensionAPI['getAllTools']> {
    if (!bound || typeof pi.getAllTools !== 'function') return [];
    try { return pi.getAllTools(); } catch { return []; }
  }

  function allGroups(): ToolGroup[] {
    if (!catalog) return [];
    return [...catalog.groups, ...pluginToolGroups(piTools(), catalog.plugins)];
  }

  function describe(name: string): string {
    return descriptions.get(name) ?? piTools().find(tool => tool.name === name)?.description ?? '';
  }

  /** tools_find, re-registered only when the groups it lists change. */
  function registerToolsFind(groups: ToolGroup[]): void {
    const ids = groups.filter(group => !group.core).map(group => group.id);
    const description = toolsFindDescription(groups);
    // No enum: an id this step's schema does not know yet (a group that just
    // arrived) or a bare server name gets the listing back, not a rejected call.
    const parameters = {
      type: 'object',
      additionalProperties: false,
      properties: {
        groups: {
          type: 'array',
          items: { type: 'string' },
          description: 'The groups to load, from the list in this tool’s description.',
        },
        need: { type: 'string', description: 'A few words about the task, when you are not sure which group fits.' },
      },
    };
    const signature = JSON.stringify({ description, parameters });
    if (signature === findSignature) return;
    pi.registerTool({
      name: TOOLS_FIND,
      label: 'tools find',
      description,
      promptSnippet: ids.length ? `Load the tool group for the area of work at hand: ${ids.join(', ')}.` : 'Lists the tool groups this chat has.',
      parameters: parameters as PiToolDefinition['parameters'],
      executionMode: 'sequential',
      async execute(_toolCallId, params) {
        const input = object(params) ? params : {};
        const groups = allGroups();
        const requested = Array.isArray(input.groups) ? input.groups.filter((id): id is string => typeof id === 'string') : [];
        // A bare server or plugin name means its group: `github` is `mcp:github`.
        const named = (id: string) => groups.find(group => !group.core &&
          (group.id === id || group.id.toLowerCase() === id.toLowerCase() || group.id.split(':')[1]?.toLowerCase() === id.toLowerCase()));
        let chosen = [...new Set(requested.map(named).filter((group): group is ToolGroup => Boolean(group)))];
        const unknown = requested.filter(id => !named(id) && !groups.some(group => group.core && group.id === id));
        if (!chosen.length && typeof input.need === 'string') chosen = matchGroups(groups, input.need);
        const listing = toolsFindDescription(groups).split('\n').slice(1).join('\n');
        if (!chosen.length) {
          return {
            content: [{ type: 'text', text: `${unknown.length ? `No group named ${unknown.join(', ')}.` : 'No single group fits that.'} Pick from these:\n${listing}` }],
            details: { loaded: [] },
          };
        }
        for (const group of chosen) loaded.add(group.id);
        pi.setActiveTools(activeToolNames(groups, loaded));
        const text = chosen.map(group => [
          `${group.title} (${group.id}) is loaded. Its tools can be called from your next step:`,
          ...group.tools.map(name => `- ${name}: ${firstSentence(describe(name))}`),
          ...(group.manual ? ['', 'Rules for these tools:', group.manual] : []),
        ].join('\n')).join('\n\n');
        const note = unknown.length ? `\n\nNo group named ${unknown.join(', ')}; the others are:\n${listing}` : '';
        return { content: [{ type: 'text', text: text + note }], details: { loaded: chosen.map(group => group.id) } };
      },
    });
    findSignature = signature;
  }

  /**
   * Groups loaded earlier in this session whose manual is still in context,
   * read back from the durable transcript. A compaction summarizes a group's
   * manual away, so only tools_find results the latest compaction kept count:
   * a group loaded before it loads again, with its rules, when needed.
   */
  function restoreLoaded(ctx: unknown): void {
    loaded.clear();
    try {
      const manager = object(ctx) ? ctx.sessionManager as { getBranch?: () => unknown[] } | undefined : undefined;
      const branch = manager?.getBranch?.() ?? [];
      let from = 0;
      for (let index = branch.length - 1; index >= 0; index -= 1) {
        const entry = branch[index];
        if (!object(entry) || entry.type !== 'compaction') continue;
        const kept = typeof entry.firstKeptEntryId === 'string'
          ? branch.findIndex(item => object(item) && item.id === entry.firstKeptEntryId) : -1;
        from = kept >= 0 ? kept : index + 1;
        break;
      }
      for (const entry of branch.slice(from)) {
        const message = object(entry) && entry.type === 'message' && object(entry.message) ? entry.message : undefined;
        const details = message && message.role === 'toolResult' && message.toolName === TOOLS_FIND && object(message.details) ? message.details : undefined;
        if (details && Array.isArray(details.loaded))
          for (const id of details.loaded) if (typeof id === 'string') loaded.add(id);
      }
    } catch { /* a transcript that cannot be read starts with the core set */ }
  }

  async function refreshTools(activate = true): Promise<string[]> {
    const response = await request<{ tools: ToolDefinition[] } & Partial<ToolCatalog>>('/tools');
    if (!Array.isArray(response.tools)) throw new Error('Hello tool bridge returned no tool definitions.');
    const names: string[] = [];
    for (const definition of response.tools) {
      const tool = definition.function;
      if (definition.type !== 'function' || !tool || !/^[a-z][a-z0-9_]{0,99}$/.test(tool.name) ||
          typeof tool.description !== 'string' || !object(tool.parameters))
        throw new Error('Hello tool bridge returned an invalid tool definition.');
      names.push(tool.name);
      descriptions.set(tool.name, tool.description);
      const signature = JSON.stringify(tool);
      if (registered.get(tool.name) === signature) continue;
      pi.registerTool({
        name: tool.name,
        label: tool.name.replaceAll('_', ' '),
        description: tool.description,
        promptSnippet: tool.description,
        parameters: tool.parameters as PiToolDefinition['parameters'],
        // Before Pi checks them: an older Pi ignores this and checks as sent.
        prepareArguments: (args: unknown) => schemaArguments(args, tool.parameters as Record<string, unknown>) as never,
        // Preserve the existing Hello ordering and one approval at a time.
        executionMode: 'sequential',
        async execute(toolCallId, params, signal) {
          if (!object(params)) throw new Error('Hello tool arguments must be an object.');
          const result = await request<{ result: unknown }>('/execute', {
            name: tool.name, args: params, toolCallId,
          }, signal);
          const output = readToolOutput(result.result);
          if (typeof output === 'string') return { content: [{ type: 'text', text: output }], details: {} };
          return {
            content: [
              { type: 'text', text: output.text },
              ...output.images.map(image => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })),
            ],
            details: {},
          };
        },
      });
      registered.set(tool.name, signature);
    }
    if (!Array.isArray(response.groups)) {
      // A bridge without groups offers every Hello tool, beside whatever the
      // plugin extensions activated themselves.
      catalog = undefined;
      if (activate) pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]);
      return names;
    }
    catalog = { groups: response.groups, plugins: Array.isArray(response.plugins) ? response.plugins : [] };
    const groups = allGroups();
    registerToolsFind(groups);
    // Launched with --no-builtin-tools and explicit built-in exclusions;
    // --no-tools would also remove extension tools from Pi's allowlist. The
    // set is the core, the groups loaded in this chat and tools_find: a
    // plugin's tools, which Pi activates as they register, wait in their group.
    const active = activeToolNames(groups, loaded);
    if (activate) pi.setActiveTools(active);
    return names.filter(name => active.includes(name));
  }

  // During extension loading only registration is legal: action methods are
  // bound later by Pi's runner. Activate after that binding at session_start.
  await refreshTools(false);
  let unloaded: string[] = [];
  pi.on('session_start', async (_event, ctx) => {
    bound = true;
    restoreLoaded(ctx);
    const expected = await refreshTools();
    const active = pi.getActiveTools();
    // Hello's own tools must all be live; plugin tools may add to them.
    if (expected.some(name => !active.includes(name)))
      throw new Error('Pi did not activate the expected Hello tools.');
    await request<{ ready: true }>('/ready');
  });
  pi.on('before_agent_start', async () => {
    await refreshTools();
  });
  // A compaction summarizes the tools_find results that carried each group's
  // manual. What it did not keep is unloaded, and the next step says so.
  pi.on('session_compact', async (_event, ctx) => {
    const before = new Set(loaded);
    restoreLoaded(ctx);
    unloaded = [...before].filter(id => !loaded.has(id));
    try { await refreshTools(); } catch { pi.setActiveTools(activeToolNames(allGroups(), loaded)); }
  });
  // A reply keeps running across steers, and Pi snapshots the active tools for
  // each next step right after turn_end. Refreshing here is what lets a folder
  // attached mid-reply bring its tools to the very next step. A failed refresh
  // keeps the current set — a thrown handler would end the reply — and the
  // bridge still re-checks availability when a tool runs.
  pi.on('turn_end', async () => {
    try { await refreshTools(); } catch { /* next step keeps the current tools */ }
  });
  // The runtime snapshot is the chat's: a CLI's context stays its own.
  if (cli) return;
  pi.on('context', async event => {
    const messages = event.messages.filter(message =>
      message.role !== 'custom' || message.customType !== CONTEXT_TYPE);
    // This step's tools were fixed before this hook ran. Anything that became
    // available since is callable from the next step, and the model is told so
    // rather than being shown a folder whose tools it cannot call yet.
    let late: string[] = [];
    let arrived: string[] = [];
    try {
      const before = new Set(pi.getActiveTools());
      late = (await refreshTools()).filter(name => !before.has(name));
      // A group that appeared since the last step — a folder attached, an
      // MCP server connected — is announced once, so it is not overlooked.
      const current = allGroups().filter(group => !group.core).map(group => group.id);
      if (knownGroups.size) arrived = current.filter(id => !knownGroups.has(id));
      for (const id of current) knownGroups.add(id);
    } catch { /* the live context below still describes the current state */ }
    let context: string;
    try {
      const response = await request<PiBridgeContextResponse>('/context');
      if (typeof response.context !== 'string') throw new Error('Invalid browser context.');
      context = response.context;
    } catch {
      context = 'Current Hello browser snapshot is unavailable. Use a recent successful browser_tabs result, or request the list once if the required tab or permission is unknown. Browser actions still check current permissions.';
    }
    if (late.length)
      context = [context, `These Hello tools were just enabled and can be called from your next step, not in this one: ${late.join(', ')}.`]
        .filter(Boolean).join('\n');
    if (arrived.length)
      context = [context, `These tool groups just became available; load one with tools_find from your next step when the task needs it: ${arrived.join(', ')}.`]
        .filter(Boolean).join('\n');
    if (unloaded.length) {
      context = [context, `Compaction summarized away the rules of these tool groups, so they were unloaded: ${unloaded.join(', ')}. Load one again with tools_find before using its tools.`]
        .filter(Boolean).join('\n');
      unloaded = [];
    }
    if (context) {
      // Pi serializes a custom message as a USER message. Appending this after
      // tool results made every step look like a fresh request to list tabs,
      // displacing the result the model should act on. Keep the snapshot before
      // the latest human request, with the assistant/tool sequence untouched.
      let anchor = 0;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === 'user') { anchor = index; break; }
      }
      messages.splice(anchor, 0, {
        role: 'custom', customType: CONTEXT_TYPE,
        content: `Hello runtime snapshot (metadata only, not a new user request):\n${context}`,
        display: false, timestamp: Date.now(),
      });
    }
    // Context copies are ephemeral: changing tabs does not append hidden,
    // obsolete browser snapshots to the durable Pi session every tool round.
    return { messages };
  });
}
