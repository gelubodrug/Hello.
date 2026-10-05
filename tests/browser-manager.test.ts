import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, HandlerDetails, WindowOpenHandlerResponse } from "electron";
import type { BrowserDownload, BrowserTab } from "../src/shared/types";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const native = vi.hoisted(() => ({
  views: [] as unknown[],
  guests: [] as unknown[],
  /** The window's own page: a guest must name it as its host. */
  host: null as unknown,
  makeGuest: null as unknown as (session: unknown) => unknown,
  partition: null as unknown,
  partitions: new Map<string, unknown>(),
  nextLoad: undefined as Promise<void> | undefined,
  /** Enough of a NativeImage for a capture: its size, a crop, a resize, bytes. */
  picture(width: number, height: number): unknown {
    return {
      width, height,
      isEmpty: () => width === 0,
      getSize: () => ({ width, height }),
      crop: (box: { width: number; height: number }) => native.picture(box.width, box.height),
      resize: ({ width: w }: { width: number }) => native.picture(w, Math.round(height * w / width)),
      toPNG: () => Buffer.from(`png ${width}x${height}`),
      toJPEG: () => Buffer.from(`jpeg ${width}x${height}`),
    };
  },
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const makePartition = () => Object.assign(new EventEmitter(), {
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    clearStorageData: vi.fn().mockResolvedValue(undefined),
    clearCache: vi.fn().mockResolvedValue(undefined),
  });
  const partition = makePartition();
  native.partition = partition;
  class Contents extends EventEmitter {
    constructor(readonly session: unknown = native.partition) { super(); }
    destroyed = false;
    loading = false;
    url = "about:blank";
    title = "Page";
    navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: vi.fn(),
      goForward: vi.fn(),
    };
    mainFrame = {
      executeJavaScript: vi
        .fn<(code: string) => Promise<unknown>>()
        .mockResolvedValue({ text: "Page text", lines: [], count: 0 }),
      isDestroyed: () => this.destroyed,
      frames: [] as unknown[],
      name: "",
      url: "https://example.com/",
    };
    executeJavaScript = vi.fn();
    zoom = 1;
    viewport: unknown = { w: 800, h: 600 };
    /** Real input main sent this page, in order. */
    sendInputEvent = vi.fn();
    getZoomFactor = () => this.zoom;
    executeJavaScriptInIsolatedWorld = vi.fn(async () => this.viewport);
    capturePage = vi.fn(async () => native.picture(1600, 1200));
    /** A download main asked this page for, with the page's own session. */
    downloadURL = vi.fn();
    setWindowOpenHandler = vi.fn();
    isDestroyed = () => this.destroyed;
    /** Frames still loading after the page itself has (an ad's). */
    framesLoading = false;
    isLoading = () => this.loading || this.framesLoading;
    isLoadingMainFrame = () => this.loading;
    getURL = () => this.url;
    getTitle = () => this.title;
    loadURL = vi.fn(async (url: string) => {
      this.url = url;
      const pending = native.nextLoad;
      native.nextLoad = undefined;
      await pending;
    });
    stop = vi.fn(() => {
      this.loading = false;
    });
    reload = vi.fn();
    close = vi.fn(() => {
      this.destroyed = true;
      this.emit("destroyed");
    });
    /** A guest of the app window, which is what the manager will adopt. */
    getType = () => "webview";
    hostWebContents: unknown = native.host;
  }
  native.makeGuest = (session: unknown) => new Contents(session);
  class View {
    webContents: Contents;
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    setBackgroundColor = vi.fn();
    setBorderRadius = vi.fn();
    setVisible = vi.fn();
    setBounds = vi.fn((bounds: typeof this.bounds) => { this.bounds = bounds; });
    getBounds = () => this.bounds;
    constructor(readonly options: { webContents?: Contents; webPreferences?: { session?: unknown } }) {
      this.webContents = options.webContents ?? new Contents(options.webPreferences?.session ?? native.partition);
      native.views.push(this);
    }
  }
  return {
    BrowserWindow: class {},
    WebContentsView: View,
    session: { fromPartition: (name: string) => {
      if (name === 'persist:hello-web') return partition;
      if (!native.partitions.has(name)) native.partitions.set(name, makePartition());
      return native.partitions.get(name);
    } },
  };
});

import {
  BrowserManager,
  BROWSER_ATTACH_TIMEOUT_MS,
  BROWSER_OPERATION_TIMEOUT_MS,
  safeFileName,
} from "../src/main/browser/manager";
import { DOWNLOAD_FINISH_MS, DOWNLOAD_START_MS } from "../src/main/browser/agent-input";
import { createDataStore, type SecretCodec } from "../src/main/data/store";
import { EventEmitter as Emitter } from "node:events";

/** Test-only codec; production injects Electron safeStorage. */
const codec: SecretCodec = {
  encrypt: (value) => Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 0xa5)),
  decrypt: (value) => Buffer.from([...value].map((byte) => byte ^ 0xa5)).toString(),
};

type FakeGuest = EventEmitter & {
  session: unknown;
  hostWebContents: unknown;
  destroyed: boolean;
  loading: boolean;
  framesLoading: boolean;
  url: string;
  mainFrame: {
    executeJavaScript: ReturnType<typeof vi.fn<(code: string) => Promise<unknown>>>;
    isDestroyed(): boolean;
    frames: unknown[];
    name: string;
    url: string;
  };
  executeJavaScript: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;
  stop: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  zoom: number;
  viewport: unknown;
  sendInputEvent: ReturnType<typeof vi.fn>;
  executeJavaScriptInIsolatedWorld: ReturnType<typeof vi.fn>;
  capturePage: ReturnType<typeof vi.fn>;
  downloadURL: ReturnType<typeof vi.fn>;
};
type FakePartition = EventEmitter & {
  setPermissionCheckHandler: ReturnType<typeof vi.fn>;
  setPermissionRequestHandler: ReturnType<typeof vi.fn>;
  clearStorageData: ReturnType<typeof vi.fn>;
  clearCache: ReturnType<typeof vi.fn>;
};
const services: BrowserManager[] = [];
const guestAt = (index = 0) => native.guests[index] as FakeGuest;
/**
 * Exactly the preferences this manager writes for a page of its own: the same
 * set is pinned on a <webview> guest at attach and on a popup's child window.
 */
const pinnedPreferences = (partition: string, session: unknown) => ({
  partition,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webviewTag: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  backgroundThrottling: true,
  plugins: true,
  session,
});
/** Let the manager's own awaits (mounting a page, then calling into it) run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(options: BrowserTab[] | { initial?: BrowserTab[]; serve?: (conversationId: string, source: string) => Promise<string>; folder?: string; downloadsFolder?: string; initialDownloads?: BrowserDownload[]; persist?: { save(tab: BrowserTab): void; remove(id: string): void; exists(id: string): boolean } } = []) {
  const { initial = [], serve, folder, downloadsFolder, initialDownloads, persist } = Array.isArray(options) ? { initial: options } : options;
  const window = {
    webContents: new Emitter(),
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 1000, height: 800 }),
  };
  native.host = window.webContents;
  // With `persist`, the hooks reach the real store: what comes back is then what
  // a database kept, not what the manager handed the hook.
  const save = vi.fn<(tab: BrowserTab) => void>(tab => persist?.save(tab));
  const remove = vi.fn<(id: string) => void>(id => persist?.remove(id));
  const emit = vi.fn();
  const lifecycle = vi.fn();
  const saveDownload = vi.fn();
  const removeDownload = vi.fn();
  const downloadEvent = vi.fn();
  const contextMenu = vi.fn();
  const manager = new BrowserManager({
    window: window as unknown as BrowserWindow,
    initial,
    conversationExists: persist ? (id) => persist.exists(id) : (id) => ["chat", "other"].includes(id),
    ...(folder ? { folderFor: () => folder } : {}),
    ...(downloadsFolder ? { downloadsFolder: () => downloadsFolder } : {}),
    ...(initialDownloads ? { initialDownloads } : {}),
    saveDownload,
    removeDownload,
    downloadEvent,
    save,
    remove,
    emit,
    lifecycle,
    contextMenu,
    ...(serve ? { serve } : {}),
  });
  services.push(manager);
  /**
   * The window creating one page for one tab, the way Electron does: it asks
   * for a nonce, the attach handler rewrites the guest's preferences, and the
   * guest that appears is adopted.
   */
  const attach = (tabId: string) => {
    const source = manager.mintAttach(tabId);
    const preferences: Record<string, unknown> = { preload: "/evil.js", nodeIntegration: true };
    const params: Record<string, string> = { src: source, preload: "file:///evil.js" };
    if (!manager.approveGuestAttach(preferences as never, params as never))
      throw new Error("The window was refused a guest for this tab.");
    const guest = native.makeGuest(preferences.session) as { hostWebContents: unknown };
    guest.hostWebContents = window.webContents;
    native.guests.push(guest);
    manager.adoptGuest(guest as never);
    return { guest: guest as unknown as FakeGuest, preferences, params };
  };
  const open = (conversationId = "chat") => {
    const tab = manager.create(conversationId, "https://example.com");
    attach(tab.id);
    manager.setActive(tab.id);
    return tab;
  };
  return { manager, window, save, remove, emit, lifecycle, saveDownload, removeDownload, downloadEvent, contextMenu, open, attach };
}
beforeEach(() => {
  native.views.length = 0;
  native.guests.length = 0;
  native.nextLoad = undefined;
  native.partitions.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  for (const manager of services.splice(0)) manager.dispose();
  vi.useRealTimers();
});

// User, 05.10: a right-click on a page showed nothing, not even Copy.
describe("a right-click on a page", () => {
  it("hands main the page and what was under the pointer, and nothing once the page is gone", () => {
    const f = fixture();
    f.open();
    const guest = guestAt(0);
    const params = { selectionText: "Google LLC", isEditable: false, linkURL: "", mediaType: "none", srcURL: "" };
    guest.emit("context-menu", {}, params);
    expect(f.contextMenu).toHaveBeenCalledWith(guest, params);
    f.manager.dispose();
    guest.emit("context-menu", {}, params);
    expect(f.contextMenu).toHaveBeenCalledTimes(1);
  });
});

