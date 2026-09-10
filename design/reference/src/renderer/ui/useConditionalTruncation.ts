import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Marks a text-bearing element only while its rendered content is clipped.
 * ResizeObserver covers layout changes; `content` re-runs the measurement when
 * React replaces text inside an otherwise fixed-width element.
 */
export function useConditionalTruncation<T extends HTMLElement>(content: unknown): RefObject<T> {
  const ref = useRef<T>(null);

  useBrowserLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;

    const measure = (): void => {
      element.toggleAttribute('data-truncated', element.scrollWidth > element.clientWidth);
    };

    measure();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [content]);

  return ref;
}
