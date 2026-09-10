/**
 * The terminal's raster renderer, and what happens when the GPU refuses it.
 *
 * xterm's DOM renderer takes block elements and box-drawing characters
 * (`▀▄█░▒▓`, `┌─┘`) from the font, so they carry the face's own metrics: a
 * frame drawn down the screen breaks up between rows, and a logo built from
 * half-blocks comes out ragged. The raster renderers draw those glyphs
 * themselves, as exact device-pixel rectangles — that is the `customGlyphs`
 * option, and it exists only there. In `@xterm/xterm` 6 WebGL is the only
 * raster renderer left: the canvas addon has no release for this major (its
 * last, 0.7.0, peers on xterm 5) and the package's own addon list no longer
 * mentions it.
 *
 * Which is why this is a fallback chain and not a `loadAddon` call. WebGL2 can
 * be missing — blocklisted driver, software rasterizer — and then `activate()`
 * throws; and a context that exists can still be dropped later, on suspend or
 * an out-of-memory reset, leaving a renderer that paints nothing at all.
 * Without the chain the first case takes the whole pane down with it and the
 * second leaves a blank rectangle over a shell that is still running. Both fall
 * back to DOM instead: uneven box drawing is a blemish, an empty terminal is a
 * broken app.
 */

import type {
  IDisposable,
  IEvent,
  ITerminalAddon,
  Terminal,
} from "@xterm/xterm";

/** `WebglAddon`, narrowed to the parts this module touches. */
export interface WebglRendererAddon extends ITerminalAddon {
  readonly onContextLoss: IEvent<void>;
}

export type TerminalRendererKind = "webgl" | "dom";

export interface TerminalRenderer {
  /**
   * Which renderer is painting right now — `dom` from the start when WebGL was
   * unavailable, and `dom` again after a context loss. It is a running state,
   * not a decision taken once at open.
   */
  readonly kind: TerminalRendererKind;
  /**
   * Idempotent, because the pane's teardown and a context loss both lead here
   * and either may come first.
   */
  dispose(): void;
}

const DOM_ONLY: TerminalRenderer = { kind: "dom", dispose: () => {} };

function loadWebgl(
  terminal: Pick<Terminal, "loadAddon">,
  createAddon: () => WebglRendererAddon,
): WebglRendererAddon | null {
  try {
    const addon = createAddon();
    // `loadAddon` activates the addon synchronously, so this call is where a
    // machine without WebGL2 throws — and the only place the throw can be
    // caught. Loading before `open()` would defer activation into xterm's own
    // `onWillOpen` callback, where the same failure escapes past every caller
    // and takes the terminal with it.
    terminal.loadAddon(addon);
    return addon;
  } catch (error) {
    // Not shown to the user: the terminal still works, just with the font's
    // own box drawing. The console line is what makes that explicable when
    // someone reports frames that look uneven on one machine and not another.
    console.warn(
      "The terminal is on the DOM renderer: WebGL was unavailable.",
      error,
    );
    return null;
  }
}

/**
 * Puts `terminal` on the WebGL renderer, with the DOM renderer underneath it.
 *
 * Call after `terminal.open()`: the addon needs the element, which is also the
 * order its own documentation gives.
 */
export function attachWebglRenderer(
  terminal: Pick<Terminal, "loadAddon">,
  createAddon: () => WebglRendererAddon,
): TerminalRenderer {
  const addon = loadWebgl(terminal, createAddon);
  if (addon === null) {
    return DOM_ONLY;
  }

  let painting = true;
  let lost: IDisposable | null = null;

  // Disposing the addon is what hands the render service back a DOM renderer,
  // so this single path serves both callers: the lost context and the pane
  // going away.
  const fallBack = (): void => {
    if (!painting) {
      return;
    }
    painting = false;
    lost?.dispose();
    lost = null;
    addon.dispose();
  };

  lost = addon.onContextLoss(fallBack);

  return {
    get kind(): TerminalRendererKind {
      return painting ? "webgl" : "dom";
    },
    dispose: fallBack,
  };
}
