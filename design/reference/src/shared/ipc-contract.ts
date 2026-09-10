/**
 * Typed renderer ↔ main IPC surface.
 *
 * Every request returns a serializable Result. Callback-based subscriptions
 * return an unsubscribe function and never expose privileged process objects.
 */

import type { AppError, Result } from './errors';
import type {
  Conversation,
  ConversationGroup,
  ConversationSummary,
  Endpoint,
  EndpointInput,
  EndpointVerification,
  Message,
  MessagePatch,
  Model,
  NewConversationInput,
  NewMessage,
  NewProjectInput,
  Project,
  ProjectMemberKind,
  RunbookEntry,
  RunbookContextStatus,
  StartCompletionInput,
  ThemePreference,
} from './types';

export type Unsubscribe = () => void;

export interface DiscoveryReport {
  endpoints: Endpoint[];
}

export interface PlatformInfo {
  os: string;
  arch: string;
  version: string;
}

export const SIDEBAR_LAYOUT = {
  minWidth: 200,
  maxWidth: 480,
  defaultWidth: 280,
  collapsedWidth: 48,
} as const;

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_LAYOUT.maxWidth, Math.max(SIDEBAR_LAYOUT.minWidth, Math.round(width)));
}

export interface SystemPreferences {
  reducedMotion: boolean;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  theme: ThemePreference;
}

export interface SystemPreferencesPatch {
  reducedMotion?: boolean;
  sidebarCollapsed?: boolean;
  sidebarWidth?: number;
  theme?: ThemePreference;
}

export type {
  ConversationGroup,
  NewProjectInput,
  Project,
  ProjectMemberKind,
  RunbookContextStatus,
};

export type ConversationExportErrorCode = 'canceled' | 'not_found' | 'write_failed' | 'internal';

export interface ConversationExportError {
  code: ConversationExportErrorCode;
  message: string;
}

/**
 * Result of exporting a conversation to Markdown. Distinct from {@link Result}:
 * a user cancelling the save dialog is a normal `ok: false` with code
 * `'canceled'` (the renderer stays silent), separate from an actual write error.
 */
export type ConversationExportResult =
  { ok: true; path: string } | { ok: false; error: ConversationExportError };

export type ChatStreamEvent =
  | { type: 'delta'; token: string }
  | ({ type: 'runbook_context' } & RunbookContextStatus)
  | {
      type: 'meta';
      ttftMs?: number;
      tokensPerSec?: number;
      promptTokens?: number;
      completionTokens?: number;
    }
  | { type: 'done'; finishReason?: string }
  | { type: 'error'; error: AppError }
  | { type: 'aborted' }
  /**
   * Progress of a tool the model called mid-stream (T137 web search). Purely
   * informational status — `phase: 'error'` means the search failed and the
   * run continued *without* it, so it must never raise the stream-failure
   * banner (DESIGNUIguide.md §Errors).
   */
  | {
      type: 'tool';
      tool: 'web_search' | 'browser' | 'shell' | 'mcp';
      /** The command a shell step ran, verbatim — shown to the user, not summarized. */
      command?: string;
      /** What that command printed, capped for display. */
      output?: string;
      exitCode?: number;
      phase: 'searching' | 'results' | 'error';
      /** Which browsing tool ran (T143 AI Mode); absent for web search. */
      action?: AgentAction;
      /** Human-readable target, e.g. a host + path. Never a filled value. */
      detail?: string;
      /**
       * Announced *before* an irreversible action runs, so the user can still
       * hit Stop while it is visible (T143 §5).
       */
      willSubmit?: boolean;
      query?: string;
      resultCount?: number;
      message?: string;
    };

/**
 * The endpoint/model the user last chose, as persisted in the config file.
 * Read on startup so a saved selection survives a relaunch; either field is
 * `null` when nothing is chosen or when the stored id no longer resolves.
 */
export interface ActiveSelection {
  endpointId: string | null;
  modelId: string | null;
}

/** Built-in web-search backends (T137). Both are configured, never hardcoded. */
export type WebSearchProviderId = 'searxng' | 'http-json';

/**
 * Web-search feature configuration, persisted in the config file. The feature
 * is off by default and stays inert until `baseUrl` is a valid http(s) URL;
 * the API key itself never lives here — it is keychain-only.
 */
export interface WebSearchConfig {
  enabled: boolean;
  providerId: WebSearchProviderId;
  /** SearXNG instance root, or the `http-json` endpoint/URL template. */
  baseUrl: string;
  /** Header the key is sent in, when one is stored. */
  apiKeyHeader: string;
  /** Prefix placed before the key inside that header (e.g. `'Bearer '`). */
  apiKeyPrefix: string;
  maxResults: number;
  /** Maximum tool round-trips per completion; the last round carries no tools. */
  maxRounds: number;
  timeoutMs: number;
}

