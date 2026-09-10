import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, HTMLAttributes, RefObject } from 'react';
import { createPortal } from 'react-dom';

import { Reveal } from './Reveal';
import { useOverlayLock } from './useOverlayLock';
import './Popover.css';

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

/**
 * Every popover currently open, so that opening one closes the others.
 *
 * Without this, two row menus could stand at once: each closes itself only on
 * a pointerdown it can see, and anything between the pointer and `document`
 * that stops the event leaves the earlier menu standing under the new one.
 * Keyed by a per-instance token rather than by `onClose`, because callers
 * recreate that function on every render and a stale identity would let a
 * popover close itself. A popover that opened from inside another — a menu's
 * anchor sitting in an open popover — leaves that parent alone.
 */
const openPopovers = new Map<object, { close: () => void; element: () => HTMLElement | null }>();

export interface PopoverProps extends Omit<HTMLAttributes<HTMLDivElement>, 'style'> {
  open: boolean;
  /** The trigger element the popover aligns to and clicks outside of are measured against. */
  anchorRef: RefObject<HTMLElement>;
  placement?: PopoverPlacement;
  /** Called on Escape or an outside click, so the trigger can close the popover. */
  onClose?: () => void;
}

const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 4;

/** Lightweight contextual container (DESIGNUIguide.md §Menus and popovers):
 * aligns to its trigger, clips to the viewport instead of overflowing it, and
 * closes on Escape or an outside click. Positioning runs when the actual
 * surface mounts and in a layout effect; static markup remains unmeasured. */
export function Popover({
  open,
  anchorRef,
  placement = 'bottom-start',
  onClose,
  className,
  children,
  ...rest
}: PopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  // T146: portalled to `document.body`, so a popover anchored anywhere near
  // the split (the model chip, a conversation row's menu) can extend over the
  // browser pane's native view and would otherwise be composited beneath it.
  // The surface itself decides now: a popover that lands clear of the pane
  // leaves the page alone.
  useOverlayLock(open, popoverRef);
  // Same containing-block hazard as Tooltip: `position: fixed` resolves
  // against the nearest transformed/filtered/`contain`ed ancestor, and the
  // transcript rows this popover opens from are exactly that
  // (MessageList.module.css `contain: strict` + row `will-change: transform`).
  // Portalling to `document.body` keeps the viewport clamping above honest.
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => setPortalTarget(document.body), []);

  const updatePosition = useCallback(() => {
    if (!open) return;

    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return;

    const anchorRect = anchor.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let top = placement.startsWith('bottom')
      ? anchorRect.bottom + TRIGGER_GAP
      : anchorRect.top - popoverRect.height - TRIGGER_GAP;
    let left = placement.endsWith('end') ? anchorRect.right - popoverRect.width : anchorRect.left;

    top = Math.min(
      Math.max(top, VIEWPORT_MARGIN),
      Math.max(viewportHeight - popoverRect.height - VIEWPORT_MARGIN, VIEWPORT_MARGIN),
    );
    left = Math.min(
      Math.max(left, VIEWPORT_MARGIN),
      Math.max(viewportWidth - popoverRect.width - VIEWPORT_MARGIN, VIEWPORT_MARGIN),
    );

    setPosition((previous) =>
      previous?.top === top && previous.left === left ? previous : { top, left },
    );
  }, [open, placement, anchorRef]);

  // Reveal mounts a previously closed surface from its own passive effect.
  // The parent's layout effect (and even its next animation frame) can have
  // already run by then. Measuring the attached node is the reliable signal,
  // including when createPortal replaces the initially inline surface.
  const attachPopover = useCallback(
    (element: HTMLDivElement | null) => {
      popoverRef.current = element;
      if (element) updatePosition();
    },
    [updatePosition],
  );

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const frame = requestAnimationFrame(updatePosition);
    return () => cancelAnimationFrame(frame);
  }, [open, updatePosition, portalTarget]);

  const tokenRef = useRef<object>({});
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const token = tokenRef.current;
    for (const [other, entry] of openPopovers) {
      if (other === token) continue;
      const anchor = anchorRef.current;
      if (anchor && entry.element()?.contains(anchor)) continue;
      entry.close();
    }
    openPopovers.set(token, {
      close: () => onCloseRef.current?.(),
      element: () => popoverRef.current,
    });
    return () => {
      openPopovers.delete(token);
    };
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose?.();
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose?.();
    }

    // `pointerdown`, not `mousedown`: the click-in-chat handler in Composer.tsx
    // calls preventDefault() on pointerdown over transcript whitespace to keep
    // the caret in the composer, and that suppresses the compatibility mouse
    // events — so a mousedown listener never sees a click on the transcript
    // and the overlay stayed open over a pane it had hidden.
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [open, onClose, anchorRef]);

  const classes = ['popover', className].filter(Boolean).join(' ');
  const presenceStyle = {
    '--popover-offset': placement.startsWith('top') ? '4px' : '-4px',
    ...(position ? { top: position.top, left: position.left } : {}),
  } as CSSProperties;

  const surface = (
    <Reveal
      show={open}
      className="popover-presence"
      style={presenceStyle}
      onExited={() => setPosition(null)}
    >
      <div
        ref={attachPopover}
        className={classes}
        aria-hidden={open ? undefined : 'true'}
        {...rest}
      >
        {children}
      </div>
    </Reveal>
  );

  return portalTarget ? createPortal(surface, portalTarget) : surface;
}
