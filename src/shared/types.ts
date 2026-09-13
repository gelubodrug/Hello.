import type { FileDocument, FileListing } from './files';
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
export interface McpServerStatus { id: string; name: string; connected: boolean; tools: string[]; error?: string | null; }
export interface ResourceChange { conversationId?: string }
export interface Conversation { id: string; title: string; folder: string | null; chatMode?: 'chat' | 'coder'; createdAt: number; updatedAt: number; }
export interface ChatAttachment { id: string; name: string; kind: 'text' | 'image'; size: number; }
export interface ChatDropResult { folder?: string; attachments: ChatAttachment[]; }
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; durationMs?: number }
  | { type: 'tool'; id: string; name: string; input: string; output?: string; status: 'running' | 'complete' | 'error' | 'approval'; approvalId?: string; durationMs?: number };
export interface Message { id: string; conversationId: string; role: 'user' | 'assistant'; content: string; parts?: MessagePart[]; status: 'complete' | 'streaming' | 'error'; createdAt: number; error?: string | null; usage?: { input: number; output: number }; runtimePhase?: 'starting' | 'working' | 'compacting' | 'retrying'; }
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
export interface BrowserTab { id: string; conversationId: string; title: string; url: string; control: AgentControl; loading: boolean; canGoBack: boolean; canGoForward: boolean; error?: string | null; pageOwned?: boolean; openerId?: string; sessionOnly?: boolean;
  /** Bumped when the page must be re-created; the renderer keys its guest on it. */
  generation?: number;
  /** The isolated session a generated preview runs in, chosen by the main process. */
  partition?: string;
  /** How to produce this page again: `artifact:<id>` for a generated document,
   *  or a path inside the chat's folder. A local URL dies with the app; a
   *  handle does not, so this is what a tab is saved by. */
  source?: string; }
export type BrowserLifecycleEvent =
  | { type: 'opened'; tab: BrowserTab; foreground: boolean; userRequested?: boolean }
  | { type: 'closed'; id: string; conversationId: string; openerId?: string };
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
  | { type: 'exit'; tabId: string; armId: string; reason: PageModeExitReason };
/** What a browser pane hands the chat composer besides words. */
export interface ChatQuoteExtra {
  attachments?: ChatAttachment[];
  /** Insert the text as written rather than as a block quote. */
  verbatim?: boolean;
}
export interface ChatQuote extends ChatQuoteExtra { text: string; }
export interface ChatEvent { conversationId: string; message: Message; }
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
    update(id: string, patch: { title?: string; folder?: string | null; chatMode?: 'chat' | 'coder' }): Promise<Conversation>;
    delete(id: string): Promise<void>;
    messages(id: string): Promise<Message[]>;
    export(id: string): Promise<string | null>;
  };
  settings: {
    get(): Promise<AppSettings>;
    save(patch: SettingsPatch): Promise<AppSettings>;
    models(): Promise<ModelChoice[]>;
    /** Keeps the endpoint and model as currently saved under a name. */
    rememberConnection(name: string): Promise<AppSettings>;
    /** Makes a remembered connection the active endpoint and model. */
    useConnection(endpointUrl: string): Promise<AppSettings>;
    /** Drops a remembered connection and the key stored for its endpoint. */
    forgetConnection(endpointUrl: string): Promise<AppSettings>;
  };
  chat: { attach(conversationId: string, paths: string[]): Promise<ChatDropResult>; send(conversationId: string, text: string, attachmentIds?: string[]): Promise<void>; queue(conversationId: string, text: string, mode: QueuedMode): Promise<QueuedMessage[]>; queued(conversationId: string): Promise<QueuedMessage[]>; reviseQueued(id: string, patch: { text?: string; mode?: QueuedMode }): Promise<QueuedMessage[]>; dropQueued(id: string): Promise<QueuedMessage[]>; stop(conversationId: string): Promise<void>; retry(conversationId: string): Promise<void>; approve(approvalId: string, allow: boolean): Promise<void>; onEvent(listener: (event: ChatEvent) => void): () => void; };
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
  system: { chooseFolder(): Promise<string | null>; pathsForFiles(files: File[]): string[]; openExternal(url: string): Promise<void>; revealPath(path: string): Promise<void>; copy(content: { text: string; html?: string }): Promise<void>; };
  terminal: {
    list(): Promise<TerminalSession[]>;
    workers(): Promise<WorkerInfo[]>;
    create(conversationId: string, workerId?: WorkerId): Promise<TerminalSession>;
    attach(id: string): Promise<TerminalAttach>;
    write(id: string, data: string): Promise<void>;
    resize(id: string, cols: number, rows: number): Promise<void>;
    close(id: string): Promise<void>;
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
    /** Design / Annotate. Human-only: no agent tool reaches these. */
    mode: {
      /** Needs Read or Full on the tab and a page that finished loading. Replaces another mode on the same tab. */
      arm(tabId: string, kind: PageModeKind): Promise<{ armId: string }>;
      /** Without armId, ends whatever is armed on the tab. */
      disarm(tabId: string, armId?: string): Promise<void>;
      /** Ends the current pick so the page highlights again; the mode stays armed. */
      release(tabId: string, armId: string): Promise<void>;
      /** A PNG of the page's viewport, or of `rect` inside it (page CSS pixels), saved in app data. */
      capture(tabId: string, rect?: PageRect): Promise<{ path: string }>;
      /** Text, with a capture this controller saved, onto the clipboard as one item. */
      copy(text: string, path?: string): Promise<void>;
      onEvent(listener: (event: PageModeEvent) => void): () => void;
    };
  };
}

declare global { interface Window { hello: HelloAPI; } }