/** {@link WebSearchConfig} as seen by the renderer: key presence, never the key. */
export interface WebSearchSettings extends WebSearchConfig {
  hasApiKey: boolean;
}

export type WebSearchSettingsPatch = Partial<WebSearchConfig>;

/** Outcome of a live provider probe from Settings. */
export interface WebSearchProbe {
  ok: boolean;
  resultCount: number;
  error?: string;
}

export interface WebSearchApi {
  getSettings(): Promise<Result<WebSearchSettings>>;
  setSettings(patch: WebSearchSettingsPatch): Promise<Result<WebSearchSettings>>;
  /** Stores the provider key in the OS keychain; it is never read back out. */
  setApiKey(value: string): Promise<Result<void>>;
  clearApiKey(): Promise<Result<void>>;
  hasApiKey(): Promise<Result<boolean>>;
  /** Runs one real search against the configured provider. */
  test(query?: string): Promise<Result<WebSearchProbe>>;
}

/** The browsing tools AI Mode can drive the pane with (T143). */
export type AgentAction =
  | 'navigate'
  | 'read_page'
  | 'screenshot'
  | 'list_tabs'
  | 'read_tab'
  | 'find'
  | 'click'
  | 'fill'
  | 'attach_file'
  | 'wait_for';

/** Agent-loop limits plus legacy permission flags retained in the config schema. */
/**
 * How long the model may run shell commands: not at all, for a day from the
 * moment it was granted, or until the user revokes it.
 */
/**
 * Where a server's definition came from: another tool's config file on this
 * machine, or a command the user typed into this app.
 */
export type McpServerSource = 'manual' | 'claude-desktop' | 'claude-code' | 'cursor' | 'codex';

/** How this app reaches a server: a process it starts, or a URL it posts to. */
export type McpTransportKind = 'stdio' | 'http';

interface McpServerCommon {
  id: string;
  /** Display name; falls back to the command or the host when blank. */
  name: string;
  enabled: boolean;
  source: McpServerSource;
  /** The source as the UI names it: "Cursor", "Claude Code · my-project". */
  sourceLabel: string;
}

/** A server started on demand as a local process, spoken to over its pipes. */
export interface McpStdioServerConfig extends McpServerCommon {
  transport: 'stdio';
  /** The executable, or — with `args` absent — a whole command line to split. */
  command: string;
  /** Argument vector as the source file wrote it; never re-split from `command`. */
  args?: string[];
  env?: Record<string, string>;
}

/** A server already running behind a URL, spoken to over streamable HTTP. */
export interface McpHttpServerConfig extends McpServerCommon {
  transport: 'http';
  url: string;
  /** Usually a bearer token: main-process only, exactly like `env`. */
  headers?: Record<string, string>;
}

/** One MCP server available to the model. */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface McpServerStatus {
  id: string;
  /** `idle` before the first connection, `ready` once its tools are listed. */
  state: 'idle' | 'ready' | 'failed';
  toolCount: number;
  error: string | null;
}

/**
 * A server as the renderer sees it. `env` and `headers` deliberately do not
 * cross the bridge: discovered configs routinely hold API keys and bearer
 * tokens, and the UI has no use for them.
 */
export interface McpServerView {
  id: string;
  name: string;
  transport: McpTransportKind;
  /** The full command line, or the URL: for display only. */
  target: string;
  source: McpServerSource;
  sourceLabel: string;
  enabled: boolean;
  /** Only a hand-added server can be deleted; the rest are turned off instead. */
  removable: boolean;
  status: McpServerStatus;
}

/**
 * The app serving *its own* tools to an outside CLI agent — the opposite
 * direction from the servers above, which the app connects out to.
 *
 * The session token is deliberately absent. It reaches a CLI through the
 * environment of the shell that spawns it, never through this channel, so no
 * renderer, devtools session, or IPC log can ever hold it.
 */
export interface McpServerGateView {
  /** Off by default. While off the socket does not exist at all. */
  serve: boolean;
  /** A second gate: acting on a page rather than only reading it. */
  allowActions: boolean;
  listening: boolean;
  socketPath: string;
  /** What to put in a CLI agent's MCP config; the address travels separately. */
  bridge: { command: string; args: string[] };
}

