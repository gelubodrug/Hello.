import type { FileDocument, FileListing } from './files';
import type { AnnotationShot } from './page-mode-format';
export type NotebookKind = 'runbook' | 'tasks';
export type AgentControl = 'off' | 'read' | 'full';
export type WorkerId = 'claude' | 'codex' | 'qwen' | 'kimi' | 'opencode' | 'pi' | 'aider';
export type ResourceKind = 'skill' | 'plugin' | 'mcp';
/** ready = approved copy intact; modified = the approved files changed on disk; missing = removed. */
export type ResourceState = 'ready' | 'modified' | 'missing';
export interface LibraryResource {
  id: string; kind: ResourceKind; name: string; description: string;
  /** Original import path, or the configured command for an MCP server. */
  source: string;
  version: string;
  /** Short hash of the approved copy. Changes only through an explicit update. */
  fingerprint: string;
  state: ResourceState;
  detail: string;
  /** Skill: bundled files. Plugin: the Pi resources found inside. */
  entries: string[];
  /** Reported by an import that found declared dependencies Hello does not install. */
  warning?: string;
  /** Lossless editor data. Environment values are deliberately absent. */
  mcp?: { command: string; args: string[]; cwd: string | null; envNames: string[] };
  createdAt: number; updatedAt: number;
}
export interface McpServerInput {
  name: string; command: string; args: string[]; env: Record<string, string>; cwd?: string | null;
  /** Set when editing an existing server. */
  id?: string;
  /** Editing with an empty environment box keeps the stored values. */
  keepEnv?: boolean;
}
/** An MCP server another agent tool already has configured on this Mac. */
export interface DiscoveredMcpServer {
  id: string; name: string; source: string; configPath: string;
  command: string; args: string[]; cwd?: string;
  /** Variable names only — values never leave the main process. */
  envNames: string[];
  transport: 'stdio' | 'remote';
  /** Why Hello cannot use this entry, when it cannot. */
  unsupported?: string;
}
/** A skill folder another agent tool already has on this Mac. */
export interface DiscoveredSkill { id: string; name: string; description: string; source: string; path: string; }
export interface DiscoveredResources { mcp: DiscoveredMcpServer[]; skills: DiscoveredSkill[]; }
/** A model the endpoint offers, with the limits it publishes for it. */
export interface ModelChoice { id: string; contextWindow?: number; maxOutputTokens?: number; }
/** One connection's models for the chat's picker: the one in use (unnamed until kept), a kept one, or a server running on this Mac. A connection that could not answer keeps its place with the reason. */
export interface ConnectionModels { name: string; endpointUrl: string; active: boolean; models: ModelChoice[]; error?: string; }
/** A model server found running on this Mac, named after what it is and the port it took. */
export interface LocalServer { name: string; endpointUrl: string; models: ModelChoice[]; }
export interface McpServerStatus { id: string; name: string; connected: boolean; tools: string[]; error?: string | null; }
export interface ResourceChange { conversationId?: string }
/** Three switches a chat carries. `planning` is the Plan switch: off by
 *  default, because a two-line request answered with a written plan is slower
 *  than the answer. `runbook` and `tasks` are the two shared pages: on by
 *  default, and when one is off it is gone from the UI and invisible to the
 *  model — no page, no tool, nothing about it in what the model is told. */
export interface Conversation { id: string; title: string; folder: string | null; chatMode?: 'chat' | 'coder'; planning?: boolean; runbook?: boolean; tasks?: boolean;
  /** When the chat was last restarted: the model's memory begins here; what came before stays for the person. */
  freshFrom?: number;
  createdAt: number; updatedAt: number; }
export interface ChatAttachment { id: string; name: string; kind: 'text' | 'image'; size: number; }
export interface ChatDropResult { folder?: string; attachments: ChatAttachment[]; }
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; durationMs?: number }
  | { type: 'tool'; id: string; name: string; input: string; output?: string; status: 'running' | 'complete' | 'error' | 'approval'; approvalId?: string; durationMs?: number };
