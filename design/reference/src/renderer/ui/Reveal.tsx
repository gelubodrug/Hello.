import {
  useEffect,
  useState,
  type CSSProperties,
  type ElementType,
  type ReactNode,
  type TransitionEvent,
} from 'react';

import './Reveal.css';

type RevealState = 'enter' | 'shown' | 'exit';

const DURATION_TOKEN: Record<'fast' | 'base' | 'slow', string> = {
  fast: 'var(--motion-fast)',
  base: 'var(--motion-base)',
  slow: 'var(--motion-slow)',
};

export interface RevealProps {
  children: ReactNode;
  /** When it flips to false the exit transition plays, then the node unmounts. */
  show?: boolean;
  /** Stagger delay (ms) applied to the enter transition only. */
  delay?: number;
  /** Which motion-token duration to use. Defaults to `base` (160ms). */
  duration?: 'fast' | 'base' | 'slow';
  /** Element to render as. Defaults to a `div`. */
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
  /** Called once the exit transition has finished and the node has unmounted. */
  onExited?: () => void;
}

/**
 * Shared mount/unmount reveal primitive (DESIGNUIguide.md §Motion): a subtle
 * fade + scale/translate driven by the motion.css tokens. Children render into
 * the DOM immediately (server-render safe) and animate in on the next frame, so
 * static markup always contains the content. Staggerable via `delay`.
 */
export function Reveal({
  children,
  show = true,
  delay = 0,
  duration = 'base',
  as: Tag = 'div',
  className,
  style,
  onExited,
}: RevealProps) {
  const [rendered, setRendered] = useState(show);
  const [state, setState] = useState<RevealState>('enter');

  // Enter: on the frame after mount, flip `enter` -> `shown` so the transition
  // actually runs (a same-frame class swap would be coalesced with no motion).
  // useEffect never fires during server rendering, so SSR keeps the pre-reveal
  // markup with children present.
  useEffect(() => {
    if (!show) return;
    setRendered(true);
    setState('enter');
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setState('shown'));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [show]);

  // Exit: play the exit transition, with a fallback timer in case the element
  // is not visible and `transitionend` never fires.
  useEffect(() => {
    if (show) return;
    setState('exit');
    const fallback = window.setTimeout(() => {
      setRendered(false);
      onExited?.();
    }, 400);
    return () => window.clearTimeout(fallback);
  }, [show, onExited]);

  if (!rendered) return null;

  const handleTransitionEnd = (event: TransitionEvent) => {
    if (event.target !== event.currentTarget) return;
    if (state === 'exit') {
      setRendered(false);
      onExited?.();
    }
  };

  const mergedStyle = {
    '--reveal-dur': DURATION_TOKEN[duration],
    transitionDelay: state === 'exit' ? '0ms' : `${delay}ms`,
    ...style,
  } as CSSProperties;

  return (
    <Tag
      className={className ? `reveal ${className}` : 'reveal'}
      data-state={state}
      style={mergedStyle}
      onTransitionEnd={handleTransitionEnd}
    >
      {children}
    </Tag>
  );
}

export default Reveal;