export interface McpApi {
  listServers(): Promise<Result<McpServerView[]>>;
  /** `target` is a command line or an http(s) URL; the main process tells them apart. */
  addServer(input: { name: string; target: string }): Promise<Result<McpServerView[]>>;
  removeServer(id: string): Promise<Result<McpServerView[]>>;
  setEnabled(id: string, enabled: boolean): Promise<Result<McpServerView[]>>;
  /** Connects (or reconnects) and refreshes the tool count. */
  refresh(id: string): Promise<Result<McpServerView[]>>;
  getServer(): Promise<Result<McpServerGateView>>;
  setServer(patch: { serve?: boolean; allowActions?: boolean }): Promise<Result<McpServerGateView>>;
}

/**
 * The embedded terminal the *user* types in — a login shell, running as them,
 * scoped to nothing. It is deliberately not the same thing as `ShellConfig`
 * below, which is the permission the *model* needs before it may run a command
 * inside one folder: opening a shell yourself is the act of opening
 * Terminal.app, and a grant for it would only be theatre (`cd /` is one
 * keystroke). These settings therefore shape the terminal; they do not gate it.
 */
export interface TerminalConfig {
  /** Whether the drawer offers a terminal at all. */
  enabled: boolean;
  /** Shell to launch. Empty means `$SHELL`, then the platform default. */
  shell: string;
  /** Directory a new session starts in; null means the user's home. */
  cwd: string | null;
  /** Output kept per session for replay when the drawer reopens. */
  scrollbackBytes: number;
  /** How many live sessions this window may hold at once. */
  maxSessions: number;
}

/**
 * {@link TerminalConfig} as the renderer sees it, plus whether a pty can
 * actually be opened on this machine. The native module is probed once at
 * boot and reports a reason rather than throwing, so the drawer can say what
 * is wrong instead of showing an empty box.
 */
export interface TerminalSettings extends TerminalConfig {
  available: boolean;
  unavailableReason: string | null;
}

export type TerminalSettingsPatch = Partial<TerminalConfig>;

/** A terminal's size in character cells. */
export interface TerminalSize {
  cols: number;
  rows: number;
}

/** CLI coding agents that can be opened as honest, interactive PTY workers. */
export type CliWorkerId = 'claude' | 'codex' | 'qwen' | 'kimi' | 'opencode' | 'pi' | 'aider';

/** Why a PTY exists, kept with it for the whole lifetime of the session. */
export type TerminalSessionMetadata = (
  | { kind: 'terminal'; workerId: null; workerLabel: null }
  | { kind: 'cli-worker'; workerId: CliWorkerId; workerLabel: string }
) & {
  /** Chat whose working folder launched this tool; null/absent means ungrouped. */
  conversationId?: string | null;
};

/** One live session, as the renderer refers to it. */
export type TerminalSession = {
  id: string;
  cols: number;
  rows: number;
  /** The directory the shell was started in. */
  cwd: string;
  /** The shell that was launched, as an absolute path. */
  shell: string;
} & TerminalSessionMetadata;

/** A detected executable. Paths stay in main; the renderer only chooses an id. */
export interface CliWorker {
  id: CliWorkerId;
  label: string;
  /** These workers use the endpoint/model currently selected in the app. */
  usesActiveModel: boolean;
  /** False for a catalog entry whose executable is not currently on PATH. */
  installed?: boolean;
}

/** Stable picker/settings order; installation is overlaid by main at runtime. */
export const CLI_WORKER_CATALOG: readonly CliWorker[] = [
  { id: 'claude', label: 'Claude Code', usesActiveModel: false },
  { id: 'codex', label: 'Codex CLI', usesActiveModel: false },
  { id: 'qwen', label: 'Qwen Code', usesActiveModel: true },
  { id: 'kimi', label: 'Kimi Code', usesActiveModel: true },
  { id: 'opencode', label: 'OpenCode', usesActiveModel: true },
  { id: 'pi', label: 'Pi', usesActiveModel: true },
  { id: 'aider', label: 'Aider', usesActiveModel: true },
] as const;

/** How a session's shell ended. `signal` is null for a normal exit. */
export interface TerminalExit {
  exitCode: number;
  signal: number | null;
}

