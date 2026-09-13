// Invariant: the browser the app shipped with at dbfb5eb is unchanged by page modes (cb4522c) — only added to.
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
    executeJavaScriptInIsolatedWorld = vi.fn(async (_world: number, scripts: Array<{ code: string }>) =>
      // The page-mode long poll never answers here; everything else succeeds.
      scripts[0].code.includes('.wait(') ? new Promise(() => {}) : true);
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
    clipboard: { writeText: vi.fn(), write: vi.fn() },
    ClipboardItem: class {},
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
  type BrowserPageEvent,
} from "../src/main/browser/manager";
import { PageModeController } from "../src/main/browser/page-mode";
import { EventEmitter as Emitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type FakeGuest = EventEmitter & {
  destroyed: boolean;
  close: ReturnType<typeof vi.fn>;
  executeJavaScriptInIsolatedWorld: ReturnType<typeof vi.fn>;
};
const services: Array<{ dispose(): void }> = [];
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const dirs: string[] = [];

function fixture() {
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
    initial: [],
    conversationExists: (id) => ["chat", "other"].includes(id),
    save, remove, emit, lifecycle,
  });
  services.push(manager);
  const guests: FakeGuest[] = [];
  const attach = (tabId: string) => {
    const source = manager.mintAttach(tabId);
    const preferences: Record<string, unknown> = {};
    if (!manager.approveGuestAttach(preferences as never, { src: source } as never))
      throw new Error("refused");
    const guest = native.makeGuest(preferences.session) as FakeGuest & { hostWebContents: unknown };
    guest.hostWebContents = window.webContents;
    manager.adoptGuest(guest as never);
    guests.push(guest);
    return guest;
  };
  return { manager, window, save, remove, emit, lifecycle, attach, guests };
}
type Fixture = ReturnType<typeof fixture>;

/** Every observable output of the manager, with random ids made ordinal. */
function trace(f: Fixture) {
  const raw = JSON.stringify({
    emit: f.emit.mock.calls,
    save: f.save.mock.calls,
    remove: f.remove.mock.calls,
    lifecycle: f.lifecycle.mock.calls,
    list: f.manager.list(),
    closes: f.guests.map((guest) => guest.close.mock.calls.length),
    destroyed: f.guests.map((guest) => guest.destroyed),
    loads: f.guests.map((guest) => (guest as unknown as { loadURL: { mock: { calls: unknown[] } } }).loadURL.mock.calls),
    windowOpen: f.guests.map((guest) => (guest as unknown as { setWindowOpenHandler: { mock: { calls: unknown[] } } }).setWindowOpenHandler.mock.calls.length),
  });
  const ids = new Map<string, string>();
  return raw.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
    if (!ids.has(id)) ids.set(id, `ID${ids.size}`);
    return ids.get(id)!;
  });
}

/**
 * The browser's existing life, start to end: open, load, show, grant, a second
 * tab, switch, read, park (pane closed), unmount, revoke, close. `during`
 * runs once the first page is readable, to let page modes join in.
 */
async function scenario(f: Fixture, during: (tabId: string) => Promise<void> = async () => {}) {
  const tab = f.manager.create("chat", "https://example.com");
  const first = f.attach(tab.id);
  f.manager.setActive(tab.id);
  first.emit("did-stop-loading");
  await flush();
  f.manager.control(tab.id, "read");
  await during(tab.id);
  const second = f.manager.create("chat", "https://example.org");
  const other = f.attach(second.id);
  other.emit("did-stop-loading");
  f.manager.setActive(second.id);
  f.manager.setActive(tab.id);
  await f.manager.read(tab.id, "chat");
  // The pane closes: its page stays mounted and parked.
  f.manager.setActive(null);
  await flush();
  f.manager.detach(second.id);
  f.manager.control(tab.id, "off");
  f.manager.close(tab.id, true);
  await flush();
  return trace(f);
}

