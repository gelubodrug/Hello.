import type { ContentSearch, FileDocument, FileListing } from './files';
import type { AnnotationShot } from './page-mode-format';
/** A chat's notebook has three sections: Runbooks, Tasks and Plans (the steps plan_write keeps). */
export type NotebookKind = 'runbook' | 'tasks' | 'plan';
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
/** A Pi extension installed for Pi itself (~/.pi/agent/extensions). */
export interface DiscoveredPlugin {
  id: string; name: string; description: string; source: string; path: string;
  /** Why Hello cannot import this one, when Pi's own folder holds something the import refuses. */
  unsupported?: string;
}
/** One skill in the catalog skills_find and the composer's / menu search: Hello's library, another agent's on this Mac, or skills.sh's. */
export interface CatalogSkill {
  /** `library:<resource id>`, `local:<folder>` or `skills.sh:<owner>/<repo>/<skill>`. */
  id: string;
  name: string;
  description: string;
  /** Where it lives, as a person would say it. */
  source: string;
  origin: 'library' | 'local' | 'online';
  installs?: number;
}
export interface CatalogSearch { local: CatalogSkill[]; online: CatalogSkill[]; onlineError?: string; }
export interface SkillUse {
  name: string;
  resourceId: string;
  /** False when the skill was already in the library. */
  imported: boolean;
  source: string;
}
export interface DiscoveredResources { mcp: DiscoveredMcpServer[]; skills: DiscoveredSkill[]; /** Optional for an older main. */ plugins?: DiscoveredPlugin[]; }
/** A model the endpoint offers, with the limits it publishes for it. */
export interface ModelChoice { id: string; contextWindow?: number; maxOutputTokens?: number; /** Costs nothing to ask: on a server of the person's own, or priced at zero by its provider (OpenRouter's `:free`). */ free?: boolean; }
/** One connection's models for the chat's picker: the one in use (unnamed until kept), a kept one, or a server running on this Mac. A connection that could not answer keeps its place with the reason. */
export interface ConnectionModels { name: string; endpointUrl: string; active: boolean; models: ModelChoice[]; error?: string; }
/** A model server found running on this Mac, named after what it is and the port it took. */
export interface LocalServer { name: string; endpointUrl: string; models: ModelChoice[]; }
/** A discovered voice server on this Mac: OpenAI-shaped speech or whisper.cpp. Discovery never takes ownership of the process. */
export interface VoiceServer { name: string; baseUrl: string; kind: 'speech' | 'whisper.cpp'; }
export interface McpServerStatus { id: string; name: string; connected: boolean; tools: string[]; error?: string | null; }
export interface ResourceChange { conversationId?: string }
/** The switches of a chat's notebook sections (user, 29.09). `planning` is
 *  Plans — the Plan switch, because a two-line request answered with a
 *  written plan is slower than the answer. All three are off in a new chat
 *  (user, 05.10) and on only when switched on. A section that is off stays
 *  in the notebook, quieter, and is invisible to the model and CLI workers —
 *  no tool, no export, nothing about it in what the model is told. */
export interface Conversation { id: string; title: string; folder: string | null; chatMode?: 'chat' | 'coder'; planning?: boolean; runbook?: boolean; tasks?: boolean;
  /** When the chat was last restarted: the model's memory begins here; what came before stays for the person. */
  freshFrom?: number;
  /** The model this chat runs on, on its connection: the last one used or picked in it (user, 04.10). Absent, the chat runs on the selection in Settings. */
  model?: ChatModel;
  createdAt: number; updatedAt: number; }
/** A model on the connection that serves it: the endpoint keys the stored API key. */
export interface ChatModel { endpointUrl: string; id: string; }
export interface ChatAttachment { id: string; name: string; kind: 'text' | 'image'; size: number; }
export interface ChatDropResult { folder?: string; attachments: ChatAttachment[]; }
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; durationMs?: number }
  | { type: 'tool'; id: string; name: string; input: string; output?: string; status: 'running' | 'complete' | 'error' | 'approval'; approvalId?: string; durationMs?: number };