describe("native browser lifecycle and grants", () => {
  it("creates isolated lazy pages without exposing preload or Node to remote content", () => {
    const f = fixture();
    const tab = f.manager.create("chat");
    f.manager.setActive(tab.id);
    // A tab is only a record until the window mounts a <webview> for it.
    expect(native.guests).toHaveLength(0);
    const { preferences } = f.attach(tab.id);
    expect(preferences).toEqual(pinnedPreferences("persist:hello-web", native.partition));
    expect(preferences).not.toHaveProperty("preload");
    // The manager owns no native view of its own any more.
    expect(native.views).toHaveLength(0);
    const partition = native.partition as FakePartition;
    expect(partition.setPermissionCheckHandler.mock.calls.at(-1)?.[0]()).toBe(
      false,
    );
    const callback = vi.fn();
    partition.setPermissionRequestHandler.mock.calls.at(-1)?.[0](
      {},
      "camera",
      callback,
    );
    expect(callback).toHaveBeenCalledWith(false);
  });

  // A video's full-screen button did nothing: the session refused the
  // `fullscreen` permission with everything else (user, 26.09).
  it("lets the page on screen fill the screen, and refuses it to a tab out of sight, a stranger and every other permission", () => {
    const f = fixture();
    const shown = f.open();
    const hidden = f.manager.create("chat", "https://example.org");
    f.attach(hidden.id);
    f.manager.setActive(shown.id);
    const partition = native.partition as FakePartition;
    const ask = (contents: unknown, permission: string) => {
      const callback = vi.fn();
      partition.setPermissionRequestHandler.mock.calls.at(-1)?.[0](contents, permission, callback);
      return callback.mock.calls[0]?.[0];
    };
    const check = partition.setPermissionCheckHandler.mock.calls.at(-1)?.[0] as (contents: unknown, permission: string) => boolean;
    expect(ask(guestAt(0), "fullscreen")).toBe(true);
    expect(check(guestAt(0), "fullscreen")).toBe(true);
    expect(ask(guestAt(1), "fullscreen")).toBe(false);
    expect(ask({ id: "stranger" }, "fullscreen")).toBe(false);
    for (const permission of ["camera", "media", "notifications", "geolocation", "pointerLock", "clipboard-read"])
      expect(ask(guestAt(0), permission)).toBe(false);
    // The tab on screen changes: so does who may.
    f.manager.setActive(hidden.id);
    expect(ask(guestAt(0), "fullscreen")).toBe(false);
    expect(ask(guestAt(1), "fullscreen")).toBe(true);
    f.manager.setActive(null);
    expect(ask(guestAt(1), "fullscreen")).toBe(false);
  });

  it("refuses a guest whose attach nonce is unknown or already spent", () => {
    const f = fixture();
    const tab = f.manager.create("chat");
    const source = f.manager.mintAttach(tab.id);
    const preferences: Record<string, unknown> = {};
    expect(f.manager.approveGuestAttach(preferences as never, { src: source } as never)).toBe(true);
    const guest = native.makeGuest(preferences.session) as FakeGuest;
    guest.hostWebContents = f.window.webContents;
    f.manager.adoptGuest(guest as never);
    for (const src of [
      source, // The window already spent this one.
      "hello://attach/2f1c8f6a-0000-4000-8000-1c8f6a2f1c8f",
      "https://example.com",
      "",
    ])
      expect(f.manager.approveGuestAttach({} as never, { src } as never)).toBe(false);
    // A refused request leaves nothing for a guest to be bound to.
    const stray = native.makeGuest(native.partition) as FakeGuest;
    stray.hostWebContents = f.window.webContents;
    f.manager.adoptGuest(stray as never);
    expect(stray.close).toHaveBeenCalledOnce();
    expect(stray.setWindowOpenHandler).not.toHaveBeenCalled();
    expect(guest.close).not.toHaveBeenCalled();
  });

  it("pins its own preferences over a renderer-supplied preload, Node integration and partition", () => {
    const f = fixture();
    const tab = f.manager.create("chat");
    const preferences: Record<string, unknown> = {
      preload: "/evil.js",
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      webviewTag: true,
      partition: "persist:evil",
    };
    const params: Record<string, string> = {
      src: f.manager.mintAttach(tab.id),
      preload: "file:///evil.js",
      nodeintegration: "on",
      nodeintegrationinsubframes: "on",
      webpreferences: "nodeIntegration=yes,contextIsolation=no",
      disablewebsecurity: "on",
      partition: "persist:evil",
    };
    expect(f.manager.approveGuestAttach(preferences as never, params as never)).toBe(true);
    expect(preferences).toEqual(pinnedPreferences("persist:hello-web", native.partition));
    for (const key of ["preload", "nodeintegration", "nodeintegrationinsubframes", "webpreferences", "disablewebsecurity"])
      expect(params).not.toHaveProperty(key);
    expect(params.partition).toBe("persist:hello-web");
    // window.open must reach this manager's handler rather than being swallowed.
    expect(params.allowpopups).toBe("true");
  });

  it("closes a guest the app window does not host and binds nothing to the tab", () => {
    const f = fixture();
    const tab = f.manager.create("chat", "https://example.com");
    const preferences: Record<string, unknown> = {};
    expect(
      f.manager.approveGuestAttach(preferences as never, { src: f.manager.mintAttach(tab.id) } as never),
    ).toBe(true);
    const foreign = native.makeGuest(preferences.session) as FakeGuest;
    foreign.hostWebContents = new Emitter();
    f.manager.adoptGuest(foreign as never);
    expect(foreign.close).toHaveBeenCalledOnce();
    expect(foreign.setWindowOpenHandler).not.toHaveBeenCalled();
    expect(foreign.loadURL).not.toHaveBeenCalled();
    expect(() => f.manager.action(tab.id, "back")).toThrow(/not open in the app window/);
  });

  // A new tab starts Off; the grant the human sets on a page is saved with it
  // and comes back with it between sessions (user, 22.09). A generated
  // document is the exception: its Full is granted again when it is served
  // again, never restored blind.
  it("starts a new tab Off, keeps a restored page's grant, and validates restored URLs", () => {
    const saved: BrowserTab[] = [
      { id: "old", conversationId: "chat", title: "Old", url: "file:///etc/passwd",
        control: "full", loading: true, progress: null, canGoBack: true, canGoForward: true },
      { id: "billing", conversationId: "chat", title: "Billing", url: "https://platform.example/billing",
        control: "full", loading: false, progress: null, canGoBack: false, canGoForward: false },
      { id: "doc", conversationId: "chat", title: "Doc", url: "about:blank", source: "artifact:00000000-0000-4000-8000-000000000001",
        control: "full", loading: false, progress: null, canGoBack: false, canGoForward: false },
    ];
    const f = fixture(saved);
    // A non-web URL is never restored; the grant on it is moot and dropped with it.
    expect(f.manager.list().find(tab => tab.id === "old")).toMatchObject({
      url: "about:blank", control: "full", loading: false, progress: null, canGoBack: false,
    });
    expect(f.manager.list().find(tab => tab.id === "billing")?.control).toBe("full");
    expect(f.manager.list().find(tab => tab.id === "doc")?.control).toBe("off");
    const tab = f.open();
    expect(tab.control).toBe("off");
    f.manager.control(tab.id, "full");
    expect(f.manager.list("chat").find((item) => item.id === tab.id)?.control).toBe("full");
    // Saved WITH the grant, so the next session opens where this one left off.
    expect(f.save.mock.calls.at(-1)?.[0]).toMatchObject({ id: tab.id, control: "full" });
    expect(f.emit.mock.calls.at(-1)?.[0].control).toBe("full");
  });

  it("keeps every tab's page alive across an app shell reload and reports none as visible", () => {
    const f = fixture();
    const first = f.open();
    const second = f.open("other");
    expect(f.manager.listForAgent("other")[0]).toMatchObject({ id: second.id, visible: true });
    expect(f.manager.listForAgent("chat")[0]).toMatchObject({ id: first.id, visible: false });
    f.window.webContents.emit("did-start-loading");
    expect(f.manager.listForAgent("other")[0].visible).toBe(false);
    expect(guestAt(0).close).not.toHaveBeenCalled();
    expect(guestAt(1).close).not.toHaveBeenCalled();
    expect(f.manager.list().map((tab) => tab.id)).toEqual([first.id, second.id]);
  });

  it("blocks non-web navigations, non-web popups, redirects and downloads", () => {
    const f = fixture();
    f.open();
    for (const name of ["will-navigate", "will-redirect"]) {
      const event = { preventDefault: vi.fn() };
      guestAt().emit(name, event, "javascript:alert(1)");
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    const handler = guestAt().setWindowOpenHandler.mock.calls[0][0];
    expect(handler({ url: "file:///private/file" })).toEqual({
      action: "deny",
    });
    const event = { preventDefault: vi.fn() };
    (native.partition as EventEmitter).emit("will-download", event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("refuses a page's attempt to move the app window or to nest another webview", () => {
    const f = fixture();
    f.open();
    for (const name of ["content-bounds-updated", "will-attach-webview"]) {
      const event = { preventDefault: vi.fn() };
      guestAt().emit(name, event, { x: 0, y: 0, width: 50, height: 50 });
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
  });

  function popup(guest: FakeGuest, patch: Partial<HandlerDetails> = {}) {
    const details: HandlerDetails = {
      url: "https://identity.example/signin",
      frameName: "signin",
      features: "popup,width=600,height=700",
      disposition: "new-window",
      referrer: { url: "https://example.com/", policy: "strict-origin-when-cross-origin" },
      ...patch,
    };
    const handler = guest.setWindowOpenHandler.mock.calls[0][0];
    return { details, response: handler(details) as WindowOpenHandlerResponse };
  }

  // A page that opens a window gets a tab beside the one it came from, never a
  // window outside the app: an invoice's "View" opened a native window the
  // human had to hunt for and the agent could not see at all (user, 22.09).
  it("opens a popup as a tab beside its opener, with the opener's grant, and never a window", () => {
    const f = fixture();
    const parent = f.open();
    f.manager.control(parent.id, "full");
    const { details, response } = popup(guestAt());
    // No native window, whatever Chromium was asked for.
    expect(response).toEqual({ action: "deny" });
    expect(native.guests).toHaveLength(1);
    const [, opened] = f.manager.list("chat");
    expect(opened).toMatchObject({
      url: details.url,
      openerId: parent.id,
      pageOwned: true,
      // The human granted the opener; the popup is that page carrying on.
      control: "full",
    });
    expect(f.lifecycle).toHaveBeenCalledWith(expect.objectContaining({
      type: "opened", foreground: true, tab: expect.objectContaining({ id: opened.id }),
    }));
    // Site-opened tabs are live for this session only, never restored.
    expect(f.save).not.toHaveBeenCalledWith(expect.objectContaining({ id: opened.id }));
  });

  it("denies a non-web or blank popup, and keeps a background-tab popup in the background", () => {
    const f = fixture();
    const parent = f.open();
    for (const url of ["file:///private/file", "javascript:alert(1)", "https://user:secret@example.com", "about:blank"])
      expect(popup(guestAt(), { url }).response).toEqual({ action: "deny" });
    expect(f.manager.list("chat").map((tab) => tab.id)).toEqual([parent.id]);
    expect(f.lifecycle).not.toHaveBeenCalled();
    const { response } = popup(guestAt(), {
      disposition: "background-tab", features: "", frameName: "_blank",
      url: "https://example.com/result",
    });
    expect(response).toEqual({ action: "deny" });
    expect(f.manager.list("chat")).toHaveLength(2);
    expect(f.lifecycle).toHaveBeenCalledWith(expect.objectContaining({ type: "opened", foreground: false }));
    // An Off opener opens an Off tab: nothing is granted that was not.
    expect(f.manager.list("chat")[1].control).toBe("off");
  });

  it("keeps a tab whose page the window unmounts, and lets the window mount it again", () => {
    const f = fixture();
    const tab = f.open();
    f.manager.detach(tab.id);
    expect(guestAt(0).close).toHaveBeenCalledOnce();
    expect(f.manager.list("chat").map((item) => item.id)).toEqual([tab.id]);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.lifecycle).not.toHaveBeenCalled();
    expect(() => f.manager.action(tab.id, "back")).toThrow(/not open in the app window/);
    // An unmount is not a discard: the window may mount this tab again.
    const { guest } = f.attach(tab.id);
    expect(guest.loadURL).toHaveBeenCalledWith(tab.url);
  });

  it("Reload asks the window for a new page and starts only one navigation", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "full");
    const controller = new AbortController();
    guestAt().mainFrame.executeJavaScript.mockReturnValueOnce(new Promise(() => {}));
    const action = f.manager.agentAction("chat", tab.id, "click", { selector: "#link" }, "", controller.signal);
    const rejected = expect(action).rejects.toThrow(/stopped/);
    await flush();
    controller.abort();
    await rejected;
    expect(guestAt(0).close).toHaveBeenCalledOnce();
    const reloading = f.manager.action(tab.id, "reload") as Promise<void>;
    const { guest } = f.attach(tab.id);
    await reloading;
    expect(guest.loadURL).toHaveBeenCalledTimes(1);
    expect(guest.loadURL).toHaveBeenCalledWith(tab.url);
    expect(f.manager.list()[0].error).toBeNull();
  });

  it("checks ownership and each tab grant before executing anything", async () => {
    const f = fixture();
    const tab = f.open();
    await expect(f.manager.read(tab.id, "chat")).rejects.toThrow(/Off/);
    f.manager.control(tab.id, "read");
    for (const action of ["click", "type", "scroll"] as const) {
      await expect(
        f.manager.agentAction("chat", tab.id, action, { selector: "#save" }),
      ).rejects.toThrow(/read only/);
    }
    await expect(f.manager.read(tab.id, "other")).rejects.toThrow(
      /different chat/,
    );
    expect(guestAt().mainFrame.executeJavaScript).not.toHaveBeenCalled();
    await expect(f.manager.read(tab.id, "chat")).resolves.toMatchObject({
      text: expect.stringContaining("Page text"),
    });
  });

  it.each(["off", "read", "full"] as const)(
    "navigates an owned %s tab without elevating its page access or reading its DOM",
    async (control) => {
      const f = fixture();
      const tab = f.open();
      f.manager.control(tab.id, control);
      await f.manager.agentNavigate("chat", tab.id, "http://127.0.0.1:5173/preview");
      expect(f.manager.list("chat")[0]).toMatchObject({
        id: tab.id, control, url: "http://127.0.0.1:5173/preview",
      });
      expect(guestAt().loadURL).toHaveBeenLastCalledWith(
        "http://127.0.0.1:5173/preview",
      );
      expect(guestAt().mainFrame.executeJavaScript).not.toHaveBeenCalled();
      if (control === "off") {
        await expect(f.manager.read(tab.id, "chat")).rejects.toThrow(/Off/);
      }
    },
  );

  it("rejects cross-chat and non-web agent navigation before loading anything", async () => {
    const f = fixture();
    const tab = f.open();
    const load = guestAt().loadURL;
    load.mockClear();
    await expect(f.manager.agentNavigate("other", tab.id, "https://example.com/next"))
      .rejects.toThrow(/different chat/);
    for (const url of ["file:///tmp/preview.html", "javascript:alert(1)", "about:blank", "https://user:secret@example.com"]) {
      await expect(f.manager.agentNavigate("chat", tab.id, url)).rejects.toThrow();
    }
    expect(load).not.toHaveBeenCalled();
    expect(f.manager.list("chat")[0]).toMatchObject({ control: "off", url: tab.url });
  });

  it("opens a requested page in a new foreground Off tab when the chat has no tabs", async () => {
    const f = fixture();
    const opening = f.manager.agentOpen("chat", "http://localhost:5173/preview");
    const { guest } = f.attach(f.manager.list("chat")[0].id);
    const opened = await opening;
    expect(f.manager.list("chat")).toEqual([opened]);
    expect(opened).toMatchObject({
      conversationId: "chat", control: "off", url: "http://localhost:5173/preview",
    });
    expect(f.lifecycle).toHaveBeenCalledWith(expect.objectContaining({
      type: "opened", foreground: true, userRequested: true,
      tab: expect.objectContaining({ id: opened.id, conversationId: "chat", control: "off" }),
    }));
    expect(guest.loadURL).toHaveBeenLastCalledWith("http://localhost:5173/preview");
    expect(guest.mainFrame.executeJavaScript).not.toHaveBeenCalled();
    await expect(f.manager.read(opened.id, "chat")).rejects.toThrow(/Off/);
  });

  // The model does not open a page just to have it open; it opens it to read
  // it and act in it (user, 29.09: "fă-l AI mode Full … read-write").
  it("starts a tab the model opens for its work at Full, readable at once", async () => {
    const f = fixture();
    const opening = f.manager.agentOpen("chat", "https://example.com/work", undefined, { grant: true });
    f.attach(f.manager.list("chat")[0].id);
    const opened = await opening;
    expect(opened).toMatchObject({ control: "full", agentGranted: true });
    expect(f.lifecycle).toHaveBeenCalledWith(expect.objectContaining({ type: "opened", tab: expect.objectContaining({ control: "full" }) }));
    // The human changing the control makes it theirs.
    expect(f.manager.control(opened.id, "read")).toMatchObject({ control: "read", agentGranted: undefined });
  });

  it("keeps a preview the model opened at Full through an anchor and as it navigates, like any tab it opened", async () => {
    const f = fixture();
    const opening = f.manager.agentOpen("chat", "http://127.0.0.1:4321/token/report.html", undefined,
      { sessionOnly: true, isolated: true, source: "docs/report.html", grant: true });
    const id = f.manager.list("chat")[0].id;
    f.attach(id);
    expect(await opening).toMatchObject({ control: "full", source: "docs/report.html" });
    await f.manager.navigate(id, "http://127.0.0.1:4321/token/report.html#part-2");
    expect(f.manager.list("chat")[0]).toMatchObject({ control: "full", source: "docs/report.html" });
    await f.manager.navigate(id, "http://127.0.0.1:4321/token/other.html");
    expect(f.manager.list("chat")[0].control).toBe("full");
    await f.manager.navigate(id, "https://example.com/away");
    expect(f.manager.list("chat")[0].control).toBe("full");
  });

  it("keeps the model's Full out of the database, so a restart brings that tab back Off", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hello-browser-grant-"));
    const store = createDataStore(directory, codec);
    try {
      const chat = store.createConversation("Chat").id;
      const persist = { save: (tab: BrowserTab) => store.saveBrowserTab(tab), remove: (id: string) => store.deleteBrowserTab(id), exists: (id: string) => id === chat };
      const first = fixture({ persist });
      const opening = first.manager.agentOpen(chat, "https://example.com/work", undefined, { grant: true });
      const modelTab = first.manager.list(chat)[0].id;
      first.attach(modelTab);
      await opening;
      const human = first.manager.create(chat, "https://example.com/mine");
      first.attach(human.id);
      first.manager.control(human.id, "full");
      expect(first.manager.list(chat).find(tab => tab.id === modelTab)?.control).toBe("full");
      const rows = store.listBrowserTabs();
      expect(rows.find(row => row.id === modelTab)?.control).toBe("off");
      expect(rows.find(row => row.id === human.id)?.control).toBe("full");
      const next = fixture({ initial: rows, persist });
      expect(next.manager.list(chat).find(tab => tab.id === modelTab)?.control).toBe("off");
      expect(next.manager.list(chat).find(tab => tab.id === human.id)?.control).toBe("full");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("opens a new Off tab without changing an existing tab's URL or grant", async () => {
    const f = fixture();
    const existing = f.open();
    f.manager.control(existing.id, "read");
    const opening = f.manager.agentOpen("chat", "https://example.com/next");
    f.attach(f.manager.list("chat").find((tab) => tab.id !== existing.id)!.id);
    const opened = await opening;
    expect(opened.id).not.toBe(existing.id);
    expect(opened.control).toBe("off");
    expect(f.manager.list("chat").find(tab => tab.id === existing.id)).toMatchObject({
      url: existing.url, control: "read",
    });
  });

  it("replaces the document a chat is showing instead of opening a tab per revision", async () => {
    const f = fixture();
    const base = f.open();
    const first = f.manager.agentShow('chat', 'http://127.0.0.1:4321/v1/index.html');
    const shown = f.manager.list('chat').find(tab => tab.id !== base.id)!.id;
    f.attach(shown);
    const one = await first;
    const before = f.manager.list('chat').length;
    const second = f.manager.agentShow('chat', 'http://127.0.0.1:4321/v2/index.html');
    const two = await second;
    // The same tab, now on the newer document; no second tab was made.
    expect(two.id).toBe(one.id);
    expect(two.url).toBe('http://127.0.0.1:4321/v2/index.html');
    expect(f.manager.list('chat')).toHaveLength(before);
    // Another chat's document is its own; it never lands in this one's slot.
    const other = f.manager.agentShow('other', 'http://127.0.0.1:4321/v3/index.html');
    f.attach(f.manager.list('other')[0].id);
    expect((await other).id).not.toBe(one.id);
  });

  it("never lets the address it minted for a guest become the page's address", async () => {
    const f = fixture();
    const tab = f.open();
    const { guest } = f.attach(tab.id);
    // The guest reports the door main opened for it; that is main's handshake,
    // not somewhere the reader went.
    const minted = f.manager.mintAttach(tab.id);
    (guest as unknown as { url: string; title: string }).url = minted;
    (guest as unknown as { url: string; title: string }).title = minted;
    (guest as unknown as { emit(name: string): void }).emit('did-navigate');
    const shown = f.manager.list('chat')[0];
    expect(shown.url).toBe('about:blank');
    expect(shown.url).not.toContain('hello-attach');
    expect(shown.title).not.toContain('hello-attach');
  });

  it("brings a local preview back from its path, without the grant its own work gets", async () => {
    const f = fixture();
    const base = f.open();
    const opening = f.manager.agentOpen('chat', 'http://127.0.0.1:4321/report.html', undefined,
      { sessionOnly: true, isolated: true, source: 'docs/report.html' });
    const id = f.manager.list('chat').find(tab => tab.id !== base.id)!.id;
    f.attach(id);
    const shown = await opening;
    // The person's own file: saved by its path, and still Off. Reading it is a
    // grant only they can give, whatever produced the address it sits at.
    expect(shown).toMatchObject({ source: 'docs/report.html', control: 'off' });
    const saved = f.save.mock.calls.map(([tab]) => tab).filter(tab => tab.id === id).at(-1)!;
    expect(saved).toMatchObject({ source: 'docs/report.html', url: 'about:blank' });

    const served = vi.fn(async () => 'http://127.0.0.1:6001/report.html');
    const next = fixture({ initial: [saved], serve: served });
    next.attach(id);
    next.manager.setActive(id);
    await vi.waitFor(() => expect(served).toHaveBeenCalledWith('chat', 'docs/report.html'));
    await vi.waitFor(() => expect(next.manager.list('chat')[0]).toMatchObject({
      url: 'http://127.0.0.1:6001/report.html', control: 'off',
    }));
  });

  it("lets the model look at its own document, and takes that back the moment the tab moves", async () => {
    const f = fixture();
    const base = f.open();
    const opening = f.manager.agentShow('chat', 'http://127.0.0.1:4321/v1/index.html', undefined, 'artifact:art-1');
    const id = f.manager.list('chat').find(tab => tab.id !== base.id)!.id;
    f.attach(id);
    // Its own work, in an isolated session, written by itself: it may read it.
    expect((await opening).control).toBe('full');
    // A second version of its own work keeps the grant.
    const again = f.manager.agentShow('chat', 'http://127.0.0.1:4321/v2/index.html', undefined, 'artifact:art-2');
    expect((await again).control).toBe('full');
    // Anywhere else is somebody else's page, and the grant does not travel.
    await f.manager.navigate(id, 'https://example.com/real');
    const moved = f.manager.list('chat').find(tab => tab.id === id)!;
    expect(moved.control).toBe('off');
    expect(moved.source).toBeUndefined();
  });

  it("ends the grant when the generated page sends itself somewhere else", async () => {
    const f = fixture();
    const base = f.open();
    const opening = f.manager.agentShow('chat', 'http://127.0.0.1:4321/v1/index.html', undefined, 'artifact:art-1');
    const id = f.manager.list('chat').find(tab => tab.id !== base.id)!.id;
    const { guest } = f.attach(id);
    await opening;
    const page = guest as unknown as { url: string; emit(name: string): void };
    page.url = 'https://elsewhere.example/';
    page.emit('did-navigate');
    expect(f.manager.list('chat').find(tab => tab.id === id)!.control).toBe('off');
  });

  it("keeps a generated document across a restart, and serves it again when opened", async () => {
    const f = fixture();
    const base = f.open();
    const first = f.manager.agentShow('chat', 'http://127.0.0.1:4321/v1/index.html', undefined, 'artifact:art-1');
    f.attach(f.manager.list('chat').find(tab => tab.id !== base.id)!.id);
    const shown = await first;
    expect(shown.source).toBe('artifact:art-1');
    // Saved by the handle that can produce it again, never by a dead local port.
    const saved = f.save.mock.calls.map(([tab]) => tab).filter(tab => tab.id === shown.id).at(-1)!;
    expect(saved).toMatchObject({ source: 'artifact:art-1', url: 'about:blank' });

    // A new run, restoring what was saved.
    const served = vi.fn(async () => 'http://127.0.0.1:5555/v1/index.html');
    const next = fixture({ initial: [saved], serve: served });
    const restored = next.manager.list('chat').find(tab => tab.id === shown.id)!;
    expect(restored.url).toBe('about:blank');
    next.attach(restored.id);
    next.manager.setActive(restored.id);
    await vi.waitFor(() => expect(served).toHaveBeenCalledWith('chat', 'artifact:art-1'));
    await vi.waitFor(() => expect(next.manager.list('chat')[0].url).toBe('http://127.0.0.1:5555/v1/index.html'));
    // And it is still the same slot: showing another document reuses this tab.
    const again = next.manager.agentShow('chat', 'http://127.0.0.1:5555/v2/index.html', undefined, 'artifact:art-2');
    expect((await again).id).toBe(shown.id);
  });

  /**
   * The same restart, through the real database. The test above hands the saved
   * object straight to the next manager, so a handle the database never kept
   * still reads back — which is how `source` came to be saved by the browser and
   * dropped by the store, and every generated document came back about:blank
   * (found 28.09). Here the row is written, read and restored by SQLite.
   */
  it("keeps a page's handle in the database across a restart, and drops it when the tab leaves", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hello-browser-tabs-"));
    const store = createDataStore(directory, codec);
    try {
      const chat = store.createConversation("Chat").id;
      const persist = {
        save: (tab: BrowserTab) => store.saveBrowserTab(tab),
        remove: (id: string) => store.deleteBrowserTab(id),
        exists: (id: string) => id === chat,
      };
      const first = fixture({ persist });
      // An ordinary web page, a generated document and a preview of the
      // person's own file: only the last two are served by this app.
      const web = first.manager.create(chat, "https://example.com");
      first.attach(web.id);
      const showing = first.manager.agentShow(chat, "http://127.0.0.1:4321/v1/index.html", undefined, "artifact:art-1");
      const documentId = first.manager.list(chat).find(tab => tab.id !== web.id)!.id;
      first.attach(documentId);
      expect((await showing).source).toBe("artifact:art-1");
      const opening = first.manager.agentOpen(chat, "http://127.0.0.1:4321/report.html", undefined,
        { sessionOnly: true, isolated: true, source: "docs/report.html" });
      const previewId = first.manager.list(chat).find(tab => tab.id !== web.id && tab.id !== documentId)!.id;
      first.attach(previewId);
      await opening;

      const rows = store.listBrowserTabs();
      // Saved by the handle that can produce the page again, never by the local
      // address whose port dies with the app.
      expect(rows.find(row => row.id === documentId)).toMatchObject({
        source: "artifact:art-1", url: "about:blank", control: "off",
      });
      expect(rows.find(row => row.id === previewId)).toMatchObject({ source: "docs/report.html", url: "about:blank" });
      // A page with no handle must read back with none at all: the browser asks
      // `!tab.source` to tell an ordinary page from one it serves, and an empty
      // string would answer that question wrongly.
      expect(rows.find(row => row.id === web.id)?.source).toBeUndefined();

      // A served page that leaves its handle in the same session leaves the
      // restore database with it: what is left is a local page in a session of
      // its own, and those are not restored at all.
      const leaving = first.manager.agentOpen(chat, "http://127.0.0.1:4321/scratch.html", undefined,
        { sessionOnly: true, isolated: true, source: "docs/scratch.html" });
      const leavingId = first.manager.list(chat).find(tab =>
        tab.id !== web.id && tab.id !== documentId && tab.id !== previewId)!.id;
      first.attach(leavingId);
      await leaving;
      expect(store.listBrowserTabs().find(row => row.id === leavingId)?.source).toBe("docs/scratch.html");
      await first.manager.navigate(leavingId, "https://example.com/elsewhere");
      expect(store.listBrowserTabs().find(row => row.id === leavingId)).toBeUndefined();

      // A new run, restoring only what the database holds.
      const served = vi.fn(async (_conversationId: string, source: string) =>
        source === "artifact:art-1" ? "http://127.0.0.1:5555/v1/index.html" : "http://127.0.0.1:5555/report.html");
      const next = fixture({ initial: store.listBrowserTabs(), serve: served, persist });
      expect(next.manager.list(chat).map(tab => tab.id).sort()).toEqual([web.id, documentId, previewId].sort());
      // Its own document is served again and read again — Full is granted by the
      // serving, never restored blind.
      next.attach(documentId);
      next.manager.setActive(documentId);
      await vi.waitFor(() => expect(served).toHaveBeenCalledWith(chat, "artifact:art-1"));
      await vi.waitFor(() => expect(next.manager.list(chat).find(tab => tab.id === documentId)).toMatchObject({
        url: "http://127.0.0.1:5555/v1/index.html", control: "full",
      }));
      // The person's own file comes back too, and comes back Off.
      next.attach(previewId);
      next.manager.setActive(previewId);
      await vi.waitFor(() => expect(served).toHaveBeenCalledWith(chat, "docs/report.html"));
      await vi.waitFor(() => expect(next.manager.list(chat).find(tab => tab.id === previewId)).toMatchObject({
        url: "http://127.0.0.1:5555/report.html", control: "off",
      }));

      // Leaving the document ends the handle in the database as well, or the run
      // after this one would serve a document this tab has left.
      await next.manager.navigate(documentId, "https://example.com/real");
      expect(next.manager.list(chat).find(tab => tab.id === documentId)).toMatchObject({ control: "off", source: undefined });
      expect(store.listBrowserTabs().find(row => row.id === documentId)?.source).toBeUndefined();
      const last = fixture({ initial: store.listBrowserTabs(), serve: served, persist });
      const count = served.mock.calls.length;
      const stale = last.manager.list(chat).find(tab => tab.id === documentId);
      if (stale) {
        last.attach(stale.id);
        last.manager.setActive(stale.id);
      }
      expect(stale?.source).toBeUndefined();
      expect(served.mock.calls.length).toBe(count);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("isolates every local preview from signed-in web storage and other previews", async () => {
    const f = fixture();
    const base = f.open();
    const opening = f.manager.agentOpen('chat', 'http://127.0.0.1:4321/first/index.html', undefined, { isolated: true });
    const firstAttach = f.attach(f.manager.list('chat').find(tab => tab.id !== base.id)!.id);
    const first = await opening;
    const opening2 = f.manager.agentOpen('other', 'http://127.0.0.1:4321/second/index.html', undefined, { isolated: true });
    const secondAttach = f.attach(f.manager.list('other')[0].id);
    const second = await opening2;
    const firstPreferences = firstAttach.preferences;
    const secondPreferences = secondAttach.preferences;
    expect(firstPreferences.partition).toMatch(/^hello-preview-/);
    expect(String(firstPreferences.partition)).not.toMatch(/^persist:/);
    // The tag is forced onto the partition this manager chose for the record.
    expect(firstAttach.params.partition).toBe(firstPreferences.partition);
    expect(firstPreferences.partition).not.toBe(secondPreferences.partition);
    expect(firstPreferences.session).not.toBe(native.partition);
    expect(firstPreferences.session).not.toBe(secondPreferences.session);
    expect(guestAt(0).session).toBe(native.partition);
    for (const tab of [first, second]) {
      expect(tab).toMatchObject({ control: 'off', sessionOnly: true });
      expect(f.save.mock.calls.some(([saved]) => saved.id === tab.id)).toBe(false);
    }
    const partition = firstPreferences.session as FakePartition;
    expect(partition.setPermissionCheckHandler.mock.calls.at(-1)?.[0]()).toBe(false);
    const callback = vi.fn();
    partition.setPermissionRequestHandler.mock.calls.at(-1)?.[0]({}, 'camera', callback);
    expect(callback).toHaveBeenCalledWith(false);
    const download = { preventDefault: vi.fn() };
    partition.emit('will-download', download);
    expect(download.preventDefault).toHaveBeenCalledOnce();
    await f.manager.navigate(first.id, 'https://example.com/next');
    expect(guestAt(1).session).toBe(partition);
    expect(f.save.mock.calls.some(([saved]) => saved.id === first.id)).toBe(false);
  });

  it("keeps a popup from an isolated preview in that preview's own session", async () => {
    const f = fixture();
    const opening = f.manager.agentOpen('chat', 'http://127.0.0.1:4321/local/index.html', undefined, { isolated: true });
    const { guest, preferences } = f.attach(f.manager.list('chat')[0].id);
    await opening;
    expect(popup(guest).response).toEqual({ action: 'deny' });
    const opened = f.manager.list('chat')[1];
    // The new tab's page is pinned to the same isolated partition and session:
    // a generated page's popup is still not the signed-in web.
    const { preferences: popupPreferences } = f.attach(opened.id);
    expect(popupPreferences).toEqual(pinnedPreferences(preferences.partition as string, preferences.session));
    expect(popupPreferences.session).not.toBe(native.partition);
  });

  it("wipes and releases a preview's isolated session when its tab closes or the browser disposes", async () => {
    const f = fixture();
    const opening = f.manager.agentOpen('chat', 'http://127.0.0.1:4321/local/index.html', undefined, { isolated: true });
    const closing = f.manager.list('chat')[0];
    const closingAttach = f.attach(closing.id);
    await opening;
    const opening2 = f.manager.agentOpen('other', 'http://127.0.0.1:4321/other/index.html', undefined, { isolated: true });
    const keptAttach = f.attach(f.manager.list('other')[0].id);
    await opening2;
    const first = closingAttach.preferences.session as FakePartition;
    const kept = keptAttach.preferences.session as FakePartition;
    expect(first.listenerCount('will-download')).toBe(1);
    f.manager.close(closing.id);
    expect(first.listenerCount('will-download')).toBe(0);
    expect(first.clearStorageData).toHaveBeenCalledOnce();
    expect(first.clearCache).toHaveBeenCalledOnce();
    expect(f.remove).not.toHaveBeenCalled();
    expect(kept.clearStorageData).not.toHaveBeenCalled();
    f.manager.dispose();
    expect(kept.listenerCount('will-download')).toBe(0);
    expect(kept.clearStorageData).toHaveBeenCalledOnce();
    expect(kept.clearCache).toHaveBeenCalledOnce();
  });

  it("rejects invalid or already-cancelled opens without creating a tab", async () => {
    const f = fixture();
    for (const url of ["file:///tmp/preview.html", "javascript:alert(1)", "about:blank", "https://user:secret@example.com"]) {
      await expect(f.manager.agentOpen("chat", url)).rejects.toThrow();
    }
    const controller = new AbortController();
    controller.abort(new Error("Stopped by you."));
    await expect(f.manager.agentOpen("chat", "https://example.com", controller.signal))
      .rejects.toThrow("Stopped by you.");
    expect(f.manager.list()).toEqual([]);
    expect(native.guests).toHaveLength(0);
    expect(f.lifecycle).not.toHaveBeenCalled();
  });

  it("stops an opened page's pending load on cancellation without granting DOM access", async () => {
    const f = fixture();
    const controller = new AbortController();
    const pending = deferred<void>();
    const opening = f.manager.agentOpen("chat", "https://example.com/slow", controller.signal);
    const rejected = expect(opening).rejects.toThrow();
    const { guest } = f.attach(f.manager.list("chat")[0].id);
    native.nextLoad = pending.promise; // The navigation's own load never settles.
    await flush();
    expect(guest.loadURL).toHaveBeenLastCalledWith("https://example.com/slow");
    controller.abort();
    await rejected;
    expect(guest.stop).toHaveBeenCalledOnce();
    expect(guest.mainFrame.executeJavaScript).not.toHaveBeenCalled();
    expect(f.manager.list().every(tab => tab.control === "off")).toBe(true);
    pending.reject(new Error("Late cancelled load"));
    await Promise.resolve();
  });

  it("rejects actions while loading rather than queuing them until after revocation", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "full");
    guestAt().loading = true;
    await expect(
      f.manager.agentAction("chat", tab.id, "click", { selector: "#save" }),
    ).rejects.toThrow(/loading/);
    f.manager.control(tab.id, "off");
    guestAt().loading = false;
    guestAt().emit("did-stop-loading");
    expect(guestAt().executeJavaScript).not.toHaveBeenCalled();
    expect(guestAt().mainFrame.executeJavaScript).not.toHaveBeenCalled();
  });

  it.each(["off", "read"] as const)(
    "cancels a pending mutation and discards its frame when control changes to %s",
    async (mode) => {
      const f = fixture();
      const tab = f.open();
      f.manager.control(tab.id, "full");
      const pending = deferred<unknown>();
      const guest = guestAt();
      guest.mainFrame.executeJavaScript.mockReturnValueOnce(pending.promise);
      const action = f.manager.agentAction("chat", tab.id, "click", { selector: "#save" });
      const rejected = expect(action).rejects.toThrow(/revoked/);
      await flush();
      f.manager.control(tab.id, mode);
      await rejected;
      expect(guest.close).toHaveBeenCalledOnce();
      expect(f.manager.list()[0]).toMatchObject({
        control: mode,
        error: expect.stringContaining("Reload"),
      });
      // The window may not mount a replacement page for a discarded tab.
      expect(() => f.manager.mintAttach(tab.id)).toThrow(/Reload/);
      pending.resolve("Late action");
      await Promise.resolve();
      expect(f.manager.list()[0].control).toBe(mode);
    },
  );

  it("refuses a new page for a discarded tab until an explicit navigation asks for one", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "full");
    const pending = deferred<unknown>();
    guestAt().mainFrame.executeJavaScript.mockReturnValueOnce(pending.promise);
    const action = f.manager.agentAction("chat", tab.id, "click", { selector: "#save" });
    const rejected = expect(action).rejects.toThrow(/revoked/);
    await flush();
    f.manager.control(tab.id, "off");
    await rejected;
    expect(() => f.manager.mintAttach(tab.id)).toThrow(/Reload/);
    const navigating = f.manager.navigate(tab.id, "https://example.com/again");
    const { guest } = f.attach(tab.id);
    await navigating;
    expect(guest.loadURL).toHaveBeenCalledWith("https://example.com/again");
    expect(f.manager.list()[0]).toMatchObject({ url: "https://example.com/again", error: null });
    pending.resolve("Late action");
    await Promise.resolve();
  });

  it("aborts a pending action, while preserving the tab for an explicit reload", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "full");
    const pending = deferred<unknown>();
    const controller = new AbortController();
    guestAt().mainFrame.executeJavaScript.mockReturnValueOnce(pending.promise);
    const action = f.manager.agentAction(
      "chat",
      tab.id,
      "type",
      { selector: "#name" },
      "hello",
      controller.signal,
    );
    const rejected = expect(action).rejects.toThrow(/stopped/);
    await flush();
    controller.abort();
    await rejected;
    expect(guestAt(0).close).toHaveBeenCalledOnce();
    expect(f.manager.list()).toHaveLength(1);
    const navigating = f.manager.navigate(tab.id, "https://example.com");
    const { guest } = f.attach(tab.id);
    await navigating;
    expect(native.guests).toHaveLength(2);
    expect(guest.loadURL).toHaveBeenLastCalledWith("https://example.com/");
    expect(f.manager.list()[0].error).toBeNull();
    pending.reject(new Error("Late closed-frame rejection"));
    await Promise.resolve();
  });

  it("discards pending read output on revocation without destroying the page", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "read");
    const pending = deferred<unknown>();
    guestAt().mainFrame.executeJavaScript.mockReturnValueOnce(pending.promise);
    const read = f.manager.read(tab.id, "chat");
    const rejected = expect(read).rejects.toThrow(/revoked/);
    await flush();
    f.manager.control(tab.id, "off");
    await rejected;
    pending.resolve("Must not be delivered");
    await Promise.resolve();
    expect(guestAt().close).not.toHaveBeenCalled();
  });

  it("bounds unresponsive page operations and destroys a timed-out mutation frame", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "full");
    const guest = guestAt();
    guest.mainFrame.executeJavaScript.mockReturnValueOnce(new Promise(() => {}));
    vi.useFakeTimers();
    const action = f.manager.agentAction("chat", tab.id, "scroll", {}, 100);
    const rejected = expect(action).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(0); // Let the page resolve and the operation start.
    await vi.advanceTimersByTimeAsync(BROWSER_OPERATION_TIMEOUT_MS);
    await rejected;
    expect(guest.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops a pending agent navigation on abort and settles without waiting for loadURL", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "full");
    const controller = new AbortController();
    guestAt().loadURL.mockReturnValueOnce(new Promise(() => {}));
    const action = f.manager.agentNavigate(
      "chat",
      tab.id,
      "https://example.com/slow",
      controller.signal,
    );
    const rejected = expect(action).rejects.toThrow();
    await flush();
    controller.abort();
    await rejected;
    expect(guestAt().stop).toHaveBeenCalledOnce();
  });

  it("does not let an older cancelled navigation overwrite its replacement page", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "full");
    guestAt().loadURL.mockReturnValueOnce(new Promise(() => {}));
    const old = f.manager.agentNavigate(
      "chat",
      tab.id,
      "https://example.com/old",
    );
    const rejected = expect(old).rejects.toThrow(/navigated/);
    await flush();
    await f.manager.navigate(tab.id, "https://example.com/new");
    await rejected;
    expect(f.manager.list()[0]).toMatchObject({
      url: "https://example.com/new",
      error: null,
    });
  });

  it("aborts a read immediately and consumes a late frame rejection", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "read");
    const pending = deferred<unknown>();
    const controller = new AbortController();
    guestAt().mainFrame.executeJavaScript.mockReturnValueOnce(pending.promise);
    const read = f.manager.read(tab.id, "chat", controller.signal);
    const rejected = expect(read).rejects.toThrow(/stopped/);
    await flush();
    controller.abort();
    await rejected;
    pending.reject(new Error("Frame was detached later"));
    await Promise.resolve();
    expect(guestAt().close).not.toHaveBeenCalled();
  });

  it("prevents already-aborted work from creating or executing a native page", async () => {
    const f = fixture();
    const tab = f.manager.create("chat", "https://example.com");
    f.manager.control(tab.id, "full");
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.manager.agentAction(
        "chat",
        tab.id,
        "click",
        { selector: "#save" },
        "",
        controller.signal,
      ),
    ).rejects.toThrow();
    await expect(
      f.manager.read(tab.id, "chat", controller.signal),
    ).rejects.toThrow();
    expect(native.guests).toHaveLength(0);
  });

  it("waits for the window to mount a tab's page, then runs the operation on the adopted guest", async () => {
    const f = fixture();
    const tab = f.manager.create("chat", "https://example.com");
    f.manager.control(tab.id, "read");
    f.emit.mockClear();
    const reading = f.manager.read(tab.id, "chat");
    // The only way to get a page is to ask the window for one.
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ id: tab.id }));
    expect(native.guests).toHaveLength(0);
    const { guest } = f.attach(tab.id);
    await expect(reading).resolves.toMatchObject({ text: expect.stringContaining("Page text") });
    expect(guest.mainFrame.executeJavaScript).toHaveBeenCalledOnce();
  });

  it("gives up on an operation the window never mounts a page for", async () => {
    const f = fixture();
    const tab = f.manager.create("chat", "https://example.com");
    f.manager.control(tab.id, "read");
    vi.useFakeTimers();
    const reading = f.manager.read(tab.id, "chat");
    const rejected = expect(reading).rejects.toThrow(
      "This page is not open in the app window.",
    );
    await vi.advanceTimersByTimeAsync(BROWSER_ATTACH_TIMEOUT_MS);
    await rejected;
    expect(native.guests).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-checks the tab's grant after waiting for a page, so a revoked mutation never runs", async () => {
    const f = fixture();
    const tab = f.manager.create("chat", "https://example.com");
    f.manager.control(tab.id, "full");
    const action = f.manager.agentAction("chat", tab.id, "click", { selector: "#save" });
    const rejected = expect(action).rejects.toThrow(/Off/);
    f.manager.control(tab.id, "off"); // Revoked while the window was still mounting.
    const { guest } = f.attach(tab.id);
    await rejected;
    expect(guest.mainFrame.executeJavaScript).not.toHaveBeenCalled();
  });

  it("closing a tab and disposing cancel pending reads, close guests and remove session listeners", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "read");
    guestAt().mainFrame.executeJavaScript.mockReturnValueOnce(
      new Promise(() => {}),
    );
    const read = f.manager.read(tab.id, "chat");
    const rejected = expect(read).rejects.toThrow(/closed/);
    await flush();
    f.manager.close(tab.id);
    await rejected;
    expect(f.remove).toHaveBeenCalledWith(tab.id);
    expect(guestAt(0).close).toHaveBeenCalledOnce();
    f.open();
    f.manager.dispose();
    f.manager.dispose();
    expect(guestAt(1).close).toHaveBeenCalledOnce();
    expect(
      (native.partition as EventEmitter).listenerCount("will-download"),
    ).toBe(0);
    expect(f.window.webContents.listenerCount("did-start-loading")).toBe(0);
    expect(() => f.manager.create("chat")).toThrow(/closed/);
  });
});

