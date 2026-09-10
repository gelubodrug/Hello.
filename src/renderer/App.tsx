import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  MessageCircle,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Settings,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import type {
  Bootstrap,
  BrowserTab,
  Conversation,
  Message,
  TerminalSession,
  WorkerId,
} from "../shared/types";
import { api } from './api';
import {
  Dialog,
  ErrorNote,
  IconButton,
  MenuButton,
  Truncated,
  errorText,
} from "./ui/primitives";
import {
  createPreviewLayoutMotion,
  type PreviewLayoutMotionPhase,
} from "./ui/layout-motion";
import { animateSurface } from "./ui/surface-motion";
import { SidebarChrome } from './ui/SidebarChrome';
import { SettingsDialog } from "./settings/SettingsDialog";
import {
  Workspace,
  defaultWorkspacePrefs,
  type WorkspacePrefs,
  type WorkspaceUpdate,
} from "./workspace/Workspace";
import { filesTabId } from '../shared/files';

interface ShellState {
  chromeVersion: 4;
  activeId: string | null;
  sidebar: "auto" | "shown" | "hidden";
  workspaces: Record<string, WorkspacePrefs>;
}
const STORAGE_KEY = "hello.workspace.v1";
function initialShell(): ShellState {
  try {
    const saved = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "null",
    ) as (Partial<Omit<ShellState, "chromeVersion">> & { chromeVersion?: number }) | null;
    if (saved && typeof saved === "object") {
      const workspaces: Record<string, WorkspacePrefs> = {};
      for (const [id, value] of Object.entries(saved.workspaces ?? {})) {
        const { pinned: legacyPinned, ...layout } = value;
        workspaces[id] = {
          ...defaultWorkspacePrefs(),
          ...layout,
          // The old standalone Pin choice becomes Expanded, so Restore always
          // returns to Floating. There is no independent pin state anymore.
          expanded: !!value.expanded ||
            (saved.chromeVersion === 3 && !value.toolsOpen && legacyPinned === true),
          split: Number.isFinite(value.split)
            ? Math.max(0.25, Math.min(0.65, value.split))
            : 0.35,
          // These are permanent sections; older closed-tab preferences cannot hide them.
          notebookTabs: ["runbook", "tasks"],
        };
      }
      return {
        chromeVersion: 4,
        activeId: typeof saved.activeId === "string" ? saved.activeId : null,
        sidebar: ["auto", "shown", "hidden"].includes(saved.sidebar ?? "")
          ? saved.sidebar!
          : "auto",
        workspaces,
      };
    }
  } catch {
    /* A damaged preference cannot prevent access to persisted conversations. */
  }
  return { chromeVersion: 4, activeId: null, sidebar: "auto", workspaces: {} };
}
function put<T extends { id: string }>(rows: T[], value: T): T[] {
  return rows.some((row) => row.id === value.id)
    ? rows.map((row) => (row.id === value.id ? value : row))
    : [...rows, value];
}

function hasExpandedPane(ui: WorkspacePrefs): boolean {
  // Solo Chat expands inside its original right-hand stage. Full-workspace
  // focus mode belongs to the two-pane Tools layout only.
  return ui.toolsOpen && ((ui.chatOpen && ui.expanded) || ui.toolsExpanded);
}

