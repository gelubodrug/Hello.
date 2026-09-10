/**
 * Composer (T054, rebuilt T101, docked T123): the message input at the bottom
 * of the conversation column.
 *
 * Anatomy follows DESIGNUIguide.md §Composer and the reference capture
 * `.agent/attachments/20260903-163352_01a068.png`: one `--r-24`
 * `--color-surface` dock — no border, no shadow, no focus ring, the caret is
 * the focus indicator — holding the autosizing field row above a fixed 32px
 * controls row (attach · model chip · voice · send).
 *
 * - Docked at all times, including with no active conversation: the first send
 *   from the empty state creates the conversation from the active
 *   endpoint/model and then sends into it.
 * - Autosizes between MIN_ROWS and MAX_ROWS. The measurement runs inside a
 *   requestAnimationFrame so React can commit a large paste in a single shot
 *   before any layout math touches the DOM — the paste never re-renders one
 *   character at a time and never freezes the UI. Height stays stable while
 *   typing; growth is bounded so the surface never jumps.
 * - Enter submits; Alt+Enter and Shift+Enter insert a newline. IME-aware:
 *   while the input is composing (dead keys / CJK candidates) Enter is passed
 *   through to the IME and never submits.
 * - The send affordance is a Send/Stop toggle bound to `state/generation`; the
 *   glyphs cross-fade inside a circle with a fixed footprint, so nothing in the
 *   controls row moves while generating.
 * - Draft text is persisted per conversation (localStorage) and restored when
 *   switching conversations, so an unsent message survives a context switch.
 * - Prompt history (T102): with an empty input, ArrowUp recalls this
 *   conversation's previous user prompts (newest first), ArrowDown steps back
 *   toward newer, and Escape restores the empty state. While the user is
 *   composing their own text the arrows keep their normal caret behaviour, and
 *   an active IME composition is never interrupted. A quiet, tokened caption is
 *   the only affordance shown while browsing — never a bright badge.
 * - Click-in-chat (T123): a pointerdown on transcript or empty-state whitespace
 *   focuses the field with the caret at the end, and a printable keypress while
 *   nothing editable is focused routes that character into the field.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Code2,
  Folder,
  ImagePlus,
  Mic,
  MessageSquareQuote,
  Plus,
  Square,
  Terminal,
  X,
} from 'lucide-react';
import { useStore } from 'zustand/react';

import { AddMenu, type AddMenuEntry } from './AddMenu';
import { conversationsStore } from '../state/conversations';
import { cliWorkersStore } from '../state/cli-workers';
import { endpointsStore } from '../state/endpoints';
import ModelSelector from '../endpoints/ModelSelector';
import { composerContextStore, formatPageQuote } from '../state/composer-context';
import { createGenerationStore } from '../state/generation';
import { settingsStore } from '../state/settings';
import { Tooltip } from '../ui/Tooltip';
import { TruncatedText } from '../ui/TruncatedText';
import { Menu, type MenuItemDef } from '../ui/Menu';
import { Popover } from '../ui/Popover';
import { isMacPlatform } from '../ui/shortcut';
import type { CliWorkerId } from '../../shared/ipc-contract';
import type { GenerationSettings } from '../../shared/types';
import styles from './Composer.module.css';

/** Host of the quoted page's URL, used as the quote header when it has no title. */
function quoteHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const MIN_ROWS = 1;
const MAX_ROWS = 8;
const LINE_HEIGHT = 22;

/** localStorage namespace for per-conversation drafts. */
const DRAFT_PREFIX = 'composer:draft:';

/**
 * Defaults for the conversation the composer creates on the first send from the
 * empty state — the same settings the Sidebar "New chat" flow uses.
 */
const DEFAULT_SETTINGS: GenerationSettings = {
  temperature: 0.7,
  maxTokens: null,
  timeoutMs: 60000,
};

/**
 * Anything under one of these is a real target, not transcript whitespace — a
 * pointerdown there must keep its own behaviour instead of focusing the field.
 */
const INTERACTIVE_SELECTOR =
  'a, button, input, textarea, select, label, [role="button"], [role="link"], [contenteditable="true"], [data-message-id], [data-composer-root]';

/**
 * `state/generation` exports a factory rather than a shared singleton, so we
 * instantiate one module-level store the Composer subscribes to for its
 * Send/Stop phase. Kept at module scope so every Composer mount shares it.
 */