describe("agent pointer and screenshot", () => {
  const drag = { action: "drag", from: { x: 10, y: 10 }, to: { x: 110, y: 60 }, steps: 5, durationMs: 0 } as const;
  const shot = { frames: 1, intervalMs: 100 };

  it("gates both on the tab's own grant and chat: Off neither, Read a screenshot, Full both", async () => {
    const f = fixture();
    const tab = f.open();
    const guest = guestAt();
    await expect(f.manager.agentScreenshot("chat", tab.id, shot)).rejects.toThrow(/Off/);
    await expect(f.manager.agentPointer("chat", tab.id, drag)).rejects.toThrow(/Off/);
    f.manager.control(tab.id, "read");
    await expect(f.manager.agentPointer("chat", tab.id, drag)).rejects.toThrow(/read only/);
    expect(guest.sendInputEvent).not.toHaveBeenCalled();
    await expect(f.manager.agentScreenshot("chat", tab.id, shot)).resolves.toMatchObject({
      viewport: { width: 800, height: 600 }, frames: [{ mimeType: "image/png", width: 1280, height: 960 }],
    });
    f.manager.control(tab.id, "full");
    await expect(f.manager.agentScreenshot("other", tab.id, shot)).rejects.toThrow(/different chat/);
    await expect(f.manager.agentPointer("other", tab.id, drag)).rejects.toThrow(/different chat/);
    expect(guest.sendInputEvent).not.toHaveBeenCalled();
    expect(guest.capturePage).toHaveBeenCalledOnce();
    await f.manager.agentPointer("chat", tab.id, drag);
    expect(guest.sendInputEvent).toHaveBeenCalledTimes(8);
    // The viewport is read in a world of its own, never the page's; the page
    // is asked only what is at the point, for the result's words.
    expect(guest.executeJavaScriptInIsolatedWorld.mock.calls[0][0]).not.toBe(0);
    expect(guest.mainFrame.executeJavaScript).toHaveBeenCalledOnce();
    expect(String(guest.mainFrame.executeJavaScript.mock.calls[0][0])).toContain("document.elementFromPoint(10, 10)");
    // Nothing about the tab changed: not shown, hidden, reloaded or navigated.
    expect(guest.loadURL).toHaveBeenCalledOnce();
    expect(guest.reload).not.toHaveBeenCalled();
    expect(guest.close).not.toHaveBeenCalled();
  });

  it("sends a drag as button down, every move with the button held, then button up, in page zoom", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "full");
    const guest = guestAt();
    guest.zoom = 2;
    guest.viewport = { w: 400, h: 300 };
    await f.manager.agentPointer("chat", tab.id, drag);
    const sent = guest.sendInputEvent.mock.calls.map(([event]) => event as { type: string; x: number; y: number; modifiers?: string[] });
    expect(sent.map(event => event.type)).toEqual(
      ["mouseMove", "mouseDown", "mouseMove", "mouseMove", "mouseMove", "mouseMove", "mouseMove", "mouseUp"]);
    expect(sent[1]).toMatchObject({ x: 20, y: 20, button: "left" });
    expect(sent.slice(2, 7).every(event => event.modifiers?.[0] === "leftbuttondown")).toBe(true);
    expect(sent[7]).toMatchObject({ type: "mouseUp", x: 220, y: 120 });
  });

  it("refuses a point outside the viewport and sends nothing", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "full");
    await expect(f.manager.agentPointer("chat", tab.id, { action: "click", x: 800, y: 5, button: "left", clickCount: 1 }))
      .rejects.toThrow(/outside this tab's viewport, which is 800x600/);
    await expect(f.manager.agentScreenshot("chat", tab.id, { ...shot, region: { x: 0, y: 590, width: 10, height: 20 } }))
      .rejects.toThrow(/does not fit/);
    guestAt().viewport = null;
    await expect(f.manager.agentPointer("chat", tab.id, { action: "hover", x: 1, y: 1 })).rejects.toThrow(/viewport size/);
    expect(guestAt().sendInputEvent).not.toHaveBeenCalled();
    expect(guestAt().capturePage).not.toHaveBeenCalled();
  });

  it("stops a drag the moment control is lowered, without sending the rest", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "full");
    const guest = guestAt();
    const pending = f.manager.agentPointer("chat", tab.id, { ...drag, steps: 10, durationMs: 1000 });
    await vi.waitFor(() => expect(guest.sendInputEvent).toHaveBeenCalledTimes(2));
    f.manager.control(tab.id, "read");
    await expect(pending).rejects.toThrow(/revoked/);
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(guest.sendInputEvent).toHaveBeenCalledTimes(2);
  });

  it("takes each frame apart, crops a region and stops when Off is chosen between frames", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "read");
    const guest = guestAt();
    const result = await f.manager.agentScreenshot("chat", tab.id,
      { frames: 3, intervalMs: 100, region: { x: 100, y: 100, width: 200, height: 100 } });
    expect(guest.capturePage).toHaveBeenCalledTimes(3);
    expect(result.frames.map(frame => [frame.width, frame.height])).toEqual([[400, 200], [400, 200], [400, 200]]);
    expect(Buffer.from(result.frames[0].data, "base64").toString()).toBe("png 400x200");
    const next = f.manager.agentScreenshot("chat", tab.id, { frames: 2, intervalMs: 200 });
    await vi.waitFor(() => expect(guest.capturePage).toHaveBeenCalledTimes(4));
    f.manager.control(tab.id, "off");
    await expect(next).rejects.toThrow(/Off/);
    expect(guest.capturePage).toHaveBeenCalledTimes(4);
  });

  it("refuses a loading page and an empty picture with a clear error", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "full");
    const guest = guestAt();
    guest.loading = true;
    await expect(f.manager.agentScreenshot("chat", tab.id, shot)).rejects.toThrow(/finish loading/);
    await expect(f.manager.agentPointer("chat", tab.id, drag)).rejects.toThrow(/finish loading/);
    guest.loading = false;
    guest.capturePage.mockResolvedValueOnce(native.picture(0, 0));
    await expect(f.manager.agentScreenshot("chat", tab.id, shot)).rejects.toThrow(/no picture/);
    expect(guest.sendInputEvent).not.toHaveBeenCalled();
  });
});

