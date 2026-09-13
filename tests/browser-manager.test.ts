import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, HandlerDetails, WindowOpenHandlerResponse } from "electron";
import type { BrowserTab } from "../src/shared/types";

const native = vi.hoisted(() => ({
  views: [] as unknown[],
  guests: [] as unknown[],
  /** The window's own page: a guest must name it as its host. */
  host: null as unknown,
  makeGuest: null as unknown as (session: unknown) => unknown,
  partition: null as unknown,
  partitions: new Map<string, unknown>(),
  nextLoad: undefined as Promise<void> | undefined,
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
        .fn<() => Promise<unknown>>()
        .mockResolvedValue("Page text"),
      isDestroyed: () => this.destroyed,
    };
    executeJavaScript = vi.fn();
    setWindowOpenHandler = vi.fn();
    isDestroyed = () => this.destroyed;
    isLoading = () => this.loading;
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
} from "../src/main/browser/manager";
import { EventEmitter as Emitter } from "node:events";

type FakeGuest = EventEmitter & {
  session: unknown;
  hostWebContents: unknown;
  destroyed: boolean;
  loading: boolean;
  url: string;
  mainFrame: {
    executeJavaScript: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
    isDestroyed(): boolean;
  };
  executeJavaScript: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;
  stop: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
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
function fixture(options: BrowserTab[] | { initial?: BrowserTab[]; serve?: (conversationId: string, source: string) => Promise<string> } = []) {
  const { initial = [], serve } = Array.isArray(options) ? { initial: options } : options;
  const window = {
    webContents: new Emitter(),
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 1000, height: 800 }),
  };
  native.host = window.webContents;
  const save = vi.fn();
  const remove = vi.fn();
  const emit = vi.fn();
  const lifecycle = vi.fn();
  const manager = new BrowserManager({
    window: window as unknown as BrowserWindow,
    initial,
    conversationExists: (id) => ["chat", "other"].includes(id),
    save,
    remove,
    emit,
    lifecycle,
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
  return { manager, window, save, remove, emit, lifecycle, open, attach };
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

  it("starts and restores every grant Off, never persists grants, and validates restored URLs", () => {
    const saved: BrowserTab = {
      id: "old",
      conversationId: "chat",
      title: "Old",
      url: "file:///etc/passwd",
      control: "full",
      loading: true,
      canGoBack: true,
      canGoForward: true,
    };
    const f = fixture([saved]);
    expect(f.manager.list()[0]).toMatchObject({
      url: "about:blank",
      control: "off",
      loading: false,
      canGoBack: false,
    });
    const tab = f.open();
    expect(tab.control).toBe("off");
    f.manager.control(tab.id, "full");
    expect(
      f.manager.list("chat").find((item) => item.id === tab.id)?.control,
    ).toBe("full");
    expect(f.save.mock.calls.at(-1)?.[0].control).toBe("off");
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

  it("opens a popup as a child window pinned to this manager's preferences, not as a tab", () => {
    const f = fixture();
    const parent = f.open();
    const { response } = popup(guestAt());
    expect(response.action).toBe("allow");
    expect(response.outlivesOpener).toBe(true);
    expect(response.overrideBrowserWindowOptions?.webPreferences).toEqual(
      pinnedPreferences("persist:hello-web", native.partition),
    );
    expect(response.overrideBrowserWindowOptions?.webPreferences).not.toHaveProperty("preload");
    // A child window is not a tab: nothing is opened, saved or announced.
    expect(f.manager.list("chat").map((tab) => tab.id)).toEqual([parent.id]);
    expect(f.lifecycle).not.toHaveBeenCalled();
    expect(native.guests).toHaveLength(1);
    expect(guestAt().loadURL).toHaveBeenCalledOnce();
  });

  it("denies a non-web popup and makes even a background-tab popup a child window, not a deferred tab", () => {
    const f = fixture();
    const parent = f.open();
    for (const url of ["file:///private/file", "javascript:alert(1)", "https://user:secret@example.com"])
      expect(popup(guestAt(), { url }).response).toEqual({ action: "deny" });
    const { response } = popup(guestAt(), {
      disposition: "background-tab", features: "", frameName: "_blank",
      url: "https://example.com/result",
      postBody: { contentType: "application/x-www-form-urlencoded", data: [{ type: "rawData", bytes: Buffer.from("q=example") }] },
    });
    expect(response.action).toBe("allow");
    expect(response.overrideBrowserWindowOptions?.webPreferences).toEqual(
      pinnedPreferences("persist:hello-web", native.partition),
    );
    expect(f.manager.list("chat").map((tab) => tab.id)).toEqual([parent.id]);
    expect(f.lifecycle).not.toHaveBeenCalled();
    expect(guestAt().loadURL).toHaveBeenCalledOnce();
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
    const action = f.manager.agentAction("chat", tab.id, "click", "#link", "", controller.signal);
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
        f.manager.agentAction("chat", tab.id, action, "#save"),
      ).rejects.toThrow(/read only/);
    }
    await expect(f.manager.read(tab.id, "other")).rejects.toThrow(
      /different chat/,
    );
    expect(guestAt().mainFrame.executeJavaScript).not.toHaveBeenCalled();
    await expect(f.manager.read(tab.id, "chat")).resolves.toMatchObject({
      text: "Page text",
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

  it("inherits the opener's isolated preview session for a popup's child window", async () => {
    const f = fixture();
    const opening = f.manager.agentOpen('chat', 'http://127.0.0.1:4321/local/index.html', undefined, { isolated: true });
    const { guest, preferences } = f.attach(f.manager.list('chat')[0].id);
    await opening;
    const { response } = popup(guest);
    expect(response.action).toBe('allow');
    expect(response.overrideBrowserWindowOptions?.webPreferences).toEqual(
      pinnedPreferences(preferences.partition as string, preferences.session),
    );
    expect(response.overrideBrowserWindowOptions?.webPreferences?.session).not.toBe(native.partition);
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
      f.manager.agentAction("chat", tab.id, "click", "#save"),
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
      const action = f.manager.agentAction("chat", tab.id, "click", "#save");
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
    const action = f.manager.agentAction("chat", tab.id, "click", "#save");
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
      "#name",
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
    const action = f.manager.agentAction("chat", tab.id, "scroll", "", 100);
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
        "#save",
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
    await expect(reading).resolves.toMatchObject({ text: "Page text" });
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
    const action = f.manager.agentAction("chat", tab.id, "click", "#save");
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