export interface Message { id: string; conversationId: string; role: 'user' | 'assistant'; content: string; parts?: MessagePart[]; status: 'complete' | 'streaming' | 'error'; createdAt: number; error?: string | null; usage?: MessageUsage; runtimePhase?: 'starting' | 'working' | 'compacting' | 'retrying';
  /** Display-only history; never injected into the model prompt. */
  compactions?: Array<{ partIndex: number; tokensBefore: number; tokensAfter?: number }>;
  /** The model that wrote this reply, as it was selected when the reply began. */
  model?: string;
  /** Pi began this reply on its own, woken by a plugin (subagents finishing, say): what woke it, in a line. */
  startedBy?: string;
  /** How long the reply worked, across its retries: its activity says so. */
  workedMs?: number; }
/**
 * What a reply cost in tokens. input and output add up every call the reply
 * made — a tool step sends the whole context again — so they are its bill,
 * not its size; context is the prompt of its latest call: how full the
 * model's window is now.
 */
export interface MessageUsage { input: number; output: number; context?: number; cost?: number; }
/** Every reply's usage added up: in all, by the model that wrote it, and by chat (the costliest first). */
export interface UsageSummary {
  replies: number; input: number; output: number; cost: number;
  models: Array<{ model: string; replies: number; input: number; output: number; cost: number }>;
  chats: Array<{ conversationId: string; title: string; replies: number; input: number; output: number; cost: number }>;
}
/** A message that has the words searched for, and the words around them. */
export interface MessageMatch { conversationId: string; messageId: string; role: 'user' | 'assistant'; snippet: string; createdAt: number; }
export interface NotebookEntry { id: string; conversationId: string; kind: NotebookKind; title: string; body: string; createdAt: number; updatedAt: number; /** A Runbook chapter's own switch: the model and CLI workers see only the Runbook chapters that are on. Tasks and Plans are on or off as a whole and ignore it. */ shared: boolean; }
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
/** Voice uses existing local servers or engines installed with consent in Settings. */
export interface VoiceSettings { /** The one Voice switch. */ enabled: boolean; /** The speech-to-text server (whisper.cpp); unset, the first one found on this Mac. */ sttEndpointUrl?: string; /** The model that server is asked for; it belongs to that server and clears when it changes. */ sttModel?: string; /** The language the person speaks, as a short code (ro); unset, the server detects it. */ sourceLanguage?: string; /** The speech server; unset, the first one found on this Mac. */ ttsEndpointUrl?: string; /** A Kokoro voice id; unset, af_heart. It belongs to its server and clears when it changes. */ ttsVoice?: string; }
/** Whether macOS lets Hello use the microphone. */
export type MicrophoneAccess = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';
/** One spoken chunk, as the voice server made it. */
export interface VoiceSpeech { audio: Uint8Array; mime: string; }
export interface AppSettings { endpointUrl: string; model: string; apiKeySet: boolean; systemPrompt: string; temperature: number; /** Light, dark, or as macOS is (audit B2); unset is System. */ appearance?: 'system' | 'light' | 'dark'; reasoningEffort?: 'off' | 'low' | 'medium' | 'high'; contextWindow?: number; maxOutputTokens?: number; modelCompatibility?: 'auto' | 'openai' | 'qwen-chat-template'; approvals?: ApprovalMode; /** The model plugins' subagents run on (pi-subagents' subagents.defaultModel), on the chat's own connection and key; unset, the chat's model. It belongs to its connection and is cleared when the connection changes. */ subagentModel?: string; /** Endpoint and model the stored context/output numbers were resolved for. Main stamps it; a change means the limits must be looked up again. */ limitsFor?: string; /** How much of the published window main hands the runtime. Learned from what the provider reports, never edited by hand: a runtime that estimates its own context low needs to be told a smaller number. */ contextScale?: number; /** Voice, off unless the person turns it on. */ voice?: VoiceSettings; connections: SavedConnection[]; }
export type SettingsPatch = Partial<Omit<AppSettings, 'apiKeySet' | 'connections'>> & { apiKey?: string };
/** Where a message the person wrote during a run is meant to land. */
export type QueuedMode = 'steer' | 'next' | 'later';
/** Their words, waiting. Not part of the conversation until it is delivered. */
export interface QueuedMessage { id: string; conversationId: string; text: string; mode: QueuedMode; createdAt: number; }
export interface WorkerInfo { id: WorkerId; label: string; installed: boolean; usesActiveModel: boolean; }
export interface TerminalSession { id: string; conversationId: string; title: string; kind: 'terminal' | 'worker'; workerId?: WorkerId; cwd: string; status: 'running' | 'exited'; exitCode?: number; notebookContext?: boolean;
  /** The conversation this CLI can continue in a later launch (Claude Code, Pi): what brings a chat tab back after a restart. */
  session?: string; }