export interface Message { id: string; conversationId: string; role: 'user' | 'assistant'; content: string; parts?: MessagePart[]; status: 'complete' | 'streaming' | 'error'; createdAt: number; error?: string | null; usage?: MessageUsage; runtimePhase?: 'starting' | 'working' | 'compacting' | 'retrying';
  /** The model that wrote this reply, as it was selected when the reply began. */
  model?: string; }
/**
 * What a reply cost in tokens. input and output add up every call the reply
 * made — a tool step sends the whole context again — so they are its bill,
 * not its size; context is the prompt of its latest call: how full the
 * model's window is now.
 */
export interface MessageUsage { input: number; output: number; context?: number; cost?: number; }
/** A message that has the words searched for, and the words around them. */
export interface MessageMatch { conversationId: string; messageId: string; role: 'user' | 'assistant'; snippet: string; createdAt: number; }
export interface NotebookEntry { id: string; conversationId: string; kind: NotebookKind; title: string; body: string; createdAt: number; updatedAt: number; }
export interface NotebookChange { conversationId: string; kind: NotebookKind; }
/**
 * How much the agent may do inside a chat's attached folder without being asked.
 * 'ask' prompts for every write and every command; 'writes' lets writes through
 * (they are confined to that folder) but still asks before a shell command;
 * 'all' asks for neither.
 */
export type ApprovalMode = 'ask' | 'writes' | 'all';
/** A provider the user asked this app to keep, so switching is a click and not a retyped URL. Its key lives under its endpoint, never in this record. */
export interface SavedConnection { name: string; endpointUrl: string; model: string; apiKeySet: boolean; }
export interface AppSettings { endpointUrl: string; model: string; apiKeySet: boolean; systemPrompt: string; temperature: number; reasoningEffort?: 'off' | 'low' | 'medium' | 'high'; contextWindow?: number; maxOutputTokens?: number; modelCompatibility?: 'auto' | 'openai' | 'qwen-chat-template'; approvals?: ApprovalMode; /** Endpoint and model the stored context/output numbers were resolved for. Main stamps it; a change means the limits must be looked up again. */ limitsFor?: string; /** How much of the published window main hands the runtime. Learned from what the provider reports, never edited by hand: a runtime that estimates its own context low needs to be told a smaller number. */ contextScale?: number; connections: SavedConnection[]; }
export type SettingsPatch = Partial<Omit<AppSettings, 'apiKeySet' | 'connections'>> & { apiKey?: string };
/** Where a message the person wrote during a run is meant to land. */
export type QueuedMode = 'steer' | 'next' | 'later';
/** Their words, waiting. Not part of the conversation until it is delivered. */
export interface QueuedMessage { id: string; conversationId: string; text: string; mode: QueuedMode; createdAt: number; }
export interface WorkerInfo { id: WorkerId; label: string; installed: boolean; usesActiveModel: boolean; }
export interface TerminalSession { id: string; conversationId: string; title: string; kind: 'terminal' | 'worker'; workerId?: WorkerId; cwd: string; status: 'running' | 'exited'; exitCode?: number; notebookContext?: boolean; }
export interface TerminalData { id: string; data: string; sequence: number; }
export interface TerminalExit { id: string; exitCode: number; }
export interface TerminalAttach { session: TerminalSession; scrollback: string; sequence: number; }
export interface BrowserTab { id: string; conversationId: string; title: string; url: string; control: AgentControl; loading: boolean; progress: number | null; canGoBack: boolean; canGoForward: boolean; error?: string | null; pageOwned?: boolean; openerId?: string; sessionOnly?: boolean;
  /** Bumped when the page must be re-created; the renderer keys its guest on it. */
  generation?: number;
  /** The isolated session a generated preview runs in, chosen by the main process. */
  partition?: string;
  /** How to produce this page again: `artifact:<id>` for a generated document,
   *  or a path inside the chat's folder. A local URL dies with the app; a
   *  handle does not, so this is what a tab is saved by. */
  source?: string; }
/**
 * A file a page offered, or the model asked for, and where it went. One list
 * per chat, kept between sessions: a download from a link that opened in a
 * popup, or from a tab since closed, is still this chat's download.
 */
