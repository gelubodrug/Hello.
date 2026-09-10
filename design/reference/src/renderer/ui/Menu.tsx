import { Fragment, useEffect, useRef, useState } from 'react';
import type { HTMLAttributes, KeyboardEvent } from 'react';
import type { LucideIcon } from 'lucide-react';

import { Reveal } from './Reveal';
import { TruncatedText } from './TruncatedText';
import { useOverlayLock } from './useOverlayLock';
import './Menu.css';

export interface MenuItemDef {
  id: string;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
  destructive?: boolean;
  /** Starts an action group; ignored for the first item. */
  separatorBefore?: boolean;
  onSelect?: () => void;
}

export interface MenuProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  items: MenuItemDef[];
  /** Keeps the menu mounted through its exit transition when closed. */
  open?: boolean;
  /** Disable when an owning Popover already provides the catalog presence. */
  animatePresence?: boolean;
  /** Called on Escape, so the owning Popover/trigger can close the menu. */
  onClose?: () => void;
}

function enabledIndexes(items: MenuItemDef[]): number[] {
  return items.reduce<number[]>((acc, item, index) => {
    if (!item.disabled) acc.push(index);
    return acc;
  }, []);
}

/** Accessible menu with roving tabindex: one item is tabbable at a time, arrow
 * keys move focus among enabled items, Enter/Space activate via native
 * <button> semantics, per DESIGNUIguide.md §Menus and popovers. */
export function Menu({
  items,
  open = true,
  animatePresence = true,
  onClose,
  className,
  ...rest
}: MenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  // T146: menus are usually owned by a Popover that already holds the lock —
  // the refcount in `useOverlayLock` makes the second hold harmless — but a
  // menu rendered on its own still needs to clear the browser pane, and only
  // when it actually crosses it.
  useOverlayLock(open, menuRef);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = enabledIndexes(items);
  const [activeIndex, setActiveIndex] = useState(enabled[0] ?? 0);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => itemRefs.current[activeIndex]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [activeIndex, open]);

  function step(delta: 1 | -1) {
    if (enabled.length === 0) return;
    const currentPos = Math.max(enabled.indexOf(activeIndex), 0);
    const nextPos = (currentPos + delta + enabled.length) % enabled.length;
    setActiveIndex(enabled[nextPos]);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        step(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        step(-1);
        break;
      case 'Home':
        event.preventDefault();
        if (enabled.length > 0) setActiveIndex(enabled[0]);
        break;
      case 'End':
        event.preventDefault();
        if (enabled.length > 0) setActiveIndex(enabled[enabled.length - 1]);
        break;
      case 'Escape':
        event.preventDefault();
        onClose?.();
        break;
      default:
        break;
    }
  }

  const classes = ['menu', className].filter(Boolean).join(' ');

  const menu = (
    <div
      ref={menuRef}
      role="menu"
      className={classes}
      aria-hidden={open ? undefined : 'true'}
      onKeyDown={handleKeyDown}
      {...rest}
    >
      {items.map((item, index) => {
        const Icon = item.icon;
        const itemClasses = ['menu-item', item.destructive ? 'menu-item-destructive' : '']
          .filter(Boolean)
          .join(' ');

        return (
          <Fragment key={item.id}>
            {index > 0 && item.separatorBefore ? (
              <div className="menu-separator" role="separator" />
            ) : null}
            <button
              data-menu-item={item.id}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              role="menuitem"
              type="button"
              className={itemClasses}
              disabled={item.disabled}
              tabIndex={!item.disabled && index === activeIndex ? 0 : -1}
              onPointerMove={() => {
                if (!item.disabled) setActiveIndex(index);
              }}
              onClick={() => item.onSelect?.()}
            >
              {Icon ? <Icon className="menu-item-icon" size={16} aria-hidden="true" /> : null}
              <TruncatedText className="menu-item-label">{item.label}</TruncatedText>
            </button>
          </Fragment>
        );
      })}
    </div>
  );

  return animatePresence ? (
    <Reveal show={open} className="menu-presence">
      {menu}
    </Reveal>
  ) : (
    menu
  );
}