const generationStore = createGenerationStore();

/** Image types the composer accepts, matching what main will store. */
const ACCEPTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Mirrors MAX_ATTACHMENT_BYTES in src/main/storage/attachments.ts. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** One image waiting to be sent. It is held in memory, not written anywhere,
 * until the message goes out — a picture dropped and then removed (or a chat
 * abandoned before the first send) must not leave a file behind. */
interface PendingImage {
  id: string;
  file: File;
  /** Object URL for the thumbnail; revoked when the entry goes away. */
  previewUrl: string;
}

function conversationsApi(): Window['api']['conversations'] | null {
  if (typeof window === 'undefined' || !('api' in window)) {
    return null;
  }
  return window.api.conversations;
}

/** Reads a file as bare base64 (no `data:` prefix) for the IPC bridge, which
 * only forwards plain values — binary would be dropped on the way across. */
function readAsBase64(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma === -1 ? null : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** Last segment of a path — what the folder is called, not where it lives. */
function folderName(path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? path;
}

/** Markdown for a stored image, with brackets stripped from the name so it can
 * never break out of the image syntax (same rule as the screenshot insert). */
function imageMarkdown(name: string, attachmentUrl: string): string {
  const label = name.replace(/[[\]\n\r]/g, ' ').trim();
  return `![${label === '' ? 'image' : label}](${attachmentUrl})`;
}

/** Detected once: macOS renders the send shortcut with the ↵ / ⇧ glyphs. */
const IS_MAC = isMacPlatform();

/** Tooltip copy for the send affordance — the platform-correct send shortcut. */
const SEND_TOOLTIP = IS_MAC
  ? 'Send message  ↵      ⌥↵ or ⇧↵ for a new line'
  : 'Send message  Enter      Alt+Enter or Shift+Enter for a new line';

/** Modified Enter belongs to the textarea; plain Enter sends the message. */
export function shouldSubmitComposerKey(event: {
  key: string;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return event.key === 'Enter' && !event.altKey && !event.shiftKey;
}

/** True for anything that owns the keyboard: a field, or contenteditable text. */
function isEditableElement(element: Element): boolean {
  if (element instanceof HTMLElement && element.isContentEditable) {
    return true;
  }
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function readDraft(id: string): string {
  try {
    return window.localStorage.getItem(DRAFT_PREFIX + id) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(id: string, text: string): void {
  try {
    if (text.length > 0) {
      window.localStorage.setItem(DRAFT_PREFIX + id, text);
    } else {
      window.localStorage.removeItem(DRAFT_PREFIX + id);
    }
  } catch {
    // Private mode / storage disabled — drafts are a convenience, never fatal.
  }
}

export interface ComposerProps {
  onAddEndpoint: () => void;
  onNewTerminal: (currentChatRoot: string | null, conversationId: string | null) => void;
  onNewCliWorker: (
    id: CliWorkerId,
    currentChatRoot: string | null,
    conversationId: string | null,
  ) => void;
}

export function Composer({
  onAddEndpoint,
  onNewTerminal,
  onNewCliWorker,
}: ComposerProps): JSX.Element {
  const activeId = useStore(conversationsStore, (state) => state.activeId);

  const [value, setValue] = useState(() => (activeId !== null ? readDraft(activeId) : ''));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const frameRef = useRef<number | null>(null);

  // Prompt-history cursor: null when the box holds the user's own draft; a
  // valid index (0 = most recent) while browsing recalled prompts.
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  // This conversation's previous user prompts, newest first, so index 0 is the
  // most recent — the first entry ArrowUp recalls.
  const messages = useStore(conversationsStore, (state) => state.activeConversation?.messages);
  const history = useMemo(
    () =>
      (messages ?? [])
        .filter((message) => message.role === 'user')
        .map((message) => message.content)
        .reverse(),
    [messages],
  );

  // Latest value + the conversation it belongs to, read from effects that must
  // not re-subscribe on every keystroke (draft persistence on switch/unmount).
  const valueRef = useRef(value);
  valueRef.current = value;
  const draftIdRef = useRef(activeId);

  const [images, setImages] = useState<PendingImage[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const workerMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const [workerMenuOpen, setWorkerMenuOpen] = useState(false);
  // Depth counter: dragenter/dragleave fire for every child crossed, so a
  // boolean alone would flicker the highlight as the pointer moves inside.
  const dragDepthRef = useRef(0);
  // Read from effects and from submit without re-subscribing on every change.
  const imagesRef = useRef<PendingImage[]>(images);
  imagesRef.current = images;

  const send = useStore(conversationsStore, (state) => state.send);
  const stop = useStore(conversationsStore, (state) => state.stop);
  const newConversation = useStore(conversationsStore, (state) => state.newConversation);
  const streamId = useStore(conversationsStore, (state) => state.streamId);
  const phase = useStore(generationStore, (state) => state.phase);

  // The endpoint/model a conversation started from the empty state inherits.
  const activeEndpointId = useStore(endpointsStore, (state) => state.activeEndpointId);
  const activeModelId = useStore(endpointsStore, (state) => state.activeModelId);
  const modelsByEndpoint = useStore(endpointsStore, (state) => state.models);
  const shellRoot = useStore(settingsStore, (state) => state.shellRoot);
  const shellGrant = useStore(settingsStore, (state) => state.shellGrant);
  const terminalEnabled = useStore(settingsStore, (state) => state.terminalEnabled);
  const catalogWorkers = useStore(cliWorkersStore, (state) => state.workers);
  const enabledWorkerIds = useStore(cliWorkersStore, (state) => state.enabledIds);
  const cliWorkersLoading = useStore(cliWorkersStore, (state) => state.loading);
  // The conversation's own mode, not a global switch: a thread made with
  // "New coder" stays a coder thread, and one made with "New chat" cannot
  // become one by the user having flipped something elsewhere.
  const appMode = useStore(conversationsStore, (state) => state.activeConversation?.mode ?? 'chat');
  const chooseShellRoot = useStore(settingsStore, (state) => state.chooseShellRoot);
  const setShellGrant = useStore(settingsStore, (state) => state.setShellGrant);
  const setCoderRoot = useStore(conversationsStore, (state) => state.setCoderRoot);
  const conversationRoot = useStore(
    conversationsStore,
    (state) => state.activeConversation?.coderRoot ?? null,
  );

  // What the agent may actually touch, and so what the chip has to name: a
  // conversation that has already worked somewhere keeps that folder, and
  // everything else follows the last one the user picked. Chat mode is only
  // ever about the terminal scope, which is the last project by definition.
  const projectRoot = appMode === 'coder' ? (conversationRoot ?? shellRoot) : shellRoot;

  // Image support is `null` for a plain OpenAI-compatible server that says
  // nothing about it. Unknown means "let them try": only an explicit `false`
  // — advertised by the endpoint, or learned from a refused request — closes
  // the attach affordance, so a capable model is never blocked by a guess.
  const activeModel =
    activeEndpointId !== null && activeModelId !== null
      ? (modelsByEndpoint[activeEndpointId] ?? []).find((model) => model.id === activeModelId)
      : undefined;
  const acceptsImages = activeModel?.vision !== false;
  const modelLabel = activeModelId ?? 'This model';

  // T110 "Send page to chat": a page quote captured in the browser pane, shown
  // here as an editable quote surface and prepended to the message on send.
  const quote = useStore(composerContextStore, (state) => state.quote);
  const updateSelection = useStore(composerContextStore, (state) => state.updateSelection);
  const clearQuote = useStore(composerContextStore, (state) => state.clearQuote);

  // A stream is live when generation reports `streaming` or the conversations
  // store is holding an active stream id — either drives the Stop affordance.
  const isStreaming = phase === 'streaming' || streamId !== null;
  const isBusy = phase === 'starting' || phase === 'stopping';
  const trimmed = value.trim();
  // With no conversation open the first send creates one, so the send
  // affordance is live as long as an endpoint and a model are selected.
  const canStartConversation = activeEndpointId !== null && activeModelId !== null;
  const cliWorkers = useMemo(
    () => catalogWorkers.filter((worker) => enabledWorkerIds.has(worker.id)),
    [catalogWorkers, enabledWorkerIds],
  );

  useEffect(() => {
    if (terminalEnabled) void cliWorkersStore.getState().refresh();
  }, [terminalEnabled]);
  const workerMenuItems = useMemo<MenuItemDef[]>(
    () =>
      cliWorkers.map((worker) => ({
        id: worker.id,
        label: worker.usesActiveModel ? `${worker.label} · active model` : worker.label,
        icon: Code2,
        disabled: worker.installed === false || (worker.usesActiveModel && !canStartConversation),
        onSelect: () => {
          setWorkerMenuOpen(false);
          onNewCliWorker(worker.id, projectRoot, activeId);
        },
      })),
    [activeId, canStartConversation, cliWorkers, onNewCliWorker, projectRoot],
  );
  // A pending page quote is sendable on its own, even with an empty message.
  const canSend =
    (trimmed.length > 0 || quote !== null) && (activeId !== null || canStartConversation);

  const autosize = useCallback((): void => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }

    el.style.height = 'auto';

    const style = window.getComputedStyle(el);
    const lineHeight = Number.parseFloat(style.lineHeight) || LINE_HEIGHT;
    const paddingY = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    const borderY =
      Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);

    const minHeight = lineHeight * MIN_ROWS + paddingY + borderY;
    const maxHeight = lineHeight * MAX_ROWS + paddingY + borderY;
    const next = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);

    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  // Focus the field showing the caret only — never the keyboard focus ring —
  // with the caret parked at the end of whatever the draft already holds.
  const focusFieldAtEnd = useCallback((): void => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    el.focus({ preventScroll: true });
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);

  // Defer measurement to the next frame so a batched value change (e.g. a huge
  // paste) is committed by React before we read scrollHeight — one layout pass,
  // no per-character reflow.
  useLayoutEffect(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
    }

    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      autosize();
    });

    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [value, autosize]);

  // Per-conversation draft persistence. When the active conversation changes,
  // stash the outgoing draft under its id and load the incoming one. The guard
  // keeps mount (same id) a no-op so the initial `readDraft` value survives.
  useEffect(() => {
    const previousId = draftIdRef.current;
    if (previousId === activeId) {
      return;
    }
    if (previousId !== null) {
      writeDraft(previousId, valueRef.current);
    }
    draftIdRef.current = activeId;
    setValue(activeId !== null ? readDraft(activeId) : '');
    setHistoryIndex(null);
  }, [activeId]);

  // Persist whatever is in the box when the composer unmounts, so a draft is
  // not lost if the conversation view tears down without a switch.
  useEffect(() => {
    return () => {
      const id = draftIdRef.current;
      if (id !== null) {
        writeDraft(id, valueRef.current);
      }
    };
  }, []);

  const addFiles = useCallback(
    (files: FileList | File[]): void => {
      if (!acceptsImages) {
        setImageError(`${modelLabel} is text-only — it cannot read images.`);
        return;
      }

      const accepted: PendingImage[] = [];
      let rejected: string | null = null;

      for (const file of Array.from(files)) {
        if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
          rejected = 'Only PNG, JPEG, WebP, and GIF images can be attached.';
          continue;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          rejected = `${file.name} is larger than 8 MB.`;
          continue;
        }
        accepted.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          file,
          previewUrl: URL.createObjectURL(file),
        });
      }

      setImageError(rejected);
      if (accepted.length > 0) {
        setImages((current) => [...current, ...accepted]);
      }
    },
    [acceptsImages, modelLabel],
  );

  const removeImage = useCallback((id: string): void => {
    setImages((current) => {
      const found = current.find((image) => image.id === id);
      if (found) {
        URL.revokeObjectURL(found.previewUrl);
      }
      return current.filter((image) => image.id !== id);
    });
  }, []);

  // Object URLs outlive the component unless they are handed back.
  useEffect(
    () => () => {
      for (const image of imagesRef.current) {
        URL.revokeObjectURL(image.previewUrl);
      }
    },
    [],
  );

  const handleDragEnter = useCallback((event: React.DragEvent<HTMLFormElement>): void => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setDropActive(true);
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLFormElement>): void => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) {
      return;
    }
    // Without this the drop never fires and the OS opens the file instead.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDragLeave = useCallback((): void => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDropActive(false);
    }
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLFormElement>): void => {
      if (!Array.from(event.dataTransfer.types).includes('Files')) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current = 0;
      setDropActive(false);
      addFiles(event.dataTransfer.files);
    },
    [addFiles],
  );

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
      const files = Array.from(event.clipboardData.files);
      if (files.length === 0) {
        return;
      }
      // A screenshot on the clipboard arrives as a file with no text twin;
      // let ordinary text pastes through untouched.
      event.preventDefault();
      addFiles(files);
    },
    [addFiles],
  );

  /** Writes the pending images into the conversation and returns their
   * Markdown, so the transcript renders them and main can inline them. */
  const storeImages = useCallback(
    async (conversationId: string): Promise<string[]> => {
      const api = conversationsApi();
      if (api === null || images.length === 0) {
        return [];
      }

      const markdown: string[] = [];
      for (const image of images) {
        const dataBase64 = await readAsBase64(image.file);
        if (dataBase64 === null) {
          continue;
        }
        const saved = await api.saveAttachment(conversationId, {
          mime: image.file.type,
          dataBase64,
        });
        if (saved.ok) {
          markdown.push(imageMarkdown(image.file.name, saved.value.attachmentUrl));
        }
      }
      return markdown;
    },
    [images],
  );

  /**
   * Attaching a folder is how terminal access is granted, next to attaching a
   * file — burying it in Settings made a capability the user hands over feel
   * like a preference. Picking one also grants the shortest permission there
   * is when none is held, so the act reads as "work in here, today".
   *
   * In Coder mode the folder is the whole permission — it is the only thing
   * confining the agent — so picking one there must not quietly hand the chat
   * model a terminal as well.
   */
  const addFolder = useCallback(() => {
    // The conversation travels with the pick, so an open chat follows the new
    // folder instead of the one its earlier turns ran in.
    void chooseShellRoot(activeId).then((chosen) => {
      if (chosen !== null && activeId !== null) {
        setCoderRoot(activeId, chosen);
      }
    });
    if (appMode === 'chat' && shellGrant === 'off') {
      setShellGrant('day');
    }
  }, [activeId, appMode, chooseShellRoot, setCoderRoot, shellGrant, setShellGrant]);

  const closeAddMenu = useCallback(() => setAddMenuOpen(false), []);

  // One entry per thing that can be brought into the chat. The row anatomy
  // lives in AddMenu, so a new capability is an entry here and nothing else.
  const addMenuEntries: AddMenuEntry[] = [
    {
      id: 'files',
      label: 'Add images',
      // A row that cannot act says why, rather than sitting there greyed out.
      description: acceptsImages ? 'PNG, JPEG, WebP, GIF' : `${modelLabel} is text-only`,
      icon: ImagePlus,
      disabled: !acceptsImages,
      onSelect: () => {
        setAddMenuOpen(false);
        fileInputRef.current?.click();
      },
    },
    {
      id: 'folder',
      label:
        appMode === 'coder'
          ? projectRoot === null
            ? 'Add folder to work in…'
            : 'Change folder to work in…'
          : projectRoot === null
            ? 'Add folder for commands…'
            : 'Change folder for commands…',
      description: projectRoot === null ? undefined : folderName(projectRoot),
      icon: Folder,
      onSelect: () => {
        setAddMenuOpen(false);
        addFolder();
      },
    },
  ];

  const submit = useCallback(async (): Promise<void> => {
    const text = textareaRef.current?.value ?? value;
    const body = text.trim();
    if ((body.length === 0 && quote === null && images.length === 0) || isStreaming || isBusy) {
      return;
    }

    // From the empty state the composer is the "new chat" affordance: create
    // the conversation from the active endpoint/model, then send into it.
    let conversationId = activeId;
    if (conversationId === null) {
      if (activeEndpointId === null || activeModelId === null) {
        return;
      }
      const created = await newConversation({
        endpointId: activeEndpointId,
        modelId: activeModelId,
        settings: DEFAULT_SETTINGS,
        title: '',
      });
      if (created === null) {
        return;
      }
      conversationId = created.id;
    }

    // Attachments are written now that the conversation exists, and appended
    // as Markdown images — the same shape "Take a screenshot" uses, so the
    // transcript renders them and main can inline them for the model.
    const attachments = await storeImages(conversationId);

    // With a page quote pending, prepend its Markdown blockquote so the shared
    // context reads as a quote in the transcript, never as the user's own line.
    const message = [
      ...(quote === null ? [] : [formatPageQuote(quote)]),
      quote === null ? text : body,
      ...attachments,
    ]
      .filter((part) => part.length > 0)
      .join('\n\n');

    setValue('');
    setHistoryIndex(null);
    writeDraft(conversationId, '');
    clearQuote();
    for (const image of imagesRef.current) {
      URL.revokeObjectURL(image.previewUrl);
    }
    setImages([]);
    setImageError(null);
    textareaRef.current?.focus();
    void send(message);
  }, [
    value,
    images,
    storeImages,
    activeId,
    activeEndpointId,
    activeModelId,
    newConversation,
    isStreaming,
    isBusy,
    send,
    quote,
    clearQuote,
  ]);

  // Recall a history entry into the box and drop the caret at the end, matching
  // shell-style history navigation. The caret move waits a frame so the
  // programmatic value has been committed to the DOM.
  const recallHistoryEntry = useCallback((index: number, text: string): void => {
    setHistoryIndex(index);
    setValue(text);
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.selectionStart = el.selectionEnd = el.value.length;
      }
    });
  }, []);

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      void submit();
    },
    [submit],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      // Never let any key handling here disturb an active IME composition
      // (dead keys / CJK candidates) — pass everything through to the IME.
      if (event.nativeEvent.isComposing || isComposingRef.current) {
        return;
      }

      const browsing = historyIndex !== null;

      if (event.key === 'ArrowUp') {
        // Only recall history from an empty box or while already browsing;
        // otherwise ArrowUp keeps its ordinary caret behaviour.
        if ((browsing || value.length === 0) && history.length > 0) {
          event.preventDefault();
          const next = historyIndex === null ? 0 : Math.min(historyIndex + 1, history.length - 1);
          recallHistoryEntry(next, history[next]);
        }
        return;
      }

      if (event.key === 'ArrowDown') {
        // ArrowDown only matters while browsing — it steps back toward newer
        // prompts and finally restores the empty draft.
        if (browsing) {
          event.preventDefault();
          if (historyIndex === 0) {
            setHistoryIndex(null);
            setValue('');
          } else {
            const next = historyIndex - 1;
            recallHistoryEntry(next, history[next]);
          }
        }
        return;
      }

      if (event.key === 'Escape') {
        if (browsing) {
          event.preventDefault();
          setHistoryIndex(null);
          setValue('');
        }
        return;
      }

      // Electron/macOS does not consistently give Alt+Enter the textarea's
      // native newline behaviour. Insert it ourselves, preserving selections
      // and putting the caret immediately after the new line.
      if (event.key === 'Enter' && event.altKey) {
        event.preventDefault();
        const field = event.currentTarget;
        const start = field.selectionStart ?? value.length;
        const end = field.selectionEnd ?? start;
        const nextValue = `${value.slice(0, start)}\n${value.slice(end)}`;
        const nextCaret = start + 1;

        setHistoryIndex(null);
        setValue(nextValue);
        window.requestAnimationFrame(() => {
          field.selectionStart = field.selectionEnd = nextCaret;
        });
        return;
      }

      if (!shouldSubmitComposerKey(event)) {
        return;
      }

      event.preventDefault();
      void submit();
    },
    [submit, history, historyIndex, value, recallHistoryEntry],
  );

  // Click-in-chat: pointerdown on transcript / empty-state whitespace — never
  // on a message, a control, a link, or an active selection — puts the caret
  // back in the composer at the end of the draft.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 || event.defaultPrevented) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (target.closest('[data-chat-surface]') === null) {
        return;
      }
      if (target.closest(INTERACTIVE_SELECTOR) !== null) {
        return;
      }
      const selection = window.getSelection();
      if (selection !== null && !selection.isCollapsed) {
        return;
      }

      // Take the focus ourselves so the browser's own focus handling cannot
      // blur the field a moment later.
      event.preventDefault();
      focusFieldAtEnd();
    };

    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [focusFieldAtEnd]);

  // A printable keypress while nothing editable holds focus types into the
  // composer instead of falling on the floor.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.key.length !== 1) {
        return;
      }
      const el = textareaRef.current;
      if (el === null || document.activeElement === el || el.getClientRects().length === 0) {
        return;
      }
      const active = document.activeElement;
      if (active !== null && isEditableElement(active)) {
        return;
      }
      // An open dialog owns the keyboard — never type behind a modal.
      if (document.querySelector('[role="dialog"]') !== null) {
        return;
      }

      event.preventDefault();
      const character = event.key;
      el.focus({ preventScroll: true });
      setHistoryIndex(null);
      setValue((current) => current + character);
      window.requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (node) {
          node.setSelectionRange(node.value.length, node.value.length);
        }
      });
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleStop = useCallback((): void => {
    void stop();
  }, [stop]);

  const showStop = isStreaming && !isBusy;

  return (
    <form
      className={styles.composer}
      aria-label="Message composer"
      data-composer-root
      data-drop-active={dropActive ? 'true' : undefined}
      onSubmit={handleSubmit}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dropActive ? (
        <div className={styles.dropHint} aria-hidden="true">
          Drop images to attach
        </div>
      ) : null}

      {images.length > 0 ? (
        <ul className={styles.attachments} aria-label="Attached images">
          {images.map((image) => (
            <li key={image.id} className={styles.attachment}>
              <img
                className={styles.attachmentThumb}
                src={image.previewUrl}
                alt={image.file.name}
              />
              <button
                type="button"
                className={styles.attachmentRemove}
                aria-label={`Remove ${image.file.name}`}
                onClick={() => removeImage(image.id)}
              >
                <X className={styles.attachmentRemoveIcon} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {appMode === 'coder' && projectRoot === null ? (
        // Coder mode cannot run at all without a folder, and the folder is the
        // only thing confining the agent. The gate belongs next to Send, not
        // behind a refused message.
        <button
          type="button"
          className={`${styles.folderChip} ${styles.folderChipQuiet} ${styles.folderChipAction}`}
          onClick={addFolder}
        >
          <Folder className={styles.folderChipIcon} aria-hidden="true" />
          <span className={styles.folderChipName}>Choose a folder to work in</span>
        </button>
      ) : null}

      {projectRoot !== null && (shellGrant !== 'off' || appMode === 'coder') ? (
        // A ghost pill, like the model chip: the folder's own name at 13px in
        // the UI font, the whole path in the title. Paths are chrome, and
        // chrome is never mono (DESIGNUIguide.md §Typography).
        <div
          className={
            appMode === 'coder'
              ? `${styles.folderChip} ${styles.folderChipQuiet}`
              : styles.folderChip
          }
          title={
            appMode === 'coder'
              ? `The coding agent reads and changes files in ${projectRoot}, and nowhere else.`
              : `Commands run in ${projectRoot} — ${
                  shellGrant === 'day' ? 'for today' : 'until turned off'
                }`
          }
        >
          <Folder className={styles.folderChipIcon} aria-hidden="true" />
          <TruncatedText className={styles.folderChipName}>{folderName(projectRoot)}</TruncatedText>
          {appMode === 'coder' ? null : (
            // Revoking the terminal grant would not stop the coding agent, so
            // the control is only offered where it tells the truth.
            <Tooltip label="Stop running commands here">
              <button
                type="button"
                className={styles.folderChipRemove}
                aria-label="Stop running commands in this folder"
                onClick={() => setShellGrant('off')}
              >
                <X className={styles.quoteRemoveIcon} aria-hidden="true" />
              </button>
            </Tooltip>
          )}
        </div>
      ) : null}

      {imageError !== null ? (
        <p className={styles.attachmentError} role="alert">
          {imageError}
        </p>
      ) : null}

      {imageError === null && images.length > 0 && !acceptsImages ? (
        <p className={styles.attachmentError} role="status">
          {modelLabel} cannot read images — it will only see your text.
        </p>
      ) : null}
      {quote !== null ? (
        <div className={styles.quote} aria-label="Quoted page">
          <div className={styles.quoteHead}>
            <MessageSquareQuote className={styles.quoteMark} aria-hidden="true" />
            <TruncatedText className={styles.quoteTitle} title={quote.url}>
              {quote.title !== '' ? quote.title : quoteHost(quote.url)}
            </TruncatedText>
            <button
              type="button"
              className={styles.quoteRemove}
              aria-label="Remove quoted page"
              title="Remove quoted page"
              onClick={clearQuote}
            >
              <X className={styles.quoteRemoveIcon} aria-hidden="true" />
            </button>
          </div>
          {quote.url !== '' ? (
            <TruncatedText className={styles.quoteUrl}>{quote.url}</TruncatedText>
          ) : null}
          <textarea
            className={styles.quoteSelection}
            value={quote.selection}
            rows={1}
            placeholder="No text selected — add a note or leave empty"
            aria-label="Quoted selection"
            onChange={(event) => updateSelection(event.target.value)}
          />
        </div>
      ) : null}

      <div className={styles.inputRow}>
        <textarea
          ref={textareaRef}
          className={styles.field}
          value={value}
          rows={MIN_ROWS}
          placeholder="Ask anything"
          aria-label="Message"
          data-focus-indicator="caret"
          onChange={(event) => {
            // Once the user edits the text it is their own draft again, not a
            // recalled prompt — leave history-browsing mode.
            setHistoryIndex(null);
            setValue(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
          }}
        />
      </div>

      <div className={styles.controls}>
        <Tooltip label="Add">
          <button
            ref={addMenuTriggerRef}
            type="button"
            className={styles.ghost}
            aria-label="Add"
            aria-haspopup="menu"
            aria-expanded={addMenuOpen}
            onClick={() => {
              setWorkerMenuOpen(false);
              setAddMenuOpen((open) => !open);
            }}
          >
            <Plus className={styles.ghostIcon} aria-hidden="true" />
          </button>
        </Tooltip>
        <AddMenu
          open={addMenuOpen}
          entries={addMenuEntries}
          anchorRef={addMenuTriggerRef}
          onClose={closeAddMenu}
        />
        <Tooltip
          label={
            activeId === null
              ? 'Open a chat first'
              : projectRoot === null
                ? 'Open terminal'
                : `Open terminal in ${projectRoot}`
          }
        >
          <button
            type="button"
            className={styles.ghost}
            aria-label="Open terminal for current chat"
            disabled={!terminalEnabled || activeId === null}
            onClick={() => onNewTerminal(projectRoot, activeId)}
          >
            <Terminal className={styles.ghostIcon} aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip
          label={
            cliWorkersLoading
              ? 'Checking CLI workers'
              : cliWorkers.length === 0
                ? 'Enable a CLI worker in Settings'
                : 'Open CLI worker for current chat'
          }
        >
          <button
            ref={workerMenuTriggerRef}
            type="button"
            className={styles.ghost}
            aria-label="Open CLI worker for current chat"
            aria-haspopup="menu"
            aria-expanded={workerMenuOpen}
            disabled={!terminalEnabled || activeId === null || cliWorkers.length === 0}
            onClick={() => {
              setAddMenuOpen(false);
              setWorkerMenuOpen((open) => !open);
            }}
          >
            <Code2 className={styles.ghostIcon} aria-hidden="true" />
          </button>
        </Tooltip>
        <Popover
          open={workerMenuOpen}
          anchorRef={workerMenuTriggerRef}
          placement="top-start"
          onClose={() => setWorkerMenuOpen(false)}
        >
          <Menu
            items={workerMenuItems}
            open={workerMenuOpen}
            animatePresence={false}
            onClose={() => setWorkerMenuOpen(false)}
          />
        </Popover>
        <input
          ref={fileInputRef}
          type="file"
          className={styles.fileInput}
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            if (event.target.files) addFiles(event.target.files);
            // Reset so picking the same file twice still fires a change.
            event.target.value = '';
          }}
        />

        <div className={styles.trailing}>
          <div className={styles.modelSlot} data-composer-model-slot>
            <ModelSelector onAddEndpoint={onAddEndpoint} />
          </div>

          <Tooltip label="Voice input">
            <button type="button" className={styles.ghost} aria-label="Voice input" disabled>
              <Mic className={styles.ghostIcon} aria-hidden="true" />
            </button>
          </Tooltip>

          {/* One button across every phase: the circle never remounts, moves,
              or resizes — only the stacked glyphs cross-fade inside it. */}
          <Tooltip label={showStop ? 'Stop generating' : SEND_TOOLTIP}>
            <button
              type={showStop ? 'button' : 'submit'}
              className={styles.send}
              aria-label={showStop ? 'Stop generating' : 'Send message'}
              disabled={showStop ? false : isBusy || !canSend}
              onClick={showStop ? handleStop : undefined}
            >
              <span
                className={styles.sendGlyph}
                data-shown={!showStop && !isBusy ? 'true' : 'false'}
              >
                <ArrowUp className={styles.icon} aria-hidden="true" />
              </span>
              <span className={styles.sendGlyph} data-shown={showStop ? 'true' : 'false'}>
                <Square className={styles.stopIcon} aria-hidden="true" />
              </span>
              <span className={styles.sendGlyph} data-shown={isBusy ? 'true' : 'false'}>
                <span className={styles.spinner} aria-hidden="true" />
              </span>
            </button>
          </Tooltip>
        </div>
      </div>

      {historyIndex !== null ? (
        <span className={styles.historyHint} aria-live="polite">
          History · ↑↓ to browse · Esc to clear
        </span>
      ) : null}
    </form>
  );
}