export interface BrowserDownload {
  id: string;
  conversationId: string;
  /** The tab it came from — its opener, when the link opened a popup for it. */
  tabId?: string;
  name: string;
  path?: string;
  /** Where it came from: origin and path, never a query string or credentials. */
  url?: string;
  mimeType?: string;
  state: 'saving' | 'saved' | 'failed' | 'cancelled' | 'refused';
  reason?: string;
  /** Bytes on disk so far, and the whole size when the server said it. */
  bytes?: number;
  total?: number;
  startedAt: number;
  finishedAt?: number;
}
export type BrowserDownloadEvent =
  | { type: 'updated'; download: BrowserDownload }
  | { type: 'removed'; id: string; conversationId: string };
export type BrowserLifecycleEvent =
  | { type: 'opened'; tab: BrowserTab; foreground: boolean; userRequested?: boolean }
  | { type: 'closed'; id: string; conversationId: string; openerId?: string }
  | { type: 'downloaded'; id: string; conversationId: string; download: BrowserDownload };
export interface ViewBounds { x: number; y: number; width: number; height: number; }
export interface BrowserContent { title: string; url: string; text: string; }
/**
 * Page modes: the human points at a page and says something about it. One mode
 * per tab at a time; both need at least Read on that tab. `design` names an
 * element; `annotate` marks a zone (its UI arrives separately).
 */
export type PageModeKind = 'design' | 'annotate';
/** A box in the page's own viewport, in its CSS pixels. */
export interface PageRect { x: number; y: number; w: number; h: number; }
export interface PagePick {
  kind: PageModeKind; armId: string; tabId: string;
  /** The document the pick was made in. */
  url: string;
  /** A CSS selector that finds the element again. */
  selector: string;
  tag: string;
  /** Its visible text, collapsed and shortened. */
  text: string;
  /** Computed styles worth naming: font, colour, spacing, radius, border, layout. */
  styles: string;
  /** The reference block a note about this element starts with. */
  ref: string;
  rect: PageRect;
  /** The page's viewport when the pick was made; rects scale against it. */
  viewport: { w: number; h: number };
  at: string;
}
export type PageModeExitReason = 'escape' | 'navigated' | 'revoked' | 'hidden' | 'closed';
export type PageModeEvent =
  /** Where the highlight is now: the element under the pointer, or the picked one as the page scrolls. */
  | { type: 'hover'; tabId: string; armId: string; rect: PageRect | null }
  | { type: 'picked'; tabId: string; armId: string; pick: PagePick; point: { x: number; y: number } }
  /** The pick ended in the page (a click away from it); the mode stays armed. */
  | { type: 'released'; tabId: string; armId: string }
  /** Annotate: the number of committed markers in the page changed. */
  | { type: 'marks'; tabId: string; armId: string; count: number }
  | { type: 'exit'; tabId: string; armId: string; reason: PageModeExitReason };
/** What a browser pane hands the chat composer besides words. */
export interface ChatQuoteExtra {
  attachments?: ChatAttachment[];
  /** Insert the text as written rather than as a block quote. */
  verbatim?: boolean;
}
export interface ChatQuote extends ChatQuoteExtra { text: string; }
export interface ChatEvent { conversationId: string; message: Message; }
/** The waiting list after main changed it on its own: a steer said, a held message delivered. */
export interface ChatQueueEvent { conversationId: string; items: QueuedMessage[]; }
export interface NotebookPaths { runbook: string; tasks: string; }
export interface Bootstrap { conversations: Conversation[]; settings: AppSettings; workers: WorkerInfo[]; terminals: TerminalSession[]; browsers: BrowserTab[]; dataPath: string; version: string; extensionsCount: number; }

