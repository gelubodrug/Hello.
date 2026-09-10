import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

import { Reveal } from './Reveal';
import { useOverlayLock } from './useOverlayLock';
import './Dialog.css';

export interface DialogProps {
  /** Whether the dialog is mounted and visible. */
  open: boolean;
  /** Called on ESC, backdrop click, or (if rendered) a close control inside children. */
  onClose: () => void;
  /** Dialog heading, rendered inside the panel and wired to aria-labelledby. */
  title?: string;
  children: ReactNode;
  className?: string;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Opt-in override for where opening focus lands. A dialog opened to fix one
 * specific thing — "add or update the API key" (T147) — marks that control
 * with `data-autofocus`; without it focus falls to the first focusable, which
 * is the right default for a form the user reads top to bottom.
 */
const AUTOFOCUS_SELECTOR = '[data-autofocus]';

/**
 * Focused-attention dialog (DESIGNUIguide.md §Menus and popovers: "use
 * dialogs only for workflows that require focused attention or
 * confirmation") with a focus trap, ESC-to-close, and a small shadow only
 * (§Elevation) rather than the large diffuse kind the guide forbids.
 */
export function Dialog({ open, onClose, title, children, className }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Resolved in an effect so a server/static render still produces the panel.
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => setPortalTarget(document.body), []);
  // T146: hide the native view while the dialog is up. The overlap gate is
  // measured against the backdrop rather than the panel: the dim is the part
  // that has to cover the pane, and a centred panel that happens to stop short
  // of the split would still leave the page burning through it undimmed.
  const backdropRef = useRef<HTMLDivElement>(null);
  useOverlayLock(open, backdropRef);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusFrame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      const requested = panel?.querySelector<HTMLElement>(AUTOFOCUS_SELECTOR);
      const focusable = panel?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      (requested ?? focusable?.[0] ?? panel)?.focus();
    });

    return () => {
      cancelAnimationFrame(focusFrame);
      previouslyFocused?.focus();
    };
  }, [open]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }

    if (event.key !== 'Tab') return;

    const panel = panelRef.current;
    if (!panel) return;

    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleBackdropMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  const classes = ['dialog-panel', className].filter(Boolean).join(' ');

  // `position: fixed` is only relative to the viewport while no ancestor sets
  // a transform, filter, or containment — and this app has several (the
  // sidebar's `backdrop-filter`, the transcript's `contain`). A dialog opened
  // from a row inside one of those was positioned and clipped against that
  // ancestor instead of the window, so the panel was cut off mid-air where
  // that box ended. Portalling to `document.body` puts it above all of them.
  const surface = (
    <Reveal show={open} duration="slow" className="dialog-overlay">
      <div ref={backdropRef} className="dialog-backdrop" onMouseDown={handleBackdropMouseDown}>
        <div
          ref={panelRef}
          className={classes}
          role="dialog"
          aria-modal="true"
          aria-hidden={open ? undefined : 'true'}
          aria-labelledby={title ? titleId : undefined}
          tabIndex={-1}
          onKeyDown={handleKeyDown}
        >
          {title ? (
            <h2 id={titleId} className="dialog-title">
              {title}
            </h2>
          ) : null}
          {children}
        </div>
      </div>
    </Reveal>
  );

  return portalTarget ? createPortal(surface, portalTarget) : surface;
}
