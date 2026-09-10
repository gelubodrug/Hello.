import { useEffect, useMemo, useRef, useState } from "react";
import type { JSONContent } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown as MarkdownStorage } from "@tiptap/markdown";
import { DOMSerializer, type Fragment } from "@tiptap/pm/model";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  CheckSquare,
  Clipboard,
  Code,
  FileCode2,
  Heading2,
  Italic,
  List,
  Plus,
  Redo2,
  Trash2,
  Undo2,
} from "lucide-react";
import type { NotebookEntry, NotebookKind } from "../../shared/types";
import { api } from "../api";
import { Markdown } from "../chat/Markdown";
import {
  ContextMenu,
  Dialog,
  ErrorNote,
  IconButton,
  errorText,
  type MenuItem,
} from "../ui/primitives";
import "./Notebook.css";

type CloseReason = "action" | "escape" | "dismiss";
type NotebookDraft = NotebookEntry & { expectedUpdatedAt: number };

function savedDraft(value: unknown, conversationId: string, kind: NotebookKind): NotebookDraft | null {
  if (!value || typeof value !== "object") return null;
  const draft = value as Partial<NotebookDraft>;
  if (typeof draft.id !== "string" || draft.conversationId !== conversationId || draft.kind !== kind ||
      typeof draft.title !== "string" || typeof draft.body !== "string" ||
      typeof draft.createdAt !== "number" || typeof draft.updatedAt !== "number") return null;
  // Older drafts have no known base. Preserve them, but never overwrite a
  // potentially newer external edit by guessing their revision.
  return { ...draft, expectedUpdatedAt: Number.isSafeInteger(draft.expectedUpdatedAt) &&
    Number(draft.expectedUpdatedAt) >= 0 ? Number(draft.expectedUpdatedAt) : 0 } as NotebookDraft;
}

function keepDraft(draft: NotebookDraft): void {
  try { localStorage.setItem(`hello.notebook.${draft.id}`, JSON.stringify(draft)); }
  catch { /* The in-memory draft and save error remain available. */ }
}

function clearDraft(id: string): void {
  try { localStorage.removeItem(`hello.notebook.${id}`); } catch { /* Best effort. */ }
}

function sameDraft(a: NotebookEntry, b: NotebookEntry): boolean {
  return a.updatedAt === b.updatedAt && a.title === b.title && a.body === b.body;
}

function acknowledgeDraft(sent: NotebookDraft, newer: NotebookEntry | undefined, revision: number): void {
  try {
    const stored = savedDraft(JSON.parse(localStorage.getItem(`hello.notebook.${sent.id}`) ?? "null"), sent.conversationId, sent.kind);
    // A component remounted while this IPC call was running may already own a
    // newer draft. An old acknowledgement must not delete or replace it.
    if (stored && sameDraft(stored, sent)) clearDraft(sent.id);
    else if (stored && newer && sameDraft(stored, newer)) keepDraft({ ...newer, expectedUpdatedAt: revision });
  } catch { /* Save success does not depend on local draft storage. */ }
}
type ContextSnapshot = {
  position: { x: number; y: number };
  selected: boolean;
  plain: string;
  html?: string;
  markdown: string;
  markdownSelected?: boolean;
  restore: (reason: CloseReason) => void;
};

const idleToolbar = {
  heading: false,
  bold: false,
  italic: false,
  bullet: false,
  task: false,
  code: false,
  canUndo: false,
  canRedo: false,
};