export interface TerminalData { id: string; data: string; sequence: number; }
/** A slash command a plugin added to a chat's Pi (its get_commands): `/name`, typed in the composer. */
export interface PluginCommand { name: string; description: string; }
export interface TerminalExit { id: string; exitCode: number; }
export interface TerminalAttach { session: TerminalSession; scrollback: string; sequence: number; }
/** One mark an agent left on a page for the person (browser_mark), in page CSS px. */
export interface TabMark { n: number; note: string; x: number; y: number; width: number; height: number;
  /** The CSS path of the element it marks: it follows that element, and finds it again after a reload. */
  path?: string; }
/** The marks left on one page of a tab, by its address without #. */
export interface TabMarks { url: string; marks: TabMark[]; }
export interface BrowserTab { id: string; conversationId: string; title: string; url: string; control: AgentControl; loading: boolean; progress: number | null; canGoBack: boolean; canGoForward: boolean; error?: string | null; pageOwned?: boolean; openerId?: string; sessionOnly?: boolean;
  /**
   * The marks an agent left for the person, page by page (user, 30.09: "tie
   * them to the link that made them, until reset"): each page shows its own
   * again when the tab comes back to it — Back, Forward, a restart — until the
   * person reloads it or clears them. The newest last, at most ten pages.
   */
  marks?: TabMarks[];
  /** Full because the model opened this tab for its work (user, 29.09), not because the human set it: not restored after a restart. */
  agentGranted?: boolean;
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
/** Something a chat waits for the person to answer before it can go on (audit
 *  A1): a tool asking for approval, or a plugin's question. Main's own runtime
 *  registers, never parsed from what was said; none survives a restart. */
export interface PendingRequest {
  requestId: string;
  conversationId: string;
  kind: 'approval' | 'question';
  createdAt: number;
  expiresAt?: number;
  /** In a few words: the tool, or the plugin's title. */
  label: string;
  /** Where it is answered: the reply and its tool step, or the plugin's dialog. */
  target: { messageId: string; toolPartId: string } | { dialogId: string };
}
/** Every request open now; a later revision always wins over an earlier one. */
export interface PendingInput { revision: number; requests: PendingRequest[] }
/** What an app menu item asks the window for (src/main/index.ts): ⌘N a new chat,
 *  ⌘B the sidebar, ⌘⇧] / ⌘⇧[ the next or previous chat, ⌘J the next chat
 *  waiting, ⌘1–9 a chat by its place in the list (S209). */
export type MenuAction = 'new-chat' | 'toggle-sidebar' | 'go-to' | 'next-chat' | 'previous-chat' | 'attention-chat'
  | `chat-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;
/** The waiting list after main changed it on its own: a steer said, a held message delivered. */
export interface ChatQueueEvent { conversationId: string; items: QueuedMessage[]; }
/**
 * What the plugins active in a chat show while its Pi runs headless (user,
 * 29.09): Pi's extension UI as it travels over RPC — text widgets, status
 * lines, notifications and questions. Every word is the plugin's.
 */
export interface ExtensionWidget { key: string; lines: string[]; placement: 'aboveEditor' | 'belowEditor'; }
export interface ExtensionNotice { id: string; message: string; kind: 'info' | 'warning' | 'error'; at: number; }
export interface ExtensionDialog { id: string; method: 'select' | 'confirm' | 'input' | 'editor'; title: string; message?: string; options?: string[]; placeholder?: string; prefill?: string; /** When Pi answers it by itself. */ expiresAt?: number; }
export interface ExtensionUiState { conversationId: string; widgets: ExtensionWidget[]; statuses: Array<{ key: string; text: string }>; notices: ExtensionNotice[]; dialogs: ExtensionDialog[]; /** Text a plugin put in the composer, and when. */ editorText?: { text: string; at: number }; }
export type ExtensionAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };
export interface NotebookPaths { runbook: string; tasks: string; plan: string; }
export interface Bootstrap { conversations: Conversation[]; settings: AppSettings; workers: WorkerInfo[]; terminals: TerminalSession[]; browsers: BrowserTab[]; dataPath: string; version: string; extensionsCount: number; }

export interface HelloAPI {
  files: {
    list(conversationId: string, path?: string, search?: string): Promise<FileListing>;
    read(conversationId: string, path: string): Promise<FileDocument>;
    open(conversationId: string, path: string): Promise<void>;
    reveal(conversationId: string, path: string): Promise<void>;
    resolvePaths(conversationId: string, paths: string[]): Promise<string[]>;
    /** The lines of the chat's folder that hold the words (audit A3b). Optional for an older preload. */
    searchContents?(conversationId: string, requestId: string, query: string, options?: { matchCase?: boolean }): Promise<ContentSearch>;
    /** Stops the chat's search of the contents, if one runs. */
    cancelSearch?(conversationId: string): Promise<void>;
  };
  bootstrap(): Promise<Bootstrap>;
  conversations: {
    list(): Promise<Conversation[]>;
    create(title?: string): Promise<Conversation>;
    update(id: string, patch: { title?: string; folder?: string | null; chatMode?: 'chat' | 'coder'; planning?: boolean; runbook?: boolean; tasks?: boolean; model?: ChatModel | null }): Promise<Conversation>;
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
    /** What replies have cost and how many tokens they moved, in all, by model and by chat. Optional for an older preload. */
    usage?(): Promise<UsageSummary>;
    /** Model servers running on this Mac, looked for afresh. */
    localServers(): Promise<LocalServer[]>;
    /** Voice servers running on this Mac, from the same look. Optional for an older preload. */
    voiceServers?(): Promise<VoiceServer[]>;
    /** Keeps the endpoint and model as currently saved under a name. */
    rememberConnection(name: string): Promise<AppSettings>;
    /** Makes a remembered connection the active endpoint and model. */
    useConnection(endpointUrl: string): Promise<AppSettings>;
    /** Drops a remembered connection and the key stored for its endpoint. */
    forgetConnection(endpointUrl: string): Promise<AppSettings>;
  };
  /** Persistent work-pane tab order. Optional for an older preload. */
  workspace?: {
    toolOrder(conversationId: string): Promise<string[]>;
    saveToolOrder(conversationId: string, order: string[]): Promise<string[]>;
  };
  /** Voice. Optional for an older preload. */
  voice?: {
    status?(): Promise<import('./voice-setup').VoiceSetupStatus | undefined>;
    prepare?(consent: boolean): Promise<{ status: import('./voice-setup').VoiceSetupStatus; settings: AppSettings }>;
    cancel?(): Promise<void>;
    stopSpeech?(): Promise<void>;
    onStatus?(listener: (status: import('./voice-setup').VoiceSetupStatus) => void): () => void;
    /** One microphone WAV, translated locally into an English turn. */
    translate?(audio: Uint8Array): Promise<string>;
    /** One chunk of prose as audio, from the voice server on this Mac. */
    speak(text: string): Promise<VoiceSpeech>;
    /** What macOS says about the microphone, without asking. */
    microphone?(): Promise<MicrophoneAccess>;
  };
  chat: { attach(conversationId: string, paths: string[]): Promise<ChatDropResult>;
    /** The picture on the clipboard, read by main and kept like a dropped image. Optional for an older preload. */
    attachClipboard?(conversationId: string): Promise<ChatDropResult>;
    /** What every chat waits for the person to answer, now. Optional for an older preload. */
    pendingInput?(): Promise<PendingInput>;
    /** The same, again, whenever it changes. Optional for an older preload. */
    onPendingInput?(listener: (state: PendingInput) => void): () => void; /** A data: URL of one of this chat's image attachments. */ previewAttachment(conversationId: string, attachmentId: string): Promise<string>; send(conversationId: string, text: string, attachmentIds?: string[]): Promise<void>; queue(conversationId: string, text: string, mode: QueuedMode): Promise<QueuedMessage[]>; queued(conversationId: string): Promise<QueuedMessage[]>; reviseQueued(id: string, patch: { text?: string; mode?: QueuedMode }): Promise<QueuedMessage[]>; /** A row that is already gone is not an error: the chat's current list comes back. */ dropQueued(id: string, conversationId?: string): Promise<QueuedMessage[]>; stop(conversationId: string): Promise<void>; retry(conversationId: string): Promise<void>; approve(approvalId: string, allow: boolean): Promise<void>; onEvent(listener: (event: ChatEvent) => void): () => void; onQueue?(listener: (event: ChatQueueEvent) => void): () => void; /** What the chat's plugins show. Optional for an older preload. */ extensionUi?(conversationId: string): Promise<ExtensionUiState>; onExtensionUi?(listener: (state: ExtensionUiState) => void): () => void; /** Answers a plugin's question. */ answerExtension?(conversationId: string, dialogId: string, answer: ExtensionAnswer): Promise<void>; /** The slash commands the chat's plugins added, as its running Pi last said; null before it ever ran. */ commands?(conversationId: string): Promise<PluginCommand[] | null>; /** Summarises the conversation now, as Pi does by itself near the limit. Optional for an older preload. */ compact?(conversationId: string): Promise<{ tokensBefore: number; tokensAfter?: number }>; };
  notebooks: { list(conversationId: string, kind: NotebookKind): Promise<NotebookEntry[]>; save(input: { id?: string; conversationId: string; kind: NotebookKind; title: string; body: string; expectedUpdatedAt?: number }): Promise<NotebookEntry>; delete(id: string): Promise<void>; /** A chapter's switch. Leaves its revision alone, so an open draft stays valid. Optional for an older preload. */ share?(id: string, shared: boolean): Promise<NotebookEntry>; paths(conversationId: string): Promise<NotebookPaths>; onChange?(listener: (event: NotebookChange) => void): () => void; };
  extensions: {
    list(): Promise<LibraryResource[]>;
    importResource(kind: 'skill' | 'plugin'): Promise<LibraryResource | null>;
    examples(): Promise<Array<{ kind: 'skill' | 'plugin'; name: string; description: string }>>;
    importExample(kind: 'skill' | 'plugin', name: string): Promise<LibraryResource>;
    addMcp(input: McpServerInput): Promise<LibraryResource>;
    /** MCP servers and skills found in other agent tools' own configuration. */
    discover(): Promise<DiscoveredResources>;
    importDiscovered(kind: 'mcp' | 'skill' | 'plugin', id: string): Promise<LibraryResource>;
    update(id: string): Promise<LibraryResource>;
    remove(id: string): Promise<void>;
    active(conversationId: string): Promise<string[]>;
    setActive(conversationId: string, resourceId: string, active: boolean): Promise<string[]>;
    status(): Promise<McpServerStatus[]>;
    probe(id: string): Promise<McpServerStatus>;
    disconnect(id: string): Promise<void>;
    onChange(listener: (event: ResourceChange) => void): () => void;
  };
  /** Every skill in one place (skill-catalog.ts). Optional for an older preload. */
  skills?: {
    /** Hello's library, then every skill another agent on this Mac keeps. */
    list(): Promise<CatalogSkill[]>;
    search(query: string, online: boolean): Promise<CatalogSearch>;
    /** Copies it into the library when it is not there, and turns it on for the chat. */
    use(id: string, conversationId: string): Promise<SkillUse>;
  };
  system: { chooseFolder(): Promise<string | null>;
    /** Files to attach, from the native picker: their paths, or null when cancelled. Optional for an older preload. */
    chooseFiles?(): Promise<string[] | null>; pathsForFiles(files: File[]): string[]; openExternal(url: string): Promise<void>; revealPath(path: string): Promise<void>; copy(content: { text: string; html?: string }): Promise<void>;
    /** A macOS notification about one chat; clicking it brings that chat forward. Optional for an older preload. */
    notify?(input: { title: string; body: string; conversationId: string }): Promise<boolean>;
    /** The number on the Dock icon: chats waiting for the person. 0 clears it. */
    badge?(count: number): Promise<void>;
    /** A notification was clicked: the chat it was about. */
    onFocusConversation?(listener: (conversationId: string) => void): () => void;
    /** An item of the app menu, by its key. Optional for an older preload. */
    onMenu?(listener: (action: MenuAction) => void): () => void;
    /** The app's window gained or lost the OS focus. */
    onWindowFocus?(listener: (focused: boolean) => void): () => void; };
  terminal: {
    list(): Promise<TerminalSession[]>;
    workers(): Promise<WorkerInfo[]>;
    /** `session`: continue that conversation of the CLI, the one a chat tab had before a restart. */
    create(conversationId: string, workerId?: WorkerId, session?: string): Promise<TerminalSession>;
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
  /** The DSH surface: dsh's own client, hosted by Hello. Optional for an older preload. */
  dsh?: {
    status(): Promise<DshStatus>;
    /** Resolves npm latest and installs the dsh runtime into the app's data folder. */
    install(): Promise<DshStatus>;
    start(): Promise<DshStatus>;
    stop(): Promise<DshStatus>;
    restart(): Promise<DshStatus>;
    /** One-time URL the window may create the surface's page with. */
    attach(): Promise<string>;
    /** The window is dropping the page it created with this nonce. */
    detach(nonce: string): Promise<void>;
    reload(): Promise<void>;
    revealLogs(): Promise<void>;
    /** Installs the newer dsh npm offers and runs it. Optional for an older preload. */
    update?(): Promise<DshStatus>;
    onStatus(listener: (status: DshStatus) => void): () => void;
    /** A web link the surface's page wanted to open. */
    onOpenLink(listener: (url: string) => void): () => void;
  };
  /** The Pi package market: the same window over Pi packages, installed into Hello's library. Optional for an older preload. */
  piMarket?: MarketApi;
  /** The Pi Hello's chats run on, and its updates. Optional for an older preload. */
  piEngine?: {
    status(): Promise<PiEngineStatus>;
    /** Installs the newer Pi npm offers; chats move to it on their next message. */
    update(): Promise<PiEngineStatus>;
    /** Goes back to the Pi this Hello came with. */
    useBundled(): Promise<PiEngineStatus>;
    onStatus(listener: (status: PiEngineStatus) => void): () => void;
  };
}

/** The Pi engine: the one running, the one Hello came with, and a newer one npm offers. */
export interface PiEngineStatus {
  version: string;
  bundled: string;
  /** Newer than `version`, when npm has one. */
  latest?: string;
  state: 'idle' | 'updating' | 'failed';
  message?: string;
}

/** Which market a window shows. */
export type MarketKind = 'pi';
/** The Pi market's handles. */
export interface MarketApi {
  sources(): Promise<MarketSource[]>;
  query(query: MarketQuery): Promise<MarketPage>;
  /** An item's icon as a data URL, fetched and re-encoded by main; null when there is none. */
  icon(ref: string): Promise<string | null>;
  installed(): Promise<MarketInstalledPlugin[]>;
  preview(key: string): Promise<MarketPreview>;
  previewByName(name: string): Promise<MarketPreview>;
  previewUninstall(packageName: string): Promise<MarketPreview>;
  /** Moving an installed package to npm's newest version, from the Installed list. Optional for an older preload. */
  previewUpdate?(packageName: string): Promise<MarketPreview>;
  confirm(token: string): Promise<MarketResult>;
}

/** The Pi package market. */
export interface MarketSource { id: string; name: string; description: string; homepage: string; endpointHost: string; builtIn: boolean; partner: boolean; selected: boolean; available: boolean; /** In the person's list; a built-in partner is offered to add until then. Absent from an older main: treat as added. */ added?: boolean; attribution: { name: string; url: string; notice: string }; }
export interface MarketItem { key: string; name: string; summary: string; publisher?: string; categories: string[]; repository: string; installable: boolean; manualCommand?: string; sourceName: string; icon?: string; installs: number; stars: number; updatedAt?: string; }
export interface MarketPage { items: MarketItem[]; total: number; /** Every entry the source holds, when a filter narrows `total`. */ unfiltered?: number; nextCursor?: string; categories: string[]; generatedAt?: string; }
export interface MarketQuery { q?: string; category?: string; /** Several category filters, when supplied by a caller. */ categories?: string[]; sort?: 'downloads' | 'updated' | 'name' | 'stars'; cursor?: string; limit?: number; installable?: boolean; reload?: boolean; }
export interface MarketInstalledPlugin { packageName: string; version: string; kind: 'plugin' | 'hello' | 'product'; bundle: boolean; /** npm's newest stable version, when it is newer than the one installed. */ latest?: string; }
export type MarketAction = 'install' | 'uninstall' | 'update';
export interface MarketPreview { token: string; action: MarketAction; displayName: string; packageName: string; version?: string; /** For an update: the version installed now. */ from?: string; folder?: string; profile: string; expiresAt: number; compatibility: { ok: boolean; reason?: string }; hello?: { ui: boolean; skills: boolean; mcp: boolean; lines: string[] }; }
export interface MarketResult { action: MarketAction; packageName: string; version?: string; installedAt: number; }

/** absent: never installed · installing · stopped · starting · running · stopping · failed. */
export type DshState = 'absent' | 'installing' | 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
export interface DshStatus {
  state: DshState;
  /** The installed version, or latest before the first install. */
  version: string;
  /** Newer than `version`, when npm has one. */
  latest?: string;
  /** Why the last switch of version failed; gone with the next one. */
  updateError?: string;
  /** The dsh version on disk, when there is one. */
  installedVersion?: string;
  progress?: {
    resolved: number;
    downloaded: number;
    added: number;
    /** What pnpm said it would add (`Packages: +N`): what "added" counts towards. */
    total?: number;
    /** Every package is in place; what remains is finishing. */
    done?: boolean;
    /** pnpm's latest word, in the person's terms: a retry, a slow download, a build. */
    activity?: string;
    /** When pnpm last printed anything, and when the install began (ms since epoch). */
    at?: number;
    startedAt?: number;
  };
  /** Why the surface failed, or what it is doing, in the person's words. */
  message?: string;
  startedAt?: number;
  profileDir: string;
  logFile: string;
  /** Plugin entries dsh's client could not activate on its last boot. */
  bootFailure?: string[];
}

declare global { interface Window { hello: HelloAPI; } }