export interface TerminalApi {
  getSettings(): Promise<Result<TerminalSettings>>;
  setSettings(patch: TerminalSettingsPatch): Promise<Result<TerminalSettings>>;
  /** Starts a shell, preferring the folder currently displayed by the chat. */
  create(
    size: TerminalSize,
    currentChatRoot?: string | null,
    conversationId?: string | null,
  ): Promise<Result<TerminalSession>>;
  /** Installed interactive coding CLIs, in stable menu order. */
  listCliWorkers(): Promise<Result<CliWorker[]>>;
  /** Starts one CLI directly in a PTY, preferring the folder shown by the current chat. */
  launchCliWorker(
    id: CliWorkerId,
    size: TerminalSize,
    currentChatRoot?: string | null,
    conversationId?: string | null,
  ): Promise<Result<TerminalSession>>;
  write(id: string, data: string): Promise<Result<void>>;
  resize(id: string, size: TerminalSize): Promise<Result<void>>;
  /** Kills the shell and forgets the session. */
  dispose(id: string): Promise<Result<void>>;
  /** Sessions still alive — what a reopened drawer reattaches to. */
  list(): Promise<Result<TerminalSession[]>>;
  /**
   * Tells main whether anything is showing this session. Hidden pauses the
   * pty (the shell blocks on a full pipe rather than filling this process's
   * memory); shown replays the kept scrollback as one `onData` chunk and then
   * resumes it, which is what stops a reopened drawer from being blank.
   */
  setVisible(id: string, visible: boolean): Promise<Result<void>>;
  onData(id: string, callback: (chunk: string) => void): Unsubscribe;
  onExit(id: string, callback: (exit: TerminalExit) => void): Unsubscribe;
}

export type ShellGrant = 'off' | 'day' | 'always';

export interface ShellConfig {
  grant: ShellGrant;
  /** When a `day` grant started; null for the others. */
  grantedAt: number | null;
  /** The one directory commands run in. Without it, nothing runs. */
  root: string | null;
  /** Per-command wall-clock budget. */
  timeoutMs: number;
}

export type ShellSettingsPatch = Partial<ShellConfig>;

/**
 * The outcome of a folder pick. `chosen` is what the user actually settled
 * on, and is null when they dismissed the picker — the caller cannot infer
 * that from `config` alone, because re-picking the folder already stored
 * leaves it identical.
 */
export interface ShellRootChoice {
  config: ShellConfig;
  chosen: string | null;
}

export interface ShellApi {
  getSettings(): Promise<Result<ShellConfig>>;
  setSettings(patch: ShellSettingsPatch): Promise<Result<ShellConfig>>;
  /**
   * Opens a native folder picker. The chosen folder becomes the last project
   * for the whole app; naming a conversation also pins it there, so a Coder
   * turn in that chat follows the change instead of the folder it last ran in.
   */
  chooseRoot(conversationId?: string): Promise<Result<ShellRootChoice>>;
}

/**
 * Whether Coder mode still has to ask before it can use this endpoint.
 *
 * The coding agent reads its credentials from a plaintext file in the user's
 * home directory, so an endpoint it has no provider for cannot be used until
 * that file describes it — and describing a server that needs a key means
 * copying the key out of the OS keychain. `needed: false` covers every case
 * where nothing has to be copied: the agent already knows the model, the
 * endpoint needs no key at all, or the user has already answered.
 */
export type CoderKeyConsentRequest =
  | { needed: false }
  | {
      needed: true;
      endpointId: string;
      endpointName: string;
      /** The file the key would be written into, shown to the user verbatim. */
      path: string;
    };

/**
 * The standing answer for one endpoint, as the endpoint editor shows it.
 *
 * Three states, not two: `true` is a yes, `false` a no, and `null` means the
 * user has never been asked — only the last one lets the prompt appear, so a
 * row that offered a checkbox could not put an endpoint back the way it
 * started.
 */
export interface CoderKeyAccess {
  consent: boolean | null;
  /** The plaintext file the key would be written into, shown verbatim. */
  path: string;
  /**
   * Set only by a change, and only when an already-written key could not be
   * taken back out. The answer itself is still recorded.
   */
  withdrawalError?: string;
}

export interface CoderApi {
  /** Whether sending to this endpoint in Coder mode still needs an answer. */
  keyConsentRequest(endpointId: string, modelId: string): Promise<Result<CoderKeyConsentRequest>>;
  /** The standing answer for this endpoint, and where the key would go. */
  keyAccess(endpointId: string): Promise<Result<CoderKeyAccess>>;
  /**
   * Records the answer, and hands back the state it leaves behind. `null`
   * puts the endpoint back to never-asked. Anything but a yes also withdraws
   * a key an earlier yes had already written into pi's file.
   */
  setKeyConsent(endpointId: string, granted: boolean | null): Promise<Result<CoderKeyAccess>>;
}

export interface AiModeConfig {
  enabled: boolean;
  allowActions: boolean;
  /** Hard cap on agent steps per query. */
  maxSteps: number;
  /** Per-step page-operation timeout, in ms. */
  stepTimeoutMs: number;
}

export type AiModeSettingsPatch = Partial<AiModeConfig>;

export interface AiModeApi {
  getSettings(): Promise<Result<AiModeConfig>>;
  setSettings(patch: AiModeSettingsPatch): Promise<Result<AiModeConfig>>;
}

/**
 * Pushed main-to-renderer while the agent drives the pane, so the pane can
 * show who is driving, what it just did, and a hard Stop (T143 §7).
 */
