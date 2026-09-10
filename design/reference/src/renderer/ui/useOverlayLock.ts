import { useEffect, useSyncExternalStore } from 'react';

/**
 * T146 — the one hook every global overlay uses to get out from under the
 * native browser pane.
 *
 * The pane is a main-process `WebContentsView`: a *native* view that
 * composites above all renderer content, so any overlay whose box crosses the
 * pane's rectangle (the Add endpoint dialog, a model-chip popover, an overflow
 * menu near the split) is painted underneath it and renders half-hidden. The
 * fix is to hide the pane's web content while such an overlay is mounted and
 * restore it when the last one closes — `browser:set-overlay-open`, handled in
 * src/main/browser/host.ts, which only flips visibility and keeps the page,
 * its history, and its scroll position intact.
 *
 * Reentrancy is the whole reason this lives in one module: two overlays can be
 * open at once (a dialog with a popover inside it, a popover wrapping a menu),
 * and the pane must stay hidden until *both* release. A module-level refcount
 * gives that, and it also means the main process only ever sees the 0↔n
 * transitions — never a stale count to reconcile after a renderer reload.
 *
 * Which overlays need it is a separate question. Blanking the pane is only
 * justified for an overlay that would actually be composited underneath, so an
 * overlay that hands its own element to the hook holds the lock only while its
 * rectangle crosses the pane's — the sidebar's row menu and the composer's Add
 * menu sit on the far side of the split and leave the page alone.
 */

/** Minimal slice of the browser API the lock needs; keeps the logic testable. */
export interface OverlayLockTransport {
  setOverlayOpen(open: boolean): Promise<unknown> | unknown;
}

export interface OverlayLock {
  /** Registers one mounted overlay. */
  acquire(): void;
  /** Releases one overlay; the pane returns once the last holder lets go. */
  release(): void;
  /** Overlays currently holding the lock. */
  readonly count: number;
}

/**
 * Refcounted lock over a transport. Pure and React-free so the reentrancy
 * rules are unit-testable without a DOM (tests/unit/overlay-lock.test.ts).
 *
 * Transitions are coalesced to the end of the current tick. React runs every
 * effect cleanup in a commit before the new effects, so one overlay handing
 * off to another — the model-chip popover closing as it opens the Add endpoint
 * dialog — would otherwise release and re-raise within the same commit and
 * flash the pane's page back for a frame. Batching sends only the net state,
 * and sends nothing at all when it did not change.
 *
 * The transport is resolved per flush rather than captured, so a lock created
 * before the preload bridge exists still works once it does; a flush that
 * finds no transport leaves the lock unsent, to be retried on the next change.
 */
export function createOverlayLock(
  getTransport: () => OverlayLockTransport | null,
  schedule: (flush: () => void) => void = queueMicrotask,
  onFrame: (frame: string | null) => void = () => undefined,
): OverlayLock {
  let count = 0;
  let sent = false;
  let scheduled = false;

  function flush(): void {
    scheduled = false;
    const open = count > 0;
    if (open === sent) return;

    const transport = getTransport();
    if (!transport) return;

    // A transport that throws or rejects costs only the pane's visibility;
    // it must never take the overlay down with it.
    try {
      void Promise.resolve(transport.setOverlayOpen(open))
        .then((result) => {
          // Raising answers with a still frame of the page; releasing clears
          // it. A stale frame outliving the overlay would freeze the pane, so
          // a failure clears it too.
          onFrame(open ? readFreezeFrame(result) : null);
        })
        .catch(() => onFrame(null));
      sent = open;
    } catch {
      // Left unsent so the next transition tries again.
    }
  }

  function scheduleFlush(): void {
    if (scheduled) return;
    scheduled = true;
    schedule(flush);
  }

  return {
    acquire(): void {
      count += 1;
      scheduleFlush();
    },
    release(): void {
      if (count === 0) return;
      count -= 1;
      scheduleFlush();
    },
    get count(): number {
      return count;
    },
  };
}

/** Pulls the data URL out of the transport's `Result`, tolerating any shape. */
function readFreezeFrame(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const shaped = result as { ok?: unknown; value?: unknown };
  return shaped.ok === true && typeof shaped.value === 'string' ? shaped.value : null;
}

let freezeFrame: string | null = null;
const freezeListeners = new Set<() => void>();

function publishFreezeFrame(frame: string | null): void {
  if (frame === freezeFrame) return;
  freezeFrame = frame;
  for (const listener of freezeListeners) listener();
}

/** The still frame to paint over the dock region, or `null` when the pane's
 * own web content is the thing on screen. */
export function overlayFreezeFrame(): string | null {
  return freezeFrame;
}

function subscribeFreezeFrame(listener: () => void): () => void {
  freezeListeners.add(listener);
  return () => {
    freezeListeners.delete(listener);
  };
}

/** Subscribes a component to the freeze frame; `null` outside Electron. */
export function useOverlayFreezeFrame(): string | null {
  return useSyncExternalStore(subscribeFreezeFrame, overlayFreezeFrame, () => null);
}

/** A rectangle in viewport coordinates — the frame both `getBoundingClientRect`
 * and the pane's docked bounds are already expressed in. */
export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Whether two rectangles share painted area. Edges that merely touch do not
 * count: an overlay whose bottom sits exactly on the pane's top edge hides
 * none of it — that is the case the omnibox panel relies on, since the pane
 * gives up the band the panel occupies. Neither does an empty rectangle, which
 * covers nothing however it is placed.
 */
export function rectsOverlap(a: OverlayRect, b: OverlayRect): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;

  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

let browserPaneRect: OverlayRect | null = null;
const paneRectListeners = new Set<() => void>();

