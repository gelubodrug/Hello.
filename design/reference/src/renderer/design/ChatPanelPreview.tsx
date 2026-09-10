/** Renderer-only design fixture. No preload, IPC, model requests or live data. */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  BookOpen,
  Download,
  ListTodo,
  MessageCircle,
  Moon,
  MoreHorizontal,
  Pencil,
  PanelLeft,
  PanelsTopLeft,
  Sun,
  Trash2,
  X,
} from 'lucide-react';

import { ChatPanel } from '../chat/ChatPanel';
import { Composer } from '../chat/Composer';
import MessageList from '../chat/MessageList';
import { StatusBar } from '../layout/StatusBar';
import { conversationsStore } from '../state/conversations';
import { endpointsStore } from '../state/endpoints';
import { settingsStore } from '../state/settings';
import { Menu, type MenuItemDef } from '../ui/Menu';
import { Popover } from '../ui/Popover';
import { Tooltip } from '../ui/Tooltip';
import { TruncatedText } from '../ui/TruncatedText';
import { trackInputModality } from '../ui/input-modality';
import { PreviewTabs } from './PreviewTabs';
import { createPreviewLayoutMotion, type PreviewLayoutMotionPhase } from './preview-layout-motion';
import {
  initialPreviewTabs,
  initialPreviewTools,
  isPreviewToolKind,
  previewTabsReducer,
  type PreviewTabKind,
  type PreviewTabsAction,
} from './preview-tabs';
import {
  clampPreviewSplit,
  previewSidebarVisible,
  previewToolsReducer,
  type SidebarPreference,
} from './preview-workspace';
import type { Conversation, Message } from '../../shared/types';

import '../styles/fonts.css';
import '../styles/tokens.css';
import '../styles/typography.css';
import '../styles/motion.css';
import '../styles/globals.css';
import '../app/App.css';
import './ChatPanelPreview.css';

const endpointId = 'design-preview';
const modelId = 'local-preview';
const settings = { temperature: 0.7, maxTokens: null, timeoutMs: 30_000 };
const now = Date.now();

function message(role: Message['role'], content: string, orderIndex: number): Message {
  return {
    id: `preview-${orderIndex}`,
    conversationId: 'chat-design-preview',
    role,
    content,
    orderIndex,
    createdAt: now + orderIndex,
    endpointId,
    modelId,
    settings,
    metrics: null,
  };
}

const sample: Conversation = {
  id: 'chat-design-preview',
  title: 'Research & handoff',
  createdAt: now,
  updatedAt: now,
  endpointId,
  modelId,
  settings,
  mode: 'chat',
  incompleteStream: false,
  groupId: null,
  groupName: null,
  coderRoot: null,
  messages: [
    message(
      'user',
      'Keep the research in the runbook. We can hand the implementation tasks to a CLI worker when we’re ready.',
      0,
    ),
    message(
      'assistant',
      'The chat keeps the context; the worker gets a clear place to start.\n\n### A small, shared workspace\n\n- **Runbook** — findings, decisions and useful references.\n- **Runbook tasks** — the work to pick up, one task at a time.\n- **CLI worker** — launched in this chat’s folder.\n\nNothing is sent automatically. Ask the worker to read the tasks when you want it to begin.\n\n```md\n- [ ] Review the browser findings\n- [ ] Implement the first task\n- [ ] Report what changed\n```',
      1,
    ),
  ],
};