export interface BrowserAgentState {
  driving: boolean;
  action?: AgentAction;
  detail?: string;
  /** The stream to abort when the user hits Stop; null when idle. */
  streamId: string | null;
}

export interface EndpointsApi {
  listEndpoints(): Promise<Result<Endpoint[]>>;
  /** Persisted active endpoint + model, for store hydration on launch. */
  getActiveSelection(): Promise<Result<ActiveSelection>>;
  discoverEndpoints(): Promise<Result<DiscoveryReport>>;
  testEndpoint(id: string): Promise<Result<EndpointVerification>>;
  saveEndpoint(input: EndpointInput): Promise<Result<Endpoint>>;
  removeEndpoint(id: string): Promise<Result<void>>;
  setActiveEndpoint(id: string): Promise<Result<void>>;
}

export interface ModelsApi {
  listModels(endpointId: string): Promise<Result<Model[]>>;
  setActiveModel(endpointId: string, modelId: string): Promise<Result<void>>;
}

export interface ChatApi {
  startCompletion(input: StartCompletionInput): Promise<Result<{ streamId: string }>>;
  stopCompletion(streamId: string): Promise<Result<void>>;
  onEvent(streamId: string, callback: (event: ChatStreamEvent) => void): Unsubscribe;
}

export interface ConversationsApi {
  list(): Promise<Result<ConversationSummary[]>>;
  /** Conversations whose title or any message content matches `query`, newest first. */
  search(query: string): Promise<Result<ConversationSummary[]>>;
  get(id: string): Promise<Result<Conversation>>;
  create(input: NewConversationInput): Promise<Result<Conversation>>;
  rename(id: string, title: string): Promise<Result<void>>;
  remove(id: string): Promise<Result<void>>;
  appendMessage(id: string, message: NewMessage): Promise<Result<Message>>;
  updateMessage(id: string, messageId: string, patch: MessagePatch): Promise<Result<void>>;
  /** Creates a group. It stays invisible in the sidebar until a chat joins it. */
  createGroup(name: string): Promise<Result<ConversationGroup>>;
  renameGroup(groupId: string, name: string): Promise<Result<void>>;
  /** Moves conversations into the group with this id. */
  addToGroup(groupId: string, conversationIds: string[]): Promise<Result<void>>;
  /** Takes conversations out of whatever group they are in. */
  removeFromGroup(conversationIds: string[]): Promise<Result<void>>;
  clearMessages(id: string): Promise<Result<void>>;
  /** Deletes every message after `afterMessageId`; `afterMessageId` itself is kept. */
  deleteMessagesAfter(id: string, afterMessageId: string): Promise<Result<void>>;
  /**
   * Serializes the conversation to Markdown (YAML front matter, one level-2
   * heading per message, code fences copied verbatim) and writes it to a
   * user-chosen path via a native save dialog.
   */
  exportMarkdown(conversationId: string): Promise<ConversationExportResult>;
  /**
   * Stores an image under the conversation and returns the `attachment://`
   * URL for it. The renderer references that URL in the message it sends; the
   * main process inlines the file for the model on the way out.
   */
  saveAttachment(
    conversationId: string,
    input: ConversationAttachmentInput,
  ): Promise<Result<ConversationAttachment>>;
}

/** Conversation groups with an optional convenience folder. */
export interface ProjectsApi {
  list(): Promise<Result<Project[]>>;
  get(id: string): Promise<Result<Project>>;
  create(input: NewProjectInput): Promise<Result<Project>>;
  rename(id: string, name: string): Promise<Result<void>>;
  /** Deletes the project. Its chats and visually filed resources all survive it. */
  remove(id: string): Promise<Result<void>>;
  /** Binds a folder, or unbinds with null. */
  setFolder(id: string, folderPath: string | null): Promise<Result<void>>;
  /** Native directory picker; resolves to null when it was dismissed. */
  chooseFolder(): Promise<Result<string | null>>;
  /**
   * Creates `<parentPath>/<name>` and hands back its path. A folder that
   * cannot be made — no permission, a name already taken — comes back as a
   * readable `validation` error, never as a throw.
   */
  createFolder(parentPath: string, name: string): Promise<Result<string>>;
  addMember(projectId: string, kind: ProjectMemberKind, memberId: string): Promise<Result<void>>;
  removeMember(kind: ProjectMemberKind, memberId: string): Promise<Result<void>>;
  /** The project driving the app, or null when none is. */
  getActive(): Promise<Result<string | null>>;
  /** Sets it, and answers with what was stored — null for an id that is gone. */
  setActive(projectId: string | null): Promise<Result<string | null>>;
}

