import {
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { BookOpen, Bot, Globe, ListTodo, MessageCircle, Plus, Terminal, X } from 'lucide-react';
import { Menu } from '../ui/Menu';
import { Popover } from '../ui/Popover';
import { animateSurface } from '../ui/surface-motion';
import { PreviewNotebook } from './PreviewNotebook';
import { PreviewToolSurface } from './PreviewToolSurface';
import { isPreviewToolKind } from './preview-tabs';
import { previewCliWorkerItems } from './preview-cli-picker';
import type {
  PreviewTab,
  PreviewTabKind,
  PreviewTabsAction,
  PreviewTabsState,
} from './preview-tabs';

const icons = {
  chat: MessageCircle,
  runbook: BookOpen,
  tasks: ListTodo,
  browser: Globe,
  terminal: Terminal,
  worker: Bot,
};

function TabContent({
  tab,
  shown,
  children,
  exclusive = false,
}: {
  tab: PreviewTab;
  shown: boolean;
  children: ReactNode;
  exclusive?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [painted, setPainted] = useState(shown);
  const first = useRef(true);
  useLayoutEffect(() => {
    if (shown) setPainted(true);
    else if (exclusive) setPainted(false);
  }, [shown, exclusive]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.inert = !shown;
    const initial = first.current;
    first.current = false;
    if (!painted || (exclusive && !shown) || (initial && !tab.added)) return;
    return animateSurface(el, shown ? 'enter' : 'exit', {
      onFinish: () => {
        if (!shown) setPainted(false);
      },
    });
  }, [shown, painted, tab.added, exclusive]);

  return (
    <div
      ref={ref}
      id={`preview-panel-${tab.id}`}
      role="tabpanel"
      aria-labelledby={`preview-tab-${tab.id}`}
      aria-hidden={!shown}
      hidden={!painted || (exclusive && !shown)}
      className="preview-tab-panel"
    >
      {children}
    </div>
  );
}

function TabButton({
  tab,
  active,
  closing,
  dispatch,
}: {
  tab: PreviewTab;
  active: boolean;
  closing: boolean;
  dispatch: Dispatch<PreviewTabsAction>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const initial = first.current;
    first.current = false;
    if (initial && !tab.added) return;
    return animateSurface(el, closing ? 'exit' : 'enter', {
      onFinish: () => {
        if (closing) dispatch({ type: 'remove', id: tab.id });
      },
    });
  }, [closing, dispatch, tab.added, tab.id]);
  const Icon = icons[tab.kind];
  return (
    <div ref={ref} className="preview-tab" data-active={active} data-closing={closing}>
      <button
        type="button"
        id={`preview-tab-${tab.id}`}
        role="tab"
        aria-selected={active}
        aria-controls={`preview-panel-${tab.id}`}
        tabIndex={active ? 0 : -1}
        onClick={() => dispatch({ type: 'select', id: tab.id })}
      >
        <Icon size={14} aria-hidden="true" />
        <span>{tab.title}</span>
      </button>
      {tab.kind !== 'chat' && (
        <button
          type="button"
          className="preview-tab-close"
          aria-label={`Close ${tab.title} tab`}
          tabIndex={active ? 0 : -1}
          onClick={(event) => {
            const list = event.currentTarget.closest('[role="tablist"]');
            // The focused close control leaves; focus the surviving tab after commit.
            dispatch({ type: 'close', id: tab.id });
            requestAnimationFrame(() =>
              list?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus(),
            );
          }}
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function SampleTool({ tab }: { tab: PreviewTab }) {
  if (tab.kind === 'runbook' || tab.kind === 'tasks') return <PreviewNotebook kind={tab.kind} />;
  return isPreviewToolKind(tab.kind) ? (
    <PreviewToolSurface kind={tab.kind} label={tab.title} />
  ) : null;
}

export function PreviewTabs({
  state,
  dispatch,
  children,
  zone = 'chat',
}: {
  state: PreviewTabsState;
  dispatch: Dispatch<PreviewTabsAction>;
  children?: ReactNode;
  zone?: 'chat' | 'tools';
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPage, setMenuPage] = useState<'tools' | 'workers'>('tools');
  const anchor = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const dismissMenu = () => {
    setMenuOpen(false);
    anchor.current?.focus();
  };
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).getAttribute('role') !== 'tab') return;
    const visible = state.tabs.filter((tab) => !state.closing.includes(tab.id));
    if (visible.length === 0) return;
    const current = visible.findIndex((tab) => tab.id === state.activeId);
    let index: number;
    switch (event.key) {
      case 'ArrowRight':
        index = (current + 1) % visible.length;
        break;
      case 'ArrowLeft':
        index = (current + visible.length - 1) % visible.length;
        break;
      case 'Home':
        index = 0;
        break;
      case 'End':
        index = visible.length - 1;
        break;
      case 'Delete':
        if (state.activeId !== 'chat') {
          event.preventDefault();
          dispatch({ type: 'close', id: state.activeId });
          requestAnimationFrame(() =>
            list.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus(),
          );
        }
        return;
      default:
        return;
    }
    event.preventDefault();
    dispatch({ type: 'select', id: visible[index].id });
    document.getElementById(`preview-tab-${visible[index].id}`)?.focus();
  }
  const allChoices: { kind: Exclude<PreviewTabKind, 'chat'>; label: string }[] = [
    { kind: 'runbook', label: 'Runbook' },
    { kind: 'tasks', label: 'Tasks' },
    { kind: 'browser', label: 'Browser' },
    { kind: 'terminal', label: 'Terminal' },
    { kind: 'worker', label: 'CLI worker' },
  ];
  const choices = allChoices.filter(({ kind }) => zone === 'chat' || isPreviewToolKind(kind));
  const menuItems =
    menuPage === 'workers'
      ? previewCliWorkerItems(
          (workerId) => {
            dispatch({ type: 'add', kind: 'worker', workerId });
            dismissMenu();
          },
          () => setMenuPage('tools'),
        )
      : choices.map(({ kind, label }) => ({
          id: kind,
          label: kind === 'worker' ? `${label}…` : label,
          icon: icons[kind],
          onSelect: () => {
            if (kind === 'worker') {
              setMenuPage('workers');
              return;
            }
            const existing = state.tabs.find((tab) => tab.kind === kind);
            dispatch(
              zone === 'tools' && existing
                ? { type: 'select', id: existing.id }
                : { type: 'add', kind },
            );
            dismissMenu();
          },
        }));
  return (
    <>
      <div className="preview-tabs-header">
        <div
          ref={list}
          className="preview-tabs"
          role="tablist"
          aria-label={zone === 'tools' ? 'Tool tabs' : 'Preview tabs'}
          onKeyDown={handleKeyDown}
        >
          {state.tabs.map((tab) => (
            <TabButton
              key={tab.id}
              tab={tab}
              active={tab.id === state.activeId}
              closing={state.closing.includes(tab.id)}
              dispatch={dispatch}
            />
          ))}
        </div>
        <button
          ref={anchor}
          className="chat-preview-actions"
          type="button"
          aria-label={zone === 'tools' ? 'Add tool' : 'Add preview tab'}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => {
            setMenuPage('tools');
            setMenuOpen((value) => !value);
          }}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
        <Popover
          key={menuPage}
          open={menuOpen}
          anchorRef={anchor}
          placement="bottom-end"
          onClose={() => setMenuOpen(false)}
        >
          <Menu
            aria-label={menuPage === 'workers' ? 'Choose CLI worker (preview)' : 'New preview tab'}
            open={menuOpen}
            animatePresence={false}
            onClose={dismissMenu}
            items={menuItems}
          />
        </Popover>
      </div>
      <div className="preview-tab-panels">
        {zone === 'tools' && state.tabs.length === 0 && (
          <p className="preview-tools-empty">Choose Browser, Terminal or CLI worker from +.</p>
        )}
        {state.tabs.map((tab) => (
          <TabContent
            key={tab.id}
            tab={tab}
            shown={tab.id === state.activeId}
            exclusive={zone === 'tools'}
          >
            {tab.kind === 'chat' ? children : <SampleTool tab={tab} />}
          </TabContent>
        ))}
      </div>
    </>
  );
}
