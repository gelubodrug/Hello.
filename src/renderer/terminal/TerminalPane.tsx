import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { TerminalSession } from "../../shared/types";
import { api as appAPI } from "../api";
import { droppedPaths, hasFileDrop, quoteTerminalPaths } from "../drop";
import { Truncated } from "../ui/primitives";
import { terminalKeyVerdict } from "./keys";
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
}: {
  session: TerminalSession;
  visible: boolean;
  /** Which pane holds it: Tools, or the chat pane as a chat tab. */
  placement?: "tools" | "chat";
  currentFolder?: string | null;
  onOpenInCurrentFolder?: () => void;
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
  const mounted = useRef<{ terminal: Terminal; fit: FitAddon } | null>(null);
  const folderChanged = currentFolder !== undefined && currentFolder !== session.cwd;

  useEffect(() => {
    if (!visible) { dropDepth.current = 0; setDropActive(false); }
  }, [visible]);

  // Moved between panes, it is the same terminal in a new place: fitted
  // there, and given the keys back that the move took away.
  useEffect(() => {
    if (!visible || !host || !mounted.current) return;
    if (host.clientWidth > 0 && host.clientHeight > 0)
      mounted.current.fit.fit();
    mounted.current.terminal.focus();
  }, [visible, host, placement]);

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
      if (active.current) xterm.focus();
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
              : session.workerId === 'aider'
                ? 'This Aider version does not support the Hello connection.'
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
      <div className="hello-terminal-surface" ref={setHost} />
    </section>
  );
}