/** Status syntax in fenced code is sample text, never a live task. */
function mapTaskRows(source: string, transform: (row: string) => string): string {
  let fence: { char: string; length: number } | null = null;
  return source.split(/(\r?\n)/).map(row => {
    const marker = /^\s*(?:>\s*)*(`{3,}|~{3,})/.exec(row)?.[1];
    if (marker) {
      if (!fence) fence = { char: marker[0], length: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.length) fence = null;
      return row;
    }
    return fence ? row : transform(row);
  }).join("");
}

/** Marked recognizes [ ]/[x]; expose legacy [-] tasks without losing their status. */
function markdownForEditor(source: string): string {
  return mapTaskRows(source, row => row.replace(
    /^(\s*(?:[-*+]|\d+[.)])\s+)\[-\]\s+(.*)$/,
    (_match, prefix: string, text: string) =>
      `${prefix}[ ] ${text.startsWith("**In progress** — ") ? text : `**In progress** — ${text}`}`,
  ));
}

function markdownForStorage(source: string): string {
  return mapTaskRows(source, row => row.replace(
    /^(\s*(?:[-*+]|\d+[.)])\s+)\[ \](\s+\*\*In progress\*\*\s+—\s+)/,
    "$1[-]$2",
  ));
}

/** Keep syntax outside the configured schema in an explicit, lossless source editor. */
function syntaxOutsideRichEditor(source: string): string {
  const rows = source.replace(/\r\n?/g, "\n").split("\n");
  let fence: { char: string; length: number } | null = null;
  return rows
    .map((row) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(row)?.[1];
      if (marker) {
        if (!fence) fence = { char: marker[0], length: marker.length };
        else if (marker[0] === fence.char && marker.length >= fence.length)
          fence = null;
        return "";
      }
      if (fence) return "";
      return row.replace(/(`+)[^`\n]*?\1/g, "");
    })
    .join("\n");
}

function needsSourceFallback(source: string, serialized: string): boolean {
  if (!source.trim()) return false;
  if (!serialized.trim()) return true;
  const visible = syntaxOutsideRichEditor(source);
  const withoutAutolinks = visible
    .replace(/<https?:\/\/[^>\s]+>/g, "")
    .replace(/<[^<>\s]+@[^<>\s]+>/g, "");
  return (
    /(^|\n)\s*<!--/.test(visible) ||
    /^\s*---\s*\n[\s\S]*?\n---\s*(\n|$)/.test(visible) ||
    /!\[[^\]]*\]\([^)]*\)/.test(visible) ||
    /\[\^[^\]]+\]/.test(visible) ||
    /(^|\n)\s*\[[^\]^]+\]:\s+\S+/.test(visible) ||
    /(^|\n)\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}/.test(visible) ||
    /<\/?[A-Za-z][^>]*>/.test(withoutAutolinks)
  );
}

function htmlForFragment(
  editor: NonNullable<ReturnType<typeof useEditor>>,
  fragment: Fragment,
): string {
  const container = document.createElement("div");
  container.appendChild(
    DOMSerializer.fromSchema(editor.schema).serializeFragment(fragment),
  );
  return container.innerHTML;
}

function fragmentMarkdown(
  editor: NonNullable<ReturnType<typeof useEditor>>,
  content: JSONContent[],
): string {
  return markdownForStorage(
    editor.markdown!.serialize({ type: "doc", content }),
  );
}

function writeClipboard(
  snapshot: ContextSnapshot,
  format: "rendered" | "markdown",
  onError: (reason: unknown) => void,
): void {
  const text = format === "markdown" ? snapshot.markdown : snapshot.plain;
  void api.system
    .copy({ text, ...(format === "rendered" && snapshot.html ? { html: snapshot.html } : {}) })
    .catch(onError);
}

function RichEntryEditor({
  body,
  label,
  placeholder,
  onBodyChange,
  onBlur,
}: {
  body: string;
  label: string;
  placeholder: string;
  onBodyChange: (body: string) => void;
  onBlur: () => void;
}) {
  const [sourceOnly, setSourceOnly] = useState(false);
  const [editingSource, setEditingSource] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [context, setContext] = useState<ContextSnapshot | null>(null);
  const source = useRef<HTMLTextAreaElement>(null);
  const lastBody = useRef(body);
  const extensions = useMemo(
    () => [
      StarterKit.configure({ link: { openOnClick: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder }),
      MarkdownStorage.configure({
        indentation: { style: "space", size: 2 },
        markedOptions: { gfm: true, breaks: false },
      }),
    ],
    [placeholder],
  );
  const editor = useEditor({
    extensions,
    content: markdownForEditor(body),
    contentType: "markdown",
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: "notebook-rich-content",
        "aria-label": label,
        role: "textbox",
        "aria-multiline": "true",
        spellcheck: "true",
      },
    },
    onCreate: ({ editor: nextEditor }) => {
      setSourceOnly(
        needsSourceFallback(
          body,
          markdownForStorage(nextEditor.getMarkdown()),
        ),
      );
    },
    onUpdate: ({ editor: nextEditor }) => {
      const markdown = markdownForStorage(nextEditor.getMarkdown());
      lastBody.current = markdown;
      onBodyChange(markdown);
    },
  });
  const toolbar =
    useEditorState({
      editor,
      selector: ({ editor: currentEditor }) =>
        currentEditor
          ? {
              heading: currentEditor.isActive("heading", { level: 2 }),
              bold: currentEditor.isActive("bold"),
              italic: currentEditor.isActive("italic"),
              bullet: currentEditor.isActive("bulletList"),
              task: currentEditor.isActive("taskList"),
              code: currentEditor.isActive("codeBlock"),
              canUndo: currentEditor.can().undo(),
              canRedo: currentEditor.can().redo(),
            }
          : idleToolbar,
    }) ?? idleToolbar;

  useEffect(() => {
    if (!editor || sourceOnly || body === lastBody.current) return;
    editor.commands.setContent(markdownForEditor(body), {
      contentType: "markdown",
      emitUpdate: false,
    });
    lastBody.current = body;
    setSourceOnly(
      needsSourceFallback(body, markdownForStorage(editor.getMarkdown())),
    );
  }, [body, editor, sourceOnly]);

  const openRichContext = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!editor) return;
    event.preventDefault();
    const selection = editor.state.selection;
    const selected = !selection.empty;
    const fragment = selected
      ? selection.content().content
      : editor.state.doc.content;
    setContext({
      position: { x: event.clientX, y: event.clientY },
      selected,
      plain: editor.state.doc.textBetween(
        selected ? selection.from : 0,
        selected ? selection.to : editor.state.doc.content.size,
        "\n",
      ),
      html: htmlForFragment(editor, fragment),
      markdown: selected
        ? fragmentMarkdown(editor, fragment.toJSON() as JSONContent[])
        : body,
      restore: (reason) => {
        if (reason === "dismiss") return;
        requestAnimationFrame(() => {
          editor.commands.setTextSelection({
            from: selection.from,
            to: selection.to,
          });
          editor.commands.focus();
        });
      },
    });
  };

  const openSourceContext = (event: React.MouseEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    const node = event.currentTarget;
    const start = node.selectionStart;
    const end = node.selectionEnd;
    const selected = start !== end;
    const markdown = selected ? body.slice(start, end) : body;
    setContext({
      position: { x: event.clientX, y: event.clientY },
      selected,
      plain: markdown,
      markdown,
      restore: (reason) => {
        if (reason === "dismiss") return;
        requestAnimationFrame(() => {
          source.current?.focus();
          source.current?.setSelectionRange(start, end);
        });
      },
    });
  };

  const openPreviewContext = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const selection = window.getSelection();
    const selected = Boolean(selection && !selection.isCollapsed && selection.rangeCount &&
      event.currentTarget.contains(selection.anchorNode) && event.currentTarget.contains(selection.focusNode));
    const range = selected ? selection!.getRangeAt(0).cloneRange() : null;
    const container = document.createElement("div");
    container.appendChild(range ? range.cloneContents() : event.currentTarget.cloneNode(true));
    container.querySelectorAll("button, .code-heading").forEach(node => node.remove());
    setContext({
      position: { x: event.clientX, y: event.clientY },
      selected,
      plain: selected ? selection!.toString() : event.currentTarget.innerText,
      html: container.innerHTML,
      // Unsupported syntax has no safe rendered-selection → source mapping.
      // Keep the original source and make this scope explicit in the menu.
      markdown: body,
      markdownSelected: false,
      restore: reason => {
        if (reason === "dismiss" || !range) return;
        requestAnimationFrame(() => {
          const currentSelection = window.getSelection();
          currentSelection?.removeAllRanges();
          currentSelection?.addRange(range);
        });
      },
    });
  };

  const contextItems: MenuItem[] = context
    ? [
        {
          id: "copy",
          label: "Copy",
          detail: context.selected ? "Selection" : "Entire entry",
          icon: Clipboard,
          action: () => {
            setCopyError(null);
            writeClipboard(context, "rendered", (reason) =>
              setCopyError(errorText(reason)),
            );
          },
        },
        {
          id: "copy-markdown",
          label: "Copy Markdown",
          detail: (context.markdownSelected ?? context.selected)
            ? "Selection source"
            : "Entire entry source",
          icon: FileCode2,
          action: () => {
            setCopyError(null);
            writeClipboard(context, "markdown", (reason) =>
              setCopyError(errorText(reason)),
            );
          },
        },
      ]
    : [];

  if (sourceOnly) {
    return (
      <>
        <ErrorNote error={copyError} />
        <div className="notebook-source-note" role="status">
          <span>
            This entry contains Markdown the rich editor cannot safely preserve.
          </span>
          {!editingSource && (
            <button
              type="button"
              className="text-button"
              onClick={() => setEditingSource(true)}
            >
              Edit Markdown source
            </button>
          )}
        </div>
        {editingSource ? (
          <textarea
            ref={source}
            className="notebook-source-fallback"
            aria-label={`${label}, Markdown source mode`}
            value={body}
            placeholder={placeholder}
            onChange={(event) => {
              lastBody.current = event.target.value;
              onBodyChange(event.target.value);
            }}
            onBlur={onBlur}
            onContextMenu={openSourceContext}
            onKeyDown={(event) => {
              if (
                (event.metaKey || event.ctrlKey) &&
                event.key.toLowerCase() === "s"
              ) {
                event.preventDefault();
                onBlur();
              }
            }}
          />
        ) : (
          <div className="notebook-source-preview" aria-label={`${label}, read-only`} onContextMenu={openPreviewContext}>
            <Markdown text={body} />
          </div>
        )}
        <ContextMenu
          position={context?.position ?? null}
          items={contextItems}
          ariaLabel="Editor copy options"
          onClose={(reason) => {
            context?.restore(reason);
            setContext(null);
          }}
        />
      </>
    );
  }

  return (
    <>
      <ErrorNote error={copyError} />
      <div
        className="notebook-rich-shell"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) onBlur();
        }}
        onKeyDownCapture={(event) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === "s"
          ) {
            event.preventDefault();
            onBlur();
          }
        }}
      >
        <div
          className="editor-toolbar"
          role="toolbar"
          aria-label="Formatting"
          onMouseDown={(event) => event.preventDefault()}
        >
          <IconButton
            label="Heading"
            aria-pressed={toolbar.heading}
            onClick={() =>
              editor?.chain().focus().toggleHeading({ level: 2 }).run()
            }
          >
            <Heading2 size={16} />
          </IconButton>
          <IconButton
            label="Bold"
            aria-pressed={toolbar.bold}
            onClick={() => editor?.chain().focus().toggleBold().run()}
          >
            <Bold size={16} />
          </IconButton>
          <IconButton
            label="Italic"
            aria-pressed={toolbar.italic}
            onClick={() => editor?.chain().focus().toggleItalic().run()}
          >
            <Italic size={16} />
          </IconButton>
          <IconButton
            label="Bullet list"
            aria-pressed={toolbar.bullet}
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
          >
            <List size={16} />
          </IconButton>
          <IconButton
            label="Task list"
            aria-pressed={toolbar.task}
            onClick={() => editor?.chain().focus().toggleTaskList().run()}
          >
            <CheckSquare size={16} />
          </IconButton>
          <IconButton
            label="Code block"
            aria-pressed={toolbar.code}
            onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
          >
            <Code size={16} />
          </IconButton>
          <span className="editor-toolbar-spacer" />
          <IconButton
            label="Undo"
            disabled={!toolbar.canUndo}
            onClick={() => editor?.chain().focus().undo().run()}
          >
            <Undo2 size={16} />
          </IconButton>
          <IconButton
            label="Redo"
            disabled={!toolbar.canRedo}
            onClick={() => editor?.chain().focus().redo().run()}
          >
            <Redo2 size={16} />
          </IconButton>
        </div>
        <div className="notebook-rich-scroll" onContextMenu={openRichContext}>
          <EditorContent editor={editor} />
        </div>
      </div>
      <ContextMenu
        position={context?.position ?? null}
        items={contextItems}
        ariaLabel="Editor copy options"
        onClose={(reason) => {
          context?.restore(reason);
          setContext(null);
        }}
      />
    </>
  );
}

/** Keying the session prevents drafts and undo history crossing conversations. */
export function Notebook(props: {
  conversationId: string;
  kind: NotebookKind;
}) {
  return (
    <NotebookSession
      key={`${props.conversationId}:${props.kind}`}
      {...props}
    />
  );
}

/** Both notebooks use the same editor and independent persisted entries. */
function NotebookSession({
  conversationId,
  kind,
}: {
  conversationId: string;
  kind: NotebookKind;
}) {
  const [entries, setEntries] = useState<NotebookEntry[]>([]);
  const entriesRef = useRef<NotebookEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<NotebookEntry | null>(null);
  const [reloading, setReloading] = useState<NotebookEntry | null>(null);
  const [resolving, setResolving] = useState(false);
  const [conflicts, setConflicts] = useState<Set<string>>(new Set());
  const conflictIds = useRef(new Set<string>());
  const baseVersions = useRef(new Map<string, number>());
  const loaded = useRef(false);
  const refreshRequested = useRef(false);
  const refreshNotebooks = useRef<() => void>(() => {});
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const pending = useRef(new Map<string, NotebookDraft>());
  const inFlight = useRef(new Map<string, NotebookDraft>());
  const mutationRevision = useRef(0);
  const queue = useRef(Promise.resolve());
  const mounted = useRef(true);
  const current = entries.find((entry) => entry.id === selected);
  const title = kind === "runbook" ? "Runbook" : "Runbook tasks";
  const setConflict = (id: string, value: boolean) => {
    if (value) conflictIds.current.add(id);
    else conflictIds.current.delete(id);
    if (mounted.current) setConflicts(new Set(conflictIds.current));
  };

  const flush = (): Promise<void> => {
    clearTimeout(timer.current);
    const writes = [...pending.current.values()].filter(entry => !conflictIds.current.has(entry.id));
    for (const entry of writes) pending.current.delete(entry.id);
    if (!writes.length) return queue.current;
    for (const entry of writes) inFlight.current.set(entry.id, entry);
    if (mounted.current) setSaving(true);
    queue.current = queue.current
      .catch(() => undefined)
      .then(async () => {
        for (const entry of writes) {
          try {
            if (conflictIds.current.has(entry.id)) {
              if (!pending.current.has(entry.id)) pending.current.set(entry.id, entry);
              continue;
            }
            const saved = await api.notebooks.save({ ...entry,
              expectedUpdatedAt: baseVersions.current.get(entry.id) ?? entry.expectedUpdatedAt });
            baseVersions.current.set(entry.id, saved.updatedAt);
            const newer = entriesRef.current.find(row => row.id === entry.id);
            acknowledgeDraft(entry, newer, saved.updatedAt);
            if (newer && sameDraft(newer, entry)) {
              const rows = entriesRef.current.map(row => row.id === entry.id ? saved : row);
              entriesRef.current = rows;
              if (mounted.current) setEntries(rows);
            } else if (newer) {
              const draft = { ...newer, expectedUpdatedAt: saved.updatedAt };
              // Only our acknowledged save can advance a pending draft's base.
              if (pending.current.has(entry.id)) pending.current.set(entry.id, draft);
            }
          } catch (reason) {
            const queued = pending.current.get(entry.id);
            const active = inFlight.current.get(entry.id);
            const hasNewer =
              (queued !== undefined && queued !== entry) ||
              (active !== undefined && active !== entry);
            if (!hasNewer)
              pending.current.set(entry.id, entry);
            if (/Notebook changed since|Notebook entry not found/i.test(errorText(reason)))
              setConflict(entry.id, true);
            if (mounted.current) setError(errorText(reason));
          } finally {
            if (inFlight.current.get(entry.id) === entry)
              inFlight.current.delete(entry.id);
          }
        }
        if (mounted.current)
          setSaving(pending.current.size > 0 || inFlight.current.size > 0);
      }).finally(() => {
        // A CLI update may arrive after our commit but before its IPC result.
        // During that interval the live refresh preserves the in-flight draft;
        // read once more after settling so that update cannot remain hidden.
        // Refresh only reads: this does not enqueue another save or refresh loop.
        if (mounted.current) refreshNotebooks.current();
      });
    return queue.current;
  };

  useEffect(() => {
    mounted.current = true;
    let alive = true;
    void api.notebooks
      .list(conversationId, kind)
      .then((rows) => {
        if (!alive) return;
        const restored = rows.map((row) => {
          baseVersions.current.set(row.id, row.updatedAt);
          try {
            const draft = savedDraft(JSON.parse(
              localStorage.getItem(`hello.notebook.${row.id}`) ?? "null",
            ), conversationId, kind);
            if (draft?.id === row.id && (draft.title !== row.title || draft.body !== row.body)) {
              baseVersions.current.set(row.id, draft.expectedUpdatedAt);
              pending.current.set(row.id, draft);
              if (draft.expectedUpdatedAt !== row.updatedAt) setConflict(row.id, true);
              return draft;
            }
            if (draft?.id === row.id) clearDraft(row.id);
          } catch {
            /* Ignore malformed local drafts. */
          }
          return row;
        });
        // A deleted entry can still have an unsaved draft from this notebook.
        // Keep it recoverable as a new entry instead of losing it on remount.
        try {
          for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (!key?.startsWith("hello.notebook.")) continue;
            let draft: NotebookDraft | null = null;
            try { draft = savedDraft(JSON.parse(localStorage.getItem(key) ?? "null"), conversationId, kind); }
            catch { continue; }
            if (!draft || key !== `hello.notebook.${draft.id}` || restored.some(row => row.id === draft.id)) continue;
            restored.push(draft);
            pending.current.set(draft.id, draft);
            baseVersions.current.set(draft.id, draft.expectedUpdatedAt);
            setConflict(draft.id, true);
          }
        } catch { /* Existing in-memory entries still load if draft storage is unavailable. */ }
        entriesRef.current = restored;
        loaded.current = true;
        setEntries(restored);
        setSelected(restored[0]?.id ?? null);
        setLoading(false);
        if (pending.current.size) void flush();
        if (refreshRequested.current) refreshNotebooks.current();
      })
      .catch((reason) => {
        if (alive) {
          loaded.current = true;
          setError(errorText(reason));
          setLoading(false);
          if (refreshRequested.current) refreshNotebooks.current();
        }
      });
    const saveOnLeave = () => void flush();
    window.addEventListener("beforeunload", saveOnLeave);
    return () => {
      alive = false;
      mounted.current = false;
      window.removeEventListener("beforeunload", saveOnLeave);
      void flush();
    };
  }, [conversationId, kind]);

  useEffect(() => {
    let alive = true;
    let request = 0;
    const completed = new Set<string>();
    const refresh = async () => {
      if (!loaded.current) {
        refreshRequested.current = true;
        return;
      }
      refreshRequested.current = false;
      const version = ++request;
      const revision = mutationRevision.current;
      try {
        const rows = await api.notebooks.list(conversationId, kind);
        if (!alive || version !== request) return;
        if (revision !== mutationRevision.current) {
          void refresh();
          return;
        }
        {
          const currentRows = entriesRef.current;
          const local = currentRows.filter((row) => {
            if (pending.current.has(row.id) || inFlight.current.has(row.id))
              return true;
            try {
              return (
                localStorage.getItem(`hello.notebook.${row.id}`) !== null
              );
            } catch {
              return false;
            }
          });
          const merged = rows.map((row) => {
            const draft = local.find(item => item.id === row.id);
            if (!draft) baseVersions.current.set(row.id, row.updatedAt);
            // In-flight writes emit before their IPC response; let their CAS
            // result determine whether this is our own update or a conflict.
            else if (!inFlight.current.has(row.id) && baseVersions.current.get(row.id) !== row.updatedAt)
              setConflict(row.id, true);
            return draft ?? row;
          });
          for (const draft of local) {
            if (!rows.some(row => row.id === draft.id)) setConflict(draft.id, true);
          }
          const next = [
            ...merged,
            ...local.filter(
              (draft) => !rows.some((row) => row.id === draft.id),
            ),
          ];
          entriesRef.current = next;
          setEntries(next);
        }
        setSelected((id) =>
          entriesRef.current.some((row) => row.id === id)
            ? id
            : (rows[0]?.id ?? null),
        );
      } catch (reason) {
        if (alive) setError(errorText(reason));
      }
    };
    refreshNotebooks.current = () => void refresh();
    const unsubscribe = api.chat.onEvent((event) => {
      if (event.conversationId !== conversationId) return;
      const changed = event.message.parts?.some((part) => {
        if (
          part.type !== "tool" ||
          part.status !== "complete" ||
          !["notebook_save", "notebook_task_status"].includes(part.name) ||
          completed.has(part.id)
        )
          return false;
        completed.add(part.id);
        return true;
      });
      if (changed) void refresh();
    });
    const unsubscribeNotebooks = api.notebooks.onChange?.(event => {
      if (event.conversationId === conversationId && event.kind === kind) void refresh();
    });
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      unsubscribe();
      unsubscribeNotebooks?.();
      window.removeEventListener("focus", onFocus);
    };
  }, [conversationId, kind]);

  const update = (
    id: string,
    patch: Partial<Pick<NotebookEntry, "title" | "body">>,
  ) => {
    const entry = entriesRef.current.find(
      (candidate) => candidate.id === id,
    );
    if (!entry) return;
    const next: NotebookDraft = { ...entry, ...patch,
      updatedAt: Math.max(Date.now(), entry.updatedAt + 1),
      expectedUpdatedAt: baseVersions.current.get(id) ?? entry.updatedAt };
    mutationRevision.current += 1;
    const rows = entriesRef.current.map((candidate) =>
      candidate.id === next.id ? next : candidate,
    );
    entriesRef.current = rows;
    setEntries(rows);
    pending.current.set(next.id, next);
    setSaving(true);
    if (!conflictIds.current.has(id)) setError(null);
    keepDraft(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 450);
  };

  const add = async () => {
    try {
      await flush();
      const entry = await api.notebooks.save({
        conversationId,
        kind,
        title: "Untitled",
        body: "",
      });
      baseVersions.current.set(entry.id, entry.updatedAt);
      const rows = [...entriesRef.current.filter(row => row.id !== entry.id), entry];
      mutationRevision.current += 1;
      entriesRef.current = rows;
      setEntries(rows);
      setSelected(entry.id);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const remove = async () => {
    if (!removing) return;
    const entry = removing;
    try {
      await flush();
      await api.notebooks.delete(entry.id);
      pending.current.delete(entry.id);
      inFlight.current.delete(entry.id);
      baseVersions.current.delete(entry.id);
      setConflict(entry.id, false);
      clearDraft(entry.id);
      const rows = entriesRef.current.filter((row) => row.id !== entry.id);
      mutationRevision.current += 1;
      entriesRef.current = rows;
      setEntries(rows);
      if (selected === entry.id) setSelected(rows[0]?.id ?? null);
      setRemoving(null);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const recover = async (entry: NotebookEntry, saveCopy: boolean) => {
    if (resolving) return;
    setResolving(true);
    try {
      await queue.current;
      const snapshot = entriesRef.current.find(row => row.id === entry.id);
      if (!snapshot) return;
      const latest = (await api.notebooks.list(conversationId, kind)).find(row => row.id === entry.id);
      const copy = saveCopy ? await api.notebooks.save({
        conversationId, kind, title: `${snapshot.title || "Untitled"} (draft)`, body: snapshot.body,
      }) : null;
      // Preserve any edits made while a save request was in flight.
      const unchanged = entriesRef.current.find(row => row.id === entry.id) === snapshot;
      let rows = entriesRef.current;
      if (unchanged) {
        pending.current.delete(entry.id);
        clearDraft(entry.id);
        setConflict(entry.id, false);
        if (latest) baseVersions.current.set(entry.id, latest.updatedAt);
        else baseVersions.current.delete(entry.id);
        rows = rows.flatMap(row => row.id === entry.id ? (latest ? [latest] : []) : [row]);
      }
      if (copy) {
        baseVersions.current.set(copy.id, copy.updatedAt);
        rows = [...rows.filter(row => row.id !== copy.id), copy];
      }
      mutationRevision.current += 1;
      entriesRef.current = rows;
      setEntries(rows);
      setSelected(copy?.id ?? (rows.some(row => row.id === entry.id) ? entry.id : rows[0]?.id ?? null));
      setSaving(pending.current.size > 0 || inFlight.current.size > 0);
      setError(null);
      setReloading(null);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      if (mounted.current) setResolving(false);
    }
  };

  return (
    <section className="notebook" aria-label={title}>
      <aside className="notebook-list" aria-label={`${title} entries`}>
        <button className="text-button notebook-add" onClick={() => void add()}>
          <Plus size={15} />
          New entry
        </button>
        {entries.map((entry) => (
          <button
            key={entry.id}
            className="notebook-entry"
            data-selected={selected === entry.id}
            aria-pressed={selected === entry.id}
            onClick={() => {
              void flush();
              setSelected(entry.id);
            }}
          >
            <span className="truncate">{entry.title || "Untitled"}</span>
          </button>
        ))}
      </aside>
      <div className="notebook-editor">
        <ErrorNote error={error} />
        {current && conflicts.has(current.id) ? (
          <div className="notebook-conflict" role="status">
            <p>This entry changed elsewhere. Your draft is kept here.</p>
            <div className="notebook-conflict-actions">
              <button className="text-button" disabled={resolving} onClick={() => void recover(current, true)}>
                Save draft as new
              </button>
              <button className="text-button" disabled={resolving} onClick={() => setReloading(current)}>
                Reload latest…
              </button>
            </div>
          </div>
        ) : error && (
          <button
            className="text-button notebook-retry"
            onClick={() => void flush()}
          >
            Retry save
          </button>
        )}
        {current ? (
          <>
            <header className="notebook-editor-header">
              <input
                aria-label="Entry title"
                value={current.title}
                onChange={(event) =>
                  update(current.id, { title: event.target.value })
                }
                onBlur={() => void flush()}
              />
              <span className="save-state" role="status" aria-live="polite">
                {conflicts.has(current.id) ? "Draft conflict"
                  : pending.current.has(current.id) || inFlight.current.has(current.id)
                    ? error ? "Unsaved changes" : saving ? "Saving…" : "Unsaved changes"
                    : "Saved"}
              </span>
              <IconButton
                label="Delete entry"
                onClick={() => setRemoving(current)}
              >
                <Trash2 size={15} />
              </IconButton>
            </header>
            <RichEntryEditor
              key={current.id}
              body={current.body}
              label={`${title} entry body`}
              placeholder={
                kind === "tasks"
                  ? "Write the next steps. One task at a time."
                  : "Keep findings, decisions and useful references here."
              }
              onBodyChange={(body) => update(current.id, { body })}
              onBlur={() => void flush()}
            />
          </>
        ) : (
          <div className="notebook-empty">
            <h2>{title}</h2>
            <p>
              {loading
                ? "Loading entries…"
                : "A quiet place to keep what matters."}
            </p>
            {!loading && (
              <button className="pill" onClick={() => void add()}>
                <Plus size={15} />
                New entry
              </button>
            )}
          </div>
        )}
      </div>
      <Dialog
        open={reloading !== null}
        title="Reload latest entry?"
        onClose={() => { if (!resolving) setReloading(null); }}
      >
        <p>This discards your local draft and loads the saved entry. Choose Save draft as new to keep both versions.</p>
        <div className="dialog-actions">
          <button className="pill" disabled={resolving} onClick={() => setReloading(null)}>Cancel</button>
          <button className="pill" disabled={resolving} onClick={() => reloading && void recover(reloading, true)}>Save draft as new</button>
          <button className="pill danger-button" disabled={resolving} onClick={() => reloading && void recover(reloading, false)}>Discard draft and reload</button>
        </div>
      </Dialog>
      <Dialog
        open={removing !== null}
        title="Delete entry?"
        onClose={() => setRemoving(null)}
      >
        <p>Delete “{removing?.title || "Untitled"}”? This cannot be undone.</p>
        <div className="dialog-actions">
          <button className="pill" onClick={() => setRemoving(null)}>
            Cancel
          </button>
          <button className="pill danger-button" onClick={() => void remove()}>
            Delete entry
          </button>
        </div>
      </Dialog>
    </section>
  );
}
