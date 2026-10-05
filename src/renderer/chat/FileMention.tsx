import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { FileText } from "lucide-react";
import type { FileEntry } from "../../shared/files";
import { api } from "../api";

/** How many files the menu lists. */
const SHOWN = 20;

/**
 * The word at the caret when it starts with @ (audit A3): the words after the
 * @, and where the token sits in the draft. An @ inside a word (an address)
 * is not a mention.
 */
export function mentionAt(draft: string, caret: number): { query: string; start: number; end: number } | null {
  const match = /(^|\s)@([^\s@]*)$/.exec(draft.slice(0, caret));
  if (!match) return null;
  const rest = /^[^\s]*/.exec(draft.slice(caret))?.[0] ?? "";
  return { query: match[2] + rest, start: caret - match[2].length - 1, end: caret + rest.length };
}

/**
 * `@name` in the composer: the files of the chat's folder whose path holds the
 * words, and Enter attaches the chosen one through the same snapshot path as a
 * drop, then takes the token out of the words (audit A3). No folder, no menu;
 * the `/` menu, when it is open, keeps the keys.
 */
export function useFileMention({ conversationId, folder, draft, caret, blocked, setDraft, onAttach, onError }: {
  conversationId: string;
  folder: string | null;
  draft: string;
  /** Where the caret is in the draft, as the composer last saw it. */
  caret: number | null;
  /** Another menu has the composer's keys. */
  blocked: boolean;
  setDraft(text: string, caret: number): void;
  /** Attaches files by their absolute paths, as a drop does. */
  onAttach(paths: string[]): void;
  onError(reason: unknown): void;
}): { popup: ReactNode; onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean; expanded: boolean; listId: string; activeId?: string } {
  const token = folder && caret !== null && !blocked ? mentionAt(draft, caret) : null;
  const [found, setFound] = useState<{ query: string; files: FileEntry[]; limited: boolean } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const listId = useId();
  const asked = useRef(0);
  const open = Boolean(token) && dismissed !== draft;
  useEffect(() => { if (dismissed !== null && dismissed !== draft) setDismissed(null); }, [draft, dismissed]);
  // A moment after the typing stops; an older answer never replaces a newer one.
  useEffect(() => {
    const ask = ++asked.current;
    if (!open || !token) { setFound(null); return; }
    const query = token.query;
    const timer = setTimeout(() => {
      void api.files.list(conversationId, "", query)
        .then(listing => {
          if (asked.current !== ask) return;
          setFound({ query, files: listing.entries.filter(entry => entry.kind === "file").slice(0, SHOWN), limited: listing.limited });
          setIndex(0);
        })
        .catch(reason => { if (asked.current === ask) { setFound(null); onError(reason); } });
    }, 150);
    return () => clearTimeout(timer);
  }, [open, token?.query, conversationId]);

  const files = open ? found?.files ?? [] : [];
  const current = Math.min(index, Math.max(files.length - 1, 0));
  const attach = (file: FileEntry) => {
    if (!token) return;
    // The token goes from the words; one space is enough where it was.
    const before = draft.slice(0, token.start);
    const after = draft.slice(token.end).replace(/^ (?= |$)/, "");
    setDraft(`${before}${after}`, token.start);
    void api.files.resolvePaths(conversationId, [file.path]).then(onAttach).catch(onError);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") { event.preventDefault(); setDismissed(draft); return true; }
    if (!files.length) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((current + (event.key === "ArrowDown" ? 1 : files.length - 1)) % files.length);
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
      event.preventDefault();
      attach(files[current]);
      return true;
    }
    return false;
  };
  const note = !open || !found ? null
    : !files.length ? "No file in this chat’s folder has that in its name or path."
    : found.limited ? "The folder is large: only part of it was searched." : null;
  const popup = open && found ? (
    <div className="skill-commands file-mention">
      {files.length > 0 && (
        <div role="listbox" id={listId} aria-label="Files in this chat’s folder">
          {files.map((file, position) => (
            <div key={file.path} id={`${listId}-${position}`} role="option" aria-selected={position === current}
              className="skill-commands__row" data-active={position === current}
              onPointerMove={() => setIndex(position)}
              // The caret stays in the message while a file is picked.
              onPointerDown={event => event.preventDefault()}
              onClick={() => attach(file)}>
              <FileText size={16} aria-hidden />
              <span className="menu-item-copy"><span className="truncate">{file.name}</span><small>{file.path}</small></span>
            </div>
          ))}
        </div>
      )}
      {note && <p className="skill-commands__note" role="status">{note}</p>}
    </div>
  ) : null;
  return { popup, onKeyDown, expanded: open && files.length > 0, listId, activeId: open && files.length ? `${listId}-${current}` : undefined };
}
