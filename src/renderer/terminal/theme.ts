/**
 * The design tokens, restated as an xterm theme.
 *
 * xterm paints into a canvas-free DOM/WebGL renderer of its own and takes its
 * palette as a plain object, so CSS variables cannot reach it: they are read
 * back here and handed over. That makes this the one place where a token turns
 * into a literal.
 *
 * The surface reads `--term-*` rather than the app's own colour roles: the
 * terminal's ground is black in either theme (tokens.css), so borrowing
 * `--color-bg` would hand xterm the app's panel colour and leave the ANSI ramp
 * unreadable on it in light mode.
 */

import type { ITheme } from "@xterm/xterm";

/** Every ANSI slot, paired with the token that supplies it. */
const ANSI_TOKENS: ReadonlyArray<[keyof ITheme, string]> = [
  ["black", "--term-ansi-black"],
  ["red", "--term-ansi-red"],
  ["green", "--term-ansi-green"],
  ["yellow", "--term-ansi-yellow"],
  ["blue", "--term-ansi-blue"],
  ["magenta", "--term-ansi-magenta"],
  ["cyan", "--term-ansi-cyan"],
  ["white", "--term-ansi-white"],
  ["brightBlack", "--term-ansi-bright-black"],
  ["brightRed", "--term-ansi-bright-red"],
  ["brightGreen", "--term-ansi-bright-green"],
  ["brightYellow", "--term-ansi-bright-yellow"],
  ["brightBlue", "--term-ansi-bright-blue"],
  ["brightMagenta", "--term-ansi-bright-magenta"],
  ["brightCyan", "--term-ansi-bright-cyan"],
  ["brightWhite", "--term-ansi-bright-white"],
];

export type TokenReader = (name: string) => string;

/** Reads a custom property off the document root, trimmed. */
export function documentTokenReader(
  root: Element = document.documentElement,
  view: Pick<Window, "getComputedStyle"> = window,
): TokenReader {
  const style = view.getComputedStyle(root);
  return (name) => style.getPropertyValue(name).trim();
}

export function readTerminalTheme(read: TokenReader): ITheme {
  const theme: ITheme = {
    background: read("--term-bg"),
    foreground: read("--term-fg"),
    // A terminal's caret is the text colour, not the app accent: accent means
    // "this is selected or verified" everywhere else in the app.
    cursor: read("--term-fg"),
    cursorAccent: read("--term-bg"),
    selectionBackground: read("--term-selection"),
    selectionInactiveBackground: read("--term-selection-inactive"),
  };

  for (const [slot, token] of ANSI_TOKENS) {
    const value = read(token);
    if (value !== "") {
      Object.assign(theme, { [slot]: value });
    }
  }

  return theme;
}

/**
 * The terminal's font stack, as a value rather than a stylesheet rule: xterm
 * takes its font as an option and measures cell width from it.
 *
 * This reads `--font-terminal`, not `--font-mono`. The two differ on purpose —
 * see the token's own note: a face without box-drawing glyphs makes the browser
 * fall back per character, and the differing advance width is what misaligns
 * every frame a TUI draws.
 */
export function readTerminalFontFamily(read: TokenReader): string {
  const family = read("--font-terminal");
  return family === "" ? "ui-monospace, monospace" : family;
}
