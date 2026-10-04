import { useEffect, useState, type ReactNode } from 'react';
import { Loader2, Undo2, type LucideIcon } from 'lucide-react';
import type { PiEngineStatus } from '../shared/types';
import { api } from './api';

/** The Pi engine's status, kept current from main. */
export function usePiEngine(): PiEngineStatus | null {
  const [status, setStatus] = useState<PiEngineStatus | null>(null);
  useEffect(() => {
    const bridge = api.piEngine;
    if (!bridge) return;
    let alive = true;
    void bridge.status().then(value => { if (alive) setStatus(value); }).catch(() => {});
    const unsubscribe = bridge.onStatus(value => setStatus(value));
    return () => { alive = false; unsubscribe(); };
  }, []);
  return status;
}

interface Props {
  icon: LucideIcon;
  name: string;
  /** The version running, when there is one. */
  version?: string;
  /** The version this Hello came with. */
  bundled?: string;
  /** A newer version npm offers. */
  latest?: string;
  updating?: boolean;
  /** Why the last update failed. */
  error?: string;
  onUpdate(): void;
  onBack(): void;
  /** What the row itself opens, when it opens something. */
  open?: { pressed: boolean; title: string; onClick(): void };
  /** A state mark beside the name. */
  mark?: ReactNode;
}

/**
 * An engine in the sidebar's footer: its name, the version running and, only
 * when npm has a newer one, "update" (user, 01.10: "v.xxx (update) dacă există
 * versiune nouă, dacă nu, nu"). Running an update, the way back to the version
 * Hello came with sits beside it.
 */
export function EngineRow({ icon: Icon, name, version, bundled, latest, updating, error, onUpdate, onBack, open, mark }: Props): JSX.Element {
  const content = <>
    <Icon size={16} aria-hidden />
    {name}
    {mark}
    {version && <span className="engine-version" title={error} data-error={error ? true : undefined}>v{version}</span>}
  </>;
  return (
    <div className="sidebar-engine">
      {open
        ? <button type="button" className="sidebar-settings" aria-pressed={open.pressed} title={open.title} onClick={open.onClick}>{content}</button>
        : <div className="sidebar-settings sidebar-engine-static">{content}</div>}
      {updating
        ? <Loader2 size={14} className="spin engine-busy" role="img" aria-label={`Updating ${name}`} />
        : <>
          {latest && version && (
            <button type="button" className="engine-update" title={`Update ${name} to v${latest}`} onClick={onUpdate}>update</button>
          )}
          {version && bundled && version !== bundled && (
            <button type="button" className="icon-button engine-back" title={`Back to v${bundled}, the ${name} Hello came with`}
              aria-label={`Back to ${name} v${bundled}`} onClick={onBack}><Undo2 size={13} /></button>
          )}
        </>}
    </div>
  );
}
