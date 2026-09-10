// A headless Pi extension, adapted to Hello's existing tool host.
// Bundle this entry separately; it runs inside the Pi child, never in Electron's
// renderer. No direct filesystem, command, browser or orchestrator tools here.
import type { ExtensionAPI, ToolDefinition as PiToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiBridgeContextResponse, PiBridgeExecuteRequest } from './pi-tool-bridge';
import type { ToolDefinition } from './tools';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const CONTEXT_TYPE = 'hello-live-browser-context';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

export default async function helloTools(pi: ExtensionAPI): Promise<void> {
  const address = process.env.HELLO_PI_BRIDGE_URL;
  const token = process.env.HELLO_PI_BRIDGE_TOKEN;
  if (!address || !token || !/^[a-f0-9]{64}$/.test(token))
    throw new Error('Hello tool bridge configuration is missing.');
  const url = new URL(address);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Hello tool bridge must use its private loopback address.');
  rejectChildFetchRedirects();

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
  async function refreshTools(activate = true): Promise<string[]> {
    const response = await request<{ tools: ToolDefinition[] }>('/tools');
    if (!Array.isArray(response.tools)) throw new Error('Hello tool bridge returned no tool definitions.');
    const names: string[] = [];
    for (const definition of response.tools) {
      const tool = definition.function;
      if (definition.type !== 'function' || !tool || !/^[a-z][a-z0-9_]{0,99}$/.test(tool.name) ||
          typeof tool.description !== 'string' || !object(tool.parameters))
        throw new Error('Hello tool bridge returned an invalid tool definition.');
      names.push(tool.name);
      const signature = JSON.stringify(tool);
      if (registered.get(tool.name) === signature) continue;
      pi.registerTool({
        name: tool.name,
        label: tool.name.replaceAll('_', ' '),
        description: tool.description,
        promptSnippet: tool.description,
        parameters: tool.parameters as PiToolDefinition['parameters'],
        // Preserve the existing Hello ordering and one approval at a time.
        executionMode: 'sequential',
        async execute(toolCallId, params, signal) {
          if (!object(params)) throw new Error('Hello tool arguments must be an object.');
          const result = await request<{ result: string }>('/execute', {
            name: tool.name, args: params, toolCallId,
          }, signal);
          if (typeof result.result !== 'string') throw new Error('Hello tool bridge returned an invalid result.');
          return { content: [{ type: 'text', text: result.result }], details: {} };
        },
      });
      registered.set(tool.name, signature);
    }
    // Launch with --no-builtin-tools and explicit built-in exclusions;
    // --no-tools would also remove extension tools from Pi's allowlist.
    // Activate Hello's tools WITHOUT deactivating tools registered by the
    // user's activated plugin extensions: replacing the set would silently
    // disable a plugin the human turned on for this conversation.
    if (activate) pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]);
    return names;
  }

  // During extension loading only registration is legal: action methods are
  // bound later by Pi's runner. Activate after that binding at session_start.
  await refreshTools(false);
  pi.on('session_start', async () => {
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
  pi.on('context', async event => {
    const messages = event.messages.filter(message =>
      message.role !== 'custom' || message.customType !== CONTEXT_TYPE);
    let context: string;
    try {
      const response = await request<PiBridgeContextResponse>('/context');
      if (typeof response.context !== 'string') throw new Error('Invalid browser context.');
      context = response.context;
    } catch {
      context = 'Current Hello browser state is unavailable. Use browser_tabs to obtain current tab IDs and permissions before a browser operation; do not assume an earlier tab remains permitted.';
    }
    if (context) messages.push({
      role: 'custom', customType: CONTEXT_TYPE,
      content: context, display: false, timestamp: Date.now(),
    });
    // Context copies are ephemeral: changing tabs does not append hidden,
    // obsolete browser snapshots to the durable Pi session every tool round.
    return { messages };
  });
}