/** Chat runbook: short titled notes owned by exactly one conversation. */
export interface RunbookApi {
  list(conversationId: string): Promise<Result<RunbookEntry[]>>;
  add(conversationId: string, title: string, body: string): Promise<Result<RunbookEntry>>;
  update(id: string, title: string, body: string): Promise<Result<RunbookEntry>>;
  remove(id: string): Promise<Result<void>>;
}

/** One image stored under a conversation, as the renderer refers to it. */
export interface ConversationAttachment {
  attachmentUrl: string;
  fileName: string;
  mime: string;
}

/** An image on its way in from a drop, a paste, or the file picker. Bytes
 * travel as base64 because the preload bridge only forwards plain values. */
export interface ConversationAttachmentInput {
  mime: string;
  /** Base64 payload, without a `data:` prefix. */
  dataBase64: string;
}

export interface SecretsApi {
  setEndpointKey(endpointId: string, value: string): Promise<Result<void>>;
  clearEndpointKey(endpointId: string): Promise<Result<void>>;
  hasEndpointKey(endpointId: string): Promise<Result<boolean>>;
  /**
   * Whether a `key.txt` is present in the project folder (dev only). It is a
   * read-only, optional key source surfaced in Settings; the value is never
   * returned to the renderer and never auto-copied into the keychain.
   */
  hasProjectKey(): Promise<Result<boolean>>;
}

/**
 * Navigation state of the embedded browser pane, pushed main-to-renderer on
 * every change. `error` is populated by a main-frame load failure and cleared
 * by the next navigation attempt.
 */
export interface BrowserNavigationState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: { code: number; description: string } | null;
  /**
   * Set when the main frame was blocked by an invalid TLS certificate (T109);
   * cleared by the next navigation attempt. `description` is the Chromium
   * error string (e.g. `net::ERR_CERT_AUTHORITY_INVALID`).
   */
  certificateError: { url: string; description: string } | null;
}

/**
 * Search engine for the browser pane. No app-level web-search provider is
 * configured for browsing (src/renderer/endpoints/ only knows model
 * endpoints), so both the omnibox's non-URL input and the page context
 * menu's "Search for …" fall back to Google. Shared because those two live
 * in different processes and must not drift apart.
 */
export const DEFAULT_SEARCH_URL = 'https://www.google.com/search?q=';

/**
 * Dock rectangle for the browser pane's `WebContentsView`, in window content
 * coordinates (CSS pixels). Added in T108 for the split-layout docking.
 */
export interface BrowserPaneBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  /** The page's own icon, as the site declared it; null before one arrives. */
  faviconUrl: string | null;
  /** Per-page agent permission. Missing on legacy persisted tabs means off. */
  agentControl?: AgentControlLevel;
}

export type AgentControlLevel = 'off' | 'read' | 'act';

/** A successfully visited web page, newest visit first in omnibox results. */
export interface BrowserHistoryEntry {
  url: string;
  title: string;
  lastVisit: number;
}

/**
 * Snapshot of the browser pane's current page for the "Send page to chat"
 * action (T110): the page title, its URL, and the user's live text selection
 * (empty when nothing is selected, or when the sandboxed pane cannot read it).
 */
export interface BrowserPageCapture {
  title: string;
  url: string;
  selection: string;
}

/**
 * Result of "Screenshot to chat" (T111): the browser pane's page was captured
 * via `webContents.capturePage` and written as a PNG into the conversation's
 * attachment dir under `${userData}`. `attachmentUrl` is the renderer-loadable
 * `attachment://<conversationId>/<fileName>` URL; `path` is the absolute file
 * path on disk.
 */
export interface BrowserScreenshotCapture {
  attachmentUrl: string;
  path: string;
  fileName: string;
  width: number;
  height: number;
  title: string;
  url: string;
}