// Replace only this isolated page's in-memory stores, never the app's stores.
conversationsStore.setState({
  activeId: sample.id,
  activeConversation: sample,
  send: async (text) => {
    const current = conversationsStore.getState().activeConversation ?? sample;
    const next = current.messages.length;
    conversationsStore.setState({
      activeConversation: {
        ...current,
        messages: [
          ...current.messages,
          message('user', text, next),
          message(
            'assistant',
            'Preview only — your message stays on this page. No model was called.',
            next + 1,
          ),
        ],
      },
    });
  },
});
endpointsStore.setState({
  discoveryPhase: 'done',
  activeEndpointId: endpointId,
  activeModelId: modelId,
  endpoints: [
    {
      id: endpointId,
      displayName: 'Design preview',
      baseUrl: 'http://localhost',
      hasApiKey: false,
      customHeaders: {},
      defaults: settings,
      timeoutMs: 30_000,
      verifiedAt: null,
      source: 'manual',
    },
  ],
  models: {
    [endpointId]: [
      {
        id: modelId,
        displayName: 'Preview model',
        endpointId,
        source: 'manual',
        verifiedAt: null,
        vision: false,
      },
    ],
  },
});
settingsStore.setState({ resolvedTheme: 'dark', terminalEnabled: false });
document.documentElement.dataset.theme = 'dark';
trackInputModality();

function ReopenPane({ pane, onOpen }: { pane: 'chat' | 'tools'; onOpen: () => void }): JSX.Element {
  return (
    <button className="chat-preview-reopen" data-pane={pane} type="button" onClick={onOpen}>
      {pane === 'chat' ? <MessageCircle size={16} /> : <PanelsTopLeft size={16} />}
      Open {pane}
    </button>
  );
}

interface PreviewLayout {
  open: boolean;
  toolsOpen: boolean;
  sidebarPreference: SidebarPreference;
}

