import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  BookOpen,
  Bot,
  ChevronUp,
  CodeXml,
  Globe,
  FolderOpen,
  ListTodo,
  Maximize2,
  MessageCircle,
  Minimize2,
  Minus,
  PanelsTopLeft,
  Plus,
  Terminal,
  X,
} from "lucide-react";
import type {
  AppSettings,
  BrowserTab,
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
import { TerminalPane } from "../terminal/TerminalPane";
import { ToolTabStrip } from './ToolTabStrip';
import { FilesPane, type FileRequest } from '../files/FilesPane';
import { FileNavigation } from '../files/navigation';
import { filesTabId, type FileLink, type FilesTab } from '../../shared/files';
import {
  IconButton,
  MenuButton,
  type MenuItem,
} from "../ui/primitives";
import { api } from '../api';

const CHAT_PAGES = ["chat", "runbook", "tasks"] as const;

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
  chatTab: "chat" | "runbook" | "tasks";
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
  quote: string | null;
  onQuote: (text: string) => void;
  onQuoteConsumed: () => void;
  reportError: (error: unknown) => void;
}

export function Workspace(props: WorkspaceProps) {
  const { conversation, ui, active, compact, onUI } = props;
  const modeLabel = conversation.chatMode === 'coder' ? 'Coder' : 'Chat';
  const ModeIcon = conversation.chatMode === 'coder' ? CodeXml : MessageCircle;
  const pageLabels = { chat: modeLabel, runbook: 'Runbook', tasks: 'Tasks' };
  const body = useRef<HTMLDivElement>(null);
  const [fileRequest, setFileRequest] = useState<FileRequest | null>(null);
  const [choosingWorker, setChoosingWorker] = useState(false);
  // A page tab carries a dot while its notebook holds something, so a plan the
  // agent wrote is visible without opening the page.
  const [filledPages, setFilledPages] = useState<Record<NotebookKind, boolean>>({ runbook: false, tasks: false });
  useEffect(() => {
    let alive = true;
    const refresh = (kind: NotebookKind) => void api.notebooks.list(conversation.id, kind).then(rows => {
      if (!alive) return;
      const filled = rows.some(row => row.title.trim() !== '' || row.body.trim() !== '');
      setFilledPages(current => current[kind] === filled ? current : { ...current, [kind]: filled });
    }, () => undefined);
    setFilledPages({ runbook: false, tasks: false });
    refresh('runbook');
    refresh('tasks');
    const unsubscribe = api.notebooks.onChange?.(event => {
      if (event.conversationId === conversation.id) refresh(event.kind);
    });
    return () => { alive = false; unsubscribe?.(); };
  }, [conversation.id]);
  const fileNonce = useRef(0);
  const choosingFolder = useRef(false);
  const dragSplit = useRef<number | null>(null);
  const filesTool: FilesTab = { id: filesTabId(conversation.id), conversationId: conversation.id, kind: 'files', title: 'Files' };
  const allTools = [...props.browsers, ...props.terminals, ...(ui.filesOpen ? [filesTool] : [])];
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
              Open {modeLabel}
            </button>
          )}
          {!ui.toolsOpen && (
            <button
              type="button"
              className="pill"
              onClick={() => onUI({ toolsOpen: true, toolsMinimized: false, toolsExpanded: false, expanded: false, focus: "tools" })}
            >
              <PanelsTopLeft size={15} />
              Open tools
            </button>
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
              {modeLabel}
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
            aria-label={`${modeLabel} panel`}
          >
            <header className="panel-header pane-tab-header">
                <div className="pills" role="tablist" aria-label={`${modeLabel} pages`}>
                  {CHAT_PAGES.map((kind) => (
                    <div
                      className="tab-pill"
                      key={kind}
                      data-active={ui.chatTab === kind}
                    >
                      <button
                        type="button"
                        className="chat-page-tab"
                        role="tab"
                        aria-label={kind !== "chat" && filledPages[kind] ? `${pageLabels[kind]} (has entries)` : pageLabels[kind]}
                        tabIndex={ui.chatTab === kind ? 0 : -1}
                        aria-selected={ui.chatTab === kind}
                        aria-controls={`${conversation.id}-${kind}`}
                        onClick={() => onUI({ chatTab: kind, focus: "chat", ...(minimized ? { minimized: false } : {}) })}
                        onKeyDown={(event) => {
                          if (
                            event.key === "ArrowRight" ||
                            event.key === "ArrowLeft" ||
                            event.key === "Home" ||
                            event.key === "End"
                          ) {
                            event.preventDefault();
                            const nextIndex = event.key === "Home"
                              ? 0
                              : event.key === "End"
                                ? CHAT_PAGES.length - 1
                                : (CHAT_PAGES.indexOf(kind) +
                                    (event.key === "ArrowRight" ? 1 : -1) +
                                    CHAT_PAGES.length) % CHAT_PAGES.length;
                            onUI({
                              ...(minimized ? { minimized: false } : {}),
                              focus: "chat",
                              chatTab: CHAT_PAGES[nextIndex],
                            });
                            event.currentTarget
                              .closest('[role="tablist"]')
                              ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]
                              ?.focus();
                          }
                        }}
                      >
                        {kind === "chat" ? (
                          <ModeIcon size={14} aria-hidden />
                        ) : kind === "runbook" ? (
                          <BookOpen size={14} aria-hidden />
                        ) : (
                          <ListTodo size={14} aria-hidden />
                        )}
                        {kind !== "chat" && filledPages[kind] && (
                          <span className="chat-page-tab__dot" aria-hidden="true" />
                        )}
                        <span className="chat-page-tab__label" aria-hidden="true">
                          <span>{pageLabels[kind]}</span>
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
                <div className="pane-actions">
                  {controlsHost === 'chat' && header}
                  <MenuButton label={`Add ${modeLabel.toLowerCase()} tool`} items={toolsMenu}>
                    <Plus size={17} />
                  </MenuButton>
                  <IconButton
                    label={`${minimized ? 'Restore' : 'Minimize'} ${modeLabel.toLowerCase()}`}
                    onClick={() => onUI(current => ({
                      minimized: !current.minimized, expanded: current.toolsOpen ? false : current.expanded,
                      focus: !current.minimized && current.toolsOpen ? "tools" : "chat",
                    }))}
                  >
                    {minimized ? <ChevronUp size={16} /> : <Minus size={16} />}
                  </IconButton>
                  <IconButton
                    label={ui.expanded ? `Restore ${modeLabel.toLowerCase()} size` : `Expand ${modeLabel.toLowerCase()}`}
                    onClick={() => onUI(current => ({
                      expanded: !current.expanded, toolsExpanded: false, minimized: false, focus: "chat",
                    }))}
                  >
                    {ui.expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                  </IconButton>
                  <IconButton label={`Close ${modeLabel.toLowerCase()}`} onClick={() => onUI({ chatOpen: false, minimized: false, expanded: false })}>
                    <X size={16} />
                  </IconButton>
                </div>
            </header>
            <div className="chat-card-body" hidden={minimized}>
              <div
                className="chat-page"
                role="tabpanel"
                id={`${conversation.id}-chat`}
                hidden={ui.chatTab !== "chat"}
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
                />
              </div>
              {(["runbook", "tasks"] as const).map((kind) => (
                <div
                  className="chat-page"
                  role="tabpanel"
                  key={kind}
                  id={`${conversation.id}-${kind}`}
                  hidden={ui.chatTab !== kind}
                >
                  <Notebook conversationId={conversation.id} kind={kind} />
                </div>
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
              onSelect={id => onUI({ toolId: id, focus: 'tools', ...(toolsMinimized ? { toolsMinimized: false } : {}) })}
              onClose={closeTool} />
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
                request={fileRequest} onChooseFolder={() => void chooseFilesFolder()} />
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
            {props.terminals.map((session) => (
              <div
                key={session.id}
                className="tool-host"
                id={`tool-host-${session.id}`}
                data-tool-host={session.id}
                hidden={currentTool?.id !== session.id}
              >
                <TerminalPane
                  session={session}
                  visible={toolsVisible && !toolsMinimized && currentTool?.id === session.id}
                  currentFolder={conversation.folder}
                  onOpenInCurrentFolder={session.workerId
                    ? () => props.onLaunch("terminal", session.workerId)
                    : undefined}
                />
              </div>
            ))}
          </div>
        </section>
      </div>
    </section>
    </FileNavigation.Provider>
  );
}
