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
  Folder,
  FolderOpen,
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
import type { Conversation, NotebookEntry, NotebookKind } from "../../shared/types";
import { NotebookSwitch } from "./NotebookSwitch";
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

/**
 * One notebook, three sections (user, 29.09): Runbooks, Tasks and Plans, each
 * switched on or off for the model as a whole. Only a Runbook chapter has a
 * switch of its own, since the Runbooks are reference the human picks from;
 * Tasks and Plans are all there while their section is on. Plans follows the
 * chat's Plan: it is where plan_write keeps the plan.
 */
const SECTIONS: ReadonlyArray<{ kind: NotebookKind; title: string; placeholder: string; empty: (on: boolean) => string; label: (on: boolean) => string }> = [
  {
    kind: "runbook", title: "Runbooks",
    placeholder: "Keep findings, decisions and useful references here.",
    empty: () => "No chapters yet",
    label: on => on ? "Runbooks on — the model reads the chapters that are on" : "Runbooks off — the model does not see them",
  },
  {
    kind: "tasks", title: "Tasks",
    placeholder: "Write the next steps. One task at a time.",
    empty: () => "No task lists yet",
    label: on => on ? "Tasks on — the model reads and updates them" : "Tasks off — the model does not see them",
  },
  {
    kind: "plan", title: "Plans",
    placeholder: "The steps the model works through. Edit them freely.",
    empty: on => on ? "The model writes its plan here" : "Turn Plans on and the model keeps a plan here",
    label: on => on ? "Plans on — the model keeps its plan here" : "Plans off — the model writes no plan",
  },
];
const KINDS: NotebookKind[] = SECTIONS.map(section => section.kind);
/** Chapters a section shows before “Show more”. */
const SECTION_ROWS = 6;

/** Whether the model may use a section at all. Plans is on while Plan is. */
export function sectionOn(conversation: Pick<Conversation, "runbook" | "tasks" | "planning">, kind: NotebookKind): boolean {
  return kind === "plan" ? conversation.planning === true : conversation[kind] !== false;
}