export interface BrowserApi {
  createTab(): Promise<Result<BrowserTab>>;
  closeTab(id: string): Promise<Result<void>>;
  selectTab(id: string): Promise<Result<void>>;
  reorderTabs(ids: string[]): Promise<Result<void>>;
  /** Changes the agent permission for one tab without affecting its peers. */
  setTabAgentControl(id: string, level: AgentControlLevel): Promise<Result<BrowserTab>>;
  /** Loads an http(s) URL in the browser pane; non-web schemes are rejected. */
  navigate(url: string): Promise<Result<void>>;
  back(): Promise<Result<void>>;
  forward(): Promise<Result<void>>;
  reload(): Promise<Result<void>>;
  stop(): Promise<Result<void>>;
  openDevTools(): Promise<Result<void>>;
  /** Docks the pane's web content into the given rectangle (added in T108). */
  setBounds(bounds: BrowserPaneBounds): Promise<Result<void>>;
  /** Tears down the pane's web content and resets navigation state (added in T108). */
  destroy(): Promise<Result<void>>;
  /**
   * Raises (`true`) or releases (`false`) the T146 overlay lock. A native
   * `WebContentsView` composites above *all* renderer content, so a global
   * overlay (dialog, popover, menu) that crosses the pane's rectangle is
   * painted underneath it. While the lock is raised the pane's web content is
   * hidden — page state, history, and scroll position are kept — and it is
   * restored when the last overlay releases. Raising resolves with a still
   * frame of the page (a data URL) for the renderer to paint over the dock
   * region, so hiding the native view does not leave a visible hole; it is
   * `null` when there was nothing to capture, and on release.
   */
  setOverlayOpen(open: boolean): Promise<Result<string | null>>;
  /**
   * Retries the certificate-blocked navigation, trusting the offending
   * certificate for that one load only (T109 "proceed once"). Fails with a
   * validation error when no certificate error is pending.
   */
  proceedOnce(): Promise<Result<void>>;
  /**
   * Captures the pane's current title, URL, and live text selection for the
   * "Send page to chat" composer action (T110). Fails with a validation error
   * when no page is loaded.
   */
  capturePage(): Promise<Result<BrowserPageCapture>>;
  /**
   * Captures the pane's current view as a PNG, saves it into the
   * conversation's attachment dir under `${userData}`, and returns the saved
   * file's location + metadata (T111 "Screenshot to chat"). Fails with a
   * validation error when no page is loaded.
   */
  captureScreenshot(conversationId: string): Promise<Result<BrowserScreenshotCapture>>;
  /** Returns persisted page visits, newest first, for omnibox suggestions. */
  getHistory(): Promise<Result<BrowserHistoryEntry[]>>;
  /**
   * Agent-driving state for the AI Mode indicator (T143). Pushed on every
   * step boundary and when a run starts or ends.
   */
  onAgentState(callback: (state: BrowserAgentState) => void): Unsubscribe;
  onNavigationState(callback: (state: BrowserNavigationState) => void): Unsubscribe;
  onTabsChanged(callback: (tabs: BrowserTab[], activeId: string) => void): Unsubscribe;
  /**
   * An image the page asked to open on its own — a photo clicked in a feed,
   * say. It is shown over the pane instead of replacing the page or taking a
   * tab of its own.
   */
  onImagePreview(callback: (url: string) => void): Unsubscribe;
  /**
   * A newer still of the hidden page while the overlay lock is held: the frame
   * `setOverlayOpen` handed back ages as soon as the page moves, and an
   * overlay can stay open for minutes. Only ever replaces a frame that is
   * already on screen — it never brings one back after the lock released.
   */
  onFreezeFrame(callback: (frame: string) => void): Unsubscribe;
}

export interface SystemApi {
  openExternal(url: string): Promise<Result<void>>;
  getPlatformInfo(): Promise<Result<PlatformInfo>>;
  getPreferences(): Promise<Result<SystemPreferences>>;
  setPreferences(patch: SystemPreferencesPatch): Promise<Result<SystemPreferences>>;
  onPreferencesChanged(callback: (preferences: SystemPreferences) => void): Unsubscribe;
}

export interface IpcApi {
  endpoints: EndpointsApi;
  models: ModelsApi;
  chat: ChatApi;
  conversations: ConversationsApi;
  projects: ProjectsApi;
  runbook: RunbookApi;
  secrets: SecretsApi;
  system: SystemApi;
  browser: BrowserApi;
  websearch: WebSearchApi;
  aimode: AiModeApi;
  shell: ShellApi;
  terminal: TerminalApi;
  mcp: McpApi;
  coder: CoderApi;
}

export type Api = IpcApi;

