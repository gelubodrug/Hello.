import { CLI_WORKER_CATALOG, type CliWorkerId } from '../../shared/ipc-contract';

export type PreviewTabKind = 'chat' | 'runbook' | 'tasks' | 'browser' | 'terminal' | 'worker';
export type PreviewToolKind = 'browser' | 'terminal' | 'worker';

export function isPreviewToolKind(kind: PreviewTabKind): kind is PreviewToolKind {
  return kind === 'browser' || kind === 'terminal' || kind === 'worker';
}

export function initialPreviewTools(): PreviewTabsState {
  return { tabs: [], activeId: '', closing: [], nextId: 1 };
}

export interface PreviewTab {
  id: string;
  kind: PreviewTabKind;
  title: string;
  /** Selected CLI identity; absent only for the generic compatibility specimen. */
  workerId?: CliWorkerId;
  added?: boolean;
}

export interface PreviewTabsState {
  tabs: PreviewTab[];
  activeId: string;
  closing: string[];
  nextId: number;
}

export type PreviewTabsAction =
  | { type: 'select'; id: string }
  | { type: 'add'; kind: Exclude<PreviewTabKind, 'chat'>; workerId?: CliWorkerId }
  | { type: 'close'; id: string }
  | { type: 'remove'; id: string };

const titles: Record<PreviewTabKind, string> = {
  chat: 'Chat',
  runbook: 'Runbook',
  tasks: 'Tasks',
  browser: 'Browser',
  terminal: 'Terminal',
  worker: 'CLI worker',
};

/** Reject stale/unknown picker metadata before it can create or select a tab. */
export function isValidPreviewTabAddition(
  action: Extract<PreviewTabsAction, { type: 'add' }>,
): boolean {
  if (!['runbook', 'tasks', 'browser', 'terminal', 'worker'].includes(action.kind)) return false;
  return (
    action.workerId === undefined ||
    (action.kind === 'worker' && CLI_WORKER_CATALOG.some((worker) => worker.id === action.workerId))
  );
}

export function initialPreviewTabs(): PreviewTabsState {
  return {
    tabs: ['chat', 'runbook', 'tasks'].map((kind) => ({
      id: kind,
      kind: kind as PreviewTabKind,
      title: titles[kind as PreviewTabKind],
    })),
    activeId: 'chat',
    closing: [],
    nextId: 1,
  };
}

/** Preview-only state: closing is a visual phase, removal follows its exit. */
export function previewTabsReducer(
  state: PreviewTabsState,
  action: PreviewTabsAction,
): PreviewTabsState {
  if (action.type === 'select') {
    if (!state.tabs.some((tab) => tab.id === action.id)) return state;
    return {
      ...state,
      activeId: action.id,
      closing: state.closing.filter((id) => id !== action.id),
    };
  }
  if (action.type === 'add') {
    if (!isValidPreviewTabAddition(action)) return state;
    const id = `${action.kind}-${state.nextId}`;
    const worker = CLI_WORKER_CATALOG.find((candidate) => candidate.id === action.workerId);
    return {
      ...state,
      tabs: [
        ...state.tabs,
        {
          id,
          kind: action.kind,
          title: worker?.label ?? titles[action.kind],
          ...(action.workerId === undefined ? {} : { workerId: action.workerId }),
          added: true,
        },
      ],
      activeId: id,
      nextId: state.nextId + 1,
    };
  }
  if (action.id === 'chat' || !state.tabs.some((tab) => tab.id === action.id)) return state;
  if (action.type === 'close') {
    if (state.closing.includes(action.id)) return state;
    const available = state.tabs.filter(
      (tab) => tab.id !== action.id && !state.closing.includes(tab.id),
    );
    const index = state.tabs.findIndex((tab) => tab.id === action.id);
    return {
      ...state,
      closing: [...state.closing, action.id],
      activeId:
        state.activeId === action.id
          ? (available[Math.max(0, Math.min(index - 1, available.length - 1))]?.id ?? '')
          : state.activeId,
    };
  }
  // A reselected/reopened tab cancels its pending removal.
  if (!state.closing.includes(action.id)) return state;
  return {
    ...state,
    tabs: state.tabs.filter((tab) => tab.id !== action.id),
    closing: state.closing.filter((id) => id !== action.id),
  };
}
