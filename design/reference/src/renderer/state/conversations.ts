import { createStore } from 'zustand/vanilla';

import type { AppError, RequestDiagnostic } from '../../shared/errors';
import type {
  AgentAction,
  Api,
  BrowserScreenshotCapture,
  ChatStreamEvent,
  ConversationGroup,
  ConversationExportResult,
} from '../../shared/ipc-contract';
import type {
  CompletionMode,
  Conversation,
  ConversationMode,
  ConversationSummary,
  GenerationSettings,
  Message,
  MessageRole,
  RunbookContextStatus,
} from '../../shared/types';
import { endpointsStore } from './endpoints';

/** A terminal 'error' or 'aborted' stream event, tied to the assistant
 * message it happened on so the UI can attach an inline affordance to it. */
export interface StreamFailure {
  messageId: string;
  kind: 'error' | 'aborted';
  message: string;
  /**
   * The normalized cause behind an 'error' failure, kept so the banner can
   * name what actually went wrong — an 'auth' failure asks for the API key
   * rather than blaming the request (T147, DESIGNUIguide.md §Errors).
   */
  errorType?: AppError['type'];
  /**
   * The request as it actually happened — URL, status, response body, how
   * long it took. The banner's sentence names the class of failure; only this
   * separates a dead upstream from a wrong key or a wrong base URL.
   */
  diagnostic?: RequestDiagnostic;
}

/**
 * One step the agent took while driving the browser pane (T143 §6), or one
 * web search (T137). Session-only: the transcript shows what just happened,
 * the persisted message keeps only the answer.
 */
export interface AgentStep {
  id: string;
  tool: 'web_search' | 'browser' | 'shell' | 'mcp';
  action?: AgentAction;
  /** Verb + target, already human-readable. Never a value typed into a field. */
  label: string;
  status: 'running' | 'done' | 'failed';
  message?: string;
  /** True while an irreversible action is announced but not yet done. */
  willSubmit?: boolean;
  /** A shell step's command, verbatim, and what it printed. */
  command?: string;
  output?: string;
  exitCode?: number;
}

/**
 * What is happening to the message the user just sent. Until this existed the
 * only sign of life between Send and the first token was a blinking caret at
 * the end of an empty bubble — indistinguishable from a request that had
 * silently died.
 */
export type StreamPhase = 'sending' | 'waiting' | 'working' | 'writing';

export interface StreamStatus {
  /** The assistant message being filled in. */
  messageId: string;
  phase: StreamPhase;
  /** When this phase began, for the elapsed counter. */
  since: number;
}

export interface ConversationsState {
  summaries: ConversationSummary[];
  activeId: string | null;
  activeConversation: Conversation | null;
  loading: boolean;
  streamId: string | null;
  streamError: string | null;
  /** Live status of the in-flight turn; null when nothing is running. */
  streamStatus: StreamStatus | null;
  lastStreamFailure: StreamFailure | null;
  /** Ids of messages after an edited user turn, until regenerated from that point. */
  staleMessageIds: Set<string>;
  /** Agent/search steps by assistant message id (T137 + T143). Not persisted. */
  agentSteps: Record<string, AgentStep[]>;
  /**
   * Whether the project runbook reached the model on a turn, by assistant
   * message id. Main decides and reports it per turn (`runbook_context`);
   * the renderer only displays what it was told. Not persisted — it
   * describes one live turn, like `agentSteps`.
   */
  runbookContext: Record<string, RunbookContextStatus>;

  refreshList(): Promise<void>;
  /** Title + message-content search, delegated to the SQLite FTS index. */
  searchConversations(query: string): Promise<ConversationSummary[]>;
  selectConversation(id: string | null): Promise<void>;
  newConversation(input: {
    endpointId: string;
    modelId: string;
    settings: GenerationSettings;
    title?: string;
    /** Fixed at creation; there is no switch to change it afterwards. */
    mode?: ConversationMode;
  }): Promise<Conversation | null>;
  send(text: string, options?: { aiMode?: boolean }): Promise<void>;
  /**
   * Sends a query from the omnibox AI Mode chip (T143): a normal turn, with
   * the browsing toolset armed for this completion only.
   */
  sendAiModeQuery(text: string): Promise<void>;
  retryLast(): Promise<void>;
  stop(): Promise<void>;
  editUserMessage(id: string, newText: string): Promise<void>;
  /** Renames any conversation and updates the local sidebar summary. */
  renameConversation(id: string, title: string): Promise<void>;
  /** Removes any conversation; deleting the active one returns to empty state. */
  removeConversation(id: string): Promise<void>;
  /** Creates a group; it appears in the sidebar once a chat joins it. */
  createGroup(name: string): Promise<ConversationGroup | null>;
  renameGroup(groupId: string, name: string): Promise<void>;
  /** Moves conversations into the group with this id. */
  addToGroup(groupId: string, ids: string[]): Promise<void>;
  removeFromGroup(ids: string[]): Promise<void>;
  /**
   * Mirrors the folder Coder mode will work in for this conversation after the
   * user has picked one. Main has already stored it; this keeps the composer's
   * folder chip from describing the folder the chat used to run in.
   */
  setCoderRoot(id: string, root: string | null): void;
  /**
   * Appends a browser-pane screenshot (T111) to the active conversation as a
   * user message whose content is a Markdown image pointing at the saved
   * `attachment://` file. No completion is started; the image simply joins
   * the transcript.
   */
  attachScreenshot(capture: BrowserScreenshotCapture): Promise<void>;
  regenerateFromMessage(id: string): Promise<void>;
  /** Exports a specific conversation to Markdown via the native save dialog. */
  exportConversation(id: string): Promise<ConversationExportResult>;
  /** Exports the active conversation to Markdown via the main-process save dialog. */
  exportActiveConversation(): Promise<ConversationExportResult>;
}

