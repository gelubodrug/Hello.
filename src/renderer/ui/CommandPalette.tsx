import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { rankGoTo, type GoToItem } from "../go-to";
import { Dialog } from "./primitives";

/** Rows shown before "Show more". */
const SHOWN = 50;

/**
 * "Go to…" (audit A2, ⌘⇧P): a chat, an open tab, a message or a command by its
 * words. Typing only filters and searches; Enter or a click on a row is what
 * acts, and closing then leaves focus to where the row led.
 */
export function CommandPalette({ open, items, searchMessages, onClose }: {
  open: boolean;
  items: readonly GoToItem[];
  /** Messages of every chat that have the words, as rows that open them. */
  searchMessages?: (query: string) => Promise<GoToItem[]>;
  onClose: () => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<GoToItem[]>([]);
  const [active, setActive] = useState(0);
  const [all, setAll] = useState(false);
  const [chosen, setChosen] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const listId = useId();
  const search = useRef(searchMessages);
  search.current = searchMessages;
  // A fresh start at every opening.
  useEffect(() => {
    if (!open) return;
    setQuery(""); setFound([]); setActive(0); setAll(false); setChosen(false);
  }, [open]);
  // Messages a moment after the typing stops; an older answer never replaces a newer one.
  const asked = useRef(0);
  useEffect(() => {
    const words = query.trim();
    const ask = ++asked.current;
    setFound([]);
    if (!open || words.length < 2 || !search.current) return;
    const timer = setTimeout(() => {
      void search.current?.(words)
        .then(rows => { if (asked.current === ask) setFound(rows); })
        .catch(() => { if (asked.current === ask) setFound([]); });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, open]);
  const ranked = useMemo(() => rankGoTo([...items, ...found], query), [items, found, query]);
  const shown = all ? ranked : ranked.slice(0, SHOWN);
  useEffect(() => setActive(0), [query]);
  useEffect(() => { document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" }); }, [active, listId]);
  const choose = (item: GoToItem) => {
    setChosen(true);
    onClose();
    item.run();
  };
  let group: string | null = null;
  return (
    <Dialog open={open} title="Go to…" onClose={onClose} dismissOnBackdrop className="go-to" initialFocus={field} returnFocus={!chosen}>
      <input
        ref={field}
        className="go-to-field"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
        aria-label="Go to a chat, tab, message or command"
        placeholder="Chats, tabs, messages, commands"
        value={query}
        spellCheck={false}
        autoComplete="off"
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (shown.length) setActive(index => (index + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
          } else if (event.key === "Enter" && shown[active]) {
            event.preventDefault();
            choose(shown[active]);
          }
        }}
      />
      <p className="go-to-status" role="status">
        {ranked.length ? `${ranked.length} ${ranked.length === 1 ? "place" : "places"}` : "Nothing matches."}
      </p>
      <ul id={listId} role="listbox" className="go-to-list" aria-label="Places and commands">
        {shown.map((item, index) => {
          const heading = item.group !== group ? (group = item.group) : null;
          return (
            <Fragment key={item.id}>
              {heading && <li role="presentation" className="go-to-group">{heading === "Matching messages" ? "Recent matches" : heading}</li>}
              <li id={`${listId}-${index}`} role="option" aria-selected={index === active} className="go-to-row"
                onMouseMove={() => setActive(index)} onClick={() => choose(item)}>
                <span className="go-to-label truncate">{item.label}</span>
                {item.detail && <span className="go-to-detail truncate">{item.detail}</span>}
              </li>
            </Fragment>
          );
        })}
      </ul>
      {!all && ranked.length > SHOWN && (
        <button type="button" className="text-button go-to-more" onClick={() => setAll(true)}>Show more</button>
      )}
    </Dialog>
  );
}
