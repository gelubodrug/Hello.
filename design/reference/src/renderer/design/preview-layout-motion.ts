import { animateSurface } from '../ui/surface-motion';

export type PreviewLayoutMotionPhase = 'idle' | 'exit' | 'enter';

interface PreviewLayoutMotionOptions<State> {
  /** Foreground surfaces only; never the workspace material or a cloned viewport. */
  surfaces: () => HTMLElement[];
  commit: (state: State) => void;
  phase: (phase: PreviewLayoutMotionPhase) => void;
  equals: (left: State, right: State) => boolean;
}

/**
 * A geometry change has one owner: fade the old foreground, commit once, then
 * reveal the same mounted hosts from the next React layout effect. An exiting
 * animation holds its last frame across that commit. No timers, bitmap copies,
 * dimensions, native-view overlays or independently racing layout effects.
 */
export function createPreviewLayoutMotion<State>(
  initial: State,
  options: PreviewLayoutMotionOptions<State>,
  animate: typeof animateSurface = animateSurface,
) {
  let desired = initial;
  let displayed = initial;
  let sequence = 0;
  let disposed = false;
  let phase: PreviewLayoutMotionPhase = 'idle';
  let needsEnter = false;
  const motions = new Map<HTMLElement, () => void>();

  const setPhase = (next: PreviewLayoutMotionPhase): void => {
    phase = next;
    options.phase(next);
  };

  const run = (next: 'exit' | 'enter', onFinish: () => void): void => {
    const current = ++sequence;
    const surfaces = [...new Set(options.surfaces())];
    for (const [surface, cancel] of motions) {
      if (!surfaces.includes(surface)) {
        cancel();
        motions.delete(surface);
      }
    }
    setPhase(next);
    // Reduced motion may finish synchronously. Wait until every surface has
    // been registered before committing, just as for asynchronous WAAPI.
    let starting = true;
    let remaining = surfaces.length;
    const finish = (): void => {
      if (disposed || current !== sequence) return;
      remaining -= 1;
      if (!starting && remaining === 0) onFinish();
    };
    for (const surface of surfaces) {
      // animateSurface samples before replacing its previous animation; do
      // not cancel here or an interrupted reversal would jump to opacity 1.
      motions.set(surface, animate(surface, next, { onFinish: finish }));
    }
    starting = false;
    if (remaining === 0 && !disposed && current === sequence) onFinish();
  };

  return {
    request(update: (state: State) => State): void {
      if (disposed) return;
      const next = update(desired);
      if (options.equals(next, desired)) return;
      desired = next;
      if (options.equals(desired, displayed)) {
        // A rapid second click reverses the pending intent without committing
        // the obsolete geometry, and reveals from its current visual frame.
        needsEnter = false;
        run('enter', () => setPhase('idle'));
        return;
      }
      run('exit', () => {
        displayed = desired;
        needsEnter = true;
        options.commit(displayed);
      });
    },
    revealCommitted(): void {
      if (disposed || !needsEnter) return;
      needsEnter = false;
      run('enter', () => setPhase('idle'));
    },
    getPhase: (): PreviewLayoutMotionPhase => phase,
    dispose(): void {
      disposed = true;
      sequence += 1;
      for (const cancel of motions.values()) cancel();
      motions.clear();
    },
  };
}
