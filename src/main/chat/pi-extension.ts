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
  activeToolNames, firstSentence, groupAfter, groupsByIntent, pluginToolGroups, toolsFindDescription, withBrought, TOOLS_FIND, TOOLS_LOADED,
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
  // Hello's tools are closed objects, so one field they do not know makes Pi refuse the whole call before
  // Hello sees it: a model that writes `description` beside `command` — the shape another harness's shell
  // takes — had every bash call thrown away (a model's report, 18.11). A field nobody asked for is not a
  // reason to lose the work the model did ask for: it is dropped, and the call goes on. A required one
  // still has to be there, and the result says what actually ran.
  const closed = parameters.additionalProperties === false && Object.keys(known).length > 0;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const camel = key.includes('_') ? key.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase()) : key;
    const name = !(key in known) && camel in known && !(camel in value) ? camel : key;
    if (closed && !(name in known)) continue;
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
  /**
   * What a step may call. In a chat `bash` is always among them, whatever is
   * loaded and whether or not there is a folder: a shell call is answered by
   * Hello — run, or told why not — never by Pi's "Tool bash not found".
   */
  const activeNow = (groups: ToolGroup[]): string[] => {
    const names = activeToolNames(groups, loaded);
    return cli || names.includes('bash') ? names : [...names, 'bash'];
  };

  /** What a group brings into the conversation when it loads: its tools in a line each, and its manual. Said once, however it loaded. */
  const announce = (loading: ToolGroup[], from = 'your next step'): string => loading.map(group => [
    `${group.title} (${group.id}) is loaded. Its tools can be called from ${from}:`,
    ...group.tools.map(name => `- ${name}: ${firstSentence(describe(name))}`),
    ...(group.manual ? ['', 'Rules for these tools:', group.manual] : []),
  ].join('\n')).join('\n\n');

  function registerToolsFind(groups: ToolGroup[]): void {
    const ids = groups.filter(group => !group.core).map(group => group.id);
    const description = toolsFindDescription(groups);
    // No enum, no closed object, a name or a list alike: the call is read by
    // intent (groupsByIntent), so `group: "browser"` or `tool: "browser_open"`
    // loads the browser group instead of failing validation and costing the
    // model a round to learn the field's name (user, 09.10).
    const parameters = {
      type: 'object',
      properties: {
        groups: {
          anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }],
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
        const { chosen, unknown, already } = groupsByIntent(groups, input);
        const listing = toolsFindDescription(groups).split('\n').slice(1).join('\n');
        const inView = already.map(group => `${group.id === 'core' ? 'These tools are' : `${group.title} (${group.id}) is`} already in view in every chat, with nothing to load: call ${group.tools.join(', ')} directly.`).join('\n');
        if (!chosen.length && inView) return { content: [{ type: 'text', text: inView }], details: { loaded: [] } };
        if (!chosen.length) {
          return {
            content: [{ type: 'text', text: `${unknown.length ? `No group named ${unknown.join(', ')}.` : 'No single group fits that.'} Pick from these:\n${listing}` }],
            details: { loaded: [] },
          };
        }
        // A group that brings another loads both, with both manuals (sheets brings the shell).
        const loading = withBrought(groups, chosen);
        for (const group of loading) loaded.add(group.id);
        pi.setActiveTools(activeNow(groups));
        const text = announce(loading);
        const note = `${inView ? `\n\n${inView}` : ''}${unknown.length ? `\n\nNo group named ${unknown.join(', ')}; the others are:\n${listing}` : ''}`;
        return { content: [{ type: 'text', text: text + note }], details: { loaded: loading.map(group => group.id) } };
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
        // Loaded by the model with tools_find, or by Hello before the reply began: the manual is in the transcript either way.
        const details = message && message.role === 'toolResult' && message.toolName === TOOLS_FIND && object(message.details) ? message.details
          : object(entry) && entry.type === 'custom_message' && entry.customType === TOOLS_LOADED && object(entry.details) ? entry.details : undefined;
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
          let result: { result: unknown };
          try {
            result = await request<{ result: unknown }>('/execute', { name: tool.name, args: params, toolCallId }, signal);
          } catch (error) {
            // A failure that sends the model to another group's tools — a search stopped by bot protection to the
            // browser, a PDF or a workbook given to file_read to theirs: that group is there for the next step,
            // with its rules. A model told only where to look next answered from memory (17.11).
            const said = error instanceof Error ? error.message : String(error);
            const groups = allGroups();
            const wanted = groupAfter(tool.name, said);
            const needed = wanted ? groups.find(group => group.id === wanted && !group.core && !loaded.has(group.id)) : undefined;
            if (!needed) throw error;
            const loading = withBrought(groups, [needed]).filter(group => !loaded.has(group.id));
            for (const group of loading) loaded.add(group.id);
            pi.setActiveTools(activeNow(groups));
            throw new Error(`${said}\n\n${announce(loading)}`);
          }
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
    // Pi has a shell of its own under this name, with no approval. Whatever the
    // bridge offers, the name is Hello's: where the bridge has no shell to give,
    // the tool that holds the name says so instead of running anything.
    // Only in a chat: a Pi the person runs as a CLI keeps its own shell.
    if (!cli && !registered.has('bash')) {
      pi.registerTool({
        name: 'bash', label: 'bash', description: 'The shell. Not available on this connection.',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } as PiToolDefinition['parameters'],
        executionMode: 'sequential',
        async execute() { throw new Error('The shell is not available on this connection.'); },
      });
      registered.set('bash', 'held');
    }
    if (!Array.isArray(response.groups)) {
      // A bridge without groups offers every Hello tool, beside whatever the
      // plugin extensions activated themselves.
      catalog = undefined;
      if (activate) pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names, ...(cli ? [] : ['bash'])])]);
      return names;
    }
    catalog = { groups: response.groups, plugins: Array.isArray(response.plugins) ? response.plugins : [],
      ...(Array.isArray(response.preload) ? { preload: response.preload.filter((id): id is string => typeof id === 'string') } : {}) };
    const groups = allGroups();
    registerToolsFind(groups);
    // Launched with --no-builtin-tools and explicit built-in exclusions;
    // --no-tools would also remove extension tools from Pi's allowlist. The
    // set is the core, the groups loaded in this chat and tools_find: a
    // plugin's tools, which Pi activates as they register, wait in their group.
    const active = activeNow(groups);
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
    // What main read in the request — spreadsheet work — is loaded before the
    // model's first step, with its manual, once: a mode the model would
    // otherwise spend a step asking for, or start working without (user, 16.11).
    // It is one message in the transcript, like a tools_find result; no step
    // and no tool result carries the rules again.
    if (cli || !catalog?.preload?.length) return undefined;
    const groups = allGroups();
    const wanted = groups.filter(group => !group.core && catalog!.preload!.includes(group.id) && !loaded.has(group.id));
    if (!wanted.length) return undefined;
    const loading = withBrought(groups, wanted).filter(group => !loaded.has(group.id));
    for (const group of loading) loaded.add(group.id);
    pi.setActiveTools(activeNow(groups));
    return { message: {
      customType: TOOLS_LOADED, display: false, details: { loaded: loading.map(group => group.id) },
      content: `Hello loaded these tools before your first step, because of what this request asks for or what the chat\u2019s folder holds. This note is Hello\u2019s, not a request from the human, and no tools_find call is needed for them.\n\n${announce(loading, 'this step on')}`,
    } };
  });
  // A compaction summarizes the tools_find results that carried each group's
  // manual. A chat keeps the groups it was using: they stay loaded and their
  // rules come back once, as a note in the transcript like the one before a
  // reply's first step. Unloading them sent a model that was halfway through an
  // eBay search straight into "Tool browser_read not found" — the summary said
  // it had been reading the page, so it read it again (user, 26.11). A Pi run
  // as a CLI keeps the old way: unloaded, and its next step is told so.
  pi.on('session_compact', async (_event, ctx) => {
    const before = new Set(loaded);
    restoreLoaded(ctx);
    const dropped = [...before].filter(id => !loaded.has(id));
    try { await refreshTools(false); } catch { /* the catalog in hand decides */ }
    const groups = allGroups();
    const kept = cli ? [] : groups.filter(group => !group.core && dropped.includes(group.id));
    for (const group of kept) loaded.add(group.id);
    unloaded = dropped.filter(id => !loaded.has(id));
    pi.setActiveTools(activeNow(groups));
    if (kept.length)
      pi.sendMessage({
        customType: TOOLS_LOADED, display: false, details: { loaded: kept.map(group => group.id) },
        content: `The conversation was just summarised. Hello kept the tools you were using loaded, with their rules again. This note is Hello’s, not a request from the human, and no tools_find call is needed for them.\n\n${announce(kept, 'your next step on')}`,
      }, { triggerTurn: false });
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
    // Pi puts what before_agent_start returned after the request that started
    // the reply. The rules read as rules when they come first and the human's
    // words last, so each such note is shown ahead of the request it followed.
    // The same on every step: the prompt does not move under a reply.
    for (let index = 1; index < messages.length; index += 1) {
      const note = messages[index], before = messages[index - 1];
      if (note.role === 'custom' && note.customType === TOOLS_LOADED && before.role === 'user') { messages[index] = before; messages[index - 1] = note; }
    }
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
