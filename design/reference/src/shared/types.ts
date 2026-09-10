/**
 * Shared domain types for the renderer, main, and preload processes.
 * Mirrors specs/spec-20260819-195833z-agent-specification-2e520baa4e/data-model.md
 * and contracts/ipc.md. Error taxonomy lives in errors.ts, IPC method
 * signatures in ipc-contract.ts.
 */

import type { RequestDiagnostic } from './errors';

export type MessageRole = 'system' | 'user' | 'assistant';
export type EndpointSource = 'discovered' | 'manual';
export type ThemePreference = 'system' | 'light' | 'dark';
export type ReducedMotionPreference = 'auto' | 'on' | 'off';

export interface GenerationSettings {
  temperature: number;
  maxTokens: number | null;
  timeoutMs: number;
  extra?: Record<string, unknown>;
}

export interface Endpoint {
  id: string;
  displayName: string;
  baseUrl: string;
  hasApiKey: boolean;
  customHeaders: Record<string, string>;
  timeoutMs: number;
  defaults: GenerationSettings;
  verifiedAt: number | null;
  source: EndpointSource;
}

export interface EndpointInput {
  id?: string;
  displayName: string;
  baseUrl: string;
  customHeaders?: Record<string, string>;
  timeoutMs?: number;
  defaults?: Partial<GenerationSettings>;
}

export interface EndpointVerification {
  endpointId: string;
  ok: boolean;
  verifiedAt: number | null;
  modelsSupported: boolean;
  error?: string;
  /** What the probe sent and what came back, on a failure. Carries no credential. */
  diagnostic?: RequestDiagnostic;
}

export interface Model {
  id: string;
  displayName?: string;
  endpointId: string;
  source: EndpointSource;
  verifiedAt: number | null;
  /**
   * Whether the model takes images: `true`/`false` when the endpoint said so
   * (or a rejected request proved it), `null` when nothing is known — plain
   * OpenAI-compatible servers advertise no such thing.
   */
  vision: boolean | null;
}

export interface MessageMetrics {
  ttftMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  tokensPerSec?: number;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  endpointId: string;
  modelId: string;
  settings: GenerationSettings;
  metrics: MessageMetrics | null;
  orderIndex: number;
}

export interface MessagePatch {
  content?: string;
  metrics?: MessageMetrics | null;
}

export interface RunbookEntry {
  id: string;
  conversationId: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export type RunbookContextSource = 'conversation' | 'none';

export type RunbookContextReason =
  'included' | 'available' | 'noConversation' | 'emptyRunbook' | 'budgetTruncated';

/** Read-only context owned by the conversation and attached to one turn. */
export interface RunbookContextStatus {
  conversationId: string | null;
  source: RunbookContextSource;
  /** Entries represented, or known to exist when `reason` is `available`. */
  entryCount: number;
  includedEntryIds: string[];
  /** Entries omitted entirely or represented with a truncated body. */
  omittedEntryCount: number;
  /** Exact character count of the injected runbook section or availability note. */
  charCount: number;
  maxChars: number;
  reason: RunbookContextReason;
}

export interface NewMessage {
  role: MessageRole;
  content: string;
  endpointId: string;
  modelId: string;
  settings: GenerationSettings;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  endpointId: string;
  modelId: string;
  settings: GenerationSettings;
  messages: Message[];
  mode: ConversationMode;
  incompleteStream: boolean;
  groupId: string | null;
  groupName: string | null;
  /**
   * The folder a Coder turn in this conversation runs in. Stamped the first
   * time one runs, so reopening the chat later resumes in the same place;
   * null means it has none yet and follows the last folder the user picked.
   */
  coderRoot: string | null;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  endpointId: string;
  modelId: string;
  mode: ConversationMode;
  incompleteStream: boolean;
  groupId: string | null;
  groupName: string | null;
}

/**
 * Which engine a conversation talks to, fixed when it is made.
 *
 * It used to be a session-wide switch, which let one thread be answered partly
 * by the chat endpoint and partly by the headless agent with nothing recording
 * which. Choosing at creation is what "New chat" and "New coder" mean.
 */
export type ConversationMode = 'chat' | 'coder';

export interface NewConversationInput {
  title?: string;
  endpointId: string;
  modelId: string;
  settings: GenerationSettings;
  /** Defaults to chat, which is also how every pre-existing row reads. */
  mode?: ConversationMode;
}

export interface ConversationGroup {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

/** Resources that may be filed under a project for sidebar organization only. */
export type ProjectMemberKind = 'terminal' | 'browser-tab';

export interface ProjectMember {
  kind: ProjectMemberKind;
  /** The main process's terminal session id, or the browser tab id. */
  id: string;
  addedAt: number;
}

/**
 * A bound folder and whether it is still one. The three ways a binding goes
 * stale — deleted, renamed away, replaced by a file — collapse into `missing`
 * because they are the same sentence to whoever has to render it.
 */
export interface ProjectFolder {
  path: string;
  missing: boolean;
}

/**
 * A project is a named conversation group with an optional working folder and
 * a runbook. Terminal/tab entries are only visual sidebar filing: they stay
 * global and never inherit project identity, visibility or runbook context.
 */
export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** null for a project that binds no folder, which is every project by default. */
  folder: ProjectFolder | null;
  /** Its chats, in the order the sidebar shows them. */
  conversationIds: string[];
  /** Optional visual filing for global terminals and tabs. */
  members: ProjectMember[];
}

export interface NewProjectInput {
  name: string;
  /** Optional from the start: a project is a name first and a folder second. */
  folderPath?: string | null;
}

/**
 * Which engine answers this send. `chat` goes to the OpenAI-compatible
 * endpoint; `coder` goes to the headless coding agent, which keeps its own
 * history and works inside the folder granted for Terminal access.
 */
export type CompletionMode = 'chat' | 'coder';

export interface StartCompletionInput {
  conversationId: string;
  endpointId: string;
  modelId: string;
  messages: Array<{ role: MessageRole; content: string }>;
  settings: GenerationSettings;
  /** Absent means `chat`, so an older caller keeps the behaviour it had. */
  mode?: CompletionMode;
  /**
   * Arms the AI Mode browsing toolset for this completion (T143). Set only
   * by an omnibox AI Mode query; a normal chat send omits it and behaves
   * exactly as before.
   */
  aiMode?: boolean;
}

export interface WindowState {
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  fullscreen: boolean;
}

export interface AppPreferences {
  windows: {
    main: WindowState;
  };
  activeEndpointId: string | null;
  activeModelId: string | null;
  theme: ThemePreference;
  reducedMotion: ReducedMotionPreference;
  keyTxtDetected: boolean;
}
