// Reused pure renderer regression tests from the authorized old terminal port.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IDisposable, IEvent, Terminal } from "@xterm/xterm";
import {
  isTerminalToggleShortcut,
  terminalKeyVerdict,
  type TerminalKeyEvent,
} from "../src/renderer/terminal/keys";
import {
  readTerminalFontFamily,
  readTerminalTheme,
} from "../src/renderer/terminal/theme";
import {
  attachWebglRenderer,
  type WebglRendererAddon,
} from "../src/renderer/terminal/webgl";

describe("retained terminal host contract", () => {
  it("ports the real xterm metrics/addons without the old shell/store or automatic launch", () => {
    const pane = readFileSync(
      join(process.cwd(), "src/renderer/terminal/TerminalPane.tsx"),
      "utf8",
    );
    expect(pane).toContain("const FONT_SIZE = 13");
    expect(pane).toContain("const LINE_HEIGHT = 1.15");
    expect(pane).toContain("const CLIENT_SCROLLBACK_LINES = 5000");
    expect(pane).toContain("customGlyphs: true");
    expect(pane).toMatch(/xterm\.unicode\.activeVersion = ['"]11['"]/);
    expect(pane.indexOf("xterm.open(host)")).toBeLessThan(
      pane.indexOf("attachWebglRenderer(xterm"),
    );
    expect(pane).toContain("await document.fonts?.load");
    expect(pane).toContain("terminalKeyVerdict(event, xterm.hasSelection())");
    expect(pane).toContain("api.attach(session.id)");
    expect(pane).not.toMatch(
      /api\.(?:create|close|setVisible)\(|projectsStore|settingsStore|Reveal|dock-state/,
    );
    expect(pane).toContain("}, [host, session.id])");
    expect(pane).toContain("hidden={!visible}");
    expect(pane.indexOf("api.onData(")).toBeLessThan(
      pane.indexOf("await api.attach("),
    );
    expect(pane).toContain("output.attach(attached)");
  });
});

function key(overrides: Partial<TerminalKeyEvent>): TerminalKeyEvent {
  return {
    type: "keydown",
    key: "a",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("terminal key routing", () => {
  it("leaves ordinary typing and control characters to the shell", () => {
    expect(terminalKeyVerdict(key({ key: "a" }), false)).toBe("terminal");
    // ^C is the interrupt; losing it would make the terminal useless.
    expect(terminalKeyVerdict(key({ key: "c", ctrlKey: true }), false)).toBe(
      "terminal",
    );
    expect(terminalKeyVerdict(key({ key: "c", ctrlKey: true }), true)).toBe(
      "terminal",
    );
    // ^B and ^J are readline and newline, not this window's shortcuts.
    expect(terminalKeyVerdict(key({ key: "b", ctrlKey: true }), false)).toBe(
      "terminal",
    );
    expect(terminalKeyVerdict(key({ key: "j", ctrlKey: true }), false)).toBe(
      "terminal",
    );
  });

  it("gives the window back its own shortcuts", () => {
    expect(terminalKeyVerdict(key({ key: "b", metaKey: true }), false)).toBe(
      "app",
    );
    expect(
      terminalKeyVerdict(
        key({ key: "B", metaKey: true, shiftKey: true }),
        false,
      ),
    ).toBe("app");
    expect(terminalKeyVerdict(key({ key: "j", metaKey: true }), false)).toBe(
      "app",
    );
  });

  it("makes ⌘C a copy only when there is a selection", () => {
    expect(terminalKeyVerdict(key({ key: "c", metaKey: true }), true)).toBe(
      "copy",
    );
    expect(terminalKeyVerdict(key({ key: "c", metaKey: true }), false)).toBe(
      "terminal",
    );
  });

  it("leaves ⌘V to the browser, so paste keeps working", () => {
    expect(terminalKeyVerdict(key({ key: "v", metaKey: true }), false)).toBe(
      "terminal",
    );
  });

  it("recognizes the drawer toggle and nothing adjacent to it", () => {
    const base = {
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      key: "j",
    };

    expect(isTerminalToggleShortcut({ ...base, metaKey: true })).toBe(true);
    expect(isTerminalToggleShortcut({ ...base, ctrlKey: true, key: "J" })).toBe(
      true,
    );
    // ⌘⇧B is the browser pane and ⌘B the sidebar; neither may be swallowed.
    expect(
      isTerminalToggleShortcut({ ...base, metaKey: true, shiftKey: true }),
    ).toBe(false);
    expect(isTerminalToggleShortcut({ ...base, metaKey: true, key: "b" })).toBe(
      false,
    );
    expect(isTerminalToggleShortcut(base)).toBe(false);
  });
});

describe("terminal theme", () => {
  const tokens: Record<string, string> = {
    // The app's own roles are present and deliberately not what the terminal
    // reads: its ground is black in either theme, so borrowing --color-bg
    // would hand xterm the panel colour it is supposed to break away from.
    "--color-bg": "#1e1e20",
    "--color-text-primary": "#f5f5f7",
    "--term-bg": "#000000",
    "--term-fg": "#f5f5f7",
    "--term-selection": "rgba(255, 255, 255, 0.24)",
    "--term-selection-inactive": "rgba(255, 255, 255, 0.12)",
    "--term-ansi-black": "#1e1e20",
    "--term-ansi-red": "#ff453a",
    "--term-ansi-bright-white": "#f5f5f7",
    "--font-mono": "'Geist Mono', ui-monospace, monospace",
    "--font-terminal": "ui-monospace, 'SF Mono', Menlo, monospace",
  };

  const read = (name: string): string => tokens[name] ?? "";

  it("restates the tokens as an xterm palette, on a black ground", () => {
    const theme = readTerminalTheme(read);

    expect(theme.background).toBe("#000000");
    expect(theme.foreground).toBe("#f5f5f7");
    expect(theme.cursor).toBe("#f5f5f7");
    expect(theme.cursorAccent).toBe("#000000");
    expect(theme.selectionBackground).toBe("rgba(255, 255, 255, 0.24)");
    expect(theme.black).toBe("#1e1e20");
    expect(theme.red).toBe("#ff453a");
    expect(theme.brightWhite).toBe("#f5f5f7");
  });

  it("leaves a slot alone rather than assigning an empty colour", () => {
    expect("green" in readTerminalTheme(read)).toBe(false);
  });

  it("takes its own family, not the chrome mono stack", () => {
    // Deliberately not --font-mono: Geist Mono has no box-drawing or block
    // glyphs, and the per-character fallback that follows is what misaligns
    // every frame a TUI draws.
    expect(readTerminalFontFamily(read)).toBe(
      "ui-monospace, 'SF Mono', Menlo, monospace",
    );
    expect(readTerminalFontFamily(() => "")).toBe("ui-monospace, monospace");
  });
});

/**
 * A stand-in for `WebglAddon` with a context loss under test control. The real
 * addon needs a GPU, and the two paths worth proving here are exactly the two
 * that never happen on a healthy machine.
 */
function fakeWebglAddon(): {
  addon: WebglRendererAddon;
  disposals: () => number;
  listening: () => number;
  loseContext: () => void;
} {
  const listeners = new Set<() => void>();
  let disposals = 0;

  const onContextLoss: IEvent<void> = (listener) => {
    const fire = (): void => listener(undefined, undefined);
    listeners.add(fire);
    const subscription: IDisposable = {
      dispose: () => {
        listeners.delete(fire);
      },
    };
    return subscription;
  };

  return {
    addon: {
      activate: () => {},
      dispose: () => {
        disposals += 1;
      },
      onContextLoss,
    },
    disposals: () => disposals,
    listening: () => listeners.size,
    loseContext: () => listeners.forEach((fire) => fire()),
  };
}

function recordingTerminal(): {
  terminal: Pick<Terminal, "loadAddon">;
  loaded: () => number;
} {
  let loaded = 0;
  return {
    terminal: {
      loadAddon: () => {
        loaded += 1;
      },
    },
    loaded: () => loaded,
  };
}

describe("terminal renderer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("paints through WebGL when the machine has it", () => {
    const { terminal, loaded } = recordingTerminal();
    const webgl = fakeWebglAddon();

    const renderer = attachWebglRenderer(terminal, () => webgl.addon);

    expect(renderer.kind).toBe("webgl");
    expect(loaded()).toBe(1);
  });

  it("leaves a working terminal on the DOM renderer when the addon cannot be created", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { terminal, loaded } = recordingTerminal();

    const renderer = attachWebglRenderer(terminal, () => {
      throw new Error("WebGL2 not supported");
    });

    expect(renderer.kind).toBe("dom");
    expect(loaded()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    // The pane tears down the same way whichever renderer it ended up with.
    expect(() => renderer.dispose()).not.toThrow();
  });

  it("falls back when activation fails, which is where a blocklisted driver throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const webgl = fakeWebglAddon();
    const terminal: Pick<Terminal, "loadAddon"> = {
      loadAddon: () => {
        throw new Error("WebGL2 not supported");
      },
    };

    const renderer = attachWebglRenderer(terminal, () => webgl.addon);

    expect(renderer.kind).toBe("dom");
    expect(webgl.listening()).toBe(0);
  });

  it("disposes the addon on context loss instead of leaving a dead surface", () => {
    const { terminal } = recordingTerminal();
    const webgl = fakeWebglAddon();

    const renderer = attachWebglRenderer(terminal, () => webgl.addon);
    expect(webgl.listening()).toBe(1);

    webgl.loseContext();

    expect(webgl.disposals()).toBe(1);
    expect(webgl.listening()).toBe(0);
    expect(renderer.kind).toBe("dom");
  });

  it("disposes the addon when the pane tears down, and only once", () => {
    const { terminal } = recordingTerminal();
    const webgl = fakeWebglAddon();

    const renderer = attachWebglRenderer(terminal, () => webgl.addon);
    renderer.dispose();
    renderer.dispose();

    expect(webgl.disposals()).toBe(1);
    expect(webgl.listening()).toBe(0);
  });

  it("does not dispose twice when teardown follows a context loss", () => {
    const { terminal } = recordingTerminal();
    const webgl = fakeWebglAddon();

    const renderer = attachWebglRenderer(terminal, () => webgl.addon);
    webgl.loseContext();
    renderer.dispose();

    expect(webgl.disposals()).toBe(1);
  });
});
