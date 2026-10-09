import { Fragment, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRightToLine,
  BookOpen,
  Bot,
  ChevronUp,
  CodeXml,
  Columns2,
  Globe,
  FolderOpen,
  Maximize2,
  MessageCircle,
  Minimize2,
  Minus,
  Plus,
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
import { filesTabId, type FileLink, type FilesTab } from '../../shared/files';
import {
  ContextMenu,
  IconButton,
  MenuButton,
  type MenuItem,
} from "../ui/primitives";
import { api } from '../api';

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
  onLaunch: (kind: "browser" | "terminal", workerId?: WorkerId) => void;
  onCloseTool: (tool: BrowserTab | TerminalSession) => void;
  onBrowserChange: (tab: BrowserTab) => void;
  onEditMessage: (id: string, text: string) => void;
  /** A search result chosen in the sidebar, for this chat's find. */
  jump?: FindJump | null;
  quote: ChatQuote | null;
  onQuote: (text: string, extra?: ChatQuoteExtra) => void;
  onQuoteConsumed: () => void;
  reportError: (error: unknown) => void;
}

export function Workspace(props: WorkspaceProps) {
  const { conversation, ui, active, compact, onUI } = props;
  // The chat is "Chat" in either mode; only its icon says which (user, 05.10).
  const chatLabel = 'Chat';
  const ModeIcon = conversation.chatMode === 'coder' ? CodeXml : MessageCircle;
  const pageLabels = { chat: chatLabel, notebook: 'Notebook' };
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
  const pages = CHAT_PAGES;
  const fileNonce = useRef(0);
  const choosingFolder = useRef(false);
  const dragSplit = useRef<number | null>(null);
  const filesTool: FilesTab = { id: filesTabId(conversation.id), conversationId: conversation.id, kind: 'files', title: 'Files' };
  // A terminal is in one pane at a time: a chat tab has left the Tools strip.
  const docked = (ui.chatTerminals ?? []).flatMap(tab => props.terminals.filter(session => session.id === tab.id));
  const dockedIds = new Set(docked.map(session => session.id));
  const shownPage: string = docked.find(session => session.id === ui.chatTerminal)?.id ?? ui.chatTab;
  const pageKeys: string[] = [...pages, ...docked.map(session => session.id)];
  const [pageMenu, setPageMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const menuSession = docked.find(session => session.id === pageMenu?.id);
  const toolOrder = useToolOrder(conversation.id, props.reportError);
  const allTools = orderedTools([...props.browsers, ...props.terminals.filter(session => !dockedIds.has(session.id)), ...(ui.filesOpen ? [filesTool] : [])], toolOrder.order);
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
    if (target) setFileRequest({ ...target, nonce: ++fileNonce.current });
    onUI(ui.filesOpen && ui.toolsOpen && !ui.toolsMinimized && !ui.expanded
      ? { toolId: filesTool.id, focus: 'tools' }
      : { filesOpen: true, toolsOpen: true, toolsMinimized: false, expanded: false, toolId: filesTool.id, focus: 'tools' });
  };
  const closeTool = (tool: BrowserTab | TerminalSession | FilesTab) => {
    if ('kind' in tool && tool.kind === 'files') {
      const remaining = allTools.filter(item => item.id !== tool.id);
      onUI({ filesOpen: false, ...(ui.toolId === tool.id ? { toolId: remaining[0]?.id ?? null } : {}),
        ...(!remaining.length ? { toolsOpen: false, toolsMinimized: false, toolsExpanded: false } : {}) });
    } else props.onCloseTool(tool);
  };
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
          title={conversation.folder ?? 'Choose the folder this chat works in'}>
          <FolderOpen size={16} aria-hidden />
          <span>Work path</span>
        </button>
        {withDetail && <small>{conversation.folder ?? 'Not set — choose a folder'}</small>}
      </li>
    </ul>
  );
  const toolsMenu: MenuItem[] = [
    { id: 'files', label: 'Files', icon: FolderOpen, action: () => openFiles() },
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
                <div className="pills" role="tablist" aria-label={`${chatLabel} pages`}>
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
                        className="chat-page-tab"
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
                    </div>
                  ))}
                </div>
                <ContextMenu position={pageMenu && menuSession ? { x: pageMenu.x, y: pageMenu.y } : null}
                  ariaLabel={menuSession ? `Actions for ${menuSession.title || 'terminal'}` : 'Page actions'}
                  items={menuSession ? [
                    { id: 'undock', label: 'Move to tools', icon: ArrowRightToLine, action: () => undock(menuSession) },
                    { id: 'close', label: 'Close tab', icon: X, action: () => props.onCloseTool(menuSession) },
                  ] : []}
                  onClose={() => setPageMenu(null)} />
                <div className="pane-actions">
                  {controlsHost === 'chat' && header}
                  <MenuButton label={`Add ${chatLabel.toLowerCase()} tool`} items={toolsMenu}>
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
                  settings={props.settings}
                  workers={props.workers}
                  onSettingsChange={props.onSettingsChange}
                  onFolderChange={props.onConversationChange}
                  onTerminal={() => props.onLaunch("terminal")}
                  onWorker={(workerId) => props.onLaunch("terminal", workerId)}
                  quote={props.quote}
                  onQuoteConsumed={props.onQuoteConsumed}
                  reportError={props.reportError}
                  onEditMessage={props.onEditMessage}
                  active={active && shownPage === "chat"}
                  jump={props.jump}
                />
              </div>
              <div
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
              </div>
              {docked.map(session => (
                <div
                  key={session.id}
                  className="chat-page"
                  role="tabpanel"
                  id={`${conversation.id}-terminal-${session.id}`}
                  data-tool-host={session.id}
                  hidden={shownPage !== session.id}
                  ref={outlet(session.id)}
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
              onClose={closeTool} onDock={dock} />
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
            {props.terminals.filter(session => !dockedIds.has(session.id)).map((session) => (
              <div
                key={session.id}
                className="tool-host"
                id={`tool-host-${session.id}`}
                data-tool-host={session.id}
                hidden={currentTool?.id !== session.id}
                ref={outlet(session.id)}
              />
            ))}
          </div>
        </section>
      </div>
    </section>
    {props.terminals.map(session => createPortal(
      <TerminalPane
        session={session}
        visible={dockedIds.has(session.id)
          ? chatVisible && !minimized && shownPage === session.id
          : toolsVisible && !toolsMinimized && currentTool?.id === session.id}
        placement={dockedIds.has(session.id) ? "chat" : "tools"}
        currentFolder={conversation.folder}
        onOpenInCurrentFolder={session.workerId
          ? () => props.onLaunch("terminal", session.workerId)
          : undefined}
      />,
      slotFor(session.id),
      session.id,
    ))}
    </FileNavigation.Provider>
  );
}
