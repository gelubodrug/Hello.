export type PreviewNotebookKind = 'runbook' | 'tasks';

export interface PreviewNotebookEntry {
  id: string;
  title: string;
  body: string;
  added?: boolean;
}

export interface PreviewNotebookState {
  kind: PreviewNotebookKind;
  entries: PreviewNotebookEntry[];
  selectedId: string | null;
  nextId: number;
}

export type PreviewNotebookAction =
  | { type: 'add' }
  | { type: 'select'; id: string }
  | { type: 'update'; id: string; patch: Partial<Pick<PreviewNotebookEntry, 'title' | 'body'>> }
  | { type: 'remove'; id: string };

/** Local specimen data only. This module never reads or writes a live runbook. */
export function initialPreviewNotebook(kind: PreviewNotebookKind): PreviewNotebookState {
  return { kind, entries: [], selectedId: null, nextId: 1 };
}

/** Every keystroke updates its own entry, so selection never acts as Save/Cancel. */
export function previewNotebookReducer(
  state: PreviewNotebookState,
  action: PreviewNotebookAction,
): PreviewNotebookState {
  if (action.type === 'add') {
    const id = `${state.kind}-entry-${state.nextId}`;
    return {
      ...state,
      entries: [...state.entries, { id, title: '', body: '', added: true }],
      selectedId: id,
      nextId: state.nextId + 1,
    };
  }
  const index = state.entries.findIndex((entry) => entry.id === action.id);
  if (index < 0) return state;
  if (action.type === 'select') {
    return state.selectedId === action.id ? state : { ...state, selectedId: action.id };
  }
  if (action.type === 'update') {
    return {
      ...state,
      entries: state.entries.map((entry) =>
        entry.id === action.id ? { ...entry, ...action.patch } : entry,
      ),
    };
  }
  const entries = state.entries.filter((entry) => entry.id !== action.id);
  return {
    ...state,
    entries,
    selectedId:
      state.selectedId === action.id
        ? (entries[Math.min(index, entries.length - 1)]?.id ?? null)
        : state.selectedId,
  };
}

export function previewEntryLabel(entry: Pick<PreviewNotebookEntry, 'title'>): string {
  return entry.title.trim() || 'New entry';
}

export type PreviewNotebookFormat = 'heading' | 'bold' | 'bullet' | 'task' | 'code';

/** Preview-only formatting mirrors the production runbook's small Markdown tools. */
export function formatPreviewNotebook(
  value: string,
  start: number,
  end: number,
  format: PreviewNotebookFormat,
): { value: string; start: number; end: number } {
  if (format === 'bold') {
    const selected = value.slice(start, end) || 'text';
    return {
      value: `${value.slice(0, start)}**${selected}**${value.slice(end)}`,
      start: start + 2,
      end: start + 2 + selected.length,
    };
  }
  const lineStart = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
  const nextBreak = value.indexOf('\n', end);
  const lineEnd = nextBreak < 0 ? value.length : nextBreak;
  const selected = value.slice(lineStart, lineEnd) || (format === 'code' ? 'code' : 'Text');
  if (format === 'code') {
    const prefix = '```text\n';
    return {
      value: `${value.slice(0, lineStart)}${prefix}${selected}\n\`\`\`${value.slice(lineEnd)}`,
      start: lineStart + prefix.length,
      end: lineStart + prefix.length + selected.length,
    };
  }
  const prefix = format === 'heading' ? '## ' : format === 'task' ? '- [ ] ' : '- ';
  const formatted = selected
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
  return {
    value: `${value.slice(0, lineStart)}${formatted}${value.slice(lineEnd)}`,
    start: lineStart + prefix.length,
    end: lineStart + formatted.length,
  };
}