// A click is real mouse input at the control's centre, the page only saying
// where that is — a DOM click left a menu that opens on pointerdown shut, and
// the model went on to guess pixels (user, 24.09: Neon's invoice menu).
describe("an element named by its words or its ref", () => {
  it("acts on a page whose frames an ad keeps loading: the page itself has loaded", async () => {
    // eBay (user, 30.09): its ads never stopped loading frames, so every click,
    // scroll and wait for the load was refused as "still loading".
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "full");
    const guest = guestAt();
    guest.framesLoading = true;
    guest.mainFrame.executeJavaScript.mockResolvedValueOnce({ what: 'button "Decline all"', x: 320, y: 437 });
    await expect(f.manager.agentAction("chat", tab.id, "click", { label: "Decline all" }))
      .resolves.toBe('Clicked button "Decline all" at (320, 437).');
    await expect(f.manager.agentWait("chat", tab.id, { load: true, timeoutMs: 2_000 }))
      .resolves.toMatch(/^Waited 0\.0 s: the page to finish loading — there now/);
    // The page's own load still holds everything back.
    guest.loading = true;
    await expect(f.manager.agentAction("chat", tab.id, "click", { label: "Decline all" })).rejects.toThrow(/finish loading/);
  });

  it("asks the page where the control is, then clicks there for real, and says so", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "full");
    const guest = guestAt();
    guest.mainFrame.executeJavaScript.mockResolvedValueOnce({ what: 'button "enable this API"', x: 65, y: 318 });
    await expect(
      f.manager.agentAction("chat", tab.id, "click", { label: "enable this API" }),
    ).resolves.toBe('Clicked button "enable this API" at (65, 318).');
    const script = String((guest.mainFrame.executeJavaScript.mock.calls.at(-1) as unknown[] | undefined)?.[0]);
    expect(script).toContain('find({"label":"enable this API"})');
    expect(script).toContain("elementFromPoint");
    expect(guest.sendInputEvent.mock.calls.map((call) => call[0])).toEqual([
      { type: "mouseMove", x: 65, y: 318 },
      { type: "mouseDown", x: 65, y: 318, button: "left", clickCount: 1 },
      { type: "mouseUp", x: 65, y: 318, button: "left", clickCount: 1 },
    ]);
    // By ref — one the latest read gave — the same; covered, the page clicked it itself and that is said.
    guest.mainFrame.executeJavaScript.mockResolvedValueOnce({ text: "Billing", lines: Array.from({ length: 12 }, (_, index) => `e${index + 1} button "…"`), count: 12 });
    await f.manager.read(tab.id, "chat");
    guest.mainFrame.executeJavaScript.mockResolvedValueOnce({ what: 'menuitem "Download"', x: 1560, y: 643, covered: 'div "Request billing support"' });
    await expect(f.manager.agentAction("chat", tab.id, "click", { ref: "e12" })).resolves.toBe(
      'Clicked menuitem "Download" directly: its centre (1560, 643) is covered by div "Request billing support". If nothing happened, close what covers it and click again.',
    );
    expect(String((guest.mainFrame.executeJavaScript.mock.calls.at(-1) as unknown[] | undefined)?.[0])).toContain('find({"ref":"e12"})');
    expect(guest.sendInputEvent).toHaveBeenCalledTimes(3);
    // A centre off the viewport is refused before anything is sent.
    guest.mainFrame.executeJavaScript.mockResolvedValueOnce({ what: 'button "Far"', x: 5000, y: 10 });
    await expect(f.manager.agentAction("chat", tab.id, "click", { label: "Far" })).rejects.toThrow(/outside this tab's viewport/);
    guest.mainFrame.executeJavaScript.mockResolvedValueOnce("Clicked.");
    await expect(f.manager.agentAction("chat", tab.id, "click", { label: "Odd" })).rejects.toThrow(/did not say where the element is/);
  });

  it("reads the controls with refs, roles, words, state and centre", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "read");
    await f.manager.read(tab.id, "chat");
    const script = String((guestAt().mainFrame.executeJavaScript.mock.calls.at(-1) as unknown[] | undefined)?.[0]);
    expect(script).toContain("__helloAgentRefs");
    expect(script).toContain("getBoundingClientRect");
  });

  // A payment field or an embedded widget lives in an iframe; a read that
  // stopped at the main frame never saw it (user, 24.09). Refs run on across
  // frames, centres are moved to the page, and a click by ref lands there.
  it("reads the frames inside the page too, and clicks a control in one by its ref, on the page", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "full");
    const guest = guestAt();
    // Which page script this is: the frame boxes, a scan, a locate, a type.
    const kind = (code: string) => code.includes("querySelectorAll('iframe')") ? "boxes"
      : code.includes("const stored = { start:") ? "scan" : code.includes("find({") ? "find" : "other";
    const child = {
      executeJavaScript: vi.fn(async (code: string) => kind(code) === "scan"
        ? { text: "Card number", lines: ['e2 textbox "Card number" (empty) @ (250, 250)'], count: 1 }
        : code.includes("is not a text field") ? 'Entered text into textbox "Card number".'
          : { what: 'textbox "Card number"', x: 150, y: 50 }),
      isDestroyed: () => false, frames: [], name: "__privateStripeFrame9", url: "https://js.stripe.com/v3/elements-inner-card",
    };
    const blank = { executeJavaScript: vi.fn(), isDestroyed: () => false, frames: [], name: "", url: "about:blank" };
    guest.mainFrame.frames = [child, blank];
    guest.mainFrame.executeJavaScript.mockImplementation(async (code: string) => kind(code) === "boxes"
      ? [{ name: "__privateStripeFrame9", src: "https://js.stripe.com/v3/elements-inner-card", x: 100, y: 200, width: 300, height: 100 }]
      : kind(code) === "scan"
        ? { text: "Pay for order 42", lines: ['e1 button "Pay" @ (60, 400)'], count: 1 }
        : { what: 'button "Pay"', x: 60, y: 400 });
    const read = await f.manager.read(tab.id, "chat");
    expect(read.text).toContain("Pay for order 42");
    expect(read.text).toContain('--- frame "__privateStripeFrame9" ---\nCard number');
    expect(read.text).toContain('e1 button "Pay" @ (60, 400)\ne2 textbox "Card number" (empty) @ (250, 250) [in frame "__privateStripeFrame9"]');
    // The frame was scanned from e2, at its place on the page.
    const scanned = String(child.executeJavaScript.mock.calls[0][0]);
    expect(scanned).toContain("start: 2");
    expect(scanned).toContain("+ 100)");
    expect(blank.executeJavaScript).not.toHaveBeenCalled();
    // The ref goes to its frame; the click goes to the page.
    await expect(f.manager.agentAction("chat", tab.id, "click", { ref: "e2" })).resolves.toBe('Clicked textbox "Card number" at (250, 250).');
    expect(String(child.executeJavaScript.mock.calls.at(-1)?.[0])).toContain('find({"ref":"e2"})');
    expect(guest.sendInputEvent.mock.calls.map(call => call[0])).toEqual([
      { type: "mouseMove", x: 250, y: 250 },
      { type: "mouseDown", x: 250, y: 250, button: "left", clickCount: 1 },
      { type: "mouseUp", x: 250, y: 250, button: "left", clickCount: 1 },
    ]);
    await expect(f.manager.agentAction("chat", tab.id, "type", { ref: "e2" }, "4242")).resolves.toBe('Entered text into textbox "Card number".');
    await expect(f.manager.agentAction("chat", tab.id, "click", { ref: "e1" })).resolves.toBe('Clicked button "Pay" at (60, 400).');
    await expect(f.manager.agentAction("chat", tab.id, "click", { ref: "e7" })).rejects.toThrow(/Ref e7 is not from the latest browser_read/);
  });

  // agent-browser's wait: the page somewhere before it is read (user, 24.09).
  it("waits for words, a control, an address or the load, at the grant each needs, and gives up in time", async () => {
    const f = fixture();
    const tab = f.open();
    const guest = guestAt();
    vi.useFakeTimers();
    await expect(f.manager.agentWait("chat", tab.id, { text: "Paid", timeoutMs: 2_000 })).rejects.toThrow(/Agent control is Off/);
    // An address and the load read nothing: any mode.
    const url = f.manager.agentWait("chat", tab.id, { url: "https://*.com/", timeoutMs: 2_000 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await url).toMatch(/^Waited 0\.0 s: an address matching "https:\/\/\*\.com\/" — there now/);
    guest.loading = true;
    const load = f.manager.agentWait("chat", tab.id, { load: true, timeoutMs: 2_000 });
    await vi.advanceTimersByTimeAsync(600);
    guest.loading = false;
    await vi.advanceTimersByTimeAsync(300);
    expect(await load).toMatch(/^Waited 0\.[5-9] s: the page to finish loading — there now/);
    f.manager.control(tab.id, "read");
    let asked = 0;
    guest.mainFrame.executeJavaScript.mockImplementation(async () => (asked += 1) >= 3);
    const words = f.manager.agentWait("chat", tab.id, { text: "Paid", timeoutMs: 2_000 });
    await vi.advanceTimersByTimeAsync(600);
    expect(await words).toMatch(/^Waited 0\.5 s: the words "Paid" — there now\. Read the page again/);
    expect(String(guest.mainFrame.executeJavaScript.mock.calls.at(-1)?.[0])).toContain('"Paid".replace(');
    guest.mainFrame.executeJavaScript.mockImplementation(async () => false);
    const never = f.manager.agentWait("chat", tab.id, { target: { label: "Refund" }, timeoutMs: 1_000 });
    const outcome = never.catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(1_400);
    expect(await outcome).toMatch(/^Waited 1\.[0-2] s and a control {"label":"Refund"} did not come\. browser_read shows what the page has now/);
    const nap = f.manager.agentWait("chat", tab.id, { ms: 300, timeoutMs: 2_000 });
    await vi.advanceTimersByTimeAsync(300);
    expect(await nap).toBe("Waited 300 ms.");
  });

  it("draws the refs on the page for an annotated screenshot, lists them with it, and erases them after", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "read");
    const guest = guestAt();
    guest.mainFrame.executeJavaScript.mockImplementation(async (code: string) => code.includes("const stored = { start:")
      ? { text: "Invoice", lines: ['e1 button "Download" @ (60, 40)'], count: 1 } : true);
    const shot = await f.manager.agentScreenshot("chat", tab.id, { frames: 1, intervalMs: 500, refs: true });
    expect(shot.legend).toBe('e1 button "Download" @ (60, 40)');
    expect(shot.frames).toHaveLength(1);
    const scripts = guest.mainFrame.executeJavaScript.mock.calls.map(call => String(call[0]));
    expect(scripts[0]).toContain("layer.appendChild(tag)");
    expect(scripts.at(-1)).toContain("__hello-annotate");
    expect(scripts.at(-1)).toContain("layer.remove()");
    // Without refs nothing is drawn, and there is no legend.
    guest.mainFrame.executeJavaScript.mockClear();
    const plain = await f.manager.agentScreenshot("chat", tab.id, { frames: 1, intervalMs: 500 });
    expect(plain.legend).toBeUndefined();
    expect(guest.mainFrame.executeJavaScript).not.toHaveBeenCalled();
  });

  it("appends what the read left out, and says what a pointer click landed on", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "full");
    const guest = guestAt();
    guest.mainFrame.executeJavaScript.mockResolvedValueOnce({ text: "Settings", lines: ['e1 tab "Billing" @ (410, 415)'], count: 1,
      note: '2 controls of the page behind the open dialog "Settings" are not listed: nothing behind it takes a click while it is open.' });
    const read = await f.manager.read(tab.id, "chat");
    expect(read.text).toMatch(/e1 tab "Billing" @ \(410, 415\)\n2 controls of the page behind the open dialog "Settings" are not listed/);
    guest.mainFrame.executeJavaScript.mockResolvedValueOnce({ what: 'link "Projects"', ref: "e13", control: true });
    await expect(f.manager.agentPointer("chat", tab.id, { action: "click", x: 130, y: 200, button: "left", clickCount: 1 })).resolves.toBe(
      ' It landed on link "Projects" (e13) — a control. Click controls with browser_click ref "e13": it finds the control wherever the page has scrolled, and a point does not.');
    expect(guest.sendInputEvent).toHaveBeenCalledTimes(3);
    guest.mainFrame.executeJavaScript.mockResolvedValueOnce({ what: 'div "Background"', ref: "", control: false });
    await expect(f.manager.agentPointer("chat", tab.id, { action: "hover", x: 5, y: 5 })).resolves.toBe(' It is over div "Background".');
    // A page that will not say still gets the input.
    guest.mainFrame.executeJavaScript.mockRejectedValueOnce(new Error("frame gone"));
    await expect(f.manager.agentPointer("chat", tab.id, { action: "click", x: 5, y: 5, button: "left", clickCount: 1 })).resolves.toBe("");
    expect(guest.sendInputEvent).toHaveBeenCalledTimes(7);
  });

  it("presses one key as from the keyboard, at Full only, and only a key it knows", async () => {
    const f = fixture();
    const tab = f.open();
    await expect(f.manager.agentKey("chat", tab.id, "Enter")).rejects.toThrow(/Agent control is Off/);
    f.manager.control(tab.id, "read");
    await expect(f.manager.agentKey("chat", tab.id, "Enter")).rejects.toThrow(/read only/);
    f.manager.control(tab.id, "full");
    await expect(f.manager.agentKey("chat", tab.id, "F5")).rejects.toThrow(/Unknown key "F5"/);
    await expect(f.manager.agentKey("chat", tab.id, "Enter")).resolves.toBe("Pressed Enter.");
    expect(guestAt().sendInputEvent.mock.calls.map((call) => call[0])).toEqual([
      { type: "keyDown", keyCode: "Return" }, { type: "char", keyCode: "Return" }, { type: "keyUp", keyCode: "Return" },
    ]);
    await f.manager.agentKey("chat", tab.id, "Escape");
    expect(guestAt().sendInputEvent.mock.calls.slice(3).map((call) => call[0])).toEqual([
      { type: "keyDown", keyCode: "Escape" }, { type: "keyUp", keyCode: "Escape" },
    ]);
  });
});

