import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRightToLine,
  BookOpen,
  Bot,
  ChevronUp,
  Columns2,
  Globe,
  Sheet,
  FolderOpen,
  Maximize2,
  MessageCircle,
  Minimize2,
  Minus,
  MoreVertical,
  Plus,
  Rows2,
  Terminal,
  X,
} from "lucide-react";
import type {
  AppSettings,
  BrowserTab,
  ChatQuote,
  ChatQuoteExtra,
  Conversation,
  Message,
  NotebookKind,
  TerminalSession,
  WorkerId,
  WorkerInfo,
} from "../../shared/types";
import { ConversationView } from "../chat/ConversationView";
import { Notebook } from "../notebook/Notebook";
import { BrowserPane } from "../browser/BrowserPane";
import type { FindJump } from "../chat/ChatFind";
import { TerminalPane } from "../terminal/TerminalPane";
import { ToolTabStrip } from './ToolTabStrip';
import { orderedTools, useToolOrder } from './useToolOrder';
import { FilesPane, type FileRequest } from '../files/FilesPane';
import { FileNavigation } from '../files/navigation';
import { isChatFolderPath } from '../../shared/chat-folder';
import { filesTabId, type FileLink, type FilesTab } from '../../shared/files';
import { sheetsTabId, type SheetsTab } from '../../shared/sheets';
import { SheetsPane } from '../sheets/SheetsPane';
import {
  ContextMenu,
  IconButton,
  MenuButton,
  type MenuItem,
} from "../ui/primitives";
import { api } from '../api';
import {
  clampRatio, leaves, liveSplits, setRatio, splitChildren, type SplitDirection, type SplitNode, type TerminalSplits,
} from './terminal-splits';

/**
 * A chat has two pages: the conversation and its notebook — one pill beside
 * Chat, not one per section (user, 29.09). The notebook's sections (Runbooks,
 * Tasks, Plans) and their chapters are switched inside it, never by hiding it.
 */
export const CHAT_PAGES = ["chat", "notebook"] as const;
export type ChatPage = (typeof CHAT_PAGES)[number];
/** A page saved before the notebook was one: Runbook and Tasks open the notebook. */
export function normalizeChatTab(value: unknown): ChatPage {
  return value === "runbook" || value === "tasks" || value === "notebook" ? "notebook" : "chat";
}

/**
 * A terminal moved into the chat pane: the one running now, and what brings
 * it back after a restart (user, 30.09: "trebuie să persiste") — which CLI,
 * and the conversation of it to continue where the CLI can.
 */
export interface ChatTerminalTab {
  id: string;
  workerId?: WorkerId;
  session?: string;
}

export interface WorkspacePrefs {
  chatOpen: boolean;
  toolsOpen: boolean;
  filesOpen?: boolean;
  /** The Sheets tab is in the Tools strip. The workbooks themselves are main's. */
  sheetsOpen?: boolean;
  // Legacy saved preference only; live pinning is derived from expanded/toolsOpen.
  pinned?: boolean;
  minimized: boolean;
  expanded: boolean;
  toolsMinimized: boolean;
  toolsExpanded: boolean;
  chatTab: ChatPage;
  /**
   * Terminals moved into the chat pane (user, 30.09: "Set as chat tab", a CLI
   * as the chat), each a page beside Chat and Notebook. A terminal lives as
   * long as the app; its tab does not, and is given a new one after a restart.
   *
   * One truth for where a terminal is: listed here it is the chat's, and the
   * Tools strip leaves it out (`dockedIds`); "Move to tools" takes it off this
   * list. A restart brings back what is listed here, in the chat pane.
   */
  chatTerminals?: ChatTerminalTab[];
  /** Which of them the chat pane shows now; unset, it shows `chatTab`. Never a list of its own. */
  chatTerminal?: string | null;
  /**
   * Terminals side by side in one tab (user, 26.11), by the id of the tab's own
   * terminal: the others in its tree have no tab of their own. In Tools or as a
   * chat tab alike, the tree goes where its tab goes.
   */
  terminalSplits?: TerminalSplits;
  // Retained for saved-preference compatibility; notebook sections are permanent.
  notebookTabs: Array<"runbook" | "tasks">;
  toolId: string | null;
  focus: "chat" | "tools";
  split: number;
}
export type WorkspaceUpdate =
  | Partial<WorkspacePrefs>
  | ((current: WorkspacePrefs) => Partial<WorkspacePrefs>);
export const defaultWorkspacePrefs = (): WorkspacePrefs => ({
  chatOpen: true,
  toolsOpen: false,
  minimized: false,
  expanded: false,
  toolsMinimized: false,
  toolsExpanded: false,
  chatTab: "chat",
  notebookTabs: ["runbook", "tasks"],
  toolId: null,
  focus: "chat",
  split: 0.35,
});

export interface WorkspaceProps {
  active: boolean;
  conversation: Conversation;
  messages: Message[];
  /** The chat's messages, replaced: one was taken back. */
  onMessages?: (messages: Message[]) => void;
  ui: WorkspacePrefs;
  settings: AppSettings;
  workers: WorkerInfo[];
  terminals: TerminalSession[];
  browsers: BrowserTab[];
  sidebarVisible: boolean;
  compact: boolean;
  onUI: (patch: WorkspaceUpdate) => void;
  onSettingsChange: (settings: AppSettings) => void;
  onConversationChange: (conversation: Conversation) => void;
  /** `chat`: what starts opens as a chat tab, not in Tools. */
  onLaunch: (kind: "browser" | "terminal", workerId?: WorkerId, place?: "chat") => void;
  /** `group`: the other terminals of a split tab, closed with it. */
  onCloseTool: (tool: BrowserTab | TerminalSession, group?: TerminalSession[]) => void;
  /** A new terminal in `lead`'s tab, beside (row) or below (column) `target`. */
  onSplit: (lead: string, target: string, dir: SplitDirection) => void;
  onBrowserChange: (tab: BrowserTab) => void;
  /** A search result chosen in the sidebar, for this chat's find. */
  jump?: FindJump | null;
  quote: ChatQuote | null;
  onQuote: (text: string, extra?: ChatQuoteExtra) => void;
  onQuoteConsumed: () => void;
  reportError: (error: unknown) => void;
}