type ConversationsApi = Pick<Api, 'conversations' | 'chat'>;
type ConversationsStore = ReturnType<typeof createConversationsStore>;

/** Renderer-local pointer to the chat that was open when the app last ran. */
const LAST_ACTIVE_CONVERSATION_KEY = 'conversations:last-active';

function readLastActiveConversationId(): string | null {
  try {
    return typeof window === 'undefined'
      ? null
      : window.localStorage.getItem(LAST_ACTIVE_CONVERSATION_KEY);
  } catch {
    return null;
  }
}

function rememberActiveConversationId(id: string): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LAST_ACTIVE_CONVERSATION_KEY, id);
    }
  } catch {
    // Storage can be unavailable; the newest conversation remains the fallback.
  }
}

function getApi(): ConversationsApi | null {
  if (typeof window === 'undefined' || !('api' in window)) {
    return null;
  }

  return window.api;
}

function toSummary(conversation: Conversation): ConversationSummary {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    endpointId: conversation.endpointId,
    modelId: conversation.modelId,
    mode: conversation.mode,
    incompleteStream: conversation.incompleteStream,
    groupId: conversation.groupId,
    groupName: conversation.groupName,
  };
}

function insertSummaryAtHead(
  summaries: ConversationSummary[],
  summary: ConversationSummary,
): ConversationSummary[] {
  return [summary, ...summaries.filter((entry) => entry.id !== summary.id)];
}

function replaceSummary(
  summaries: ConversationSummary[],
  summary: ConversationSummary,
): ConversationSummary[] {
  const index = summaries.findIndex((entry) => entry.id === summary.id);
  if (index === -1) {
    return [summary, ...summaries];
  }

  const next = summaries.slice();
  next[index] = summary;
  return next;
}

function updateConversationMessage(
  conversation: Conversation | null,
  conversationId: string,
  messageId: string,
  updater: (message: Message) => Message,
): Conversation | null {
  if (!conversation || conversation.id !== conversationId) {
    return conversation;
  }

  return {
    ...conversation,
    messages: conversation.messages.map((message) =>
      message.id === messageId ? updater(message) : message,
    ),
  };
}

function mergeMetaIntoMetrics(
  metrics: Message['metrics'],
  event: Extract<ChatStreamEvent, { type: 'meta' }>,
): Message['metrics'] {
  const next = { ...(metrics ?? {}) };

  if (event.ttftMs !== undefined) {
    next.ttftMs = event.ttftMs;
  }

  if (event.tokensPerSec !== undefined) {
    next.tokensPerSec = event.tokensPerSec;
  }

  if (event.promptTokens !== undefined) {
    next.tokensIn = event.promptTokens;
  }

  if (event.completionTokens !== undefined) {
    next.tokensOut = event.completionTokens;
  }

  return Object.keys(next).length > 0 ? next : null;
}

/** The placeholder older builds wrote into the database as a real title. */
const LEGACY_UNTITLED = 'New conversation';

/** Longest auto-title, in characters, before it is cut at a word boundary. */
const AUTO_TITLE_MAX = 56;

/**
 * A conversation's name, taken from the first thing the user asked.
 *
 * The first prompt is what people remember a chat by — the last one changes
 * under them, and "New conversation" repeated down the sidebar names nothing.
 * Markdown images (a pasted screenshot), quoted page blocks and code fences
 * are stripped first: they are attachments to the question, not the question.
 */