function ChatPanelPreview(): JSX.Element {
  const [layout, setLayout] = useState<PreviewLayout>({
    open: true,
    toolsOpen: false,
    sidebarPreference: 'auto',
  });
  const { open, toolsOpen, sidebarPreference } = layout;
  const workMode = toolsOpen;
  const [layoutMotion, setLayoutMotion] = useState<PreviewLayoutMotionPhase>('idle');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [notice, setNotice] = useState('Sample conversation. No connected tools or model.');
  const [empty, setEmpty] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tabs, dispatchLocalTabs] = useReducer(previewTabsReducer, undefined, initialPreviewTabs);
  const [tools, dispatchToolState] = useReducer(
    previewToolsReducer,
    undefined,
    initialPreviewTools,
  );
  const [workspaceWidth, setWorkspaceWidth] = useState(1200);
  const [split, setSplit] = useState(0.35);
  const [focusPane, setFocusPane] = useState<'chat' | 'tools'>('tools');
  const workspaceRef = useRef<HTMLElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const closedPanesRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const layoutMotionRef = useRef<ReturnType<typeof createPreviewLayoutMotion<PreviewLayout>>>();
  if (!layoutMotionRef.current) {
    layoutMotionRef.current = createPreviewLayoutMotion(layout, {
      surfaces: () =>
        [layoutRef.current, sidebarRef.current, closedPanesRef.current].filter(
          (surface): surface is HTMLElement => surface !== null && !surface.hidden,
        ),
      commit: setLayout,
      phase: setLayoutMotion,
      equals: (left, right) =>
        left.open === right.open &&
        left.toolsOpen === right.toolsOpen &&
        left.sidebarPreference === right.sidebarPreference,
    });
  }
  const layoutController = layoutMotionRef.current;
  const requestLayout = layoutController.request;
  const savedSidebar = useRef<SidebarPreference>('auto');
  const previousWorkMode = useRef(false);
  const hasTools = tools.tabs.length > 0;
  const previousHasTools = useRef(hasTools);
  const sidebarVisible = previewSidebarVisible(workspaceWidth, workMode, sidebarPreference);
  const contentWidth = workspaceWidth - (sidebarVisible ? 228 : 0) - 48;
  const compact = workMode && contentWidth < 720;
  const splitRatio = clampPreviewSplit(split, contentWidth);
  const requestToolsOpen = useCallback(
    (next: boolean) => {
      requestLayout((current) => {
        if (current.toolsOpen === next) return current;
        if (next) savedSidebar.current = current.sidebarPreference;
        return {
          ...current,
          toolsOpen: next,
          sidebarPreference: next ? current.sidebarPreference : savedSidebar.current,
        };
      });
    },
    [requestLayout],
  );
  const dispatchTools = useCallback(
    (action: PreviewTabsAction) => {
      dispatchToolState(action);
      if (action.type === 'add' || action.type === 'select') {
        requestToolsOpen(true);
        setFocusPane('tools');
      }
    },
    [requestToolsOpen],
  );
  const dispatchTabs = useCallback(
    (action: PreviewTabsAction) => {
      if (action.type === 'add' && isPreviewToolKind(action.kind)) dispatchTools(action);
      else {
        dispatchLocalTabs(action);
        if (action.type === 'select') setFocusPane('chat');
      }
    },
    [dispatchTools],
  );
  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const observer = new ResizeObserver(([entry]) => setWorkspaceWidth(entry.contentRect.width));
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    // Closing the group preserves hosts. Only explicit last-tab removal ends
    // the tool workspace; a newly opened empty group still exposes its chooser.
    if (previousHasTools.current && !hasTools) requestToolsOpen(false);
    previousHasTools.current = hasTools;
  }, [hasTools, requestToolsOpen]);
  useLayoutEffect(() => {
    // The exit's filled frame survives React's one geometry commit. Reveal
    // before paint, including a newly shown sidebar, without a visible snap.
    layoutController.revealCommitted();
  }, [layout, layoutController]);
  useEffect(() => () => layoutController.dispose(), [layoutController]);
  useLayoutEffect(() => {
    if (previousWorkMode.current === workMode) return;
    previousWorkMode.current = workMode;
    document
      .querySelector<HTMLButtonElement>(
        workMode
          ? '.chat-preview-tools [aria-label="Add tool"]'
          : '.chat-preview-reopen[data-pane="tools"]',
      )
      ?.focus();
  }, [workMode]);
  const [motion, setMotion] = useState<'normal' | 'slow' | 'reduced'>('normal');
  const previousOpen = useRef(open);
  useLayoutEffect(() => {
    if (previousOpen.current === open) return;
    previousOpen.current = open;
    document
      .querySelector<HTMLButtonElement>(
        open ? '[aria-label="Chat panel"] button' : '.chat-preview-reopen[data-pane="chat"]',
      )
      ?.focus();
  }, [open]);
  useEffect(() => {
    document.documentElement.dataset.previewMotion = motion;
    return () => {
      delete document.documentElement.dataset.previewMotion;
    };
  }, [motion]);
  const openChat = (): void => {
    requestLayout((current) => ({ ...current, open: true }));
    setFocusPane('chat');
  };
  const openTools = (): void => {
    requestToolsOpen(true);
    setFocusPane('tools');
  };
  const toggleSidebar = (): void => {
    // Toggle against the last intent, not the still-visible outgoing layout.
    requestLayout((current) => ({
      ...current,
      sidebarPreference: previewSidebarVisible(
        workspaceWidth,
        current.toolsOpen,
        current.sidebarPreference,
      )
        ? 'hidden'
        : 'shown',
    }));
  };
  const selectPreviewTab = (kind: PreviewTabKind): void => {
    const target = isPreviewToolKind(kind) ? tools : tabs;
    const dispatch = isPreviewToolKind(kind) ? dispatchTools : dispatchTabs;
    const existing = target.tabs.find((tab) => tab.kind === kind);
    if (existing) dispatch({ type: 'select', id: existing.id });
    else if (kind !== 'chat') dispatch({ type: 'add', kind });
    if (!isPreviewToolKind(kind)) openChat();
  };
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const dismissMenuFromKeyboard = (): void => {
    setMenuOpen(false);
    menuAnchor.current?.focus();
  };
  const previewAction = (label: string): void => {
    setNotice(`${label} — visual preview only; no live conversation is changed.`);
    setMenuOpen(false);
    if (label === 'Runbook') selectPreviewTab('runbook');
    if (label === 'Runbook tasks') selectPreviewTab('tasks');
  };
  const menuItems: MenuItemDef[] = [
    { id: 'runbook', label: 'Runbook', icon: BookOpen },
    { id: 'tasks', label: 'Runbook tasks', icon: ListTodo },
    { id: 'rename', label: 'Rename', icon: Pencil, separatorBefore: true },
    { id: 'export', label: 'Export as Markdown', icon: Download, separatorBefore: true },
    { id: 'delete', label: 'Delete…', icon: Trash2, destructive: true, separatorBefore: true },
  ].map((item) => ({ ...item, onSelect: () => previewAction(item.label) }));

  const toggleSample = (): void => {
    const next = !empty;
    setEmpty(next);
    conversationsStore.setState({
      activeConversation: { ...sample, messages: next ? [] : sample.messages },
    });
  };
  const toggleTheme = (): void => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    settingsStore.setState({ resolvedTheme: next });
  };

  return (
    <div className="chat-preview">
      <nav className="chat-preview-toolbar" aria-label="Design preview controls">
        <span>
          Hello. <span className="chat-preview-caption">Chat design preview</span>
        </span>
        <div>
          <button
            type="button"
            onClick={() => {
              for (const kind of ['terminal', 'worker', 'browser'] as const)
                dispatchTools({ type: 'add', kind });
            }}
          >
            Try tools
          </button>
          <button
            type="button"
            onClick={() =>
              setMotion((value) =>
                value === 'normal' ? 'slow' : value === 'slow' ? 'reduced' : 'normal',
              )
            }
          >
            Motion: {motion === 'normal' ? 'Normal' : motion === 'slow' ? 'Slow ×3' : 'Reduced'}
          </button>
          <button type="button" onClick={toggleSample}>
            {empty ? 'Sample conversation' : 'Empty state'}
          </button>
          <button type="button" onClick={toggleTheme}>
            {theme === 'dark' ? <Moon size={14} /> : <Sun size={14} />}
            {theme === 'dark' ? 'Dark' : 'Light'}
          </button>
        </div>
      </nav>
      <main
        ref={workspaceRef}
        className="chat-preview-workspace"
        data-surface-rim="bottom-left"
        data-work-mode={workMode}
        data-sidebar-visible={sidebarVisible}
        data-layout-motion={layoutMotion}
        aria-busy={layoutMotion !== 'idle' || undefined}
      >
        <aside
          ref={sidebarRef}
          className="chat-preview-sidebar"
          aria-label="Workspace preview"
          hidden={!sidebarVisible}
        >
          <strong className="chat-preview-brand">Hello.</strong>
          <span className="chat-preview-caption">Chats</span>
          <button
            className="chat-preview-current"
            type="button"
            aria-current="true"
            onClick={() => selectPreviewTab('chat')}
          >
            <MessageCircle size={16} /> Research & handoff
          </button>
        </aside>
        <section
          className="chat-preview-canvas"
          data-surface-rim="top-right"
          aria-label="Chat design study"
        >
          <header className="chat-preview-canvas-header">
            <button
              type="button"
              className="chat-preview-actions"
              aria-label={sidebarVisible ? 'Hide chats sidebar' : 'Show chats sidebar'}
              aria-expanded={sidebarVisible}
              onClick={toggleSidebar}
            >
              <PanelLeft size={16} aria-hidden="true" />
            </button>
            <TruncatedText className="chat-preview-workspace-title">
              Research & handoff <span className="chat-preview-tag">Chat</span>
            </TruncatedText>
            {(!open || !toolsOpen) && (
              <div ref={closedPanesRef} className="chat-preview-closed-panes">
                {!open && <ReopenPane pane="chat" onOpen={openChat} />}
                {!toolsOpen && <ReopenPane pane="tools" onOpen={openTools} />}
              </div>
            )}
            {compact && open && (
              <div className="chat-preview-pane-switch" aria-label="Visible workspace pane">
                <button
                  type="button"
                  aria-pressed={focusPane === 'chat'}
                  onClick={() => setFocusPane('chat')}
                >
                  Chat
                </button>
                <button
                  type="button"
                  aria-pressed={focusPane === 'tools'}
                  onClick={() => setFocusPane('tools')}
                >
                  Tool
                </button>
              </div>
            )}
            <Tooltip label="Chat actions">
              <button
                ref={menuAnchor}
                type="button"
                className="chat-preview-actions"
                aria-label="Chat actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((current) => !current)}
              >
                <MoreHorizontal size={18} />
              </button>
            </Tooltip>
            <Popover
              open={menuOpen}
              anchorRef={menuAnchor}
              placement="bottom-end"
              onClose={() => setMenuOpen(false)}
            >
              <Menu
                items={menuItems}
                open={menuOpen}
                animatePresence={false}
                aria-label="Chat actions"
                onClose={dismissMenuFromKeyboard}
              />
            </Popover>
          </header>
          <div
            ref={layoutRef}
            className="chat-preview-canvas-body"
            data-work-mode={workMode}
            data-chat-open={open}
            data-compact={compact}
            data-focus-pane={focusPane}
            style={{ '--preview-chat-share': `${splitRatio * 100}%` } as CSSProperties}
          >
            <aside className="chat-preview-context">
              <span className="chat-preview-caption">Design study</span>
              <h1>Research & handoff</h1>
              <p>
                One conversation.
                <br />A shared place to work.
              </p>
              <p className="chat-preview-caption">
                Open this chat’s tools from the + beside its pills.
                <br />
                Keep them together as you float, pin or minimize.
              </p>
            </aside>
            <div
              className="chat-preview-module"
              hidden={!open || (compact && focusPane !== 'chat')}
            >
              {open && (
                <ChatPanel
                  title="Research & handoff"
                  initialPresentation="floating"
                  workMode={workMode}
                  onClose={() => {
                    requestLayout((current) => ({ ...current, open: false }));
                  }}
                >
                  <PreviewTabs state={tabs} dispatch={dispatchTabs}>
                    <MessageList />
                    <Composer
                      onAddEndpoint={() =>
                        setNotice(
                          'Endpoint setup belongs to the app. This page uses local sample data.',
                        )
                      }
                      onNewTerminal={() => selectPreviewTab('terminal')}
                      onNewCliWorker={(workerId) =>
                        dispatchTools({ type: 'add', kind: 'worker', workerId })
                      }
                    />
                    <StatusBar />
                  </PreviewTabs>
                </ChatPanel>
              )}
            </div>
            <div
              className="chat-preview-splitter"
              role="separator"
              aria-label="Resize chat and tool"
              aria-orientation="vertical"
              aria-valuemin={Math.round(clampPreviewSplit(0, contentWidth) * 100)}
              aria-valuemax={Math.round(clampPreviewSplit(1, contentWidth) * 100)}
              aria-valuenow={Math.round(splitRatio * 100)}
              tabIndex={workMode && !compact && open ? 0 : -1}
              hidden={!workMode || compact || !open}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                event.preventDefault();
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                const rect = layoutRef.current?.getBoundingClientRect();
                if (rect)
                  setSplit(
                    clampPreviewSplit((event.clientX - rect.left) / rect.width, contentWidth),
                  );
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onKeyDown={(event) => {
                const next =
                  event.key === 'ArrowLeft'
                    ? splitRatio - 0.025
                    : event.key === 'ArrowRight'
                      ? splitRatio + 0.025
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? 1
                          : null;
                if (next !== null) {
                  event.preventDefault();
                  setSplit(clampPreviewSplit(next, contentWidth));
                }
              }}
            />
            <section
              className="chat-preview-tools"
              aria-label="Chat tools"
              data-surface-rim="top-left"
              hidden={!workMode || (compact && open && focusPane !== 'tools')}
            >
              <div className="chat-preview-tools-heading">
                <span>Tools</span>
                <div className="chat-preview-tools-actions">
                  <span className="chat-preview-caption">One at a time · simulated</span>
                  <button
                    type="button"
                    className="chat-preview-actions"
                    aria-label="Close tools"
                    onClick={() => requestToolsOpen(false)}
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <PreviewTabs state={tools} dispatch={dispatchTools} zone="tools" />
            </section>
          </div>
        </section>
      </main>
      <footer className="chat-preview-footer" role="status">
        {notice}
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<ChatPanelPreview />);