function Application() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [shell, setShell] = useState<ShellState>(initialShell);
  const [phase, setPhase] = useState<PreviewLayoutMotionPhase>("idle");
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [visited, setVisited] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState("");
  const [rename, setRename] = useState<Conversation | null>(null);
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [ending, setEnding] = useState<TerminalSession | null>(null);
  const [launching, setLaunching] = useState(false);
  const [width, setWidth] = useState(window.innerWidth);
  const [quotes, setQuotes] = useState<Record<string, string | null>>({});
  const appRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const loaded = useRef(new Set<string>());
  const closingTools = useRef(new Set<string>());
  const overlayHeld = useRef(false);
  const controllerRef =
    useRef<ReturnType<typeof createPreviewLayoutMotion<ShellState>>>();
  if (!controllerRef.current)
    controllerRef.current = createPreviewLayoutMotion(shell, {
      surfaces: () => [
        ...(appRef.current?.querySelectorAll<HTMLElement>(
          '.navigation-area[data-pinned="true"],.workspace:not([hidden]) .workspace-foreground',
        ) ?? []),
      ],
      commit: setShell,
      equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      phase: (next) => {
        if (next !== "idle" && !overlayHeld.current) {
          overlayHeld.current = true;
        }
        if (next === "idle" && overlayHeld.current) {
          overlayHeld.current = false;
        }
        setPhase(next);
      },
    });
  const controller = controllerRef.current;
  const request = controller.request;
  const reportError = useCallback(
    (reason: unknown) => setError(errorText(reason)),
    [],
  );
  const active = boot?.conversations.find(
    (conversation) => conversation.id === shell.activeId,
  );
  const ui = shell.workspaces[shell.activeId ?? ""] ?? defaultWorkspacePrefs();
  const sidebarVisible =
    !hasExpandedPane(ui) && (shell.sidebar === "shown" ||
    (shell.sidebar === "auto" && width >= (ui.toolsOpen ? 1280 : 720)));
  // Hidden navigation keeps only a narrow pointer edge and the native lights.
  const compact = width - (sidebarVisible ? 272 : 4) - 2 < 728;
  const appMessage = error || (launching ? "Opening tool…" : notice);
  useEffect(() => {
    if (!appMessage) setNoticeOpen(false);
  }, [appMessage]);
  useLayoutEffect(() => {
    controller.revealCommitted();
  }, [shell, controller]);
  useEffect(
    () => () => {
      controller.dispose();
      if (overlayHeld.current) {
        overlayHeld.current = false;
      }
    },
    [controller],
  );
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(shell));
    } catch {
      /* UI remains usable if local preferences cannot be written. */
    }
  }, [shell]);
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    let alive = true;
    void api
      .bootstrap()
      .then((data) => {
        if (!alive) return;
        setBoot(data);
        request((current) => ({
          ...current,
          activeId: data.conversations.some(
            (row) => row.id === current.activeId,
          )
            ? current.activeId
            : (data.conversations[0]?.id ?? null),
        }));
      })
      .catch(reportError);
    const unchat = api.chat.onEvent((event) => {
      setMessages((current) => ({
        ...current,
        [event.conversationId]: put(
          current[event.conversationId] ?? [],
          event.message,
        ),
      }));
      if (event.message.status !== "streaming")
        void api.conversations
          .list()
          .then((conversations) => {
            if (alive)
              setBoot((current) =>
                current ? { ...current, conversations } : current,
              );
          })
          .catch(reportError);
    });
    const unbrowser = api.browser.onUpdate((tab) =>
      setBoot((current) =>
        current
          ? { ...current, browsers: put(current.browsers, tab) }
          : current,
      ),
    );
    const unbrowserLifecycle = api.browser.onLifecycle?.((event) => {
      if (event.type === "opened") {
        const { tab } = event;
        setBoot(current => current ? { ...current, browsers: put(current.browsers, tab) } : current);
        if (!event.foreground) return;
        request(current => {
          // A background conversation can open tabs without taking over the desk.
          if (current.activeId !== tab.conversationId) return current;
          const workspace = current.workspaces[tab.conversationId] ?? defaultWorkspacePrefs();
          // Do not steal focus if the user switched tools while the popup opened.
          if (!event.userRequested && workspace.toolId && workspace.toolId !== tab.openerId) return current;
          return { ...current, workspaces: { ...current.workspaces,
            [tab.conversationId]: { ...workspace, toolsOpen: true, toolsMinimized: false,
              expanded: false, toolId: tab.id, focus: "tools" },
          } };
        });
      } else {
        setBoot(current => current ? { ...current, browsers: current.browsers.filter(tab => tab.id !== event.id) } : current);
        request(current => {
          const workspace = current.workspaces[event.conversationId];
          if (!workspace || workspace.toolId !== event.id) return current;
          return { ...current, workspaces: { ...current.workspaces,
            [event.conversationId]: { ...workspace, toolId: event.openerId ?? null },
          } };
        });
      }
    });
    const unterminal = api.terminal.onExit((event) =>
      setBoot((current) =>
        current
          ? {
              ...current,
              terminals: current.terminals.map((session) =>
                session.id === event.id
                  ? { ...session, status: "exited", exitCode: event.exitCode }
                  : session,
              ),
            }
          : current,
      ),
    );
    return () => {
      alive = false;
      unchat();
      unbrowser();
      unbrowserLifecycle?.();
      unterminal();
    };
  }, [request, reportError]);
  useEffect(() => {
    if (!active) return;
    setVisited((current) =>
      current.includes(active.id) ? current : [...current, active.id],
    );
    if (loaded.current.has(active.id)) return;
    loaded.current.add(active.id);
    void api.conversations
      .messages(active.id)
      .then((rows) =>
        setMessages((current) => ({
          ...current,
          [active.id]: [
            ...rows.map(
              (row) =>
                current[active.id]?.find(
                  (existing) => existing.id === row.id,
                ) ?? row,
            ),
            ...(current[active.id] ?? []).filter(
              (row) => !rows.some((existing) => existing.id === row.id),
            ),
          ],
        })),
      )
      .catch((reason) => {
        loaded.current.delete(active.id);
        reportError(reason);
      });
  }, [active?.id, reportError]);
  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching, sidebarVisible]);
  const changeConversation = useCallback(
    (conversation: Conversation) =>
      setBoot((current) =>
        current
          ? {
              ...current,
              conversations: put(current.conversations, conversation),
            }
          : current,
      ),
    [],
  );
  const updateUI = (id: string, patch: WorkspaceUpdate) =>
    request((current) => {
      const previous = {
        ...defaultWorkspacePrefs(),
        ...current.workspaces[id],
      };
      const change = typeof patch === "function" ? patch(previous) : patch;
      return {
        ...current,
        workspaces: {
          ...current.workspaces,
          [id]: {
            ...previous,
            ...change,
          },
        },
      };
    }, typeof patch !== "function" &&
      Object.keys(patch).every(key => ["chatTab", "toolId", "focus"].includes(key))
      ? "instant" : "animate");
  const toggleSidebarPin = () => request(current => {
    const id = current.activeId;
    const currentUI = current.workspaces[id ?? ""] ?? defaultWorkspacePrefs();
    const expanded = hasExpandedPane(currentUI);
    const visible = !expanded && (current.sidebar === "shown" ||
      (current.sidebar === "auto" && width >= (currentUI.toolsOpen ? 1280 : 720)));
    return {
      ...current,
      sidebar: visible ? "hidden" : "shown",
      // Pinning navigation exits focus mode; ordinary Restore keeps
      // the previous sidebar preference because expanding never overwrites it.
      workspaces: expanded && id ? {
        ...current.workspaces,
        [id]: { ...currentUI, expanded: false, toolsExpanded: false },
      } : current.workspaces,
    };
  });
  const select = (id: string) => {
    setError(null);
    request((current) => ({ ...current, activeId: id }));
  };
  const newChat = async () => {
    try {
      const conversation = await api.conversations.create();
      changeConversation(conversation);
      select(conversation.id);
    } catch (reason) {
      reportError(reason);
    }
  };
  const launch = async (
    conversation: Conversation,
    kind: "browser" | "terminal",
    workerId?: WorkerId,
  ) => {
    if (launching) return;
    setLaunching(true);
    setError(null);
    try {
      if (kind === "terminal" && !conversation.folder) {
        const folder = await api.system.chooseFolder();
        if (!folder) return;
        changeConversation(
          await api.conversations.update(conversation.id, { folder }),
        );
      }
      const tool =
        kind === "browser"
          ? await api.browser.create(conversation.id)
          : await api.terminal.create(conversation.id, workerId);
      setBoot((current) =>
        current
          ? "url" in tool
            ? { ...current, browsers: put(current.browsers, tool) }
            : { ...current, terminals: put(current.terminals, tool) }
          : current,
      );
      updateUI(conversation.id, {
        toolsOpen: true,
        toolsMinimized: false,
        expanded: false,
        toolId: tool.id,
        focus: "tools",
      });
    } catch (reason) {
      reportError(reason);
    } finally {
      setLaunching(false);
    }
  };
  const closeTool = async (tool: BrowserTab | TerminalSession) => {
    if (closingTools.current.has(tool.id)) return;
    closingTools.current.add(tool.id);
    const cancel: Array<() => void> = [];
    try {
      const foreground = [
        ...document.querySelectorAll<HTMLElement>(
          `[data-tool-id="${CSS.escape(tool.id)}"],[data-tool-host="${CSS.escape(tool.id)}"]`,
        ),
      ].filter((node) => !node.hidden);
      await Promise.all(
        foreground.map(
          (node) =>
            new Promise<void>((resolve) => {
              cancel.push(animateSurface(node, "exit", { onFinish: resolve }));
            }),
        ),
      );
      if ("url" in tool) await api.browser.close(tool.id);
      else await api.terminal.close(tool.id);
      setBoot((current) =>
        current
          ? {
              ...current,
              browsers: current.browsers.filter((row) => row.id !== tool.id),
              terminals: current.terminals.filter((row) => row.id !== tool.id),
            }
          : current,
      );
      const remaining = [
        ...(boot?.browsers ?? []),
        ...(boot?.terminals ?? []),
        ...(shell.workspaces[tool.conversationId]?.filesOpen ? [{ id: filesTabId(tool.conversationId), conversationId: tool.conversationId }] : []),
      ].filter(
        (row) =>
          row.conversationId === tool.conversationId && row.id !== tool.id,
      );
      updateUI(tool.conversationId, {
        toolId: ("url" in tool && tool.openerId
          ? remaining.find(row => row.id === tool.openerId)?.id : undefined) ?? remaining[0]?.id ?? null,
        ...(remaining.length ? {} : { toolsOpen: false, toolsMinimized: false, toolsExpanded: false }),
      });
      setEnding(null);
    } catch (reason) {
      reportError(reason);
    } finally {
      cancel.forEach((stop) => stop());
      closingTools.current.delete(tool.id);
    }
  };
  const removeConversation = async () => {
    if (!deleting) return;
    try {
      await api.conversations.delete(deleting.id);
      try {
        localStorage.removeItem(`hello.draft.${deleting.id}`);
        for (const key of Object.keys(localStorage)) {
          if (!key.startsWith("hello.notebook.")) continue;
          try {
            if (
              JSON.parse(localStorage.getItem(key) ?? "null")
                ?.conversationId === deleting.id
            )
              localStorage.removeItem(key);
          } catch {
            /* Only entries proven to belong to this chat are removed. */
          }
        }
      } catch {
        /* Persistent app deletion is complete even if local preferences are unavailable. */
      }
      const next = boot!.conversations.filter((row) => row.id !== deleting.id);
      setBoot((current) =>
        current
          ? {
              ...current,
              conversations: next,
              browsers: current.browsers.filter(
                (row) => row.conversationId !== deleting.id,
              ),
              terminals: current.terminals.filter(
                (row) => row.conversationId !== deleting.id,
              ),
            }
          : current,
      );
      request((current) => {
        const workspaces = { ...current.workspaces };
        delete workspaces[deleting.id];
        return {
          ...current,
          workspaces,
          activeId:
            current.activeId === deleting.id
              ? (next[0]?.id ?? null)
              : current.activeId,
        };
      });
      setVisited((current) => current.filter((id) => id !== deleting.id));
      setDeleting(null);
    } catch (reason) {
      reportError(reason);
    }
  };
  const exportConversation = (conversation: Conversation) => {
    void api.conversations
      .export(conversation.id)
      .then((path) => {
        if (path) setNotice("Conversation exported.");
      })
      .catch(reportError);
  };
  const mountedIds = new Set([...visited, ...(active ? [active.id] : [])]);
  return (
    <div className="application">
      <main
        ref={appRef}
        className="app-frame"
        data-surface-rim="bottom-left"
        data-sidebar-visible={sidebarVisible}
        data-layout-motion={phase}
        aria-busy={phase !== "idle" || launching || undefined}
      >
      <SidebarChrome visible={sidebarVisible}>
      <header className="titlebar" aria-label="App navigation">
        <div className="titlebar-brand">
          {appMessage ? (
            <button type="button" className="brand-notice" aria-label={`Hello. ${appMessage}. Show details`}
              onClick={() => setNoticeOpen(true)}>
              Hello.
              <span className="brand-notice-dot" data-error={!!error} />
            </button>
          ) : <strong>Hello.</strong>}
          <IconButton
            label="Search chats"
            onClick={() => {
              setSearching(value => !value);
            }}
            aria-expanded={searching}
          >
            <Search size={17} />
          </IconButton>
          <IconButton label="New chat" onClick={() => void newChat()}>
            <SquarePen size={17} />
          </IconButton>
          <IconButton label={sidebarVisible ? 'Unpin chats sidebar' : 'Pin chats sidebar'}
            className="sidebar-pin-toggle" onClick={toggleSidebarPin} aria-pressed={sidebarVisible}>
            <PanelLeft size={16} aria-hidden="true" />
          </IconButton>
        </div>
      </header>
        <aside className="sidebar" aria-label="Chats">
          {searching && (
            <div className="sidebar-search">
              <Search size={14} />
              <input
                ref={searchRef}
                aria-label="Search conversations"
                placeholder="Search chats"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setSearch("");
                    setSearching(false);
                  }
                }}
              />
            </div>
          )}
          <span className="sidebar-section-label">Chats</span>
          <nav className="chat-list" aria-label="Conversations">
            {boot?.conversations
              .filter((row) =>
                row.title.toLowerCase().includes(search.toLowerCase()),
              )
              .map((conversation) => (
                <div
                  className="chat-list-row"
                  key={conversation.id}
                  data-selected={shell.activeId === conversation.id}
                >
                  <button
                    className="chat-list-select"
                    aria-current={
                      shell.activeId === conversation.id ? "page" : undefined
                    }
                    onClick={() => select(conversation.id)}
                  >
                    <MessageCircle size={16} />
                    <Truncated>{conversation.title}</Truncated>
                    {messages[conversation.id]?.some(
                      (message) => message.status === "streaming",
                    ) && <span className="status-dot busy-dot" />}
                  </button>
                  <MenuButton
                    label={`Actions for ${conversation.title}`}
                    items={[
                      {
                        id: "rename",
                        label: "Rename",
                        icon: Pencil,
                        action: () => {
                          setRename(conversation);
                          setName(conversation.title);
                        },
                      },
                      {
                        id: "export",
                        label: "Export as Markdown",
                        action: () => exportConversation(conversation),
                      },
                      {
                        id: "delete",
                        label: "Delete…",
                        icon: Trash2,
                        separator: true,
                        action: () => setDeleting(conversation),
                      },
                    ]}
                  >
                    <MoreHorizontal size={15} />
                  </MenuButton>
                </div>
              ))}
          </nav>
          <div className="sidebar-footer">
            <button type="button" className="sidebar-settings" onClick={() => setSettingsOpen(true)}>
              <Settings size={16} /> Settings
            </button>
          </div>
        </aside>
      </SidebarChrome>
        {appMessage && <span className="sr-only" role={error ? "alert" : "status"}>{appMessage}</span>}
        {boot && active ? (
          boot.conversations
            .filter((conversation) => mountedIds.has(conversation.id))
            .map((conversation) => (
              <Workspace
                key={conversation.id}
                active={shell.activeId === conversation.id}
                conversation={conversation}
                ui={
                  shell.workspaces[conversation.id] ?? defaultWorkspacePrefs()
                }
                messages={messages[conversation.id] ?? []}
                settings={boot.settings}
                workers={boot.workers}
                terminals={boot.terminals.filter(
                  (session) => session.conversationId === conversation.id,
                )}
                browsers={boot.browsers.filter(
                  (tab) => tab.conversationId === conversation.id,
                )}
                sidebarVisible={sidebarVisible}
                compact={compact}
                onUI={(patch) => updateUI(conversation.id, patch)}
                onSettingsChange={(settings) =>
                  setBoot((current) =>
                    current ? { ...current, settings } : current,
                  )
                }
                onConversationChange={changeConversation}
                onLaunch={(kind, workerId) =>
                  void launch(conversation, kind, workerId)
                }
                onCloseTool={(tool) => {
                  if ("kind" in tool && tool.status === "running")
                    setEnding(tool);
                  else void closeTool(tool);
                }}
                onBrowserChange={(tab) =>
                  setBoot((current) =>
                    current
                      ? { ...current, browsers: put(current.browsers, tab) }
                      : current,
                  )
                }
                quote={quotes[conversation.id] ?? null}
                onQuote={(text) => {
                  setQuotes((current) => ({
                    ...current,
                    [conversation.id]: text,
                  }));
                  updateUI(conversation.id, {
                    chatOpen: true,
                    minimized: false,
                    toolsExpanded: false,
                    chatTab: "chat",
                    focus: "chat",
                  });
                }}
                onQuoteConsumed={() =>
                  setQuotes((current) =>
                    current[conversation.id]
                      ? { ...current, [conversation.id]: null }
                      : current,
                  )
                }
                reportError={reportError}
              />
            ))
        ) : (
          <section
            className="workspace empty-workspace"
            data-surface-rim="top-right"
          >
            <div className="welcome">
              <MessageCircle size={28} />
              <h1>
                {boot
                  ? "Hello. What’s on your mind?"
                  : "Opening your workspace…"}
              </h1>
              <p>
                {boot
                  ? "One conversation. A shared place to work."
                  : "Your conversations stay on this device."}
              </p>
              {boot && (
                <button className="pill" onClick={() => void newChat()}>
                  <Plus size={15} />
                  New chat
                </button>
              )}
            </div>
          </section>
        )}
      </main>
      <Dialog
        open={noticeOpen && !!appMessage}
        title={error ? "Something needs attention" : "Workspace notification"}
        onClose={() => setNoticeOpen(false)}
      >
        <p className={error ? "error-text app-message" : "app-message"}>{appMessage}</p>
        <div className="dialog-actions">
          <button className="pill" onClick={() => {
            setNoticeOpen(false);
            setError(null);
            setNotice("");
          }}>Dismiss</button>
        </div>
      </Dialog>
      {boot && (
<SettingsDialog
	          open={settingsOpen}
	          settings={boot.settings}
	          onSaved={(settings) =>
	            setBoot((current) => (current ? { ...current, settings } : current))
	          }
	          onClose={() => setSettingsOpen(false)}
	          dataPath={boot.dataPath}
	          version={boot.version}
	          extensionsCount={boot.extensionsCount}
	        />
      )}
      <Dialog
        open={rename !== null}
        title="Rename chat"
        onClose={() => setRename(null)}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (rename && name.trim())
              void api.conversations
                .update(rename.id, { title: name.trim() })
                .then((value) => {
                  changeConversation(value);
                  setRename(null);
                })
                .catch(reportError);
          }}
        >
          <label className="field-label">
            Name
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="dialog-actions">
            <button
              type="button"
              className="pill"
              onClick={() => setRename(null)}
            >
              Cancel
            </button>
            <button className="pill primary-button" disabled={!name.trim()}>
              Save
            </button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={deleting !== null}
        title="Delete conversation?"
        onClose={() => setDeleting(null)}
      >
        <p>
          “{deleting?.title}” and its messages and notebook entries will be
          permanently deleted. Its tools will close.
        </p>
        <ErrorNote error={error} />
        <div className="dialog-actions">
          <button className="pill" onClick={() => setDeleting(null)}>
            Cancel
          </button>
          <button
            className="pill danger-button"
            onClick={() => void removeConversation()}
          >
            Delete conversation
          </button>
        </div>
      </Dialog>
      <Dialog
        open={ending !== null}
        title="End this session?"
        onClose={() => setEnding(null)}
      >
        <p>
          Closing “{ending?.title}” ends its running process. To keep it
          running, close the Tools panel instead.
        </p>
        <ErrorNote error={error} />
        <div className="dialog-actions">
          <button className="pill" onClick={() => setEnding(null)}>
            Keep running
          </button>
          <button
            className="pill danger-button"
            onClick={() => ending && void closeTool(ending)}
          >
            End session
          </button>
        </div>
      </Dialog>
    </div>
  );
}

export class App extends Component<
  Record<string, never>,
  { error: string | null }
> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error: errorText(error) };
  }
  render(): ReactNode {
    return this.state.error ? (
      <div className="fatal-error">
        <h1>Unable to show the workspace</h1>
        <p>Your saved conversations have not been deleted.</p>
        <ErrorNote error={this.state.error} />
        <button className="pill" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    ) : (
      <Application />
    );
  }
}
