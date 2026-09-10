/**
 * The composer's Add panel: the surface the `+` control opens.
 *
 * It is a list rather than a dropdown because the list is going to grow — a
 * heading, then one row per thing that can be brought into a chat, each row
 * with room for a muted gloss beside its label. A narrow menu would have to
 * change shape the first time an entry needed that second column, so the panel
 * takes the composer's own width from the start.
 *
 * Positioning is CSS only: the panel is an absolutely positioned child of the
 * composer surface, so it is exactly as wide as the composer and opens above
 * it without any measurement to keep in sync as the column resizes. The shared
 * `Popover` cannot do that — it clamps every surface to 320px and aligns to a
 * trigger rect — and other surfaces depend on those rules, so this one is
 * local to the composer.
 *
 * Anatomy per DESIGNUIguide.md §Menus, popovers, dialogs (floating level:
 * `--r-10`, 1px `--color-border`, `--shadow-sm`) and §Motion (a popover
 * opening upward translates +4px→0, `--motion-base` in, `--motion-fast` out).
 * Keyboard behaviour mirrors the shared `Menu`: roving tabindex, arrows move
 * between enabled rows, Escape closes and hands focus back to the trigger.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { LucideIcon } from 'lucide-react';

import { Reveal } from '../ui/Reveal';
import { TruncatedText } from '../ui/TruncatedText';
import { useOverlayLock } from '../ui/useOverlayLock';
import styles from './AddMenu.module.css';

export interface AddMenuEntry {
  id: string;
  label: string;
  /** Optional muted gloss after the label; omit it for a label-only row. */
  description?: string;
  icon: LucideIcon;
  /** Kept rendered and named rather than dropped, so the reason a row does
   * nothing stays discoverable (DESIGNUIguide.md §Sidebar, placeholders). */
  disabled?: boolean;
  onSelect: () => void;
}

export interface AddMenuProps {
  open: boolean;
  entries: AddMenuEntry[];
  /**
   * The `+` trigger. Excluded from outside-click detection, otherwise a click
   * on it would close the panel and the same click would reopen it.
   */
  anchorRef: RefObject<HTMLElement>;
  onClose: () => void;
}

function firstEnabledIndex(entries: AddMenuEntry[]): number {
  const index = entries.findIndex((entry) => entry.disabled !== true);
  return index === -1 ? 0 : index;
}

function enabledIndexes(entries: AddMenuEntry[]): number[] {
  return entries.reduce<number[]>((indexes, entry, index) => {
    if (entry.disabled !== true) indexes.push(index);
    return indexes;
  }, []);
}

export function AddMenu({ open, entries, anchorRef, onClose }: AddMenuProps): JSX.Element {
  const headingId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  // T146: the panel spans the composer, which can sit against the browser
  // split where the pane's native view would otherwise composite over it —
  // but only when the composer is actually wide enough to reach it.
  useOverlayLock(open, panelRef);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(() => firstEnabledIndex(entries));

  const enabled = enabledIndexes(entries);
  const initialIndex = firstEnabledIndex(entries);

  // Each opening starts at the top of the list; the number, not the array,
  // is the dependency, so a re-rendered entries array does not move focus.
  useEffect(() => {
    if (!open) return;
    setActiveIndex(initialIndex);
  }, [open, initialIndex]);

  // Reveal mounts its children from an effect, so the row does not exist yet
  // on the commit that opens the panel — take focus on the next frame.
  useEffect(() => {
    if (!open) return undefined;
    const frame = window.requestAnimationFrame(() => rowRefs.current[activeIndex]?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };

    // Document-level rather than on the panel: Escape must close it even when
    // something else has taken the focus out of the list.
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      anchorRef.current?.focus();
      onClose();
    };

    // `pointerdown`, not `mousedown`: the click-in-chat handler in Composer.tsx
    // calls preventDefault() on pointerdown over transcript whitespace to keep
    // the caret in the composer, and that suppresses the compatibility mouse
    // events — so a mousedown listener never sees a click on the transcript
    // and the overlay stayed open over a pane it had hidden.
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose, anchorRef]);

  function step(delta: 1 | -1): void {
    if (enabled.length === 0) return;
    const position = Math.max(enabled.indexOf(activeIndex), 0);
    setActiveIndex(enabled[(position + delta + enabled.length) % enabled.length]);
  }

  function handleListKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
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
      default:
        break;
    }
  }

  return (
    <Reveal show={open} className={styles.presence}>
      <div ref={panelRef} className={styles.panel} aria-hidden={open ? undefined : 'true'}>
        <p className={styles.heading} id={headingId}>
          Add
        </p>
        <div
          role="menu"
          aria-labelledby={headingId}
          className={styles.list}
          onKeyDown={handleListKeyDown}
        >
          {entries.map((entry, index) => {
            const Icon = entry.icon;
            return (
              <button
                key={entry.id}
                data-add-menu-item={entry.id}
                ref={(node) => {
                  rowRefs.current[index] = node;
                }}
                role="menuitem"
                type="button"
                className={styles.row}
                disabled={entry.disabled}
                tabIndex={index === activeIndex ? 0 : -1}
                onClick={() => entry.onSelect()}
              >
                <Icon className={styles.rowIcon} size={16} aria-hidden="true" />
                <TruncatedText className={styles.rowLabel}>{entry.label}</TruncatedText>
                {entry.description === undefined ? null : (
                  <TruncatedText className={styles.rowDescription}>
                    {entry.description}
                  </TruncatedText>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </Reveal>
  );
}