/**
 * The pane's docked rectangle, published by the same effect that pushes
 * `browser:set-bounds` (src/renderer/app/App.tsx) so the gate below can never
 * disagree with where the native view actually is. `null` means no pane is
 * docked — or that it has not been measured yet, which is why an unknown rect
 * counts as an overlap instead of as "nothing to hide".
 */
export function setBrowserPaneRect(rect: OverlayRect | null): void {
  browserPaneRect = rect;
  for (const listener of paneRectListeners) listener();
}

/** Any ref that can hand back the overlay's own element. */
export interface OverlayElementRef {
  readonly current: HTMLElement | null;
}

/**
 * Whether this overlay would be composited under the pane. Three cases answer
 * yes without measuring anything — a call site that supplies no element, an
 * element that is not in the DOM yet, and a pane whose rectangle is unknown —
 * because none of them can *prove* the overlay misses the pane, and the cost
 * of guessing wrong the other way is an overlay rendered half-hidden.
 */
function overlapsBrowserPane(overlayRef: OverlayElementRef | undefined): boolean {
  if (overlayRef === undefined || browserPaneRect === null) return true;

  const element = overlayRef.current;
  if (element === null) return true;

  const rect = element.getBoundingClientRect();
  return rectsOverlap(
    { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    browserPaneRect,
  );
}

function browserTransport(): OverlayLockTransport | null {
  if (typeof window === 'undefined' || !('api' in window)) {
    return null;
  }
  const browser = window.api.browser;
  return browser && typeof browser.setOverlayOpen === 'function' ? browser : null;
}

/** Process-wide lock shared by every overlay primitive in this window. */
const overlayLock = createOverlayLock(browserTransport, queueMicrotask, publishFreezeFrame);

/**
 * Clears main's overlay state once, on load.
 *
 * The refcount lives in this module, so a reload — a dev hot restart, or the
 * window reloading for any reason — restarts it at zero while the main
 * process may still be holding the pane hidden for an overlay that no longer
 * exists. Nothing would ever release it, and the browser pane just stays
 * blank. This is sent outside the lock so the refcount's "send nothing when
 * nothing changed" contract is untouched.
 */
function resyncOverlayState(): void {
  const transport = browserTransport();
  if (!transport) return;

  try {
    void Promise.resolve(transport.setOverlayOpen(false)).catch(() => undefined);
    publishFreezeFrame(null);
  } catch {
    // A pane that cannot be reached needs no resync.
  }
}

/** Minimal slice of the browser API the freeze-frame refresh needs. */
interface FreezeFrameSource {
  onFreezeFrame?(callback: (frame: string) => void): unknown;
}

/**
 * Subscribes to the re-shot frames main sends while the lock is held:
 * a still of a video or an animated page goes stale within a second, and a
 * dialog can stay open far longer than that.
 *
 * A refresh only ever *replaces* a frame that is already on screen. One that
 * lands after the last overlay released would otherwise paint a still back
 * over the live page.
 */
function subscribeToFreezeFrameRefresh(): void {
  if (typeof window === 'undefined' || !('api' in window)) return;

  const browser: FreezeFrameSource | null = window.api.browser;
  browser?.onFreezeFrame?.((frame) => {
    if (freezeFrame === null) return;
    publishFreezeFrame(frame);
  });
}

if (typeof window !== 'undefined') {
  subscribeToFreezeFrameRefresh();

  if (document.readyState === 'complete') {
    resyncOverlayState();
  } else {
    window.addEventListener('load', resyncOverlayState, { once: true });
  }
}

/** Overlays currently holding the lock — exported for assertions in tests. */
export function overlayLockCount(): number {
  return overlayLock.count;
}

/**
 * Holds the overlay lock for as long as `active` is true and the overlay
 * crosses the browser pane. Wired into the shared Dialog/Popover/Menu
 * primitives, so any overlay built on them — today or later — is lifted above
 * the pane for free.
 *
 * `overlayRef` is optional: without it the overlay holds the lock the whole
 * time it is open, which is what every call site did before the gate existed.
 * Missing geometry must fail towards hiding the pane, never away from it.
 */
export function useOverlayLock(active: boolean, overlayRef?: OverlayElementRef): void {
  useEffect(() => {
    if (!active) return;

    let held = false;
    let observer: ResizeObserver | null = null;
    const hold = (next: boolean): void => {
      if (next === held) return;
      held = next;
      if (next) overlayLock.acquire();
      else overlayLock.release();
    };

    const evaluate = (): void => {
      const element = overlayRef?.current ?? null;
      // Watch the surface as soon as there is one: an overlay that grows —
      // a menu that flips, a list that filters — can start crossing the pane
      // long after it opened.
      if (element !== null && observer === null && typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(evaluate);
        observer.observe(element);
      }
      hold(overlapsBrowserPane(overlayRef));
    };

    // An element that is not mounted *yet* is not an unmeasurable overlay:
    // the primitives render their surface from an effect and place it on the
    // next frame. Taking the pessimistic answer straight away would hide the
    // pane and capture a frame for exactly the menus this gate exists to
    // spare, then hand it back a frame later — the flash, twice over. A call
    // site that passes no ref at all still locks immediately.
    if (overlayRef === undefined || overlayRef.current !== null) evaluate();
    const frame = requestAnimationFrame(evaluate);

    // The pane moves too, when the split divider is dragged.
    window.addEventListener('resize', evaluate);
    paneRectListeners.add(evaluate);

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', evaluate);
      paneRectListeners.delete(evaluate);
      hold(false);
    };
  }, [active, overlayRef]);
}