// A download is the CHAT's, wherever it came from — a tab, a popup a link
// opened for it, a tab since closed — and it lands in the chat's folder or,
// like any browser's, in the system Downloads folder (user, 24.09: "ca în
// Chrome, profesional": a list with the file, its size, Show in Finder).
describe("a page offering a download", () => {
  function item(filename: string, options: { url?: string; total?: number; mime?: string } = {}) {
    const listeners = new Map<string, Array<(event: unknown, state: string) => void>>();
    let received = 0;
    const listen = vi.fn((name: string, listener: (event: unknown, state: string) => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    });
    const fake = {
      getFilename: () => filename,
      getURL: () => options.url ?? `https://billing.example/files/${filename}?token=secret`,
      getMimeType: () => options.mime ?? "application/pdf",
      getTotalBytes: () => options.total ?? 0,
      getReceivedBytes: () => received,
      setSavePath: vi.fn(),
      on: listen,
      once: listen,
      cancel: vi.fn(() => fake.finish("cancelled")),
      progress: (bytes: number) => { received = bytes; for (const listener of listeners.get("updated") ?? []) listener({}, "progressing"); },
      finish: (state = "completed") => { if (state === "completed" && !received) received = 1234; for (const listener of listeners.get("done") ?? []) listener({}, state); },
    };
    return fake;
  }
  const offer = (download: ReturnType<typeof item>, guest: unknown) => {
    const event = { preventDefault: vi.fn() };
    (native.partition as EventEmitter).emit("will-download", event, download, guest);
    return event;
  };

  it("saves it into the chat's folder under a safe, unused name, on the chat's list, with its progress and source", () => {
    const folder = mkdtempSync(join(tmpdir(), "hello-downloads-"));
    writeFileSync(join(folder, "invoice.pdf"), "already here");
    try {
      vi.useFakeTimers();
      const f = fixture({ folder });
      const tab = f.open();
      const download = item("../../invoice.pdf", { total: 4000, url: "https://billing.example/i/inv_1/pdf?s=ap" });
      expect(offer(download, guestAt()).preventDefault).not.toHaveBeenCalled();
      expect(download.setSavePath).toHaveBeenCalledWith(join(folder, "invoice-2.pdf"));
      const listed = () => f.manager.downloadsOf("chat");
      expect(listed()).toMatchObject([{
        conversationId: "chat", tabId: tab.id, name: "invoice-2.pdf", path: join(folder, "invoice-2.pdf"), state: "saving",
        total: 4000, url: "https://billing.example/i/inv_1/pdf", mimeType: "application/pdf",
      }]);
      expect(f.saveDownload).toHaveBeenCalledWith(expect.objectContaining({ state: "saving" }));
      expect(f.downloadEvent).toHaveBeenCalledWith({ type: "updated", download: expect.objectContaining({ state: "saving" }) });
      // Progress reaches the window, not the disk.
      vi.advanceTimersByTime(300);
      download.progress(2000);
      expect(listed()[0]).toMatchObject({ bytes: 2000, state: "saving" });
      expect(f.saveDownload).toHaveBeenCalledTimes(1);
      download.finish();
      expect(listed()[0]).toMatchObject({ state: "saved", bytes: 2000, total: 4000, finishedAt: expect.any(Number) });
      expect(f.saveDownload).toHaveBeenLastCalledWith(expect.objectContaining({ state: "saved" }));
      expect(f.lifecycle).toHaveBeenCalledWith(expect.objectContaining({
        type: "downloaded", id: tab.id, conversationId: "chat", download: expect.objectContaining({ name: "invoice-2.pdf", state: "saved" }),
      }));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("lands in the system Downloads folder when the chat has no folder, is refused only with no folder at all, and never from no page of ours", () => {
    const downloads = mkdtempSync(join(tmpdir(), "hello-system-downloads-"));
    try {
      const f = fixture({ downloadsFolder: downloads });
      f.open();
      const download = item("invoice.pdf");
      expect(offer(download, guestAt()).preventDefault).not.toHaveBeenCalled();
      expect(download.setSavePath).toHaveBeenCalledWith(join(downloads, "invoice.pdf"));
      expect(f.manager.downloadFolder("chat")).toBe(downloads);
      // One partition, one listener: the next manager must be the only one.
      f.manager.dispose();
    } finally {
      rmSync(downloads, { recursive: true, force: true });
    }
    const bare = fixture();
    bare.open();
    const refused = item("invoice.pdf");
    // The second fixture's page is the second guest the window made.
    expect(offer(refused, guestAt(1)).preventDefault).toHaveBeenCalledOnce();
    expect(refused.setSavePath).not.toHaveBeenCalled();
    expect(bare.manager.downloadsOf("chat")).toMatchObject([{ name: "invoice.pdf", state: "refused", reason: "there is no folder to save into" }]);
    expect(() => bare.manager.downloadFolder("chat")).toThrow(/no folder/);
    const stranger = { preventDefault: vi.fn() };
    (native.partition as EventEmitter).emit("will-download", stranger, item("x.bin"), { id: "not-ours" });
    expect(stranger.preventDefault).toHaveBeenCalledOnce();
  });

  it("makes a link's popup that only carried the file the opener's download, and closes that popup again", async () => {
    const folder = mkdtempSync(join(tmpdir(), "hello-downloads-"));
    try {
      const f = fixture({ folder });
      const tab = f.open();
      const handler = guestAt().setWindowOpenHandler.mock.calls[0][0] as (details: HandlerDetails) => WindowOpenHandlerResponse;
      expect(handler({ url: "https://billing.example/i/inv_1/pdf", disposition: "foreground-tab" } as HandlerDetails)).toEqual({ action: "deny" });
      const popup = f.manager.list("chat").find((candidate) => candidate.openerId === tab.id)!;
      expect(popup).toBeDefined();
      const { guest } = f.attach(popup.id);
      // The navigation became a download: the popup's page never committed anything.
      guest.url = "about:blank";
      const download = item("inv_1.pdf");
      offer(download, guest);
      expect(f.manager.downloadsOf("chat")).toMatchObject([{ name: "inv_1.pdf", tabId: tab.id, state: "saving" }]);
      // The popup goes once the download handler has returned — a moment later.
      await vi.waitFor(() => expect(f.manager.list("chat").map((candidate) => candidate.id)).toEqual([tab.id]));
      expect(f.lifecycle).toHaveBeenCalledWith(expect.objectContaining({ type: "closed", id: popup.id, openerId: tab.id }));
      download.finish();
      expect(f.manager.downloadsOf("chat")[0]).toMatchObject({ state: "saved", tabId: tab.id });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("tells the click that caused it where the file went, finished or still saving", async () => {
    const folder = mkdtempSync(join(tmpdir(), "hello-downloads-"));
    try {
      const f = fixture({ folder });
      const tab = f.open();
      f.manager.control(tab.id, "full");
      const guest = guestAt();
      guest.mainFrame.executeJavaScript.mockImplementationOnce(async () => {
        const download = item("receipt.pdf");
        offer(download, guest);
        download.finish();
        return { what: 'button "Download receipt"', x: 10, y: 20 };
      });
      vi.useRealTimers();
      const done = await f.manager.agentAction("chat", tab.id, "click", { label: "Download receipt" });
      expect(done).toContain('Clicked button "Download receipt" at (10, 20).');
      expect(done).toContain(`Saved receipt.pdf → ${join(folder, "receipt.pdf")} (1234 bytes). It is on disk now; do not look for another way to fetch it.`);
      vi.useFakeTimers();
      guest.mainFrame.executeJavaScript.mockImplementationOnce(async () => {
        offer(item("statement.pdf", { total: 9000 }), guest);
        return { what: 'button "Download statement"', x: 10, y: 20 };
      });
      const slow = f.manager.agentAction("chat", tab.id, "click", { label: "Download statement" });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await slow).toContain(`Download started: statement.pdf → ${join(folder, "statement.pdf")} (0 of 9000 bytes); still saving. It will be on disk in a moment — browser_downloads shows when`);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("is listed between sessions, can be cancelled, taken off the list, cleared, opened where it is", () => {
    const folder = mkdtempSync(join(tmpdir(), "hello-downloads-"));
    try {
      writeFileSync(join(folder, "old.pdf"), "kept");
      const earlier: BrowserDownload[] = [
        { id: "old", conversationId: "chat", name: "old.pdf", path: join(folder, "old.pdf"), state: "saved", bytes: 4, startedAt: 1, finishedAt: 2 },
        { id: "gone", conversationId: "chat", name: "gone.pdf", path: join(folder, "gone.pdf"), state: "saved", bytes: 4, startedAt: 3, finishedAt: 4 },
        { id: "theirs", conversationId: "other", name: "theirs.pdf", state: "failed", startedAt: 5 },
      ];
      const f = fixture({ folder, initialDownloads: earlier });
      f.open();
      expect(f.manager.downloadsOf("chat").map((download) => download.id)).toEqual(["gone", "old"]);
      expect(f.manager.downloadPath("old")).toBe(join(folder, "old.pdf"));
      expect(() => f.manager.downloadPath("gone")).toThrow(/no longer where it was saved/);
      const saving = item("big.zip", { total: 9000 });
      offer(saving, guestAt());
      const id = f.manager.downloadsOf("chat")[0].id;
      expect(() => f.manager.downloadPath(id)).toThrow(/still being saved/);
      // Clear leaves what is still saving; cancel ends it, and it says so.
      f.manager.clearDownloads("chat");
      expect(f.manager.downloadsOf("chat").map((download) => download.id)).toEqual([id]);
      expect(f.removeDownload).toHaveBeenCalledWith("old");
      expect(f.downloadEvent).toHaveBeenCalledWith({ type: "removed", id: "old", conversationId: "chat" });
      f.manager.cancelDownload(id);
      expect(saving.cancel).toHaveBeenCalledOnce();
      expect(f.manager.downloadsOf("chat")[0]).toMatchObject({ state: "cancelled", reason: "cancelled" });
      expect(f.lifecycle).toHaveBeenCalledWith(expect.objectContaining({ type: "downloaded", download: expect.objectContaining({ state: "cancelled" }) }));
      f.manager.removeDownload(id);
      expect(f.manager.downloadsOf("chat")).toEqual([]);
      expect(() => f.manager.removeDownload(id)).toThrow(/no longer listed/);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  // The model asks for the file itself: the document open in the tab, or
  // a link's address, fetched by the page with the page's own session — the
  // one thing a shell does not have (user, 23.09: curl after curl at a
  // Stripe invoice, "the browser has no download function").
  describe("asked for by the model", () => {
    /** The page answering a download request the way Chromium does: a will-download on its session. */
    const offering = (guest: FakeGuest, finish = true) =>
      guest.downloadURL.mockImplementation((url: string) => {
        const download = item(url.split("/").pop() || "download");
        offer(download, guest);
        if (finish) download.finish();
      });

    it("saves the file at a link's address, or the page shown in the tab, and says where it is", async () => {
      const folder = mkdtempSync(join(tmpdir(), "hello-downloads-"));
      try {
        const f = fixture({ folder });
        const tab = f.open();
        f.manager.control(tab.id, "full");
        const guest = guestAt();
        offering(guest);
        vi.useRealTimers();
        await expect(f.manager.agentDownload("chat", tab.id, "https://billing.example/invoice.pdf")).resolves.toMatchObject({
          name: "invoice.pdf", path: join(folder, "invoice.pdf"), state: "saved", bytes: 1234, tabId: tab.id,
        });
        expect(guest.downloadURL).toHaveBeenCalledWith("https://billing.example/invoice.pdf");
        // No address: the page in the tab is the file.
        await f.manager.agentDownload("chat", tab.id, undefined);
        expect(guest.downloadURL).toHaveBeenLastCalledWith("https://example.com/");
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    });

    it("needs Full and a web address, and hands back a refusal instead of hiding it", async () => {
      const f = fixture();
      const tab = f.open();
      await expect(f.manager.agentDownload("chat", tab.id, "https://billing.example/invoice.pdf")).rejects.toThrow(/Agent control is Off/);
      f.manager.control(tab.id, "read");
      await expect(f.manager.agentDownload("chat", tab.id, "https://billing.example/invoice.pdf")).rejects.toThrow(/read only/);
      f.manager.control(tab.id, "full");
      await expect(f.manager.agentDownload("chat", tab.id, "file:///etc/passwd")).rejects.toThrow(/web address/);
      expect(guestAt().downloadURL).not.toHaveBeenCalled();
      offering(guestAt());
      vi.useRealTimers();
      // No folder anywhere: the same refusal a click gets, returned, not thrown away.
      await expect(f.manager.agentDownload("chat", tab.id, "https://billing.example/invoice.pdf")).resolves.toMatchObject({
        name: "invoice.pdf", state: "refused", reason: "there is no folder to save into",
      });
    });

    it("gives up on an address nothing starts from, and answers with a file still being written", async () => {
      const folder = mkdtempSync(join(tmpdir(), "hello-downloads-"));
      try {
        const f = fixture({ folder });
        const tab = f.open();
        f.manager.control(tab.id, "full");
        vi.useFakeTimers();
        const nothing = f.manager.agentDownload("chat", tab.id, "https://billing.example/not-a-file");
        const refused = nothing.catch((error: Error) => error.message);
        await vi.advanceTimersByTimeAsync(DOWNLOAD_START_MS + 200);
        expect(await refused).toMatch(/Nothing started downloading from https:\/\/billing.example\/not-a-file within 10 s/);
        offering(guestAt(), false);
        const slow = f.manager.agentDownload("chat", tab.id, "https://billing.example/big.zip");
        await vi.advanceTimersByTimeAsync(DOWNLOAD_FINISH_MS + 500);
        expect(await slow).toMatchObject({ name: "big.zip", path: join(folder, "big.zip"), state: "saving" });
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    });
  });

  it("makes a proposed name safe", () => {
    expect(safeFileName("../../.hidden/../invoice.pdf")).toBe("invoice.pdf");
    expect(safeFileName("C:\\\\Users\\\\x\\\\report.csv")).toBe("report.csv");
    expect(safeFileName("...")).toBe("download");
    expect(safeFileName("")).toBe("download");
    expect(safeFileName("bad\u0000name\u001f.txt")).toBe("badname.txt");
  });
});

// "A pointer for agents" (user, 30.09): after finding something, the agent
// marks where the person should look. It reads and draws over: Read is enough.
describe("marks for the person", () => {
  it("draws where the elements are at Read, scrolls only at Full, and clears with an empty list", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "read");
    const guest = guestAt();
    guest.mainFrame.executeJavaScript.mockResolvedValueOnce({ what: 'link "Mac Studio M3 Ultra"', left: 40, top: 300, width: 320, height: 90, inView: true });
    const said = await f.manager.agentMark("chat", tab.id, [{ target: { label: "Mac Studio M3 Ultra" }, note: "Cheapest: $3,500" }]);
    expect(said).toContain('#1 link "Mac Studio M3 Ultra" — Cheapest: $3,500');
    expect(said).not.toContain("out of view");
    const measured = String(guest.mainFrame.executeJavaScript.mock.calls.at(-1)?.[0]);
    expect(measured).toContain('find({"label":"Mac Studio M3 Ultra"})');
    expect(measured).not.toContain("scrollIntoView");
    const drawn = () => guest.executeJavaScriptInIsolatedWorld.mock.calls.at(-1) as unknown as [number, Array<{ code: string }>];
    expect(drawn()[0]).toBe(1207);
    expect(drawn()[1][0].code).toContain('.hints([{"n":1,"left":40,"top":300,"width":320,"height":90,"note":"Cheapest: $3,500"}])');
    // Off: nothing is measured or drawn.
    const before = guest.mainFrame.executeJavaScript.mock.calls.length;
    f.manager.control(tab.id, "off");
    await expect(f.manager.agentMark("chat", tab.id, [{ target: { label: "Buy" }, note: "here" }])).rejects.toThrow(/Off/);
    expect(guest.mainFrame.executeJavaScript.mock.calls.length).toBe(before);
    // Full: the first one is scrolled into view; one out of view is said.
    f.manager.control(tab.id, "full");
    guest.mainFrame.executeJavaScript
      .mockResolvedValueOnce({ what: 'button "Buy It Now"', left: 10, top: 200, width: 90, height: 30, inView: true })
      .mockResolvedValueOnce({ what: 'link "Seller"', left: 10, top: 2400, width: 60, height: 20, inView: false });
    const two = await f.manager.agentMark("chat", tab.id, [
      { target: { label: "Buy It Now" }, note: "Buy here" }, { target: { label: "Seller" }, note: "Seller rating" },
    ]);
    const calls = guest.mainFrame.executeJavaScript.mock.calls.slice(-2).map(call => String(call[0]));
    expect(calls[0]).toContain("scrollIntoView");
    expect(calls[1]).not.toContain("scrollIntoView");
    expect(two).toContain("#2 is out of view");
    await expect(f.manager.agentMark("chat", tab.id, [])).resolves.toBe("Cleared your marks on this page.");
    expect(drawn()[1][0].code).toContain(".clearHints()");
  });
});

// Marks belong to the page that made them (user, 30.09: "tie them to the link
// that generated them, until reset"): saved with the tab page by page, shown
// again when the tab comes back to that page, gone at the person's reload or reset.
describe("marks kept with their page", () => {
  type Script = Array<{ code: string }>;
  const calls = (guest: FakeGuest, piece: string) =>
    guest.executeJavaScriptInIsolatedWorld.mock.calls.filter(call => String((call[1] as Script)[0].code).includes(piece)).length;
  /** A page that draws what it is asked to and answers the watch when told. */
  function page(guest: FakeGuest) {
    const state: { answer: (value: unknown) => void } = { answer: () => {} };
    guest.executeJavaScriptInIsolatedWorld.mockImplementation((async (_world: number, scripts: Script) => {
      const code = scripts[0].code;
      if (code.includes(".hintsWait(")) return new Promise(resolve => { state.answer = resolve; });
      const drawn = /\.hints\((\[[\s\S]*\])\)/.exec(code);
      if (drawn) return (JSON.parse(drawn[1]) as Array<Record<string, unknown>>).map((mark, index) => ({
        n: mark.n ?? index + 1, note: mark.note, x: mark.x ?? mark.left, y: mark.y ?? mark.top, width: mark.width, height: mark.height, ...(mark.path ? { path: mark.path } : {}),
      }));
      return guest.viewport;
    }) as never);
    return state;
  }
  async function marked(f: ReturnType<typeof fixture>, tabId: string, guest: FakeGuest) {
    guest.mainFrame.executeJavaScript
      .mockResolvedValueOnce({ what: 'link "Mac"', left: 40, top: 300, width: 320, height: 90, inView: true, path: "#mac" })
      .mockResolvedValueOnce({ what: 'link "Seller"', left: 40, top: 500, width: 100, height: 20, inView: true, path: "#seller" });
    await f.manager.agentMark("chat", tabId, [{ target: { label: "Mac" }, note: "Cheapest" }, { target: { label: "Seller" }, note: "Seller" }]);
  }

  it("are kept for their page, follow what the person keeps, and come back when the tab returns to it", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "read");
    const guest = guestAt();
    const watch = page(guest);
    await marked(f, tab.id, guest);
    const pages = () => f.manager.list().find(item => item.id === tab.id)?.marks;
    const first = pages()![0];
    expect(first.marks.map(mark => [mark.n, mark.note, mark.path])).toEqual([[1, "Cheapest", "#mac"], [2, "Seller", "#seller"]]);
    expect(f.save.mock.calls.at(-1)?.[0].marks).toEqual(pages());
    // The person puts #1 away; #2's element has moved since.
    await vi.waitFor(() => expect(calls(guest, ".hintsWait(")).toBeGreaterThan(0));
    watch.answer([{ n: 2, x: 40, y: 620, width: 100, height: 20 }]);
    await vi.waitFor(() => expect(pages()![0].marks).toEqual([{ ...first.marks[1], y: 620 }]));
    // Another page: the first keeps its marks for later.
    guest.url = "https://example.com/other";
    guest.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url: guest.url });
    guest.emit("dom-ready");
    expect(pages()!.map(item => item.url)).toEqual([first.url]);
    // Back to it: they are drawn there again.
    const drawnBefore = calls(guest, ".hints(");
    guest.url = first.url;
    guest.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url: first.url });
    guest.emit("dom-ready");
    await vi.waitFor(() => expect(calls(guest, ".hints(")).toBe(drawnBefore + 1));
    expect(pages()![0].marks.map(mark => mark.path)).toEqual(["#seller"]);
  });

  it("go at the person's reload, or when the page reports none left", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "read");
    const guest = guestAt();
    const watch = page(guest);
    await marked(f, tab.id, guest);
    const pages = () => f.manager.list().find(item => item.id === tab.id)?.marks;
    // A double click on the bubble: the page has none left.
    await vi.waitFor(() => expect(calls(guest, ".hintsWait(")).toBeGreaterThan(0));
    watch.answer([]);
    await vi.waitFor(() => expect(pages()).toBeUndefined());
    await marked(f, tab.id, guest);
    expect(pages()).toHaveLength(1);
    f.manager.action(tab.id, "reload");
    expect(pages()).toBeUndefined();
  });

  it("give way to an address's own in a page that does not reload, and stay for a #section", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "read");
    const guest = guestAt();
    page(guest);
    await marked(f, tab.id, guest);
    const pages = () => f.manager.list().find(item => item.id === tab.id)?.marks;
    const url = pages()![0].url;
    const cleared = () => calls(guest, ".clearHints()");
    guest.emit("did-navigate-in-page", {}, `${url}#reviews`, true);
    expect(cleared()).toBe(0);
    guest.emit("did-navigate-in-page", {}, "https://example.com/next-result", true);
    expect(cleared()).toBe(1);
    // Kept for when the page comes back to that address.
    expect(pages()!.map(item => item.url)).toEqual([url]);
    const drawnBefore = calls(guest, ".hints(");
    guest.emit("did-navigate-in-page", {}, url, true);
    await vi.waitFor(() => expect(calls(guest, ".hints(")).toBe(drawnBefore + 1));
  });

  it("come back with a restored tab, on their page", async () => {
    const url = "https://www.ebay.com/sch/i.html?_nkw=ipad";
    const saved: BrowserTab = {
      id: "restored", conversationId: "chat", title: "eBay", url, control: "off", loading: false, progress: null, canGoBack: false, canGoForward: false,
      marks: [{ url, marks: [{ n: 1, note: "Cheapest", x: 40, y: 1300, width: 320, height: 90, path: "#mac" }] }],
    };
    const f = fixture([saved]);
    const { guest } = f.attach("restored");
    page(guest);
    guest.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url });
    guest.emit("dom-ready");
    await vi.waitFor(() => expect(calls(guest, '"path":"#mac"')).toBeGreaterThan(0));
    expect(f.manager.list().find(item => item.id === "restored")?.marks).toEqual(saved.marks);
  });
});

