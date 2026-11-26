import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { TerminalSession } from "../../shared/types";
import { api as appAPI } from "../api";
import { droppedPaths, hasFileDrop, quoteTerminalPaths } from "../drop";
import { Truncated } from "../ui/primitives";
import { terminalKeyVerdict } from "./keys";
import { findInBuffer, type TerminalMatch } from "./find";
import {
  documentTokenReader,
  readTerminalFontFamily,
  readTerminalTheme,
} from "./theme";
import { attachWebglRenderer, type TerminalRenderer } from "./webgl";
import { createTerminalOutput } from "./output";
import "@xterm/xterm/css/xterm.css";
import "./TerminalPane.css";

const FONT_SIZE = 13;
const LINE_HEIGHT = 1.15;
const CLIENT_SCROLLBACK_LINES = 5000;

function folderName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

/** The existing xterm renderer, without the old shell, stores or dock chrome. */
export function TerminalPane({
  session,
  visible,
  placement,
  currentFolder,
  onOpenInCurrentFolder,
  focusOnShow = true,
}: {
  session: TerminalSession;
  visible: boolean;
  /** Which pane holds it: Tools, or the chat pane as a chat tab. */
  placement?: "tools" | "chat";
  currentFolder?: string | null;
  onOpenInCurrentFolder?: () => void;
  /** Whether being shown gives it the keys: in a split tab only the terminal in use takes them. */
  focusOnShow?: boolean;
}): JSX.Element {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [copyFailure, setCopyFailure] = useState<string | null>(null);
  const [dropFailure, setDropFailure] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [exited, setExited] = useState(session.status === "exited");
  const dropDepth = useRef(0);
  const dropBusy = useRef(false);
  const inputReady = useRef(false);
  const active = useRef(visible);
  active.current = visible;
  const takesKeys = useRef(focusOnShow);
  takesKeys.current = focusOnShow;
  const mounted = useRef<{ terminal: Terminal; fit: FitAddon } | null>(null);
  const folderChanged = currentFolder !== undefined && currentFolder !== session.cwd;

  // Find in the scrollback (S209 F5): ⌘F, or Ctrl+Shift+F, while the terminal
  // has focus. The query is this terminal's own, kept while it is hidden or
  // moved; the field is outside xterm, so nothing typed reaches the shell.
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState({ index: 0, total: 0 });
  const [alternate, setAlternate] = useState(false);
  const findField = useRef<HTMLInputElement>(null);
  const matches = useRef<TerminalMatch[]>([]);
  const findState = useRef({ open: false, query: "", index: 0 });
  findState.current.open = finding;
  findState.current.query = query;
  const showMatch = (terminal: Terminal, index: number) => {
    const match = matches.current[index];
    if (!match) { terminal.clearSelection(); return; }
    terminal.select(match.col, match.row, match.length);
    terminal.scrollToLine(Math.max(0, match.row - Math.floor(terminal.rows / 2)));
  };
  /** Again from the buffer: after typing, new output, a reflow or a screen switch.
   *  A search starts at the newest match, and stays there while output arrives. */
  const searchAgain = useRef((fromNewest: boolean) => {
    const terminal = mounted.current?.terminal;
    const state = findState.current;
    if (!terminal || !state.open) return;
    // A full-screen program (an editor, a pager) has no scrollback to search.
    const full = terminal.buffer.active.type === "alternate";
    setAlternate(full);
    const atNewest = state.index >= matches.current.length - 1;
    matches.current = full ? [] : findInBuffer(terminal.buffer.active, terminal.cols, state.query);
    const total = matches.current.length;
    state.index = !total ? 0 : fromNewest || atNewest ? total - 1 : Math.min(state.index, total - 1);
    setFound({ index: state.index, total });
    showMatch(terminal, state.index);
  });
  const step = (delta: number) => {
    const terminal = mounted.current?.terminal;
    const total = matches.current.length;
    if (!terminal || !total) return;
    findState.current.index = (findState.current.index + delta + total) % total;
    setFound({ index: findState.current.index, total });
    showMatch(terminal, findState.current.index);
  };
  const openFind = useRef(() => {
    setFinding(true);
    requestAnimationFrame(() => { findField.current?.focus(); findField.current?.select(); });
  });
  const closeFind = () => {
    setFinding(false);
    matches.current = [];
    mounted.current?.terminal.clearSelection();
    mounted.current?.terminal.focus();
  };
  useEffect(() => { if (finding) searchAgain.current(true); }, [finding, query]);

  useEffect(() => {
    if (!visible) { dropDepth.current = 0; setDropActive(false); }
  }, [visible]);

  // Moved between panes, it is the same terminal in a new place: fitted
  // there, and given the keys back that the move took away.
  useEffect(() => {
    if (!visible || !host || !mounted.current) return;
    if (host.clientWidth > 0 && host.clientHeight > 0)
      mounted.current.fit.fit();
    if (takesKeys.current) mounted.current.terminal.focus();
  }, [visible, host, placement, focusOnShow]);

  useEffect(() => {
    if (!host) return;
    let stopped = false;
    let terminal: Terminal | null = null;
    let renderer: TerminalRenderer | null = null;
    const cleanup: Array<() => void> = [];
    const dispose = (): void => {
      inputReady.current = false;
      for (const off of cleanup.splice(0)) off();
      renderer?.dispose();
      renderer = null;
      if (mounted.current?.terminal === terminal) mounted.current = null;
      terminal?.dispose();
      terminal = null;
    };
    const start = async (): Promise<void> => {
      setFailure(null);
      const api = window.hello?.terminal;
      if (!api)
        throw new Error("The terminal bridge is unavailable. Reopen the app.");
      const [
        { Terminal: XTerm },
        { FitAddon },
        { Unicode11Addon },
        { WebglAddon },
      ] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-unicode11"),
        import("@xterm/addon-webgl"),
      ]);
      const read = documentTokenReader();
      const fontFamily = readTerminalFontFamily(read);
      try {
        await document.fonts?.load(`${FONT_SIZE}px ${fontFamily}`);
      } catch {
        /* use the fallback face */
      }
      await document.fonts?.ready;
      if (stopped) return;
      terminal = new XTerm({
        fontFamily,
        fontSize: FONT_SIZE,
        lineHeight: LINE_HEIGHT,
        cursorBlink: true,
        scrollback: CLIENT_SCROLLBACK_LINES,
        theme: readTerminalTheme(read),
        allowProposedApi: true,
        customGlyphs: true,
      });
      const xterm = terminal;
      xterm.options.disableStdin = true;
      const fit = new FitAddon();
      xterm.loadAddon(fit);
      xterm.loadAddon(new Unicode11Addon());
      xterm.unicode.activeVersion = "11";
      xterm.attachCustomKeyEventHandler((event) => {
        // ⌘F, or Ctrl+Shift+F off a Mac, opens find; Ctrl+F stays the shell's.
        if (!event.altKey && event.key.toLowerCase() === "f" &&
            ((event.metaKey && !event.ctrlKey && !event.shiftKey) || (event.ctrlKey && event.shiftKey && !event.metaKey))) {
          event.preventDefault();
          event.stopPropagation();
          if (event.type === "keydown") openFind.current();
          return false;
        }
        const verdict = terminalKeyVerdict(event, xterm.hasSelection());
        if (verdict === "copy" && event.type === "keydown") {
          event.preventDefault();
          setCopyFailure(null);
          void appAPI.system.copy({ text: xterm.getSelection() }).catch((reason: unknown) => {
            if (!stopped) setCopyFailure(reason instanceof Error ? reason.message : "The selection could not be copied.");
          });
        }
        return verdict === "terminal";
      });
      xterm.open(host);
      renderer = attachWebglRenderer(xterm, () => new WebglAddon());
      mounted.current = { terminal: xterm, fit };
      const output = createTerminalOutput((data, done) =>
        xterm.write(data, done),
      );
      cleanup.push(() => output.dispose());
      let processExited = false;
      let attachedOutput = false;
      let exitCode: number | undefined;
      // Subscribe before snapshot; sequence reconciliation excludes its already-kept chunks.
      cleanup.push(
        api.onData((event) => {
          if (event.id === session.id) output.receive(event);
        }),
      );
      cleanup.push(
        api.onExit((event) => {
          if (event.id !== session.id) return;
          processExited = true;
          inputReady.current = false;
          exitCode = event.exitCode;
          setExited(true);
          xterm.options.disableStdin = true;
          if (attachedOutput)
            output.append(
              `\r\n[process exited with status ${event.exitCode}]\r\n`,
            );
        }),
      );
      const attached = await api.attach(session.id);
      if (stopped) return;
      output.attach(attached);
      attachedOutput = true;
      processExited ||= attached.session.status === "exited";
      setExited(processExited);
      xterm.options.disableStdin = processExited;
      if (processExited)
        output.append(
          `\r\n[process exited with status ${exitCode ?? attached.session.exitCode ?? 0}]\r\n`,
        );
      const fail = (error: unknown): void => {
        if (!stopped)
          setFailure(
            error instanceof Error
              ? error.message
              : "Terminal connection failed.",
          );
      };
      const input = xterm.onData((data) => {
        if (!processExited) void api.write(session.id, data).catch(fail);
      });
      const resized = xterm.onResize(({ cols, rows }) => {
        if (!processExited) void api.resize(session.id, cols, rows).catch(fail);
      });
      cleanup.push(
        () => input.dispose(),
        () => resized.dispose(),
      );
      // An open search follows the buffer: output, a reflow, a full-screen program.
      let findTimer: ReturnType<typeof setTimeout> | undefined;
      const refind = () => { clearTimeout(findTimer); findTimer = setTimeout(() => searchAgain.current(false), 200); };
      const parsed = xterm.onWriteParsed(refind);
      const reflowed = xterm.onResize(refind);
      const switched = xterm.buffer.onBufferChange(() => searchAgain.current(false));
      cleanup.push(() => { clearTimeout(findTimer); parsed.dispose(); reflowed.dispose(); switched.dispose(); });
      inputReady.current = !processExited;
      const fitVisible = (): void => {
        if (active.current && host.clientWidth > 0 && host.clientHeight > 0)
          fit.fit();
      };
      const sizeObserver = new ResizeObserver(fitVisible);
      sizeObserver.observe(host);
      cleanup.push(() => sizeObserver.disconnect());
      const themeObserver = new MutationObserver(() => {
        xterm.options.theme = readTerminalTheme(documentTokenReader());
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "class", "style"],
      });
      cleanup.push(() => themeObserver.disconnect());
      fitVisible();
      if (active.current && takesKeys.current) xterm.focus();
    };
    void start().catch((error: unknown) => {
      if (!stopped)
        setFailure(
          error instanceof Error
            ? error.message
            : "The terminal could not attach.",
        );
      dispose();
    });
    return () => {
      stopped = true;
      dispose();
    };
    // A visibility change never destroys the terminal, input draft or subscriptions.
  }, [host, session.id]);

  return (
    <section
      className="hello-terminal"
      hidden={!visible}
      aria-label={session.title}
      data-session-id={session.id}
      data-exited={exited}
      data-drop-active={dropActive}
      onDragEnter={event => {
        if (!hasFileDrop(event.dataTransfer)) return;
        event.preventDefault(); event.stopPropagation();
        dropDepth.current++;
        setDropActive(true);
      }}
      onDragOver={event => {
        if (!hasFileDrop(event.dataTransfer)) return;
        event.preventDefault(); event.stopPropagation();
        event.dataTransfer.dropEffect = inputReady.current && !dropBusy.current ? 'copy' : 'none';
      }}
      onDragLeave={event => {
        if (!hasFileDrop(event.dataTransfer)) return;
        event.preventDefault(); event.stopPropagation();
        dropDepth.current = Math.max(0, dropDepth.current - 1);
        if (!dropDepth.current) setDropActive(false);
      }}
      onDrop={event => {
        if (!hasFileDrop(event.dataTransfer)) return;
        event.preventDefault(); event.stopPropagation();
        dropDepth.current = 0; setDropActive(false); setDropFailure(null);
        const target = mounted.current;
        if (!target || !inputReady.current) {
          setDropFailure(exited ? 'This terminal has exited. Open a new terminal to drop files.' : 'The terminal is still connecting. Drop the files again when it is ready.');
          return;
        }
        if (dropBusy.current) { setDropFailure('The previous file drop is still being added.'); return; }
        dropBusy.current = true;
        void droppedPaths(event.dataTransfer).then(paths => {
          // A slow scoped lookup must not type into a hidden, replaced or exited session.
          if (!active.current || mounted.current !== target || !inputReady.current) return;
          target.terminal.paste(quoteTerminalPaths(paths));
          target.terminal.focus();
        }).catch((reason: unknown) => {
          if (mounted.current === target) setDropFailure(reason instanceof Error ? reason.message : 'The dropped files could not be added.');
        }).finally(() => { dropBusy.current = false; });
      }}
    >
      {session.kind === "worker" && (
        <div className="hello-terminal-context" aria-label="CLI session context">
          <span className="hello-terminal-folder" title={`Launch folder: ${session.cwd}`}>
            <span>Launch folder:</span>
            <Truncated>{folderName(session.cwd)}</Truncated>
          </span>
          {!exited && (
            <span className="hello-terminal-tasks" title={session.notebookContext === true
              ? 'Connected to this chat in Hello: its notebook (the Runbooks, Tasks and Plans sections and chapters that are on; Runbooks read-only, Tasks and Plans read and status updates) and its browser tabs, each as far as its Agent control allows.'
              : 'Open a new CLI from Hello to connect it to this chat’s notebook and browser.'}>
              {session.notebookContext === true ? 'Hello connected' : 'Not connected to Hello'}
            </span>
          )}
          {folderChanged && (
            <div className="hello-terminal-folder-change">
              <span className="hello-terminal-folder-explanation">
                {currentFolder ? (
                  <>Chat folder: <span title={currentFolder}>{folderName(currentFolder)}</span>.</>
                ) : "No folder selected for this chat."}{" "}
                This CLI keeps its launch folder.
              </span>
              {currentFolder && session.workerId && onOpenInCurrentFolder && (
                <button
                  type="button"
                  className="pill hello-terminal-open-folder"
                  title={`Open a new ${session.title} CLI in ${currentFolder}. This session stays open.`}
                  onClick={onOpenInCurrentFolder}
                >
                  <Truncated>{`Open in ${folderName(currentFolder)}`}</Truncated>
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {(failure || copyFailure || dropFailure) && (
        <p className="hello-terminal-notice" role="status">
          {failure || copyFailure || dropFailure}
        </p>
      )}
      {dropActive && <p className="hello-terminal-drop" role="status">{exited ? 'This terminal has exited' : 'Drop files to insert their paths'}</p>}
      {finding && (
        <div className="hello-terminal-find" role="search" aria-label="Find in terminal">
          <input
            ref={findField}
            aria-label="Find in terminal"
            placeholder="Find"
            value={query}
            spellCheck={false}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              // Enter goes up to older output, Shift+Enter back down; Escape returns to the shell.
              if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); step(event.shiftKey ? 1 : -1); }
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeFind(); }
            }}
          />
          <span className="hello-terminal-find-count" role="status">
            {alternate ? "Search is available in terminal scrollback"
              : !query.trim() ? "" : found.total ? `${found.index + 1} of ${found.total}` : "No results"}
          </span>
          <button type="button" aria-label="Older match" title="Older match (Enter)" disabled={!found.total} onClick={() => step(-1)}>
            <ChevronUp size={14} />
          </button>
          <button type="button" aria-label="Newer match" title="Newer match (Shift+Enter)" disabled={!found.total} onClick={() => step(1)}>
            <ChevronDown size={14} />
          </button>
          <button type="button" aria-label="Close find" title="Close find (Esc)" onClick={closeFind}>
            <X size={14} />
          </button>
        </div>
      )}
      <div className="hello-terminal-surface" ref={setHost} />
    </section>
  );
}
