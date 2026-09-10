export type SurfaceMotionPhase = 'enter' | 'exit';

export interface SurfaceMotionOptions {
  onFinish?: () => void;
}

const activeMotions = new WeakMap<HTMLElement, () => void>();

function milliseconds(token: string, fallback: number): number {
  const match = token.trim().match(/^([\d.]+)(ms|s)$/);
  if (!match) return fallback;
  const value = Number(match[1]) * (match[2] === 's' ? 1000 : 1);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * One short surface reveal, using only compositor opacity/transform. Calling
 * again on the same element supersedes its previous motion. Cancellation never
 * calls onFinish. An exit keeps its final frame until canceled/replaced so the
 * caller can commit its layout change before the next paint, without a flash.
 */
export function animateSurface(
  element: HTMLElement,
  phase: SurfaceMotionPhase,
  options: SurfaceMotionOptions = {},
): () => void {
  const previous = activeMotions.get(element);
  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  // Sample before canceling an interrupted animation, preserving its current
  // visual position instead of jumping to the old start frame on rapid clicks.
  const interrupted = previous
    ? { opacity: style?.opacity || '1', transform: style?.transform || 'none' }
    : null;
  previous?.();

  const reduced =
    element.closest('[data-reduced-motion="true"]') !== null ||
    view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const entering = phase === 'enter';
  const duration = milliseconds(
    style?.getPropertyValue(entering ? '--motion-base' : '--motion-fast') ?? '',
    entering ? 160 : 120,
  );
  const easing =
    style?.getPropertyValue(entering ? '--ease-out' : '--ease-in').trim() ||
    (entering ? 'ease-out' : 'ease-in');
  const offset = style?.getPropertyValue('--reveal-translate').trim() || '4px';

  if (reduced || duration === 0 || typeof element.animate !== 'function') {
    options.onFinish?.();
    return () => undefined;
  }

  let animation: Animation;
  let canceled = false;
  let finished = false;
  const cancel = (): void => {
    if (canceled) return;
    canceled = true;
    animation.onfinish = null;
    animation.oncancel = null;
    animation.cancel();
    if (activeMotions.get(element) === cancel) activeMotions.delete(element);
  };

  try {
    animation = element.animate(
      [
        interrupted ??
          (entering
            ? { opacity: 0, transform: `translateY(${offset})` }
            : { opacity: 1, transform: 'none' }),
        entering
          ? { opacity: 1, transform: 'none' }
          : { opacity: 0, transform: `translateY(${offset})` },
      ],
      { duration, easing, fill: 'both' },
    );
  } catch {
    // A renderer without functional WAAPI must not strand a close/layout action.
    options.onFinish?.();
    return () => undefined;
  }

  activeMotions.set(element, cancel);
  animation.onfinish = () => {
    if (canceled || finished) return;
    finished = true;
    if (entering) cancel();
    options.onFinish?.();
  };
  animation.oncancel = () => {
    canceled = true;
    if (activeMotions.get(element) === cancel) activeMotions.delete(element);
  };
  return cancel;
}