describe("a mark on what moves by itself", () => {
  it("is refused, with where to mark instead", async () => {
    const f = fixture();
    const tab = f.open();
    f.manager.control(tab.id, "read");
    const guest = guestAt();
    guest.mainFrame.executeJavaScript.mockResolvedValueOnce({ what: 'link "Emil Design Engineering"', left: 600, top: 110, width: 177, height: 21, inView: true, moving: true });
    await expect(f.manager.agentMark("chat", tab.id, [{ target: { label: "Emil Design Engineering" }, note: "Top 2" }]))
      .rejects.toThrow(/#1 link "Emil Design Engineering" moves by itself[\s\S]*where it stands still/);
    expect(guest.executeJavaScriptInIsolatedWorld.mock.calls.some(call => String((call[1] as Array<{ code: string }>)[0].code).includes(".hints("))).toBe(false);
  });
});


// A letter short of the site, "smarbill.ro" ended in "Could not load
// smarbill.ro." — where any browser would have searched it (user, 30.09).
describe("a typed name no site answers to", () => {
  const search = "https://www.google.com/search?q=smarbill.ro";
  /** What Chromium reports for a name DNS does not know: the event, then the load's rejection. */
  const unknownName = (guest: FakeGuest, url: string) => {
    guest.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", url, true);
    return Object.assign(new Error(`ERR_NAME_NOT_RESOLVED (-105) loading '${url}'`), { errno: -105, code: "ERR_NAME_NOT_RESOLVED" });
  };
  /** A page whose history is like Chromium's, where a failed load leaves an entry of its own. */
  const opened = async () => {
    const f = fixture();
    const tab = f.open();
    await flush();
    const guest = guestAt();
    const entries = [guest.url];
    const unknown = new Set(["smarbill.ro"]);
    let active = 0;
    Object.assign(guest, { navigationHistory: {
      canGoBack: () => active > 0,
      canGoForward: () => active < entries.length - 1,
      goBack: vi.fn(),
      goForward: vi.fn(),
      getActiveIndex: () => active,
      getEntryAtIndex: (index: number) => ({ url: entries[index], title: "" }),
      removeEntryAtIndex: (index: number) => {
        if (index === active) return false;
        entries.splice(index, 1);
        if (index < active) active--;
        return true;
      },
    } });
    guest.loadURL.mockImplementation(async (url: string) => {
      guest.url = url;
      entries.splice(active + 1, Infinity, url);
      active = entries.length - 1;
      if (unknown.has(new URL(url).hostname)) throw unknownName(guest, url);
    });
    guest.loadURL.mockClear();
    f.emit.mockClear();
    return { f, tab, guest, entries, unknown };
  };
  const loads = (guest: FakeGuest) => guest.loadURL.mock.calls.map(([url]) => url);
  const errors = (f: ReturnType<typeof fixture>) => f.emit.mock.calls.map(([tab]) => (tab as BrowserTab).error).filter(Boolean);

  it("is searched for instead, and Back skips the name that failed", async () => {
    const { f, tab, guest, entries } = await opened();
    await f.manager.navigate(tab.id, "smarbill.ro");
    expect(loads(guest)).toEqual(["https://smarbill.ro/", search]);
    expect(f.manager.list()[0]).toMatchObject({ url: search, error: null, canGoBack: true });
    // No error on the way to the results, not even for a frame.
    expect(errors(f)).toEqual([]);
    expect(entries).toEqual(["https://example.com/", search]);
  });

  it("fails as before for the model, for an address given with its scheme, and when the search cannot load either", async () => {
    const { f, tab, guest, unknown } = await opened();
    await expect(f.manager.navigate(tab.id, "smarbill.ro", undefined, "chat")).rejects.toThrow("Could not load smarbill.ro.");
    await expect(f.manager.navigate(tab.id, "https://smarbill.ro")).rejects.toThrow("Could not load smarbill.ro.");
    expect(loads(guest)).toEqual(["https://smarbill.ro/", "https://smarbill.ro/"]);
    // The load reports its own failure, once, in words — not Chromium's code first.
    expect(errors(f)).toEqual(["Could not load smarbill.ro.", "Could not load smarbill.ro."]);
    unknown.add("www.google.com");
    guest.loadURL.mockClear();
    await expect(f.manager.navigate(tab.id, "smarbill.ro")).rejects.toThrow("Could not load www.google.com.");
    expect(loads(guest)).toEqual(["https://smarbill.ro/", search]);
  });

  it("leaves a failure the page itself ran into to the page's own error", async () => {
    const { f, guest } = await opened();
    guest.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://gone.example.org/", true);
    expect(f.manager.list()[0]).toMatchObject({ url: "https://gone.example.org/", error: "ERR_NAME_NOT_RESOLVED" });
    expect(guest.loadURL).not.toHaveBeenCalled();
  });
});