export function titleFromPrompt(prompt: string): string {
  const cleaned = prompt
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images, including attachment:// ones
    .replace(/```[\s\S]*?```/g, ' ') // fenced code
    .replace(/^>.*$/gm, ' ') // quoted page context
    .replace(/[#*`_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned === '') {
    return '';
  }
  if (cleaned.length <= AUTO_TITLE_MAX) {
    return cleaned;
  }

  const cut = cleaned.slice(0, AUTO_TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > AUTO_TITLE_MAX / 2 ? cut.slice(0, lastSpace) : cut).replace(/[,.;:!?-]+$/, '')}…`;
}

function resultMessage(error: { message: string }): string {
  return error.message;
}

/**
 * Markdown source for an inserted screenshot (T111): a single image whose alt
 * text carries the captured page's identity. Brackets and newlines are
 * stripped from the title so it can never break out of the image syntax.
 */
export function screenshotMarkdown(capture: BrowserScreenshotCapture): string {
  const label = (capture.title || capture.url).replace(/[[\]\n\r]/g, ' ').trim();
  return `![Screenshot of ${label}](${capture.attachmentUrl})`;
}

function applyLoadedConversation(
  store: ConversationsStore,
  conversation: Conversation | null,
): void {
  store.setState((state) => ({
    activeConversation: conversation,
    summaries: conversation
      ? replaceSummary(state.summaries, toSummary(conversation))
      : state.summaries,
  }));
}

/** A message id considered stale after an ancestor user turn was edited, until
 * the conversation is regenerated from that point. Transient UI-only state:
 * it is never persisted, and reloading the conversation clears it. */
function markStaleAfter(messages: Message[], editedMessageId: string): Set<string> {
  const editedIndex = messages.findIndex((message) => message.id === editedMessageId);
  if (editedIndex === -1) {
    return new Set();
  }

  return new Set(messages.slice(editedIndex + 1).map((message) => message.id));
}

/** Finds the user message that generation should resume from: `id` itself if
 * it is a user message, otherwise the nearest preceding user message. */
function findRegenerationAnchor(messages: Message[], id: string): Message | null {
  const index = messages.findIndex((message) => message.id === id);
  if (index === -1) {
    return null;
  }

  for (let i = index; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      return messages[i];
    }
  }

  return null;
}

const AGENT_VERBS: Record<AgentAction, string> = {
  navigate: 'Opening',
  read_page: 'Reading the page',
  screenshot: 'Taking a screenshot',
  list_tabs: 'Listing open tabs',
  read_tab: 'Reading tab',
  find: 'Looking for',
  click: 'Clicking',
  fill: 'Filling',
  attach_file: 'Attaching',
  wait_for: 'Waiting for',
};

type ToolStreamEvent = Extract<ChatStreamEvent, { type: 'tool' }>;

/** The one line a step shows. Never carries a value typed into a field. */
function agentStepLabel(event: ToolStreamEvent): string {
  if (event.tool === 'web_search') {
    return event.query ? `Searching the web for "${event.query}"` : 'Searching the web';
  }

  if (event.tool === 'shell') {
    return event.detail?.trim() || event.command?.split('\n')[0].trim() || 'Shell command';
  }

  const verb = event.action ? AGENT_VERBS[event.action] : 'Working';
  return event.detail ? `${verb} ${event.detail}` : verb;
}

/**
 * Folds one `tool` stream event into the step trail: a `searching` phase
 * opens a step, and the matching `results`/`error` closes the one still
 * running.
 */
export function reduceAgentSteps(steps: AgentStep[], event: ToolStreamEvent): AgentStep[] {
  if (event.phase === 'searching') {
    // Shell output is streamed as repeated progress events. Fold it into the
    // open command instead of adding one transcript row per stdout chunk.
    if (event.tool === 'shell' && event.command !== undefined) {
      let runningIndex = -1;
      for (let index = steps.length - 1; index >= 0; index -= 1) {
        const step = steps[index];
        if (step.tool === 'shell' && step.status === 'running' && step.command === event.command) {
          runningIndex = index;
          break;
        }
      }

      if (runningIndex !== -1) {
        const next = [...steps];
        next[runningIndex] = {
          ...next[runningIndex],
          label: agentStepLabel(event),
          ...(event.output !== undefined ? { output: event.output } : {}),
        };
        return next;
      }
    }

    return [
      ...steps,
      {
        id: `${steps.length}-${event.action ?? event.tool}`,
        tool: event.tool,
        ...(event.action ? { action: event.action } : {}),
        label: agentStepLabel(event),
        status: 'running',
        ...(event.willSubmit ? { willSubmit: true } : {}),
        ...(event.command !== undefined ? { command: event.command } : {}),
        ...(event.output !== undefined ? { output: event.output } : {}),
      },
    ];
  }

  let index = -1;
  for (let candidate = steps.length - 1; candidate >= 0; candidate -= 1) {
    const step = steps[candidate];
    const sameTool = step.tool === event.tool;
    const sameCommand = event.command === undefined || step.command === event.command;
    if (step.status === 'running' && sameTool && sameCommand) {
      index = candidate;
      break;
    }
  }
  if (index === -1) {
    // A renderer can attach just after the opening event on an exceptionally
    // fast local endpoint. The terminal result is authoritative, so recover
    // the whole row from it instead of losing the command entirely.
    if (event.tool === 'shell' && event.command !== undefined) {
      return [
        ...steps,
        {
          id: `${steps.length}-shell-recovered`,
          tool: 'shell',
          label: agentStepLabel(event),
          status: event.phase === 'error' ? 'failed' : 'done',
          command: event.command,
          ...(event.message ? { message: event.message } : {}),
          ...(event.output !== undefined ? { output: event.output } : {}),
          ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
        },
      ];
    }
    return steps;
  }

  const next = [...steps];
  next[index] = {
    ...next[index],
    label: agentStepLabel(event),
    status: event.phase === 'error' ? 'failed' : 'done',
    ...(event.message ? { message: event.message } : {}),
    ...(event.command !== undefined ? { command: event.command } : {}),
    ...(event.output !== undefined ? { output: event.output } : {}),
    ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
  };
  return next;
}

/**
 * Which engine this send goes to — the conversation's own, chosen when it was
 * made. Only `coder` is ever sent: a chat send carries exactly the payload it
 * always did, so nothing downstream had to learn about the new column.
 */
function conversationMode(conversationId: string | null): { mode?: CompletionMode } {
  if (conversationId === null) {
    return {};
  }

  const summary = conversationsStore
    .getState()
    .summaries.find((candidate) => candidate.id === conversationId);
  return summary?.mode === 'coder' ? { mode: 'coder' } : {};
}

export function createConversationsStore(api?: Pick<Api, 'conversations' | 'chat'>) {
  const resolvedApi = api ?? getApi();
  let selectionToken = 0;
  let activeStreamToken: string | null = null;
  let cleanupActiveStream: (() => void) | null = null;

  /**
   * Streams a fresh assistant reply into `conversationId`, appending a new
   * assistant message and completing it from `completionMessages`. Shared by
   * `send` (new user turn) and `regenerateFromMessage` (existing history).
   */
  async function beginAssistantGeneration(
    conversationId: string,
    conversationSettings: GenerationSettings,
    completionMessages: Array<{ role: MessageRole; content: string }>,
  ): Promise<void> {
    if (!resolvedApi) {
      return;
    }

    if (activeStreamToken !== null) {
      store.setState({ streamError: 'stream already active' });
      return;
    }

    store.setState({ streamError: null, lastStreamFailure: null });

    const endpointsState = endpointsStore.getState();
    const activeConversation = store.getState().activeConversation;
    const endpointId = endpointsState.activeEndpointId ?? activeConversation?.endpointId;
    const modelId = endpointsState.activeModelId ?? activeConversation?.modelId;

    if (!endpointId || !modelId) {
      store.setState({ streamError: 'no active endpoint or model' });
      return;
    }

    const assistantResult = await resolvedApi.conversations.appendMessage(conversationId, {
      role: 'assistant',
      content: '',
      endpointId,
      modelId,
      settings: conversationSettings,
    });

    if (!assistantResult.ok) {
      store.setState({ streamError: resultMessage(assistantResult.error) });
      return;
    }

    const assistantMessage = assistantResult.value;

    store.setState((currentState) => {
      if (currentState.activeConversation?.id !== conversationId) {
        return {};
      }

      const conversation = currentState.activeConversation;
      const optimisticConversation: Conversation = {
        ...conversation,
        updatedAt: assistantMessage.createdAt,
        messages: [...conversation.messages, assistantMessage],
      };

      return {
        activeConversation: optimisticConversation,
        summaries: replaceSummary(currentState.summaries, toSummary(optimisticConversation)),
      };
    });

    store.setState({
      streamStatus: { messageId: assistantMessage.id, phase: 'sending', since: Date.now() },
    });

    const startResult = await resolvedApi.chat.startCompletion({
      conversationId,
      endpointId,
      modelId,
      messages: completionMessages,
      settings: conversationSettings,
      ...conversationMode(conversationId),
    });

    if (!startResult.ok) {
      store.setState({
        streamError: resultMessage(startResult.error),
        streamStatus: null,
      });
      return;
    }

    const streamId = startResult.value.streamId;
    activeStreamToken = streamId;
    store.setState({
      streamId,
      streamError: null,
      streamStatus: { messageId: assistantMessage.id, phase: 'waiting', since: Date.now() },
    });

    let latestAssistantContent = assistantMessage.content;
    let persistedAssistantContent = assistantMessage.content;
    let latestMetrics = assistantMessage.metrics;
    let writeTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const clearTimer = (): void => {
      if (writeTimer !== null) {
        clearTimeout(writeTimer);
        writeTimer = null;
      }
    };

    const cleanup = (): void => {
      clearTimer();
      unsubscribe?.();
      unsubscribe = null;

      if (cleanupActiveStream === cleanup) {
        cleanupActiveStream = null;
      }

      if (activeStreamToken === streamId) {
        activeStreamToken = null;
      }
    };

    const flushContent = async (): Promise<void> => {
      clearTimer();

      if (latestAssistantContent === persistedAssistantContent) {
        return;
      }

      const content = latestAssistantContent;
      const result = await resolvedApi.conversations.updateMessage(
        conversationId,
        assistantMessage.id,
        {
          content,
        },
      );

      if (!result.ok) {
        console.error(result.error);
        return;
      }

      persistedAssistantContent = content;
    };

    const scheduleFlush = (): void => {
      if (writeTimer !== null) {
        return;
      }

      writeTimer = setTimeout(() => {
        writeTimer = null;
        void flushContent();
      }, 200);
    };

    const refreshActiveConversation = async (): Promise<void> => {
      const result = await resolvedApi.conversations.get(conversationId);
      if (!result.ok) {
        console.error(result.error);
        return;
      }

      if (store.getState().activeId !== conversationId) {
        return;
      }

      applyLoadedConversation(store, result.value);
    };

    const handleStreamEvent = async (event: ChatStreamEvent): Promise<void> => {
      if (activeStreamToken !== streamId) {
        return;
      }

      switch (event.type) {
        case 'delta': {
          latestAssistantContent += event.token;
          // Refresh on every token, throttled to a second: `since` then means
          // "how long the endpoint has been silent", which is the only signal
          // that separates a slow answer from a dead server.
          const status = store.getState().streamStatus;
          if (status?.phase !== 'writing' || Date.now() - status.since >= 1000) {
            store.setState({
              streamStatus: {
                messageId: assistantMessage.id,
                phase: 'writing',
                since: Date.now(),
              },
            });
          }
          store.setState((currentState) => ({
            activeConversation: updateConversationMessage(
              currentState.activeConversation,
              conversationId,
              assistantMessage.id,
              (message) => ({ ...message, content: latestAssistantContent }),
            ),
          }));
          scheduleFlush();
          return;
        }

        case 'tool': {
          store.setState((currentState) => ({
            streamStatus:
              event.phase === 'searching'
                ? { messageId: assistantMessage.id, phase: 'working', since: Date.now() }
                : currentState.streamStatus,
            agentSteps: {
              ...currentState.agentSteps,
              [assistantMessage.id]: reduceAgentSteps(
                currentState.agentSteps[assistantMessage.id] ?? [],
                event,
              ),
            },
          }));
          return;
        }

        case 'runbook_context': {
          const { type: _type, ...status } = event;
          store.setState((currentState) => ({
            runbookContext: { ...currentState.runbookContext, [assistantMessage.id]: status },
          }));
          return;
        }

        case 'meta': {
          latestMetrics = mergeMetaIntoMetrics(latestMetrics, event);
          store.setState((currentState) => ({
            activeConversation: updateConversationMessage(
              currentState.activeConversation,
              conversationId,
              assistantMessage.id,
              (message) => ({ ...message, metrics: latestMetrics }),
            ),
          }));
          return;
        }

        case 'done': {
          await flushContent();

          if (latestMetrics !== null) {
            const result = await resolvedApi.conversations.updateMessage(
              conversationId,
              assistantMessage.id,
              { metrics: latestMetrics },
            );

            if (!result.ok) {
              console.error(result.error);
            }
          }

          cleanup();
          store.setState({ streamId: null, streamStatus: null });
          return;
        }

        case 'aborted': {
          await flushContent();
          cleanup();
          store.setState({
            streamId: null,
            streamStatus: null,
            lastStreamFailure: {
              messageId: assistantMessage.id,
              kind: 'aborted',
              message: 'Generation was interrupted before it finished.',
            },
          });
          await refreshActiveConversation();
          return;
        }

        case 'error': {
          cleanup();
          store.setState({
            streamId: null,
            streamError: resultMessage(event.error),
            lastStreamFailure: {
              messageId: assistantMessage.id,
              kind: 'error',
              message: resultMessage(event.error),
              errorType: event.error.type,
              diagnostic: event.error.diagnostic,
            },
          });
          return;
        }
      }
    };

    unsubscribe = resolvedApi.chat.onEvent(streamId, (event) => {
      void handleStreamEvent(event);
    });
    cleanupActiveStream = cleanup;
  }

  const store = createStore<ConversationsState>()((set, get) => ({
    summaries: [],
    activeId: null,
    activeConversation: null,
    loading: false,
    streamId: null,
    streamError: null,
    streamStatus: null,
    lastStreamFailure: null,
    staleMessageIds: new Set(),
    agentSteps: {},
    runbookContext: {},

    async refreshList(): Promise<void> {
      if (!resolvedApi) {
        return;
      }

      set({ loading: true });

      const result = await resolvedApi.conversations.list();
      if (result.ok) {
        set({ summaries: result.value, loading: false });
        return;
      }

      console.error(result.error);
      set({ loading: false });
    },

    async searchConversations(query: string): Promise<ConversationSummary[]> {
      if (!resolvedApi) {
        return [];
      }

      const result = await resolvedApi.conversations.search(query);
      if (result.ok) {
        return result.value;
      }

      console.error(result.error);
      return [];
    },

    async selectConversation(id: string | null): Promise<void> {
      const currentSelection = ++selectionToken;

      if (id !== null) {
        rememberActiveConversationId(id);
      }

      set({
        activeId: id,
        activeConversation:
          id === null
            ? null
            : get().activeConversation?.id === id
              ? get().activeConversation
              : null,
        loading: id !== null,
      });

      if (!resolvedApi || id === null) {
        set({ loading: false, activeConversation: null });
        return;
      }

      const result = await resolvedApi.conversations.get(id);
      if (currentSelection !== selectionToken || get().activeId !== id) {
        return;
      }

      if (!result.ok) {
        console.error(result.error);
        set({ activeConversation: null, loading: false });
        return;
      }

      applyLoadedConversation(store, result.value);
      set({ loading: false });
    },

    async newConversation(input): Promise<Conversation | null> {
      if (!resolvedApi) {
        return null;
      }

      set({ loading: true, streamError: null });

      const result = await resolvedApi.conversations.create({
        title: input.title,
        endpointId: input.endpointId,
        modelId: input.modelId,
        settings: input.settings,
        // The mode is fixed at creation and there is no switch to change it
        // afterwards, so leaving it out of this payload did not degrade the
        // conversation — it silently made every "New coder" a chat, with
        // nothing anywhere to say so. Anything added to the input type has to
        // be added here too, which is what `tests/unit/conversation-mode.test.ts`
        // is for.
        mode: input.mode,
      });

      if (!result.ok) {
        console.error(result.error);
        set({ loading: false, streamError: resultMessage(result.error) });
        return null;
      }

      const conversation = result.value;
      selectionToken += 1;
      rememberActiveConversationId(conversation.id);

      set((state) => ({
        activeId: conversation.id,
        activeConversation: conversation,
        loading: false,
        summaries: insertSummaryAtHead(state.summaries, toSummary(conversation)),
      }));

      return conversation;
    },

    async send(text: string, options?: { aiMode?: boolean }): Promise<void> {
      if (!resolvedApi) {
        return;
      }

      const state = get();
      const conversation = state.activeConversation;
      const conversationId = state.activeId;

      if (!conversation || !conversationId) {
        set({ streamError: 'no active conversation' });
        return;
      }

      if (activeStreamToken !== null) {
        set({ streamError: 'stream already active' });
        return;
      }

      set({ streamError: null, lastStreamFailure: null });

      const endpointsState = endpointsStore.getState();
      const endpointId = endpointsState.activeEndpointId ?? conversation.endpointId;
      const modelId = endpointsState.activeModelId ?? conversation.modelId;

      const appendMessage = async (role: MessageRole, content: string) =>
        resolvedApi.conversations.appendMessage(conversationId, {
          role,
          content,
          endpointId,
          modelId,
          settings: conversation.settings,
        });

      const userResult = await appendMessage('user', text);
      if (!userResult.ok) {
        set({ streamError: resultMessage(userResult.error) });
        return;
      }

      // Name the chat after the question that started it, once. A title the
      // user typed is never touched, and neither is a chat that already has
      // one — only an unnamed chat gets one. `LEGACY_UNTITLED` covers chats
      // created before titles were stored empty.
      const untitled =
        conversation.title.trim() === '' || conversation.title.trim() === LEGACY_UNTITLED;
      const autoTitle = untitled && conversation.messages.length === 0 ? titleFromPrompt(text) : '';

      if (autoTitle !== '') {
        void store.getState().renameConversation(conversationId, autoTitle);
      }

      // The optimistic updates below rebuild the summary from `conversation`,
      // which still carries the old, empty title — writing it back would undo
      // the rename a moment after it landed, which is exactly what left the
      // sidebar on "New conversation" while the database held the real name.
      const titled: Conversation =
        autoTitle === '' ? conversation : { ...conversation, title: autoTitle };

      const assistantResult = await appendMessage('assistant', '');
      if (!assistantResult.ok) {
        set({ streamError: resultMessage(assistantResult.error) });
        return;
      }

      const userMessage = userResult.value;
      const assistantMessage = assistantResult.value;
      const completionMessages = [...conversation.messages, userMessage].map(
        ({ role, content }) => ({
          role,
          content,
        }),
      );
      const optimisticConversation: Conversation = {
        ...titled,
        updatedAt: assistantMessage.createdAt,
        messages: [...conversation.messages, userMessage, assistantMessage],
      };

      set((currentState) => ({
        activeConversation:
          currentState.activeConversation?.id === conversationId
            ? optimisticConversation
            : currentState.activeConversation,
        summaries: replaceSummary(currentState.summaries, toSummary(optimisticConversation)),
      }));

      const startResult = await resolvedApi.chat.startCompletion({
        conversationId,
        endpointId,
        modelId,
        messages: completionMessages,
        settings: conversation.settings,
        ...(options?.aiMode ? { aiMode: true } : {}),
        ...conversationMode(conversation.id),
      });

      if (!startResult.ok) {
        set({ streamError: resultMessage(startResult.error) });
        return;
      }

      const streamId = startResult.value.streamId;
      activeStreamToken = streamId;
      set({
        streamId,
        streamError: null,
        streamStatus: { messageId: assistantMessage.id, phase: 'waiting', since: Date.now() },
      });

      let latestAssistantContent = assistantMessage.content;
      let persistedAssistantContent = assistantMessage.content;
      let latestMetrics = assistantMessage.metrics;
      let writeTimer: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe: (() => void) | null = null;

      const clearTimer = (): void => {
        if (writeTimer !== null) {
          clearTimeout(writeTimer);
          writeTimer = null;
        }
      };

      const cleanup = (): void => {
        clearTimer();
        unsubscribe?.();
        unsubscribe = null;

        if (cleanupActiveStream === cleanup) {
          cleanupActiveStream = null;
        }

        if (activeStreamToken === streamId) {
          activeStreamToken = null;
        }
      };

      const flushContent = async (): Promise<void> => {
        clearTimer();

        if (latestAssistantContent === persistedAssistantContent) {
          return;
        }

        const content = latestAssistantContent;
        const result = await resolvedApi.conversations.updateMessage(
          conversationId,
          assistantMessage.id,
          {
            content,
          },
        );

        if (!result.ok) {
          console.error(result.error);
          return;
        }

        persistedAssistantContent = content;
      };

      const scheduleFlush = (): void => {
        if (writeTimer !== null) {
          return;
        }

        writeTimer = setTimeout(() => {
          writeTimer = null;
          void flushContent();
        }, 200);
      };

      const refreshActiveConversation = async (): Promise<void> => {
        const result = await resolvedApi.conversations.get(conversationId);
        if (!result.ok) {
          console.error(result.error);
          return;
        }

        if (get().activeId !== conversationId) {
          return;
        }

        applyLoadedConversation(store, result.value);
      };

      const handleStreamEvent = async (event: ChatStreamEvent): Promise<void> => {
        if (activeStreamToken !== streamId) {
          return;
        }

        switch (event.type) {
          case 'delta': {
            latestAssistantContent += event.token;
            const status = get().streamStatus;
            if (status?.phase !== 'writing' || Date.now() - status.since >= 1000) {
              set({
                streamStatus: {
                  messageId: assistantMessage.id,
                  phase: 'writing',
                  since: Date.now(),
                },
              });
            }
            set((currentState) => ({
              activeConversation: updateConversationMessage(
                currentState.activeConversation,
                conversationId,
                assistantMessage.id,
                (message) => ({ ...message, content: latestAssistantContent }),
              ),
            }));
            scheduleFlush();
            return;
          }

          case 'tool': {
            set((currentState) => ({
              streamStatus:
                event.phase === 'searching'
                  ? { messageId: assistantMessage.id, phase: 'working', since: Date.now() }
                  : currentState.streamStatus,
              agentSteps: {
                ...currentState.agentSteps,
                [assistantMessage.id]: reduceAgentSteps(
                  currentState.agentSteps[assistantMessage.id] ?? [],
                  event,
                ),
              },
            }));
            return;
          }

          case 'runbook_context': {
            const { type: _type, ...status } = event;
            set((currentState) => ({
              runbookContext: { ...currentState.runbookContext, [assistantMessage.id]: status },
            }));
            return;
          }

          case 'meta': {
            latestMetrics = mergeMetaIntoMetrics(latestMetrics, event);
            set((currentState) => ({
              activeConversation: updateConversationMessage(
                currentState.activeConversation,
                conversationId,
                assistantMessage.id,
                (message) => ({ ...message, metrics: latestMetrics }),
              ),
            }));
            return;
          }

          case 'done': {
            await flushContent();

            if (latestMetrics !== null) {
              const result = await resolvedApi.conversations.updateMessage(
                conversationId,
                assistantMessage.id,
                { metrics: latestMetrics },
              );

              if (!result.ok) {
                console.error(result.error);
              }
            }

            cleanup();
            set({ streamId: null, streamStatus: null });
            return;
          }

          case 'aborted': {
            await flushContent();
            cleanup();
            set({
              streamId: null,
              streamStatus: null,
              lastStreamFailure: {
                messageId: assistantMessage.id,
                kind: 'aborted',
                message: 'Generation was interrupted before it finished.',
              },
            });
            await refreshActiveConversation();
            return;
          }

          case 'error': {
            cleanup();
            set({
              streamId: null,
              streamError: resultMessage(event.error),
              lastStreamFailure: {
                messageId: assistantMessage.id,
                kind: 'error',
                message: resultMessage(event.error),
                errorType: event.error.type,
                diagnostic: event.error.diagnostic,
              },
            });
            return;
          }
        }
      };

      unsubscribe = resolvedApi.chat.onEvent(streamId, (event) => {
        void handleStreamEvent(event);
      });
      cleanupActiveStream = cleanup;
    },

    async sendAiModeQuery(text: string): Promise<void> {
      await store.getState().send(text, { aiMode: true });
    },

    async retryLast(): Promise<void> {
      const state = get();
      const conversation = state.activeConversation;

      if (!conversation) {
        return;
      }

      const lastUserMessage = [...conversation.messages]
        .reverse()
        .find((msg) => msg.role === 'user');

      if (!lastUserMessage) {
        return;
      }

      await get().send(lastUserMessage.content);
    },

    async stop(): Promise<void> {
      if (!resolvedApi) {
        return;
      }

      const streamId = get().streamId;
      if (!streamId) {
        return;
      }

      set({ streamId: null, streamStatus: null });
      const result = await resolvedApi.chat.stopCompletion(streamId);
      if (!result.ok) {
        console.error(result.error);
      }
    },

    async editUserMessage(id: string, newText: string): Promise<void> {
      if (!resolvedApi) {
        return;
      }

      const conversationId = get().activeId;
      if (!conversationId) {
        return;
      }

      const result = await resolvedApi.conversations.updateMessage(conversationId, id, {
        content: newText,
      });

      if (!result.ok) {
        console.error(result.error);
        return;
      }

      set((currentState) => {
        const updatedConversation = updateConversationMessage(
          currentState.activeConversation,
          conversationId,
          id,
          (message) => ({ ...message, content: newText }),
        );

        return {
          activeConversation: updatedConversation,
          staleMessageIds: updatedConversation
            ? markStaleAfter(updatedConversation.messages, id)
            : currentState.staleMessageIds,
        };
      });
    },

    async renameConversation(id: string, title: string): Promise<void> {
      if (!resolvedApi) {
        return;
      }

      const result = await resolvedApi.conversations.rename(id, title);
      if (!result.ok) {
        console.error(result.error);
        return;
      }

      set((currentState) => ({
        summaries: currentState.summaries.map((summary) =>
          summary.id === id ? { ...summary, title } : summary,
        ),
        activeConversation:
          currentState.activeConversation?.id === id
            ? { ...currentState.activeConversation, title }
            : currentState.activeConversation,
      }));
    },

    async removeConversation(id: string): Promise<void> {
      if (!resolvedApi) {
        return;
      }

      const result = await resolvedApi.conversations.remove(id);
      if (!result.ok) {
        console.error(result.error);
        return;
      }

      if (get().activeId === id) {
        cleanupActiveStream?.();
        selectionToken += 1;
      }

      set((currentState) => ({
        summaries: currentState.summaries.filter((summary) => summary.id !== id),
        activeId: currentState.activeId === id ? null : currentState.activeId,
        activeConversation:
          currentState.activeConversation?.id === id ? null : currentState.activeConversation,
        loading: currentState.activeId === id ? false : currentState.loading,
        streamId: currentState.activeId === id ? null : currentState.streamId,
        streamError: currentState.activeId === id ? null : currentState.streamError,
        agentSteps: currentState.activeId === id ? {} : currentState.agentSteps,
        runbookContext: currentState.activeId === id ? {} : currentState.runbookContext,
        staleMessageIds: currentState.activeId === id ? new Set() : currentState.staleMessageIds,
      }));
    },

    async createGroup(name: string): Promise<ConversationGroup | null> {
      if (!resolvedApi) {
        return null;
      }

      const result = await resolvedApi.conversations.createGroup(name);
      if (!result.ok) {
        console.error(result.error);
        return null;
      }

      return result.value;
    },

    async renameGroup(groupId: string, name: string): Promise<void> {
      if (!resolvedApi) {
        return;
      }

      const result = await resolvedApi.conversations.renameGroup(groupId, name);
      if (!result.ok) {
        console.error(result.error);
        return;
      }

      // Every row carries the group's name, so they all move together.
      set((currentState) => ({
        summaries: currentState.summaries.map((summary) =>
          summary.groupId === groupId ? { ...summary, groupName: name.trim() } : summary,
        ),
      }));
    },

    async addToGroup(groupId: string, ids: string[]): Promise<void> {
      if (!resolvedApi) {
        return;
      }

      const conversationIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
      if (conversationIds.length === 0) {
        return;
      }

      const result = await resolvedApi.conversations.addToGroup(groupId, conversationIds);
      if (!result.ok) {
        console.error(result.error);
        return;
      }

      await store.getState().refreshList();
    },

    async removeFromGroup(ids: string[]): Promise<void> {
      if (!resolvedApi) {
        return;
      }

      const conversationIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
      if (conversationIds.length === 0) {
        return;
      }

      const result = await resolvedApi.conversations.removeFromGroup(conversationIds);
      if (!result.ok) {
        console.error(result.error);
        return;
      }

      await store.getState().refreshList();
    },

    setCoderRoot(id: string, root: string | null): void {
      const active = get().activeConversation;
      if (active === null || active.id !== id) {
        return;
      }

      set({ activeConversation: { ...active, coderRoot: root } });
    },

    async attachScreenshot(capture: BrowserScreenshotCapture): Promise<void> {
      if (!resolvedApi) {
        return;
      }

      const state = get();
      const conversation = state.activeConversation;
      const conversationId = state.activeId;
      if (!conversation || !conversationId) {
        return;
      }

      const endpointsState = endpointsStore.getState();
      const endpointId = endpointsState.activeEndpointId ?? conversation.endpointId;
      const modelId = endpointsState.activeModelId ?? conversation.modelId;

      const result = await resolvedApi.conversations.appendMessage(conversationId, {
        role: 'user',
        content: screenshotMarkdown(capture),
        endpointId,
        modelId,
        settings: conversation.settings,
      });

      if (!result.ok) {
        set({ streamError: resultMessage(result.error) });
        return;
      }

      const message = result.value;
      set((currentState) => {
        if (currentState.activeConversation?.id !== conversationId) {
          return {};
        }

        const optimisticConversation: Conversation = {
          ...currentState.activeConversation,
          updatedAt: message.createdAt,
          messages: [...currentState.activeConversation.messages, message],
        };

        return {
          activeConversation: optimisticConversation,
          summaries: replaceSummary(currentState.summaries, toSummary(optimisticConversation)),
        };
      });
    },

    async regenerateFromMessage(id: string): Promise<void> {
      if (!resolvedApi) {
        return;
      }

      const state = get();
      const conversation = state.activeConversation;
      const conversationId = state.activeId;

      if (!conversation || !conversationId) {
        return;
      }

      if (activeStreamToken !== null) {
        set({ streamError: 'stream already active' });
        return;
      }

      const anchor = findRegenerationAnchor(conversation.messages, id);
      if (!anchor) {
        return;
      }

      const deleteResult = await resolvedApi.conversations.deleteMessagesAfter(
        conversationId,
        anchor.id,
      );
      if (!deleteResult.ok) {
        console.error(deleteResult.error);
        set({ streamError: resultMessage(deleteResult.error) });
        return;
      }

      const anchorIndex = conversation.messages.findIndex((message) => message.id === anchor.id);
      const truncatedConversation: Conversation = {
        ...conversation,
        messages: conversation.messages.slice(0, anchorIndex + 1),
      };

      set((currentState) => ({
        activeConversation:
          currentState.activeConversation?.id === conversationId
            ? truncatedConversation
            : currentState.activeConversation,
        summaries: replaceSummary(currentState.summaries, toSummary(truncatedConversation)),
        staleMessageIds: new Set(),
        streamError: null,
        lastStreamFailure: null,
      }));

      const completionMessages = truncatedConversation.messages.map(({ role, content }) => ({
        role,
        content,
      }));

      await beginAssistantGeneration(conversationId, conversation.settings, completionMessages);
    },

    async exportConversation(id: string): Promise<ConversationExportResult> {
      if (!resolvedApi) {
        return { ok: false, error: { code: 'internal', message: 'Export is unavailable.' } };
      }

      return resolvedApi.conversations.exportMarkdown(id);
    },

    async exportActiveConversation(): Promise<ConversationExportResult> {
      const conversationId = get().activeId;
      if (!conversationId) {
        // No active conversation: treat as a silent no-op (the trigger is
        // disabled in this state, so the UI never surfaces this path).
        return { ok: false, error: { code: 'canceled', message: 'No active conversation.' } };
      }

      return get().exportConversation(conversationId);
    },
  }));

  if (resolvedApi) {
    const hydrationSelection = selectionToken;
    void store
      .getState()
      .refreshList()
      .then(async () => {
        // Do not override a click/new-chat action that happened while the list
        // was loading at startup.
        if (selectionToken !== hydrationSelection || store.getState().activeId !== null) {
          return;
        }

        const summaries = store.getState().summaries;
        const rememberedId = readLastActiveConversationId();
        const conversationToOpen =
          summaries.find((summary) => summary.id === rememberedId) ?? summaries[0];

        if (conversationToOpen) {
          await store.getState().selectConversation(conversationToOpen.id);
        }
      });
  }

  return store;
}

export const conversationsStore = createConversationsStore();

declare global {
  interface Window {
    api: Api;
  }
}