export function Workspace(props: WorkspaceProps) {
  const { conversation, ui, active, compact, onUI } = props;
  // A chat has one way of working (user, 17.11): no mode, so one icon.
  const chatLabel = 'Chat';
  const ModeIcon = MessageCircle;
  // The folder Hello keeps for a chat is not one the person chose: to them, none is set.
  const chosenFolder = isChatFolderPath(conversation.folder) ? null : conversation.folder;
  // The page of Runbooks, Tasks and Plans is the chat's Workbook to the person (user, 17.11); in code it stays the notebook.
  const pageLabels = { chat: chatLabel, notebook: 'Workbook' };
  const body = useRef<HTMLDivElement>(null);
  const [fileRequest, setFileRequest] = useState<FileRequest | null>(null);
  const [choosingWorker, setChoosingWorker] = useState(false);
  // The Notebook pill carries a dot while a section holds something, so a plan
  // the agent wrote is visible without opening the notebook.
  const [filled, setFilled] = useState<Record<NotebookKind, boolean>>({ runbook: false, tasks: false, plan: false });
  useEffect(() => {
    let alive = true;
    const refresh = (kind: NotebookKind) => void api.notebooks.list(conversation.id, kind).then(rows => {
      if (!alive) return;
      const has = rows.some(row => row.title.trim() !== '' || row.body.trim() !== '');
      setFilled(current => current[kind] === has ? current : { ...current, [kind]: has });
    }, () => undefined);
    setFilled({ runbook: false, tasks: false, plan: false });
    refresh('runbook');
    refresh('tasks');
    refresh('plan');
    const unsubscribe = api.notebooks.onChange?.(event => {
      if (event.conversationId === conversation.id) refresh(event.kind);
    });
    return () => { alive = false; unsubscribe?.(); };
  }, [conversation.id]);
  const hasEntries = filled.runbook || filled.tasks || filled.plan;
  // The Workbook is a switch of the chat, off by default: a chat that does not need it is only a chat.
  const workbook = conversation.notebook === true;
  const pages = workbook ? CHAT_PAGES : CHAT_PAGES.filter(page => page !== 'notebook');
  const fileNonce = useRef(0);
  const choosingFolder = useRef(false);
  const dragSplit = useRef<number | null>(null);
  const filesTool: FilesTab = { id: filesTabId(conversation.id), conversationId: conversation.id, kind: 'files', title: 'Files' };
  const sheetsTool: SheetsTab = { id: sheetsTabId(conversation.id), conversationId: conversation.id, kind: 'sheets', title: 'Sheets' };
  // A terminal shown inside another's tab has no tab of its own.
  const splits = liveSplits(ui.terminalSplits, new Set(props.terminals.map(session => session.id)));
  const inSplit = splitChildren(splits);
  const tabTerminals = props.terminals.filter(session => !inSplit.has(session.id));
  const sessionById = new Map(props.terminals.map(session => [session.id, session]));
  /** Which terminal of a split tab is in use: the last one focused, else the tab's own. */
  const [paneFocus, setPaneFocus] = useState<Record<string, string>>({});
  const focusedLeaf = (lead: string) => splits[lead] && leaves(splits[lead]).includes(paneFocus[lead]) ? paneFocus[lead] : lead;
  /** The tab a terminal is shown in: its own, or the one whose split holds it. */
  const tabOf = new Map<string, string>();
  for (const [lead, node] of Object.entries(splits)) for (const id of leaves(node)) tabOf.set(id, lead);
  // The terminal clicked or typed in is the one a split splits. Its events reach React through its portal, not
  // through the pane it sits in, so the pane is found from the page itself (user, 26.11).
  const tabOfRef = useRef(tabOf);
  tabOfRef.current = tabOf;
  useEffect(() => {
    const choose = (event: Event) => {
      const pane = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-split-pane]') : null;
      const id = pane?.dataset.splitPane;
      const lead = id ? tabOfRef.current.get(id) : undefined;
      if (id && lead) setPaneFocus(current => current[lead] === id ? current : { ...current, [lead]: id });
    };
    document.addEventListener('pointerdown', choose, true);
    document.addEventListener('focusin', choose, true);
    return () => {
      document.removeEventListener('pointerdown', choose, true);
      document.removeEventListener('focusin', choose, true);
    };
  }, []);
  // A terminal is in one pane at a time: a chat tab has left the Tools strip.
  const docked = (ui.chatTerminals ?? []).flatMap(tab => tabTerminals.filter(session => session.id === tab.id));
  const dockedIds = new Set(docked.map(session => session.id));
  // A Workbook switched off while it was in front leaves the chat in front.
  const shownPage: string = docked.find(session => session.id === ui.chatTerminal)?.id ?? (ui.chatTab === 'notebook' && !workbook ? 'chat' : ui.chatTab);
  const pageKeys: string[] = [...pages, ...docked.map(session => session.id)];
  const [pageMenu, setPageMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // The chat's tabs past the strip's edge (user, 26.11: "dacă am mai multe
  // taburi nu le pot accesa… o listă verticală under a '...'"). The strip
  // scrolls and shows no scrollbar, so the tab on screen is brought into view,
  // and while the strip holds more than it shows, "…" lists every tab.
  const pageStrip = useRef<HTMLDivElement>(null);
  const [pagesOverflow, setPagesOverflow] = useState(false);
  const pageTitles = docked.map(session => session.title).join('\n');
  useLayoutEffect(() => {
    const node = pageStrip.current;
    if (!node) return;
    const measure = () => {
      const selected = node.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.parentElement;
      if (selected) {
        const bounds = node.getBoundingClientRect(), tab = selected.getBoundingClientRect();
        if (tab.left < bounds.left) node.scrollLeft -= bounds.left - tab.left;
        else if (tab.right > bounds.right) node.scrollLeft += tab.right - bounds.right;
      }
      setPagesOverflow(node.scrollWidth > node.clientWidth + 1);
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(node);
    return () => resize.disconnect();
  }, [shownPage, pageKeys.join(' '), pageTitles]);
  const menuSession = docked.find(session => session.id === pageMenu?.id);
  const toolOrder = useToolOrder(conversation.id, props.reportError);
  const allTools = orderedTools([...props.browsers, ...tabTerminals.filter(session => !dockedIds.has(session.id)), ...(ui.filesOpen ? [filesTool] : []), ...(ui.sheetsOpen ? [sheetsTool] : [])], toolOrder.order);
  /**
   * Each terminal is rendered once, into a node of its own that is moved to
   * whichever pane holds it. Rendering it in the other pane instead would
   * build a new xterm on the same PTY and replay its output, which a TUI
   * does not survive whole. React never manages the node itself, only what
   * is inside it, so moving it is safe.
   */
  const slots = useRef(new Map<string, HTMLDivElement>());
  const slotFor = (id: string) => {
    let slot = slots.current.get(id);
    if (!slot) {
      slot = document.createElement('div');
      slot.className = 'terminal-slot';
      slots.current.set(id, slot);
    }
    return slot;
  };
  const outlet = (id: string) => (node: HTMLDivElement | null) => {
    if (node && slotFor(id).parentNode !== node) node.appendChild(slotFor(id));
  };
  useEffect(() => {
    const live = new Set(props.terminals.map(session => session.id));
    for (const id of slots.current.keys()) if (!live.has(id)) slots.current.delete(id);
  }, [props.terminals]);
  const chooseFilesFolder = async () => {
    if (choosingFolder.current) return false;
    choosingFolder.current = true;    try {
      const folder = await api.system.chooseFolder();
      if (!folder) return false;
      props.onConversationChange(await api.conversations.update(conversation.id, { folder }));
      return true;
    } catch (reason) { props.reportError(reason); return false; }
    finally { choosingFolder.current = false; }
  };
  const openFiles = (target?: FileLink) => {
    // In the folder Hello keeps for a chat the person sees no file: a link to one is how they get it — saved where
    // they choose. A workbook is also shown, where workbooks are.
    if (target && isChatFolderPath(conversation.folder) && api.files.deliver) {
      if (/\.xlsx$/i.test(target.path) && api.sheets) openSheets();
      void api.files.deliver(conversation.id, target.path).catch(props.reportError);
      return;
    }
    // A workbook is shown where workbooks are, and a PDF in Finder: the Files viewer reads text.
    if (target && /\.xlsx$/i.test(target.path) && api.sheets) { openSheets(); return; }
    // One Hello keeps for the chat — dropped from outside the folder — is saved where the person chooses instead.
    if (target && /\.pdf$/i.test(target.path)) { void (api.files.deliver ?? api.files.reveal)(conversation.id, target.path).catch(props.reportError); return; }
    if (target) setFileRequest({ ...target, nonce: ++fileNonce.current });
    onUI(ui.filesOpen && ui.toolsOpen && !ui.toolsMinimized && !ui.expanded
      ? { toolId: filesTool.id, focus: 'tools' }
      : { filesOpen: true, toolsOpen: true, toolsMinimized: false, expanded: false, toolId: filesTool.id, focus: 'tools' });
  };
  const openSheets = () => onUI(ui.sheetsOpen && ui.toolsOpen && !ui.toolsMinimized && !ui.expanded
    ? { toolId: sheetsTool.id, focus: 'tools' }
    : { sheetsOpen: true, toolsOpen: true, toolsMinimized: false, expanded: false, toolId: sheetsTool.id, focus: 'tools' });
  // A workbook the model made or opened is shown, as a page it opens is: beside
  // the chat, without taking the keyboard from what the person is writing.
  const showSheets = useRef(() => {});
  showSheets.current = () => onUI({ sheetsOpen: true, toolsOpen: true, toolsMinimized: false, expanded: false, toolId: sheetsTool.id });
  useEffect(() => api.sheets?.onChange(event => {
    if (event.conversationId === conversation.id && event.list && (event.by === 'model' || event.show) && event.revision > 0) showSheets.current();
  }), [conversation.id]);
  const closeTool = (tool: BrowserTab | TerminalSession | FilesTab | SheetsTab) => {
    if ('kind' in tool && (tool.kind === 'files' || tool.kind === 'sheets')) {
      const remaining = allTools.filter(item => item.id !== tool.id);
      onUI({ ...(tool.kind === 'files' ? { filesOpen: false } : { sheetsOpen: false }), ...(ui.toolId === tool.id ? { toolId: remaining[0]?.id ?? null } : {}),
        ...(!remaining.length ? { toolsOpen: false, toolsMinimized: false, toolsExpanded: false } : {}) });
    } else if (!('url' in tool) && splits[tool.id]) {
      // A split tab's X closes the tab: every terminal in it.
      props.onCloseTool(tool, leaves(splits[tool.id]).flatMap(id => id === tool.id ? [] : sessionById.get(id) ?? []));
    } else props.onCloseTool(tool);
  };
  const split = (lead: string, dir: SplitDirection) => props.onSplit(lead, focusedLeaf(lead), dir);
  // A terminal just split off is the one in use: it was asked for to be typed in.
  const known = useRef(new Map<string, string[]>());
  const treeKey = JSON.stringify(splits);
  useEffect(() => {
    const next = new Map(Object.entries(splits).map(([lead, node]) => [lead, leaves(node)] as const));
    for (const [lead, ids] of next) {
      const before = known.current.get(lead) ?? [lead];
      const added = ids.find(id => !before.includes(id));
      if (added) setPaneFocus(current => ({ ...current, [lead]: added }));
    }
    known.current = next;
  }, [treeKey]);
  /** A split's divider, dragged: shown live on the node, saved once on release. */
  const dragDivider = (lead: string, path: string, dir: SplitDirection) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const divider = event.currentTarget;
    const box = divider.parentElement;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const before = box.style.getPropertyValue('--split-a');
    let ratio: number | null = null;
    divider.setPointerCapture?.(event.pointerId);
    const move = (next: PointerEvent) => {
      ratio = clampRatio(dir === 'row' ? (next.clientX - rect.left) / (rect.width || 1) : (next.clientY - rect.top) / (rect.height || 1));
      box.style.setProperty('--split-a', `${ratio * 100}%`);
    };
    const end = (last: PointerEvent) => {
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', end);
      divider.removeEventListener('pointercancel', end);
      if (last.type === 'pointerup' && ratio !== null) resizeSplit(lead, path, ratio);
      else box.style.setProperty('--split-a', before);
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', end);
    divider.addEventListener('pointercancel', end);
  };
  const resizeSplit = (lead: string, path: string, ratio: number) => onUI(current => {
    const node = current.terminalSplits?.[lead];
    return node ? { terminalSplits: { ...current.terminalSplits, [lead]: setRatio(node, path, ratio) } } : {};
  });
  /** A split tab's terminals, each in a place of its own with its name and its X. */
  const splitView = (lead: string, node: SplitNode, path = ''): JSX.Element => {
    if (typeof node === 'string') {
      const session = sessionById.get(node);
      const title = session?.title || 'Terminal';
      return (
        <div className="terminal-split-pane" data-split-pane={node} data-focused={focusedLeaf(lead) === node}
>
          <div className="terminal-split-bar">
            {session?.kind === 'worker' ? <Bot size={12} aria-hidden /> : <Terminal size={12} aria-hidden />}
            <span className="terminal-split-title" title={title}>{title}</span>
            {/* The terminal's own commands, on its own bar: split this one (user, 26.11). */}
            <button type="button" className="terminal-split-action" aria-label="Split right" title="Split right"
              onClick={() => props.onSplit(lead, node, 'row')}>
              <Columns2 size={12} />
            </button>
            <button type="button" className="terminal-split-action" aria-label="Split down" title="Split down"
              onClick={() => props.onSplit(lead, node, 'column')}>
              <Rows2 size={12} />
            </button>
            {/* Alone in its tab, the tab's X is its X. */}
            {splits[lead] && (
              <button type="button" className="terminal-split-action" aria-label={`Close ${title}`} title={`Close ${title}`}
                onClick={() => session && props.onCloseTool(session)}>
                <X size={12} />
              </button>
            )}
          </div>
          <div className="terminal-split-outlet" ref={outlet(node)} />
        </div>
      );
    }
    const percent = Math.round(node.ratio * 100);
    return (
      <div className="terminal-split" data-dir={node.dir} style={{ '--split-a': `${node.ratio * 100}%` } as CSSProperties}>
        <div className="terminal-split-side">{splitView(lead, node.a, `${path}a`)}</div>
        <div className="terminal-split-divider" role="separator" tabIndex={0}
          aria-orientation={node.dir === 'row' ? 'vertical' : 'horizontal'}
          aria-label="Resize terminals" aria-valuemin={15} aria-valuemax={85} aria-valuenow={percent}
          onPointerDown={dragDivider(lead, path, node.dir)}
          onKeyDown={event => {
            const back = node.dir === 'row' ? 'ArrowLeft' : 'ArrowUp', forward = node.dir === 'row' ? 'ArrowRight' : 'ArrowDown';
            if (event.key !== back && event.key !== forward) return;
            event.preventDefault();
            resizeSplit(lead, path, node.ratio + (event.key === back ? -0.05 : 0.05));
          }} />
        <div className="terminal-split-side">{splitView(lead, node.b, `${path}b`)}</div>
      </div>
    );
  };
  /** Where a tab's terminals go: each on its own bar, alone or split. */
  const terminalHost = (lead: string) => ({ children: splitView(lead, splits[lead] ?? lead) });
  /** A terminal becomes a chat tab, and the chat pane shows it. */
  const dock = (session: TerminalSession) => {
    const remaining = allTools.filter(tool => tool.id !== session.id);
    onUI(current => ({
      chatTerminals: [...(current.chatTerminals ?? []).filter(tab => tab.id !== session.id), {
        id: session.id, ...(session.workerId ? { workerId: session.workerId } : {}), ...(session.session ? { session: session.session } : {}),
      }],
      chatTerminal: session.id, chatOpen: true, minimized: false, toolsExpanded: false, focus: 'chat',
      ...(current.toolId === session.id || !current.toolId ? { toolId: remaining[0]?.id ?? null } : {}),
      ...(!remaining.length ? { toolsOpen: false, toolsMinimized: false } : {}),
    }));
  };
  /** And goes back to Tools, selected there. */
  const undock = (session: TerminalSession) => onUI(current => ({
    chatTerminals: (current.chatTerminals ?? []).filter(tab => tab.id !== session.id),
    ...(current.chatTerminal === session.id ? { chatTerminal: null } : {}),
    toolsOpen: true, toolsMinimized: false, expanded: false, toolId: session.id, focus: 'tools',
  }));
  const showPage = (key: string) => onUI({
    ...(key === 'chat' || key === 'notebook' ? { chatTab: key, chatTerminal: null } : { chatTerminal: key }),
    focus: 'chat', ...(minimized ? { minimized: false } : {}),
  });
  const pageKeyDown = (event: KeyboardEvent<HTMLButtonElement>, key: string): boolean => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return false;
    event.preventDefault();
    const index = pageKeys.indexOf(key);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? pageKeys.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + pageKeys.length) % pageKeys.length;
    showPage(pageKeys[next]);
    event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    return true;
  };
  const currentTool =
    allTools.find((tool) => tool.id === ui.toolId) ?? allTools[0];
  const chatOnly = !ui.toolsOpen;
  const maximizedPane = ui.toolsOpen && ui.toolsExpanded ? "tools"
    : ui.toolsOpen && ui.chatOpen && ui.expanded ? "chat" : null;
  const minimized = ui.minimized && maximizedPane !== "chat";
  const toolsMinimized = !!ui.toolsMinimized && maximizedPane !== "tools";
  const compactSelection = compact && ui.chatOpen && ui.toolsOpen &&
    !minimized && !toolsMinimized && !maximizedPane;
  const chatVisible = active && ui.chatOpen && maximizedPane !== "tools" &&
    !(compactSelection && ui.focus === "tools");
  const toolsVisible = active && ui.toolsOpen && maximizedPane !== "chat" &&
    !(compactSelection && ui.focus === "chat");
  const paneLayout = chatOnly ? "chat-only"
    : chatVisible && minimized && toolsVisible && toolsMinimized ? "both-minimized"
    : chatVisible && minimized ? "chat-minimized"
    : toolsVisible && toolsMinimized ? "tools-minimized"
    : chatVisible && toolsVisible ? "split" : "single";
  const controlsHost = chatVisible && !minimized ? 'chat' : toolsVisible && !toolsMinimized ? 'tools'
    : chatVisible ? 'chat' : toolsVisible ? 'tools' : null;
  const chatMinWidth = 320;
  const workerItems: MenuItem[] = props.workers.map((worker) => ({
    id: worker.id,
    label: worker.label,
    icon: Bot,
    detail: !worker.installed
      ? "Not installed"
      : worker.usesActiveModel
        ? "Active model"
        : undefined,
    disabled: !worker.installed,
    action: () => props.onLaunch("terminal", worker.id),
  }));
  const toolSummary = [
    { id: 'browser', label: 'Browser', Icon: Globe, detail: 'A real page, yours to read or hand over',
      open: () => props.onLaunch('browser') },
    { id: 'terminal', label: 'Terminal', Icon: Terminal, detail: 'A shell that starts in this chat’s folder',
      open: () => props.onLaunch('terminal') },
    { id: 'files', label: 'Files', Icon: FolderOpen, detail: 'What the folder holds, without leaving',
      open: () => openFiles() },
    { id: 'sheets', label: 'Sheets', Icon: Sheet, detail: 'An Excel workbook, yours and the model’s',
      open: () => openSheets() },
    { id: 'workers', label: 'CLI worker', Icon: Bot, detail: 'Claude, Codex and the rest, in a pane',
      // Choosing which one is the whole point; a bare terminal is the row above.
      open: () => setChoosingWorker(current => !current) },
  ];
  /** The same list wherever it appears: press a row and that tool opens. */
  const toolList = (className: string, withDetail = true) => (
    <ul className={className}>
      {toolSummary.map(tool => (
        <Fragment key={tool.id}>
          <li>
            <button type="button" onClick={tool.open} title={withDetail ? undefined : tool.detail}
              aria-expanded={tool.id === 'workers' ? choosingWorker : undefined}>
              <tool.Icon size={16} aria-hidden />
              <span>{tool.label}</span>
            </button>
            {withDetail && <small>{tool.detail}</small>}
          </li>
          {tool.id === 'workers' && choosingWorker && props.workers.map(worker => (
            <li key={worker.id} className="tool-choice">
              <button type="button" disabled={!worker.installed}
                title={worker.installed ? undefined : 'Not installed'}
                onClick={() => { setChoosingWorker(false); props.onLaunch('terminal', worker.id); }}>
                <Bot size={16} aria-hidden />
                <span>{worker.label}</span>
              </button>
              {withDetail && worker.installed && worker.usesActiveModel && <small>Active model</small>}
              {withDetail && !worker.installed && <small>Not installed</small>}
            </li>
          ))}
        </Fragment>
      ))}
      <li>
        <button type="button" onClick={() => void chooseFilesFolder()}
          title={chosenFolder ?? 'Choose the folder this chat works in'}>
          <FolderOpen size={16} aria-hidden />
          <span>Work path</span>
        </button>
        {withDetail && <small>{chosenFolder ?? 'Not set — choose a folder'}</small>}
      </li>
    </ul>
  );
  const toolsMenu: MenuItem[] = [
    { id: 'files', label: 'Files', icon: FolderOpen, action: () => openFiles() },
    { id: 'sheets', label: 'Sheets', icon: Sheet, action: () => openSheets() },
    {
      id: "browser",
      label: "Browser",
      icon: Globe,
      action: () => props.onLaunch("browser"),
    },
    {
      id: "terminal",
      label: "Terminal",
      icon: Terminal,
      action: () => props.onLaunch("terminal"),
    },
    { id: "workers", label: "CLI worker…", icon: Bot, children: workerItems },
  ];
  /** The chat's own +: what runs in a chat tab, and it opens there (user, 26.11). Tools' + opens in Tools. */
  const chatMenu: MenuItem[] = [
    { id: "terminal", label: "Terminal", icon: Terminal, action: () => props.onLaunch("terminal", undefined, "chat") },
    { id: "workers", label: "CLI worker…", icon: Bot,
      children: workerItems.map(item => ({ ...item, action: () => props.onLaunch("terminal", item.id as WorkerId, "chat") })) },
  ];
  const header = (
      <div className="workspace-controls">
        <div className="workspace-header-restores" role="group" aria-label="Reopen panels">
          {!ui.chatOpen && (
            <button
              type="button"
              className="pill"
              onClick={() => onUI({ chatOpen: true, minimized: false, expanded: false, toolsExpanded: false, focus: "chat" })}
            >
              <ModeIcon size={15} aria-hidden />
              Open {chatLabel}
            </button>
          )}
          {/* The icon alone, its name on hover and to a screen reader (user, 05.10). */}
          {!ui.toolsOpen && (
            <IconButton
              label="Open tools"
              onClick={() => onUI({ toolsOpen: true, toolsMinimized: false, toolsExpanded: false, expanded: false, focus: "tools" })}
            >
              <Columns2 size={16} />
            </IconButton>
          )}
        </div>
        {ui.toolsOpen && ui.chatOpen && (compactSelection || maximizedPane) && (
          <div className="compact-switch">
            <button
              className="pill"
              aria-pressed={chatVisible}
              onClick={() => onUI(maximizedPane
                ? { focus: "chat", expanded: true, toolsExpanded: false, minimized: false }
                : { focus: "chat" })}
            >
              {chatLabel}
            </button>
            <button
              className="pill"
              aria-pressed={toolsVisible}
              onClick={() => onUI(maximizedPane
                ? { focus: "tools", toolsExpanded: true, expanded: false, toolsMinimized: false }
                : { focus: "tools" })}
            >
              Tools
            </button>
          </div>
        )}
      </div>
  );
  return (
    <FileNavigation.Provider value={openFiles}>
    <section
      className="workspace"
      data-surface-rim="top-right"
      data-chat-only={chatOnly}
      hidden={!active}
      aria-label={conversation.title}
    >
      {!controlsHost && <div className="workspace-closed-controls workspace-foreground">{header}</div>}
      <div
        ref={body}
        className="workspace-body workspace-foreground"
        data-work-mode={ui.toolsOpen}
        data-chat-open={ui.chatOpen}
        data-compact={compact}
        data-focus-pane={ui.focus}
        data-pane-layout={paneLayout}
        data-top-pane={chatVisible && !minimized ? 'chat' : toolsVisible && !toolsMinimized ? 'tools' : 'none'}
        style={{ "--chat-share": `${ui.split * 100}%` } as CSSProperties}
      >
        <aside className="workspace-context" hidden={!chatOnly} aria-label="Conversation workspace">
          <h2>Workspace</h2>
          <p>One conversation.<br />A shared place to work.</p>
          <p className="workspace-context-hint">
            Open this chat’s tools from the + beside its pills.<br />
            Keep them together as you expand, restore or minimize.
          </p>
          {toolList('workspace-context-tools')}
        </aside>
        <div
          className="chat-stage"
          data-chat-design="true"
          hidden={!chatVisible}
          data-pinned={ui.expanded || ui.toolsOpen}
          data-expanded={ui.expanded}
          data-minimized={minimized}
        >
          <section
            className="chat-card"
            data-surface-rim="bottom-right"
            aria-label={`${chatLabel} panel`}
          >
            <header className="panel-header pane-tab-header">
                <div ref={pageStrip} className="pills" role="tablist" aria-label={`${chatLabel} pages`}>
                  {pages.map((kind) => (
                    <div
                      className="tab-pill"
                      key={kind}
                      data-active={shownPage === kind}
                    >
                      <button
                        type="button"
                        className="chat-page-tab"
                        role="tab"
                        aria-label={kind === "notebook" && hasEntries ? `${pageLabels[kind]} (has entries)` : pageLabels[kind]}
                        tabIndex={shownPage === kind ? 0 : -1}
                        aria-selected={shownPage === kind}
                        aria-controls={`${conversation.id}-${kind}`}
                        onClick={() => showPage(kind)}
                        onKeyDown={(event) => { pageKeyDown(event, kind); }}
                      >
                        {kind === "chat" ? (
                          <ModeIcon size={14} aria-hidden />
                        ) : (
                          <BookOpen size={14} aria-hidden />
                        )}
                        {kind === "notebook" && hasEntries && (
                          <span className="chat-page-tab__dot" aria-hidden="true" />
                        )}
                        <span className="chat-page-tab__label" aria-hidden="true">
                          <span>{pageLabels[kind]}</span>
                        </span>
                      </button>
                    </div>
                  ))}
                  {docked.map(session => (
                    <div
                      className="tab-pill"
                      key={session.id}
                      data-active={shownPage === session.id}
                      onContextMenu={event => { event.preventDefault(); setPageMenu({ id: session.id, x: event.clientX, y: event.clientY }); }}
                    >
                      <button
                        type="button"
                        className="chat-page-tab chat-page-tab--terminal"
                        role="tab"
                        aria-label={`${session.title || 'Terminal'}${session.status === 'exited' ? ' — Session ended' : ''}`}
                        tabIndex={shownPage === session.id ? 0 : -1}
                        aria-selected={shownPage === session.id}
                        aria-controls={`${conversation.id}-terminal-${session.id}`}
                        onClick={() => showPage(session.id)}
                        onKeyDown={event => {
                          if (pageKeyDown(event, session.id)) return;
                          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                            event.preventDefault();
                            const rect = event.currentTarget.getBoundingClientRect();
                            setPageMenu({ id: session.id, x: rect.left, y: rect.bottom });
                          }
                        }}
                      >
                        {session.kind === 'worker' ? <Bot size={14} aria-hidden /> : <Terminal size={14} aria-hidden />}
                        <span className="chat-page-tab__label" aria-hidden="true">
                          <span>{session.title || 'Terminal'}</span>
                        </span>
                        {session.status === 'exited' && <span className="session-ended" aria-hidden="true" />}
                      </button>
                      {/* Closing a chat tab ends it, as in Tools: it does not go back there. */}
                      <button type="button" className="pill-close chat-page-close" aria-label={`Close ${session.title || 'terminal'}`}
                        title={`Close ${session.title || 'terminal'}`} onClick={() => closeTool(session)}>
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
                <ContextMenu position={pageMenu && menuSession ? { x: pageMenu.x, y: pageMenu.y } : null}
                  ariaLabel={menuSession ? `Actions for ${menuSession.title || 'terminal'}` : 'Page actions'}
                  items={menuSession ? [
                    { id: 'undock', label: 'Move to tools', icon: ArrowRightToLine, action: () => undock(menuSession) },
                    { id: 'split-right', label: 'Split right', icon: Columns2, action: () => split(menuSession.id, 'row') },
                    { id: 'split-down', label: 'Split down', icon: Rows2, action: () => split(menuSession.id, 'column') },
                    { id: 'close', label: 'Close tab', icon: X, action: () => closeTool(menuSession) },
                  ] : []}
                  onClose={() => setPageMenu(null)} />
                <div className="pane-actions">
                  {pagesOverflow && (
                    <MenuButton label={`All ${chatLabel.toLowerCase()} tabs`} items={[
                      ...pages.map((kind): MenuItem => ({ id: kind, label: pageLabels[kind], icon: kind === "chat" ? ModeIcon : BookOpen,
                        checked: shownPage === kind, action: () => showPage(kind) })),
                      ...docked.map((session): MenuItem => ({ id: session.id, label: session.title || 'Terminal', icon: session.kind === 'worker' ? Bot : Terminal,
                        ...(session.status === 'exited' ? { detail: 'Session ended' } : {}),
                        checked: shownPage === session.id, action: () => showPage(session.id) })),
                    ]}>
                      <MoreVertical size={17} />
                    </MenuButton>
                  )}
                  {controlsHost === 'chat' && header}
                  <MenuButton label={`Add ${chatLabel.toLowerCase()} tab`} items={chatMenu}>
                    <Plus size={17} />
                  </MenuButton>
                  <IconButton
                    label={`${minimized ? 'Restore' : 'Minimize'} ${chatLabel.toLowerCase()}`}
                    onClick={() => onUI(current => ({
                      minimized: !current.minimized, expanded: current.toolsOpen ? false : current.expanded,
                      focus: !current.minimized && current.toolsOpen ? "tools" : "chat",
                    }))}
                  >
                    {minimized ? <ChevronUp size={16} /> : <Minus size={16} />}
                  </IconButton>
                  <IconButton
                    label={ui.expanded ? `Restore ${chatLabel.toLowerCase()} size` : `Expand ${chatLabel.toLowerCase()}`}
                    onClick={() => onUI(current => ({
                      expanded: !current.expanded, toolsExpanded: false, minimized: false, focus: "chat",
                    }))}
                  >
                    {ui.expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                  </IconButton>
                  <IconButton label={`Close ${chatLabel.toLowerCase()}`} onClick={() => onUI({ chatOpen: false, minimized: false, expanded: false })}>
                    <X size={16} />
                  </IconButton>
                </div>
            </header>
            <div className="chat-card-body" hidden={minimized}>
              <div
                className="chat-page"
                role="tabpanel"
                id={`${conversation.id}-chat`}
                hidden={shownPage !== "chat"}
              >
                <ConversationView
                  conversation={conversation}
                  messages={props.messages}
                  onMessages={props.onMessages}
                  settings={props.settings}
                  workers={props.workers}
                  onSettingsChange={props.onSettingsChange}
                  onFolderChange={props.onConversationChange}
                  // Started from the chat's composer, it opens in the chat, as from the chat's + (user, 26.11).
                  onTerminal={() => props.onLaunch("terminal", undefined, "chat")}
                  onWorker={(workerId) => props.onLaunch("terminal", workerId, "chat")}
                  quote={props.quote}
                  onQuoteConsumed={props.onQuoteConsumed}
                  reportError={props.reportError}
                  active={active && shownPage === "chat"}
                  jump={props.jump}
                />
              </div>
              {workbook && <div
                className="chat-page"
                role="tabpanel"
                id={`${conversation.id}-notebook`}
                hidden={shownPage !== "notebook"}
              >
                <Notebook
                  conversation={conversation}
                  onConversationChange={props.onConversationChange}
                  reportError={props.reportError}
                  active={active && shownPage === "notebook"}
                />
              </div>}
              {docked.map(session => (
                <div
                  key={session.id}
                  className="chat-page"
                  role="tabpanel"
                  id={`${conversation.id}-terminal-${session.id}`}
                  data-tool-host={session.id}
                  hidden={shownPage !== session.id}
                  {...terminalHost(session.id)}
                />
              ))}
            </div>
          </section>
        </div>
        <div
          className="workspace-splitter"
          hidden={paneLayout !== "split"}
          role="separator"
          aria-label="Resize chat and tools"
          aria-orientation="vertical"
          aria-valuemin={25}
          aria-valuemax={65}
          aria-valuenow={Math.round(ui.split * 100)}
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button === 0) {
              dragSplit.current = ui.split;
              event.currentTarget.setPointerCapture(event.pointerId);
              event.preventDefault();
            }
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const rect = body.current!.getBoundingClientRect();
            dragSplit.current = Math.max(
              chatMinWidth / rect.width,
              Math.min(
                1 - 408 / rect.width,
                (event.clientX - rect.left) / rect.width,
              ),
            );
            body.current!.style.setProperty(
              "--chat-share",
              `${dragSplit.current * 100}%`,
            );
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
              if (dragSplit.current !== null) {
                onUI({ split: dragSplit.current });
                dragSplit.current = null;
              }
            }
          }}
          onPointerCancel={() => {
            if (dragSplit.current !== null) {
              dragSplit.current = null;
              body.current?.style.setProperty(
                "--chat-share",
                `${ui.split * 100}%`,
              );
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              onUI({
                split: Math.max(
                  0.25,
                  Math.min(
                    0.65,
                    ui.split + (event.key === "ArrowLeft" ? -0.025 : 0.025),
                  ),
                ),
              });
            }
          }}
        />
        <section
          className="tools-card"
          data-surface-rim="top-left"
          aria-label="Chat tools"
          hidden={!toolsVisible}
          data-minimized={toolsMinimized}
        >
          <header className="panel-header pane-tab-header">
            <ToolTabStrip tools={allTools} selectedId={currentTool?.id}
              onReorder={toolOrder.reorder}
              onSelect={id => onUI({ toolId: id, focus: 'tools', ...(toolsMinimized ? { toolsMinimized: false } : {}) })}
              onClose={closeTool} onDock={dock} onSplit={(session, dir) => split(session.id, dir)} />
            <div className="pane-actions">
              {controlsHost === 'tools' && header}
              <MenuButton label="Add tool" items={toolsMenu}>
                <Plus size={17} />
              </MenuButton>
              <IconButton
                label={toolsMinimized ? "Restore tools" : "Minimize tools"}
                onClick={() => onUI(current => ({
                  toolsMinimized: !current.toolsMinimized, toolsExpanded: false,
                  focus: !current.toolsMinimized && current.chatOpen ? "chat" : "tools",
                }))}
              >
                {toolsMinimized ? <ChevronUp size={16} /> : <Minus size={16} />}
              </IconButton>
              <IconButton
                label={ui.toolsExpanded ? "Restore tools size" : "Expand tools"}
                onClick={() => onUI(current => ({
                  toolsExpanded: !current.toolsExpanded, expanded: false, toolsMinimized: false, focus: "tools",
                }))}
              >
                {ui.toolsExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </IconButton>
              <IconButton label="Close tools" onClick={() => onUI({ toolsOpen: false, toolsMinimized: false, toolsExpanded: false })}>
                <X size={16} />
              </IconButton>
            </div>
          </header>
          <div className="tool-hosts" hidden={toolsMinimized}>
            {!allTools.length && toolList('workspace-context-tools tools-empty-list', false)}
            <div className="tool-host" id={`tool-host-${filesTool.id}`} data-tool-host={filesTool.id} hidden={!ui.filesOpen || currentTool?.id !== filesTool.id}>
              <FilesPane key={conversation.folder ?? 'no-folder'} conversation={conversation}
                visible={toolsVisible && !toolsMinimized && !!ui.filesOpen && currentTool?.id === filesTool.id}
                request={fileRequest} onChooseFolder={() => void chooseFilesFolder()} onQuote={props.onQuote} />
            </div>
            <div className="tool-host" id={`tool-host-${sheetsTool.id}`} data-tool-host={sheetsTool.id} hidden={!ui.sheetsOpen || currentTool?.id !== sheetsTool.id}>
              {ui.sheetsOpen && <SheetsPane conversation={conversation}
                visible={toolsVisible && !toolsMinimized && currentTool?.id === sheetsTool.id} />}
            </div>
            {props.browsers.map((tab) => (
              <div
                key={tab.id}
                className="tool-host"
                id={`tool-host-${tab.id}`}
                data-tool-host={tab.id}
                hidden={currentTool?.id !== tab.id}
              >
                <BrowserPane
                  tab={tab}
                  visible={toolsVisible && !toolsMinimized && currentTool?.id === tab.id}
                  onTabChange={props.onBrowserChange}
                  onQuote={props.onQuote}
                />
              </div>
            ))}
            {tabTerminals.filter(session => !dockedIds.has(session.id)).map((session) => (
              <div
                key={session.id}
                className="tool-host"
                id={`tool-host-${session.id}`}
                data-tool-host={session.id}
                hidden={currentTool?.id !== session.id}
                {...terminalHost(session.id)}
              />
            ))}
          </div>
        </section>
      </div>
    </section>
    {props.terminals.map(session => {
      // A terminal in a split is shown with its tab, and takes the keys only when it is the one in use.
      const tab = tabOf.get(session.id) ?? session.id;
      return createPortal(
      <TerminalPane
        session={session}
        visible={dockedIds.has(tab)
          ? chatVisible && !minimized && shownPage === tab
          : toolsVisible && !toolsMinimized && currentTool?.id === tab}
        placement={dockedIds.has(tab) ? "chat" : "tools"}
        focusOnShow={focusedLeaf(tab) === session.id}
        currentFolder={conversation.folder}
        onOpenInCurrentFolder={session.workerId
          ? () => props.onLaunch("terminal", session.workerId)
          : undefined}
      />,
      slotFor(session.id),
      session.id,
    );
    })}
    </FileNavigation.Provider>
  );
}
