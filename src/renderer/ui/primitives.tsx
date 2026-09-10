import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import { onNativeBrowserFocus } from "../api";
import { animateSurface } from "./surface-motion";

const MenuLayer = createContext(100);

export function Truncated({
  children,
  className = "",
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () =>
      setOverflow(
        node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 1,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    void document.fonts?.ready.then(measure);
    return () => observer.disconnect();
  }, [children]);
  return (
    <span
      ref={ref}
      className={`truncate ${className}`}
      data-overflow={overflow || undefined}
      title={
        overflow
          ? (title ?? (typeof children === "string" ? children : undefined))
          : undefined
      }
    >
      {children}
    </span>
  );
}

export function IconButton({
  label,
  children,
  onClick,
  disabled,
  className = "",
  ...rest
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  "aria-expanded"?: boolean;
  "aria-pressed"?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * Keeps a surface in the DOM while it animates out, so a dismissed popup can
 * finish its motion instead of disappearing between two frames. Returns whether
 * the caller should render it at all.
 */
function usePresence(open: boolean, ref: RefObject<HTMLElement>): boolean {
  const [present, setPresent] = useState(open);
  useLayoutEffect(() => {
    if (open) setPresent(true);
  }, [open]);
  useLayoutEffect(() => {
    if (!present) return;
    const node = ref.current;
    // Nothing to animate out: the surface is already gone from the tree.
    if (!node) {
      if (!open) setPresent(false);
      return;
    }
    if (open) return animateSurface(node, "enter");
    return animateSurface(node, "exit", { onFinish: () => setPresent(false) });
  }, [open, present, ref]);
  return present;
}

export interface MenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  leading?: ReactNode;
  detail?: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  action?: () => void;
  children?: MenuItem[];
}

/** A selection-safe context menu using the same surface and native-view gate. */
export function ContextMenu({
  position,
  items,
  onClose,
  ariaLabel = "Actions",
}: {
  position: { x: number; y: number } | null;
  items: MenuItem[];
  onClose: (reason: "action" | "escape" | "dismiss") => void;
  ariaLabel?: string;
}) {
  const popup = useRef<HTMLDivElement>(null);
  const open = position !== null;
  const present = usePresence(open, popup);
  const layer = useContext(MenuLayer);
  const [active, setActive] = useState(0);
  const snapshot = useRef({ position, items });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  if (position) snapshot.current = { position, items };

  useLayoutEffect(() => {
    const node = popup.current;
    const point = snapshot.current.position;
    if (!present || !node || !point) return;
    const bounds = node.getBoundingClientRect();
    node.style.left = `${Math.max(12, Math.min(point.x, window.innerWidth - bounds.width - 12))}px`;
    node.style.top = `${Math.max(12, Math.min(point.y, window.innerHeight - bounds.height - 12))}px`;
  }, [position, present]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const first = snapshot.current.items.findIndex(item => !item.disabled);
      setActive(Math.max(0, first));
      const target = popup.current?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? popup.current;
      target?.focus({ preventScroll: true });
    });
    const outside = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node)) closeRef.current("dismiss");
    };
    const dismiss = () => closeRef.current("dismiss");
    const stopNativeFocus = onNativeBrowserFocus(dismiss);
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !popup.current?.contains(event.target)) dismiss();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", scroll, true);
    return () => {
      cancelAnimationFrame(frame);
      stopNativeFocus();
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [open, position]);

  if (!present) return null;
  const visible = snapshot.current.items;
  return createPortal(
    <div
      ref={popup}
      className="menu-popup"
      role="menu"
      tabIndex={-1}
      aria-label={ariaLabel}
      aria-hidden={!open || undefined}
      style={{ zIndex: layer, pointerEvents: open ? undefined : "none" }}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={event => {
        if (open && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c') {
          const copy = visible.find(item => item.id === 'copy' && item.shortcut);
          if (copy) {
            event.preventDefault(); event.stopPropagation();
            if (!copy.disabled) { try { copy.action?.(); } finally { onClose('action'); } }
          }
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose("escape");
        } else if (event.key === "Tab") {
          event.stopPropagation();
          onClose("dismiss");
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          const enabled = visible.flatMap((item, index) => item.disabled ? [] : [index]);
          const index = event.key === "Home" ? enabled[0]
            : event.key === "End" ? enabled.at(-1)
            : enabled[(enabled.indexOf(active) + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length];
          if (index !== undefined) {
            setActive(index);
            popup.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[index]?.focus({ preventScroll: true });
          }
        }
      }}
    >
      {visible.map((item, index) => (
        <div key={item.id}>
          {item.separator && index > 0 && <div role="separator" className="menu-separator" />}
          <button
            type="button"
            role="menuitem"
            aria-label={item.label}
            aria-keyshortcuts={item.id === 'copy' && item.shortcut ? 'Meta+C Control+C' : undefined}
            className="menu-item"
            data-active={active === index}
            tabIndex={open && active === index ? 0 : -1}
            disabled={!open || item.disabled}
            onPointerMove={() => !item.disabled && setActive(index)}
            onFocus={() => setActive(index)}
            onClick={() => {
              // Clipboard callers need the original click's user activation.
              // The editor owns its selection snapshot and focus restoration.
              try { item.action?.(); } finally { onClose("action"); }
            }}
          >
            {item.icon ? <item.icon size={16} /> : <span className="menu-icon-space" />}
            <span className="menu-item-copy">{item.label}{item.detail && <small>{item.detail}</small>}</span>
            {item.shortcut && <span className="menu-shortcut" aria-hidden>{item.shortcut}</span>}
            {item.checked && <Check size={14} />}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

export function MenuButton({
  label,
  children,
  items,
  className = "icon-button",
  onOpen,
  align = "end",
  menuLabel,
  searchPlaceholder,
  menuClassName = "",
  heading,
}: {
  label: string;
  children: ReactNode;
  items: MenuItem[];
  className?: string;
  onOpen?: () => void;
  align?: "start" | "end";
  menuLabel?: string;
  searchPlaceholder?: string;
  menuClassName?: string;
  heading?: string;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<MenuItem | null>(null);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState("");
  const layer = useContext(MenuLayer);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const present = usePresence(open, popup);
  const id = useId();
  const unfiltered = page
    ? [
        {
          id: "back",
          label: "Back",
          icon: ArrowLeft,
          action: () => {
            setPage(null);
            setActive(0);
          },
        },
        ...(page.children ?? []),
      ]
    : items;
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const visible = searchPlaceholder && terms.length
    ? unfiltered.filter(item => terms.every(term => item.label.toLocaleLowerCase().includes(term)))
    : unfiltered;
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!present || !popup.current || !trigger.current) return;
    const position = () => {
      const anchor = trigger.current!.getBoundingClientRect();
      const menu = popup.current!.getBoundingClientRect();
      const left = align === "start" ? anchor.left : anchor.right - menu.width;
      const below = anchor.bottom + 8;
      popup.current!.style.left = `${Math.max(12, Math.min(left, window.innerWidth - menu.width - 12))}px`;
      popup.current!.style.top = `${Math.max(12, below + menu.height > window.innerHeight - 12 ? anchor.top - menu.height - 8 : below)}px`;
    };
    position();
    const resize = new ResizeObserver(position);
    resize.observe(popup.current);
    resize.observe(trigger.current);
    window.addEventListener("resize", position);
    return () => {
      resize.disconnect();
      window.removeEventListener("resize", position);
    };
  }, [present, page, items, align, query]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const node = popup.current;
      if (node?.contains(document.activeElement)) return;
      node?.querySelector<HTMLElement>(searchPlaceholder ? "input" : "button:not(:disabled)")?.focus();
    });
    const outside = (event: PointerEvent) => {
      if (
        !popup.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    // Native browser clicks do not bubble into the app document. Losing the
    // app renderer's focus also dismisses an otherwise non-overlapping menu.
    const dismiss = () => setOpen(false);
    const stopNativeFocus = onNativeBrowserFocus(dismiss);
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !popup.current?.contains(event.target)) dismiss();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("blur", dismiss);
    document.addEventListener("scroll", scroll, true);
    return () => {
      cancelAnimationFrame(frame);
      stopNativeFocus();
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("blur", dismiss);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [open, page, searchPlaceholder]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={className}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        title={label}
        onClick={() => {
          if (!open) {
            setPage(null);
            setActive(0);
            setQuery("");
            onOpen?.();
          }
          setOpen((value) => !value);
        }}
      >
        {children}
      </button>
      {present &&
        createPortal(
          <div
            ref={popup}
            id={id}
            className={`menu-popup${searchPlaceholder ? " menu-searchable" : ""} ${menuClassName}`}
            style={{ zIndex: layer }}
            role="menu"
            aria-label={page?.label ?? menuLabel ?? label}
            aria-hidden={!open || undefined}
            onKeyDown={(event) => {
              const enabled = visible.flatMap((item, index) =>
                item.disabled ? [] : [index],
              );
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
              }
              if (event.key === "Tab") { event.stopPropagation(); close(); }
              const inSearch = event.target instanceof HTMLInputElement;
              if (inSearch && ["Home", "End", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
              if (inSearch && event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                popup.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.click();
              }
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const index =
                  (inSearch && event.key === "ArrowDown") || event.key === "Home"
                    ? enabled[0]
                    : (inSearch && event.key === "ArrowUp") || event.key === "End"
                      ? enabled.at(-1)
                      : enabled[
                          (enabled.indexOf(active) +
                            (event.key === "ArrowDown" ? 1 : -1) +
                            enabled.length) %
                            enabled.length
                        ];
                if (index !== undefined) {
                  setActive(index);
                  popup.current
                    ?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
                    [index]?.focus();
                }
              }
              if (event.key === "ArrowLeft" && page) {
                event.preventDefault();
                setPage(null);
                setActive(0);
              }
            }}
          >
            {heading && <div className="menu-heading">{heading}</div>}
            {searchPlaceholder && <div className="menu-search">
              <Search size={15} aria-hidden="true" />
              <input aria-label="Search models" placeholder={searchPlaceholder} value={query}
                autoComplete="off" spellCheck={false}
                onChange={event => { setQuery(event.target.value); setActive(0); }} />
            </div>}
            {searchPlaceholder && visible.length === 0 && <p className="menu-empty" role="status">No models match your search.</p>}
            {visible.map((item, index) => (
              <div key={item.id}>
                {item.separator && index > 0 && (
                  <div role="separator" className="menu-separator" />
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  data-active={active === index}
                  tabIndex={active === index ? 0 : -1}
                  disabled={item.disabled}
                  onPointerMove={() => !item.disabled && setActive(index)}
                  onFocus={() => setActive(index)}
                  onClick={() => {
                    if (item.children) {
                      setPage(item);
                      setActive(0);
                    } else if (page && item.id === "back") item.action?.();
                    else {
                      close();
                      item.action?.();
                    }
                  }}
                >
                  {item.leading ?? (item.icon ? (
                    <item.icon size={16} />
                  ) : (
                    <span className="menu-icon-space" />
                  ))}
                  <span className="menu-item-copy">
                    {item.label}
                    {item.detail && <small>{item.detail}</small>}
                  </span>
                  {item.children ? (
                    <ChevronRight size={14} />
                  ) : item.checked ? (
                    <Check size={14} />
                  ) : null}
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

export function Dialog({
  open,
  title,
  children,
  onClose,
  wide = false,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const present = usePresence(open, ref);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input,button,textarea")?.focus();
    return () => previous?.focus();
  }, [open, present]);
  return present
    ? createPortal(
        <div
          className="dialog-backdrop"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
            if (event.key === "Tab") {
              const nodes = [
                ...(ref.current?.querySelectorAll<HTMLElement>(
                  'button:not(:disabled),input,textarea,select,[tabindex="0"]',
                ) ?? []),
              ];
              if (event.shiftKey && document.activeElement === nodes[0]) {
                event.preventDefault();
                nodes.at(-1)?.focus();
              } else if (
                !event.shiftKey &&
                document.activeElement === nodes.at(-1)
              ) {
                event.preventDefault();
                nodes[0]?.focus();
              }
            }
          }}
        >
          <div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className={`dialog ${wide ? "dialog-wide" : ""}`}
          >
            <header>
              <h1 id={titleId}>{title}</h1>
              <IconButton label={`Close ${title}`} onClick={onClose}>
                <X size={16} />
              </IconButton>
            </header>
            <MenuLayer.Provider value={300}>{children}</MenuLayer.Provider>
          </div>
        </div>,
        document.body,
      )
    : null;
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  return error ? (
    <p className="error-note" role="alert">
      {error}
    </p>
  ) : null;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