export const IPC_CHANNELS = {
  endpoints: {
    listEndpoints: 'endpoints:list',
    getActiveSelection: 'endpoints:get-active',
    discoverEndpoints: 'endpoints:discover',
    testEndpoint: 'endpoints:test',
    saveEndpoint: 'endpoints:save',
    removeEndpoint: 'endpoints:remove',
    setActiveEndpoint: 'endpoints:set-active',
  },
  models: {
    listModels: 'models:list',
    setActiveModel: 'models:set-active',
  },
  chat: {
    startCompletion: 'chat:start-completion',
    stopCompletion: 'chat:stop-completion',
    onEvent: 'chat:event',
  },
  conversations: {
    list: 'conversations:list',
    search: 'conversations:search',
    get: 'conversations:get',
    create: 'conversations:create',
    rename: 'conversations:rename',
    remove: 'conversations:remove',
    appendMessage: 'conversations:append-message',
    updateMessage: 'conversations:update-message',
    createGroup: 'conversations:create-group',
    renameGroup: 'conversations:rename-group',
    addToGroup: 'conversations:add-to-group',
    removeFromGroup: 'conversations:remove-from-group',
    clearMessages: 'conversations:clear-messages',
    deleteMessagesAfter: 'conversations:delete-messages-after',
    exportMarkdown: 'conversations:export-markdown',
    saveAttachment: 'conversations:save-attachment',
  },
  projects: {
    list: 'projects:list',
    get: 'projects:get',
    create: 'projects:create',
    rename: 'projects:rename',
    remove: 'projects:remove',
    setFolder: 'projects:set-folder',
    chooseFolder: 'projects:choose-folder',
    createFolder: 'projects:create-folder',
    addMember: 'projects:add-member',
    removeMember: 'projects:remove-member',
    getActive: 'projects:get-active',
    setActive: 'projects:set-active',
  },
  runbook: {
    list: 'runbook:list',
    add: 'runbook:add',
    update: 'runbook:update',
    remove: 'runbook:remove',
  },
  secrets: {
    setEndpointKey: 'secrets:set-endpoint-key',
    clearEndpointKey: 'secrets:clear-endpoint-key',
    hasEndpointKey: 'secrets:has-endpoint-key',
    hasProjectKey: 'secrets:has-project-key',
  },
  browser: {
    createTab: 'browser:create-tab',
    closeTab: 'browser:close-tab',
    selectTab: 'browser:select-tab',
    reorderTabs: 'browser:reorder-tabs',
    setTabAgentControl: 'browser:set-tab-agent-control',
    navigate: 'browser:navigate',
    back: 'browser:back',
    forward: 'browser:forward',
    reload: 'browser:reload',
    stop: 'browser:stop',
    openDevTools: 'browser:open-devtools',
    // Added in T108: split-layout docking + clean teardown of the pane.
    setBounds: 'browser:set-bounds',
    destroy: 'browser:destroy',
    // Added in T146: hide the native pane while a renderer overlay is mounted.
    setOverlayOpen: 'browser:set-overlay-open',
    proceedOnce: 'browser:proceed-once',
    // Added in T110: capture the pane's page for the "Send page to chat" action.
    capturePage: 'browser:capture-page',
    // Added in T111: save the pane's view as a PNG attachment ("Screenshot to chat").
    captureScreenshot: 'browser:capture-screenshot',
    // Added in T142: persisted recent-page suggestions for the omnibox.
    getHistory: 'browser:get-history',
    onNavigationState: 'browser:navigation-state',
    tabsChanged: 'browser:tabs-changed',
    imagePreview: 'browser:image-preview',
    // A re-shot still while the T146 overlay lock keeps the pane hidden.
    freezeFrame: 'browser:freeze-frame',
    // Added in T143: "AI is driving" indicator state for the pane.
    agentState: 'browser:agent-state',
  },
  aimode: {
    getSettings: 'aimode:get-settings',
    setSettings: 'aimode:set-settings',
  },
  shell: {
    getSettings: 'shell:get-settings',
    setSettings: 'shell:set-settings',
    chooseRoot: 'shell:choose-root',
  },
  terminal: {
    getSettings: 'terminal:get-settings',
    setSettings: 'terminal:set-settings',
    create: 'terminal:create',
    listCliWorkers: 'terminal:list-cli-workers',
    launchCliWorker: 'terminal:launch-cli-worker',
    write: 'terminal:write',
    resize: 'terminal:resize',
    dispose: 'terminal:dispose',
    list: 'terminal:list',
    setVisible: 'terminal:set-visible',
    onData: 'terminal:data',
    onExit: 'terminal:exit',
  },
  coder: {
    keyConsentRequest: 'coder:key-consent-request',
    keyAccess: 'coder:key-access',
    setKeyConsent: 'coder:set-key-consent',
  },
  mcp: {
    listServers: 'mcp:list-servers',
    addServer: 'mcp:add-server',
    removeServer: 'mcp:remove-server',
    setEnabled: 'mcp:set-enabled',
    refresh: 'mcp:refresh',
    getServer: 'mcp:get-server',
    setServer: 'mcp:set-server',
  },
  websearch: {
    getSettings: 'websearch:get-settings',
    setSettings: 'websearch:set-settings',
    setApiKey: 'websearch:set-api-key',
    clearApiKey: 'websearch:clear-api-key',
    hasApiKey: 'websearch:has-api-key',
    test: 'websearch:test',
  },
  system: {
    openExternal: 'system:open-external',
    getPlatformInfo: 'system:get-platform-info',
    getPreferences: 'system:get-preferences',
    setPreferences: 'system:set-preferences',
    onPreferencesChanged: 'system:preferences-changed',
  },
} as const;
