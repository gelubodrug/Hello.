import { useEffect, useId, useReducer, useRef, useState } from 'react';
import { Bold, CheckSquare, Code2, Eye, Heading2, List, Pencil, Plus, Trash2 } from 'lucide-react';
import { Markdown } from '../chat/Markdown';
import { CodeBlock } from '../chat/CodeBlock';
import { Tooltip } from '../ui/Tooltip';
import { TruncatedText } from '../ui/TruncatedText';
import {
  formatPreviewNotebook,
  initialPreviewNotebook,
  previewEntryLabel,
  previewNotebookReducer,
  type PreviewNotebookEntry,
  type PreviewNotebookFormat,
  type PreviewNotebookKind,
} from './preview-notebook';
import './PreviewNotebook.css';

const formats = [
  ['heading', 'Heading', Heading2],
  ['bold', 'Bold', Bold],
  ['bullet', 'Bullet list', List],
  ['task', 'Task checklist', CheckSquare],
  ['code', 'Code block', Code2],
] as const;

export function PreviewNotebookEditor({
  entry,
  selected,
  label,
  onChange,
}: {
  entry: PreviewNotebookEntry;
  selected: boolean;
  label: string;
  onChange: (patch: Partial<Pick<PreviewNotebookEntry, 'title' | 'body'>>) => void;
}) {
  const [editing, setEditing] = useState(Boolean(entry.added));
  const title = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !entry.added || !selected) return;
    started.current = true;
    title.current?.focus();
  }, [entry.added, selected]);

  function focusBody(start?: number, end?: number) {
    requestAnimationFrame(() => {
      const editor = body.current;
      if (!editor || editor.closest('[hidden], [aria-hidden="true"]')) return;
      editor.focus();
      if (start !== undefined && end !== undefined) editor.setSelectionRange(start, end);
    });
  }

  function formatBody(format: PreviewNotebookFormat) {
    const editor = body.current;
    if (!editor) return;
    const next = formatPreviewNotebook(
      entry.body,
      editor.selectionStart,
      editor.selectionEnd,
      format,
    );
    onChange({ body: next.value });
    focusBody(next.start, next.end);
  }

  const modeLabel = editing ? 'Show formatted text' : 'Edit Markdown source';
  return (
    <section
      className="preview-notebook-editor"
      aria-label={`${label} entry editor`}
      hidden={!selected}
    >
      <div className="preview-notebook-title-row">
        <input
          ref={title}
          aria-label="Entry title"
          placeholder="New entry"
          value={entry.title}
          onChange={(event) => onChange({ title: event.target.value })}
        />
        <Tooltip label={modeLabel}>
          <button
            type="button"
            className="preview-notebook-icon"
            aria-label={modeLabel}
            aria-pressed={editing}
            onClick={() => {
              setEditing((current) => !current);
              if (!editing) focusBody();
            }}
          >
            {editing ? (
              <Eye size={14} aria-hidden="true" />
            ) : (
              <Pencil size={14} aria-hidden="true" />
            )}
          </button>
        </Tooltip>
      </div>
      <div className="preview-notebook-source" hidden={!editing}>
        <div className="preview-notebook-format" role="toolbar" aria-label="Format entry">
          {formats.map(([format, title, Icon]) => (
            <Tooltip key={format} label={title}>
              <button
                type="button"
                className="preview-notebook-icon"
                aria-label={title}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => formatBody(format)}
              >
                <Icon size={14} aria-hidden="true" />
              </button>
            </Tooltip>
          ))}
        </div>
        <textarea
          ref={body}
          aria-label={`${label} sample text`}
          placeholder="Write notes or - [ ] tasks…"
          value={entry.body}
          onChange={(event) => onChange({ body: event.target.value })}
          onKeyDown={(event) => {
            if (
              (event.metaKey || event.ctrlKey) &&
              !event.altKey &&
              event.key.toLowerCase() === 'b'
            ) {
              event.preventDefault();
              formatBody('bold');
            }
          }}
        />
      </div>
      <div
        className="preview-notebook-formatted"
        hidden={editing}
        aria-label="Formatted entry text"
      >
        {entry.body.trim() ? (
          <Markdown content={entry.body} CodeBlockComponent={CodeBlock} />
        ) : (
          <button
            type="button"
            className="preview-notebook-write"
            onClick={() => {
              setEditing(true);
              focusBody();
            }}
          >
            Write a note…
          </button>
        )}
      </div>
    </section>
  );
}

/** One renderer-only notebook module for both pills. Drafts live with their entries. */
export function PreviewNotebook({ kind }: { kind: PreviewNotebookKind }) {
  const [state, dispatch] = useReducer(previewNotebookReducer, kind, initialPreviewNotebook);
  const editorId = useId();
  const label = kind === 'runbook' ? 'Runbook' : 'Tasks';
  return (
    <div className="preview-notebook" data-preview-notebook={kind}>
      <aside className="preview-notebook-list" aria-label={`${label} entries`}>
        <button
          type="button"
          className="preview-notebook-new"
          onClick={() => dispatch({ type: 'add' })}
        >
          <Plus size={14} aria-hidden="true" />
          <span>New entry</span>
        </button>
        <ul>
          {state.entries.map((entry) => (
            <li
              key={entry.id}
              className="preview-notebook-row"
              data-selected={entry.id === state.selectedId}
            >
              <button
                type="button"
                className="preview-notebook-select"
                aria-current={entry.id === state.selectedId ? 'true' : undefined}
                aria-controls={editorId}
                onClick={() => dispatch({ type: 'select', id: entry.id })}
              >
                <TruncatedText>{previewEntryLabel(entry)}</TruncatedText>
              </button>
              <Tooltip label={`Delete ${previewEntryLabel(entry)}`}>
                <button
                  type="button"
                  className="preview-notebook-icon"
                  aria-label={`Delete ${previewEntryLabel(entry)}`}
                  onClick={() => dispatch({ type: 'remove', id: entry.id })}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      </aside>
      <div className="preview-notebook-divider" aria-hidden="true" />
      <div id={editorId} className="preview-notebook-editors">
        {state.entries.length ? (
          state.entries.map((entry) => (
            <PreviewNotebookEditor
              key={entry.id}
              entry={entry}
              selected={entry.id === state.selectedId}
              label={label}
              onChange={(patch) => dispatch({ type: 'update', id: entry.id, patch })}
            />
          ))
        ) : (
          <p className="preview-notebook-empty">Create an entry to start writing.</p>
        )}
      </div>
    </div>
  );
}