/** What this browser remembers of a chat's notebook: the chapter open, folded and unfolded sections. */
interface NotebookView { selected?: string; collapsed?: NotebookKind[]; expanded?: NotebookKind[] }
function readView(conversationId: string): NotebookView {
  try {
    const value = JSON.parse(localStorage.getItem(`hello.notebookView.${conversationId}`) ?? "null") as NotebookView | null;
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}
function writeView(conversationId: string, view: NotebookView): void {
  try { localStorage.setItem(`hello.notebookView.${conversationId}`, JSON.stringify(view)); }
  catch { /* A view that is not remembered opens at its first chapter. */ }
}

/** A draft kept in this browser for this chat, matched to its chapter by id. */
function savedDraft(value: unknown, conversationId: string): NotebookDraft | null {
  if (!value || typeof value !== "object") return null;
  const draft = value as Partial<NotebookDraft>;
  if (typeof draft.id !== "string" || draft.conversationId !== conversationId ||
      !KINDS.includes(draft.kind as NotebookKind) ||
      typeof draft.title !== "string" || typeof draft.body !== "string" ||
      typeof draft.createdAt !== "number" || typeof draft.updatedAt !== "number") return null;
  // Older drafts have no known base. Preserve them, but never overwrite a
  // potentially newer external edit by guessing their revision. Nor did they
  // know the chapter switch: the saved entry's decides, else on.
  return { ...draft, shared: typeof draft.shared === "boolean" ? draft.shared : true,
    expectedUpdatedAt: Number.isSafeInteger(draft.expectedUpdatedAt) &&
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
    // By id: a draft kept before its chapter moved section (the plan left Tasks) is still that chapter's.
    const stored = savedDraft(JSON.parse(localStorage.getItem(`hello.notebook.${sent.id}`) ?? "null"), sent.conversationId);
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
  conversation: Conversation;
  onConversationChange: (conversation: Conversation) => void;
  reportError: (reason: unknown) => void;
}) {
  return (
    <NotebookSession
      key={props.conversation.id}
      {...props}
    />
  );
}

/** All three sections share one editor; each chapter is persisted on its own. */
function NotebookSession({
  conversation,
  onConversationChange,
  reportError,
}: {
  conversation: Conversation;
  onConversationChange: (conversation: Conversation) => void;
  reportError: (reason: unknown) => void;
}) {
  const conversationId = conversation.id;
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
  const [view, setView] = useState<NotebookView>(() => readView(conversationId));
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
  const currentSection = SECTIONS.find(section => section.kind === current?.kind) ?? SECTIONS[0];
  const collapsed = new Set(view.collapsed ?? []);
  const unfolded = new Set(view.expanded ?? []);
  const updateView = (patch: Partial<NotebookView>) => setView(previous => {
    const next = { ...previous, ...patch };
    writeView(conversationId, next);
    return next;
  });
  // The chapter open is remembered with the rest of the view.
  useEffect(() => {
    if (loaded.current && (selected ?? undefined) !== view.selected) updateView({ selected: selected ?? undefined });
  }, [selected]);
  const setConflict = (id: string, value: boolean) => {
    if (value) conflictIds.current.add(id);
    else conflictIds.current.delete(id);
    if (mounted.current) setConflicts(new Set(conflictIds.current));
  };
  const listAll = async () => (await Promise.all(KINDS.map(kind => api.notebooks.list(conversationId, kind)))).flat();

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
              // The switch is not part of a save: the one on screen stands.
              const rows = entriesRef.current.map(row => row.id === entry.id ? { ...saved, shared: row.shared } : row);
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
    void listAll()
      .then((rows) => {
        if (!alive) return;
        const restored = rows.map((row) => {
          baseVersions.current.set(row.id, row.updatedAt);
          try {
            // By id, taking the saved entry's section: a draft kept before the
            // plan moved from Tasks to Plans is still that chapter's.
            const draft = savedDraft(JSON.parse(
              localStorage.getItem(`hello.notebook.${row.id}`) ?? "null",
            ), conversationId);
            if (draft?.id === row.id && (draft.title !== row.title || draft.body !== row.body)) {
              baseVersions.current.set(row.id, draft.expectedUpdatedAt);
              const kept = { ...draft, kind: row.kind, shared: row.shared };
              pending.current.set(row.id, kept);
              if (draft.expectedUpdatedAt !== row.updatedAt) setConflict(row.id, true);
              return kept;
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
            try { draft = savedDraft(JSON.parse(localStorage.getItem(key) ?? "null"), conversationId); }
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
        const remembered = readView(conversationId).selected;
        setSelected(restored.some(row => row.id === remembered) ? remembered! : restored[0]?.id ?? null);
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
  }, [conversationId]);

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
        const rows = await listAll();
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
            // A draft keeps its words; the saved entry's switch is the truth.
            // The same object while nothing changed: recovery compares by identity.
            return draft ? (draft.shared === row.shared ? draft : { ...draft, shared: row.shared }) : row;
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
          !["notebook_save", "notebook_task_status", "plan_write"].includes(part.name) ||
          completed.has(part.id)
        )
          return false;
        completed.add(part.id);
        return true;
      });
      if (changed) void refresh();
    });
    const unsubscribeNotebooks = api.notebooks.onChange?.(event => {
      if (event.conversationId === conversationId) void refresh();
    });
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      unsubscribe();
      unsubscribeNotebooks?.();
      window.removeEventListener("focus", onFocus);
    };
  }, [conversationId]);

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

  const add = async (kind: NotebookKind) => {
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
      if (collapsed.has(kind)) updateView({ collapsed: [...collapsed].filter(item => item !== kind) });
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
      if (selected === entry.id) setSelected(rows.find(row => row.kind === entry.kind)?.id ?? rows[0]?.id ?? null);
      setRemoving(null);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  /** A chapter's own switch. Its words and revision stay as they are. */
  const share = async (entry: NotebookEntry, shared: boolean) => {
    if (!api.notebooks.share) return;
    const set = (value: boolean) => {
      mutationRevision.current += 1;
      const rows = entriesRef.current.map(row => row.id === entry.id ? { ...row, shared: value } : row);
      entriesRef.current = rows;
      setEntries(rows);
    };
    set(shared);
    try {
      await api.notebooks.share(entry.id, shared);
    } catch (reason) {
      set(!shared);
      setError(errorText(reason));
    }
  };

  /** A section's switch: the chat's own Runbook, Tasks or Plan setting. */
  const switchSection = (kind: NotebookKind, on: boolean) => {
    void api.conversations
      .update(conversationId, kind === "plan" ? { planning: on } : { [kind]: on })
      .then(onConversationChange)
      .catch(reportError);
  };

  const recover = async (entry: NotebookEntry, saveCopy: boolean) => {
    if (resolving) return;
    setResolving(true);
    try {
      await queue.current;
      const snapshot = entriesRef.current.find(row => row.id === entry.id);
      if (!snapshot) return;
      const latest = (await api.notebooks.list(conversationId, entry.kind)).find(row => row.id === entry.id);
      const copy = saveCopy ? await api.notebooks.save({
        conversationId, kind: entry.kind, title: `${snapshot.title || "Untitled"} (draft)`, body: snapshot.body,
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

  const toggleFold = (kind: NotebookKind) =>
    updateView({ collapsed: collapsed.has(kind) ? [...collapsed].filter(item => item !== kind) : [...collapsed, kind] });
  const toggleMore = (kind: NotebookKind) =>
    updateView({ expanded: unfolded.has(kind) ? [...unfolded].filter(item => item !== kind) : [...unfolded, kind] });

  return (
    <section className="notebook" aria-label="Notebook">
      <aside className="notebook-list notebook-tree" aria-label="Notebook sections">
        {SECTIONS.map((section) => {
          const rows = entries.filter(entry => entry.kind === section.kind);
          const on = sectionOn(conversation, section.kind);
          const folded = collapsed.has(section.kind);
          const all = unfolded.has(section.kind) || rows.length <= SECTION_ROWS;
          // The chapter being read is never folded away behind “Show more”.
          const shown = all ? rows : rows.filter((row, index) => index < SECTION_ROWS || row.id === selected);
          return (
            <div className="notebook-section" data-on={on} key={section.kind}>
              <div className="notebook-section-header">
                <button
                  type="button"
                  className="notebook-section-title"
                  aria-expanded={!folded}
                  onClick={() => toggleFold(section.kind)}
                >
                  {folded ? <Folder size={15} aria-hidden /> : <FolderOpen size={15} aria-hidden />}
                  <span className="truncate">{section.title}</span>
                </button>
                <IconButton label={`New chapter in ${section.title}`} onClick={() => void add(section.kind)}>
                  <Plus size={14} />
                </IconButton>
                <NotebookSwitch on={on} label={section.label(on)} onChange={next => switchSection(section.kind, next)} />
              </div>
              {!folded && (
                <div className="notebook-section-entries" role="group" aria-label={section.title}>
                  {!rows.length && !loading && <p className="notebook-section-empty">{section.empty(on)}</p>}
                  {shown.map((entry) => (
                    <div className="notebook-entry-row" key={entry.id} data-selected={selected === entry.id}
                      data-shared={section.kind !== "runbook" || entry.shared}>
                      {/* Only a Runbook chapter has a switch: Tasks and Plans are
                          on or off as a whole, by their section (user, 29.09). */}
                      {section.kind === "runbook" && (
                        <NotebookSwitch
                          on={entry.shared}
                          label={entry.shared
                            ? `“${entry.title || "Untitled"}” on — the model sees it`
                            : `“${entry.title || "Untitled"}” off — hidden from the model`}
                          disabled={!api.notebooks.share}
                          onChange={next => void share(entry, next)}
                        />
                      )}
                      <button
                        type="button"
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
                    </div>
                  ))}
                  {rows.length > SECTION_ROWS && (
                    <button type="button" className="notebook-show-more" onClick={() => toggleMore(section.kind)}>
                      {unfolded.has(section.kind) ? "Show less" : "Show more"}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
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
              label={`${currentSection.title} entry body`}
              placeholder={currentSection.placeholder}
              onBodyChange={(body) => update(current.id, { body })}
              onBlur={() => void flush()}
            />
          </>
        ) : (
          <div className="notebook-empty">
            <h2>Notebook</h2>
            <p>
              {loading
                ? "Loading entries…"
                : "A quiet place to keep what matters."}
            </p>
            {!loading && (
              <button className="pill" onClick={() => void add("runbook")}>
                <Plus size={15} />
                New chapter
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
