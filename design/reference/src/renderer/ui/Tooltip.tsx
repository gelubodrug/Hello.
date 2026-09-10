import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';

import { Reveal } from './Reveal';
import './Tooltip.css';

export interface TooltipProps {
  /** Short hint text. Icon-only affordance — never the sole home for required/critical text. */
  label: string;
  /** A single icon-only control; receives aria-describedby and the hover/focus handlers. */
  children: ReactElement;
  /** Delay in ms before the tooltip appears on hover. */
  delay?: number;
  className?: string;
}

const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 6;
const DEFAULT_DELAY = 400;

/** Lightweight hint for icon-only controls (DESIGNUIguide.md §Tooltips):
 * appears on hover/focus after a short delay, dismissible on Esc/blur, and
 * clips to the viewport instead of overflowing it. Not for critical or
 * required text — that must be available outside the tooltip. */
export function Tooltip({ label, children, delay = DEFAULT_DELAY, className }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipId = useId();
  // The surface is `position: fixed`, but a transformed, filtered or
  // `contain`ed ancestor becomes its containing block and it would then be
  // laid out — and measured — against that box instead of the viewport.
  // Several of this app's tooltip hosts are exactly that (the titlebar
  // clusters' `translateY(-50%)`, the sidebar panel's transform +
  // backdrop-filter, the transcript's `contain: strict`), so the surface is
  // portalled to `document.body`, whose only containing block is the
  // viewport. The effect never runs during static-markup rendering, so
  // server output keeps the inline surface (which is `null` while hidden).
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => setPortalTarget(document.body), []);

  const clearShowTimeout = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const show = useCallback(() => {
    clearShowTimeout();
    timeoutRef.current = setTimeout(() => setVisible(true), delay);
  }, [clearShowTimeout, delay]);

  const hide = useCallback(() => {
    clearShowTimeout();
    setVisible(false);
  }, [clearShowTimeout]);

  useEffect(() => clearShowTimeout, [clearShowTimeout]);

  useLayoutEffect(() => {
    if (!visible) return;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      const tooltip = tooltipRef.current;
      if (!trigger || !tooltip) return;

      const triggerRect = trigger.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let top = triggerRect.top - tooltipRect.height - TRIGGER_GAP;
      if (top < VIEWPORT_MARGIN) top = triggerRect.bottom + TRIGGER_GAP;

      let left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2;
      left = Math.min(
        Math.max(left, VIEWPORT_MARGIN),
        Math.max(viewportWidth - tooltipRect.width - VIEWPORT_MARGIN, VIEWPORT_MARGIN),
      );
      top = Math.min(
        top,
        Math.max(viewportHeight - tooltipRect.height - VIEWPORT_MARGIN, VIEWPORT_MARGIN),
      );

      setPosition({ top, left });
    };

    updatePosition();
    const frame = requestAnimationFrame(updatePosition);
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  useEffect(() => {
    if (!visible) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') hide();
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [visible, hide]);

  const trigger = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      const { ref } = children as unknown as { ref?: unknown };
      if (typeof ref === 'function') ref(node);
      else if (ref && typeof ref === 'object')
        (ref as { current: HTMLElement | null }).current = node;
    },
    'aria-describedby': visible ? tooltipId : undefined,
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
  });

  const classes = ['tooltip', className].filter(Boolean).join(' ');

  const surface = (
    <Reveal
      show={visible}
      duration="fast"
      className="tooltip-presence"
      style={position ? { top: position.top, left: position.left } : undefined}
      onExited={() => setPosition(null)}
    >
      <div
        ref={tooltipRef}
        id={tooltipId}
        role="tooltip"
        className={classes}
        aria-hidden={visible ? undefined : 'true'}
      >
        {label}
      </div>
    </Reveal>
  );

  return (
    <>
      {trigger}
      {portalTarget ? createPortal(surface, portalTarget) : surface}
    </>
  );
}