export interface HelloAPI {
  files: {
    list(conversationId: string, path?: string, search?: string): Promise<FileListing>;
    read(conversationId: string, path: string): Promise<FileDocument>;
    open(conversationId: string, path: string): Promise<void>;
    reveal(conversationId: string, path: string): Promise<void>;
    resolvePaths(conversationId: string, paths: string[]): Promise<string[]>;
  };
  bootstrap(): Promise<Bootstrap>;
  conversations: {
    list(): Promise<Conversation[]>;
    create(title?: string): Promise<Conversation>;
    update(id: string, patch: { title?: string; folder?: string | null; chatMode?: 'chat' | 'coder'; planning?: boolean; runbook?: boolean; tasks?: boolean }): Promise<Conversation>;
    delete(id: string): Promise<void>;
    /** The model starts fresh from now; messages, tabs, terminals, notes and the folder stay. */
    restart(id: string): Promise<Conversation>;
    /** Messages of every chat that have these words, newest first, a few per chat. Optional for an older preload. */
    search?(query: string): Promise<MessageMatch[]>;
    /** The chat empty as new — messages, queue, attachments and, with notes, its Runbook and Tasks go; tabs, terminals, downloads and the folder stay. */
    reset(id: string, options?: { notes?: boolean }): Promise<Conversation>;
    messages(id: string): Promise<Message[]>;
    export(id: string): Promise<string | null>;
  };
  settings: {
    get(): Promise<AppSettings>;
    save(patch: SettingsPatch): Promise<AppSettings>;
    /** An endpoint's models, asked afresh: the one given, or the one in use. */
    models(endpointUrl?: string): Promise<ModelChoice[]>;
    /** Every model the chat can reach: the endpoint in use, kept connections and servers on this Mac. */
    catalog(): Promise<ConnectionModels[]>;
    /** Model servers running on this Mac, looked for afresh. */
    localServers(): Promise<LocalServer[]>;
    /** Keeps the endpoint and model as currently saved under a name. */
    rememberConnection(name: string): Promise<AppSettings>;
    /** Makes a remembered connection the active endpoint and model. */
    useConnection(endpointUrl: string): Promise<AppSettings>;
    /** Drops a remembered connection and the key stored for its endpoint. */
    forgetConnection(endpointUrl: string): Promise<AppSettings>;
  };
  chat: { attach(conversationId: string, paths: string[]): Promise<ChatDropResult>; /** A data: URL of one of this chat's image attachments. */ previewAttachment(conversationId: string, attachmentId: string): Promise<string>; send(conversationId: string, text: string, attachmentIds?: string[]): Promise<void>; queue(conversationId: string, text: string, mode: QueuedMode): Promise<QueuedMessage[]>; queued(conversationId: string): Promise<QueuedMessage[]>; reviseQueued(id: string, patch: { text?: string; mode?: QueuedMode }): Promise<QueuedMessage[]>; /** A row that is already gone is not an error: the chat's current list comes back. */ dropQueued(id: string, conversationId?: string): Promise<QueuedMessage[]>; stop(conversationId: string): Promise<void>; retry(conversationId: string): Promise<void>; approve(approvalId: string, allow: boolean): Promise<void>; onEvent(listener: (event: ChatEvent) => void): () => void; onQueue?(listener: (event: ChatQueueEvent) => void): () => void; };
  notebooks: { list(conversationId: string, kind: NotebookKind): Promise<NotebookEntry[]>; save(input: { id?: string; conversationId: string; kind: NotebookKind; title: string; body: string; expectedUpdatedAt?: number }): Promise<NotebookEntry>; delete(id: string): Promise<void>; paths(conversationId: string): Promise<NotebookPaths>; onChange?(listener: (event: NotebookChange) => void): () => void; };
  extensions: {
    list(): Promise<LibraryResource[]>;
    importResource(kind: 'skill' | 'plugin'): Promise<LibraryResource | null>;
    examples(): Promise<Array<{ kind: 'skill' | 'plugin'; name: string; description: string }>>;
    importExample(kind: 'skill' | 'plugin', name: string): Promise<LibraryResource>;
    addMcp(input: McpServerInput): Promise<LibraryResource>;
    /** MCP servers and skills found in other agent tools' own configuration. */
    discover(): Promise<DiscoveredResources>;
    importDiscovered(kind: 'mcp' | 'skill', id: string): Promise<LibraryResource>;
    update(id: string): Promise<LibraryResource>;
    remove(id: string): Promise<void>;
    active(conversationId: string): Promise<string[]>;
    setActive(conversationId: string, resourceId: string, active: boolean): Promise<string[]>;
    status(): Promise<McpServerStatus[]>;
    probe(id: string): Promise<McpServerStatus>;
    disconnect(id: string): Promise<void>;
    onChange(listener: (event: ResourceChange) => void): () => void;
  };
  system: { chooseFolder(): Promise<string | null>; pathsForFiles(files: File[]): string[]; openExternal(url: string): Promise<void>; revealPath(path: string): Promise<void>; copy(content: { text: string; html?: string }): Promise<void>;
    /** A macOS notification about one chat; clicking it brings that chat forward. Optional for an older preload. */
    notify?(input: { title: string; body: string; conversationId: string }): Promise<boolean>;
    /** The number on the Dock icon: chats waiting for the person. 0 clears it. */
    badge?(count: number): Promise<void>;
    /** A notification was clicked: the chat it was about. */
    onFocusConversation?(listener: (conversationId: string) => void): () => void;
    /** The app's window gained or lost the OS focus. */
    onWindowFocus?(listener: (focused: boolean) => void): () => void; };
  terminal: {
    list(): Promise<TerminalSession[]>;
    workers(): Promise<WorkerInfo[]>;
    create(conversationId: string, workerId?: WorkerId): Promise<TerminalSession>;
    attach(id: string): Promise<TerminalAttach>;
    write(id: string, data: string): Promise<void>;
    resize(id: string, cols: number, rows: number): Promise<void>;
    close(id: string): Promise<void>;
    /** A pane opened without the renderer asking — the model opened it. */
    onCreated(listener: (session: TerminalSession) => void): () => void;
    onData(listener: (event: TerminalData) => void): () => void;
    onExit(listener: (event: TerminalExit) => void): () => void;
  };
  browser: {
    create(conversationId: string, url?: string): Promise<BrowserTab>;
    navigate(id: string, url: string): Promise<void>;
    action(id: string, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<void>;
    /** Which tab the window is showing, for the agent's tab list. */
    setActive(id: string | null): Promise<void>;
    /** One-time URL the window may create this tab's page with. */
    attach(id: string): Promise<string>;
    /** The window is dropping this tab's page on purpose; the tab stays. */
    detach(id: string, nonce?: string): Promise<void>;
    control(id: string, mode: AgentControl): Promise<BrowserTab>;
    read(id: string): Promise<BrowserContent>;
    close(id: string): Promise<void>;
    onUpdate(listener: (tab: BrowserTab) => void): () => void;
    /** Site-created tabs and pages which close themselves. Optional for older dev preloads. */
    onLifecycle?(listener: (event: BrowserLifecycleEvent) => void): () => void;
    /** Optional during renderer hot updates against an older desktop preload. */
    onFocus?(listener: () => void): () => void;
    /** This chat's downloads: the list, what to do with one, and where they land. */
    downloads: {
      list(conversationId: string): Promise<BrowserDownload[]>;
      open(id: string): Promise<void>;
      reveal(id: string): Promise<void>;
      cancel(id: string): Promise<void>;
      /** Off the list; the file stays. */
      remove(id: string): Promise<void>;
      /** Every finished one off the list. */
      clear(conversationId: string): Promise<void>;
      /** The chat's attached folder, else the system Downloads folder. */
      folder(conversationId: string): Promise<string>;
      onChange(listener: (event: BrowserDownloadEvent) => void): () => void;
    };
    /** Design / Annotate. Human-only: no agent tool reaches these. */
    mode: {
      /** Needs Read or Full on the tab and a page that finished loading. Replaces another mode on the same tab. */
      arm(tabId: string, kind: PageModeKind): Promise<{ armId: string }>;
      /** Without armId, ends whatever is armed on the tab. */
      disarm(tabId: string, armId?: string): Promise<void>;
      /** Ends the current pick so the page highlights again; the mode stays armed. */
      release(tabId: string, armId: string): Promise<void>;
      /** A PNG of the page's viewport, or of `rect` inside it (page CSS pixels), saved in app data.
       *  While Annotate is armed, `annotations` lists the markers that picture shows. */
      capture(tabId: string, rect?: PageRect): Promise<{ path: string; annotations?: AnnotationShot }>;
      /** Text, with a capture this controller saved, onto the clipboard as one item. */
      copy(text: string, path?: string): Promise<void>;
      onEvent(listener: (event: PageModeEvent) => void): () => void;
    };
  };
}

declare global { interface Window { hello: HelloAPI; } }
