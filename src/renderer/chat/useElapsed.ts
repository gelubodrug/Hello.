import { useEffect, useRef, useState } from 'react';

/**
 * Milliseconds of work so far, ticking each second while `active`: since
 * `since` when the work has a stamp of its own (a reply's start), otherwise
 * since it became active here — a reload must not resume someone else's
 * clock. A new `resetKey` starts the count again (another phase of waiting).
 */
export function useElapsed(active: boolean, since?: number, resetKey?: unknown): number {
  const [now, setNow] = useState(() => Date.now());
  const started = useRef(since ?? Date.now());
  useEffect(() => {
    if (!active) return;
    started.current = since ?? Date.now();
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [active, since, resetKey]);
  return active ? Math.max(0, now - started.current) : 0;
}