beforeEach(() => {
  native.views.length = 0;
  native.guests.length = 0;
  native.nextLoad = undefined;
  native.partitions.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  for (const service of services.splice(0).reverse()) service.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("browser invariant: page observers only watch", () => {
  it("emits, saves, removes, closes and loads exactly as with no observer, even when an observer throws", async () => {
    const baseline = await scenario(fixture());
    const observed = fixture();
    const events: BrowserPageEvent[] = [];
    observed.manager.observePages((event) => { events.push(event); throw new Error("observer bug"); });
    expect(await scenario(observed)).toBe(baseline);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["updated", "active", "detached", "closed"]));
  });

  it("tells observers only after the window was told and the tab was saved", async () => {
    const f = fixture();
    const seen: Array<{ type: string; emitted: number; saved: number }> = [];
    f.manager.observePages((event) => seen.push({ type: event.type, emitted: f.emit.mock.calls.length, saved: f.save.mock.calls.length }));
    const tab = f.manager.create("chat", "https://example.com");
    expect(seen).toEqual([{ type: "updated", emitted: 1, saved: 1 }]);
    f.attach(tab.id);
    f.manager.control(tab.id, "read");
    const last = seen.at(-1)!;
    expect(last.type).toBe("updated");
    expect(last.emitted).toBe(f.emit.mock.calls.length);
    expect(last.saved).toBe(f.save.mock.calls.length);
    // Close: removed from the database before observers hear, lifecycle after.
    f.manager.observePages((event) => {
      if (event.type === "closed") {
        expect(f.remove).toHaveBeenCalledWith(tab.id);
        expect(f.lifecycle).not.toHaveBeenCalled();
        expect(f.manager.pageFor(tab.id)).toBeUndefined();
      }
    });
    f.manager.close(tab.id, true);
    expect(f.lifecycle).toHaveBeenCalledOnce();
  });

  it("pageFor hands out a copy and never a destroyed page", () => {
    const f = fixture();
    const tab = f.manager.create("chat", "https://example.com");
    const guest = f.attach(tab.id);
    const page = f.manager.pageFor(tab.id)!;
    expect(page.contents).toBe(guest);
    page.tab.control = "full";
    page.tab.url = "https://evil.example";
    expect(f.manager.list()[0]).toMatchObject({ control: "off", url: tab.url });
    f.manager.detach(tab.id);
    expect(f.manager.pageFor(tab.id)).toEqual({ tab: expect.objectContaining({ id: tab.id }) });
    expect(f.manager.pageFor(tab.id)!.contents).toBeUndefined();
  });
});

describe("browser invariant: an armed page mode never changes the browser", () => {
  const controller = (f: Fixture) => {
    const dataDir = mkdtempSync(join(tmpdir(), "hello-invariant-"));
    dirs.push(dataDir);
    const events: unknown[] = [];
    const modes = new PageModeController({ pages: f.manager, dataDir, kinds: ["design", "annotate"], emit: (event) => events.push(event) });
    services.push(modes);
    return { modes, events };
  };

  it("leaves every manager output identical while Design is armed through show, park, unmount, revoke and close", async () => {
    const baseline = await scenario(fixture());
    const f = fixture();
    const { modes, events } = controller(f);
    let armed = false;
    const result = await scenario(f, async (tabId) => {
      await modes.arm(tabId, "design");
      armed = modes.armed(tabId) !== null;
    });
    expect(armed).toBe(true);
    expect(result).toBe(baseline);
    // It ended on its own as the page stopped being shown, without touching it.
    expect(events).toContainEqual(expect.objectContaining({ type: "exit", reason: "hidden" }));
  });

  it("parks a hidden page instead of closing it, and gives the guest its listeners back", async () => {
    const f = fixture();
    const { modes } = controller(f);
    const tab = f.manager.create("chat", "https://example.com");
    const guest = f.attach(tab.id);
    f.manager.setActive(tab.id);
    guest.emit("did-stop-loading");
    f.manager.control(tab.id, "read");
    const names = ["before-input-event", "did-start-navigation", "render-process-gone", "destroyed", "did-stop-loading", "did-navigate"];
    const before = names.map((name) => guest.listenerCount(name));
    await modes.arm(tab.id, "annotate");
    expect(names.map((name) => guest.listenerCount(name))).not.toEqual(before);
    // The pane closes: the mode ends, the page does not.
    f.manager.setActive(null);
    expect(modes.armed(tab.id)).toBeNull();
    expect(guest.close).not.toHaveBeenCalled();
    expect(guest.destroyed).toBe(false);
    expect(f.manager.pageFor(tab.id)?.contents).toBe(guest);
    expect(names.map((name) => guest.listenerCount(name))).toEqual(before);
    // And the parked page is still readable by the existing flow.
    await expect(f.manager.read(tab.id, "chat")).resolves.toMatchObject({ text: "Page text" });
  });

  it("an arming does not outlive its page: unmount closes the guest exactly as before and ends the mode", async () => {
    const f = fixture();
    const { modes, events } = controller(f);
    const tab = f.manager.create("chat", "https://example.com");
    const guest = f.attach(tab.id);
    f.manager.setActive(tab.id);
    guest.emit("did-stop-loading");
    f.manager.control(tab.id, "read");
    await modes.arm(tab.id, "design");
    f.manager.detach(tab.id);
    expect(guest.close).toHaveBeenCalledOnce();
    expect(modes.armed(tab.id)).toBeNull();
    expect(f.manager.list().map((item) => item.id)).toEqual([tab.id]);
    expect(events).toContainEqual(expect.objectContaining({ type: "exit" }));
  });
});
