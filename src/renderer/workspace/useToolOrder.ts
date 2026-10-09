import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

/** Stable ids survive browser restoration. New tools append in their original order. */
export function orderedTools<T extends { id: string }>(tools: T[], order: string[]): T[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...tools].sort((a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length));
}

export function useToolOrder(conversationId: string, onError: (error: unknown) => void) {
  const [order, setOrder] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const saving = useRef(false);
  const generation = useRef(0);
  const report = useRef(onError); report.current = onError;
  useEffect(() => {
    const request = ++generation.current;
    setReady(false); setOrder([]); saving.current = false;
    void api.workspace?.toolOrder(conversationId).then(saved => {
      if (generation.current === request) { setOrder(saved); setReady(true); }
    }, error => { if (generation.current === request) report.current(error); });
    return () => { generation.current++; };
  }, [conversationId]);
  const reorder = ready && api.workspace ? (ids: string[]) => {
    if (saving.current) return;
    saving.current = true;
    const request = generation.current;
    // The DB acknowledges before the displayed order changes. Failed writes
    // leave the existing order intact and visible.
    void api.workspace!.saveToolOrder(conversationId, ids).then(saved => {
      if (generation.current === request) setOrder(saved);
    }, error => { if (generation.current === request) report.current(error); })
      .finally(() => { if (generation.current === request) saving.current = false; });
  } : undefined;
  return { order, reorder };
}
