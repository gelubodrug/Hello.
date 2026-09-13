import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserTab, PageModeKind, PagePick, PageRect } from '../../shared/types';
import { api } from '../api';

/** Kinds with a finished UI. Annotate's lane adds itself here. */
export const PAGE_MODE_KINDS_READY: readonly PageModeKind[] = ['design'];

export interface PageModePicked { pick: PagePick; point: { x: number; y: number }; }

/**
 * One tab's page mode, as the window sees it. Main decides whether a mode may
 * run and ends it on its own (grant lowered, navigation, hide, close, Escape);
 * this hook only asks, listens, and lets go when its pane stops showing.
 */
export function usePageMode(tab: BrowserTab, visible: boolean) {
  const [armed, setArmed] = useState<{ kind: PageModeKind; armId: string } | null>(null);
  const [picked, setPicked] = useState<PageModePicked | null>(null);
  const [hover, setHover] = useState<PageRect | null>(null);
  const [pending, setPending] = useState<PageModeKind | null>(null);
  const [error, setError] = useState('');
  const current = useRef(armed);
  current.current = armed;
  // Bridges from an older preload have no page modes; the switch simply stays off.
  const bridge = api.browser.mode as typeof api.browser.mode | undefined;

  const clear = useCallback(() => { setArmed(null); setPicked(null); setHover(null); }, []);

  useEffect(() => bridge?.onEvent(event => {
    const active = current.current;
    if (event.tabId !== tab.id || !active || event.armId !== active.armId) return;
    if (event.type === 'exit') clear();
    else if (event.type === 'picked') { setPicked({ pick: event.pick, point: event.point }); setHover(event.pick.rect); }
    else if (event.type === 'released') setPicked(null);
    else {
      setHover(event.rect);
      // The picked element moved with the page: the composer follows it.
      if (event.rect) setPicked(value => value ? { ...value, pick: { ...value.pick, rect: event.rect! } } : value);
    }
  }), [bridge, tab.id, clear]);

  const disarm = useCallback(() => {
    const active = current.current;
    if (!active) return;
    clear();
    void bridge?.disarm(tab.id, active.armId).catch(() => {});
  }, [bridge, tab.id, clear]);

  const toggle = useCallback(async (kind: PageModeKind) => {
    if (!bridge || pending) return;
    if (current.current?.kind === kind) { disarm(); return; }
    setError('');
    setPending(kind);
    try {
      const { armId } = await bridge.arm(tab.id, kind);
      setPicked(null); setHover(null);
      setArmed({ kind, armId });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'This mode could not start.');
    } finally {
      setPending(null);
    }
  }, [bridge, pending, tab.id, disarm]);

  /** Ends the pick in the page; the mode stays armed for the next one. */
  const release = useCallback(() => {
    const active = current.current;
    setPicked(null);
    if (active) void bridge?.release(tab.id, active.armId).catch(() => {});
  }, [bridge, tab.id]);

  // The window's own reasons to let go. Main enforces the same; this just
  // keeps the switch honest without waiting for its word.
  const readable = tab.control !== 'off';
  useEffect(() => { if (!visible || !readable) disarm(); }, [visible, readable, disarm]);
  useEffect(() => { disarm(); }, [tab.url, disarm]);
  useEffect(() => () => {
    const active = current.current;
    if (active) void bridge?.disarm(tab.id, active.armId).catch(() => {});
  }, [bridge, tab.id]);

  return { available: Boolean(bridge), mode: armed?.kind ?? null, armId: armed?.armId ?? null, picked, hover, pending, error, clearError: () => setError(''), toggle, disarm, release };
}
