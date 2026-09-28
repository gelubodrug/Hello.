import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { DataStore } from "../src/main/data/store";
import type { ChatService } from "../src/main/chat/service";
import type { MainTerminalService } from "../src/main/terminal/service";
import type { BrowserManager } from "../src/main/browser/manager";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const bridge = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  openExternal: vi.fn(),
  showSaveDialog: vi.fn(),
  showOpenDialog: vi.fn(),
  notices: [] as Array<{ options: { title: string; body: string }; listeners: Map<string, () => void>; show: ReturnType<typeof vi.fn> }>,
  setBadgeCount: vi.fn(),
}));
vi.mock("electron", () => ({
   ipcMain: {
     handle: (name: string, handler: Handler) =>
       bridge.handlers.set(name, handler),
     removeHandler: (name: string) => bridge.handlers.delete(name),
   },
   dialog: {
     showSaveDialog: bridge.showSaveDialog,
     showOpenDialog: bridge.showOpenDialog,
   },
   shell: { openExternal: bridge.openExternal, showItemInFolder: vi.fn() },
   app: { getVersion: () => "0.1.0", setBadgeCount: bridge.setBadgeCount },
   Notification: class {
     static isSupported() { return true; }
     listeners = new Map<string, () => void>();
     show = vi.fn();
     constructor(readonly options: { title: string; body: string }) { bridge.notices.push(this); }
     on(name: string, listener: () => void) { this.listeners.set(name, listener); return this; }
   },
 }));
import { registerIPC } from "../src/main/ipc";

const unregisters: Array<() => void> = [];
beforeEach(() => {
  bridge.handlers.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  for (const unregister of unregisters.splice(0)) unregister();
});
function fixture() {
  const frame = {};
  const window = {
    webContents: { mainFrame: frame, send: vi.fn() },
    isDestroyed: () => false, isMinimized: () => true, restore: vi.fn(), show: vi.fn(), focus: vi.fn(),
  };
  const store = {
    getConversation: vi.fn((id: string) => { if (id !== "chat") throw new Error("Conversation not found."); return { id }; }),
    dataDir: "/temporary/hello-test",
    getApiKey: vi.fn(() => ""),
    listConversations: vi.fn(() => []),
    getSettings: vi.fn(() => ({ apiKeySet: false })),
    deleteConversation: vi.fn(),
  };
  const chat = { deleteSession: vi.fn(async (_id: string) => {}), library: { list: vi.fn(async () => []) } };
  const terminal = {
    workers: vi.fn(() => []),
    list: vi.fn(() => [
      { id: "own-terminal", conversationId: "chat" },
      { id: "other-terminal", conversationId: "other" },
    ]),
    close: vi.fn(),
  };
  const browser = {
    list: vi.fn(() => []),
    closeConversation: vi.fn(),
    control: vi.fn(),
    navigate: vi.fn(),
  };
  const unregister = registerIPC(
    window as unknown as BrowserWindow,
    store as unknown as DataStore,
    chat as unknown as ChatService,
    terminal as unknown as MainTerminalService,
    browser as unknown as BrowserManager,
  );
  unregisters.push(unregister);
  const event = { sender: window.webContents, senderFrame: frame };
  const call = (name: string, ...args: unknown[]) =>
    bridge.handlers.get(`hello:${name}`)!(event, ...args);
  return { window, store, chat, terminal, browser, event, call, unregister };
}

describe("app IPC trust boundary", () => {
  it("rejects remote webContents and app subframes on every registered channel", async () => {
    const f = fixture();
    expect(bridge.handlers.size).toBeGreaterThan(30);
    for (const handler of bridge.handlers.values()) {
      await expect(
        handler({
          sender: { mainFrame: {} },
          senderFrame: f.event.senderFrame,
        }),
      ).rejects.toThrow("Untrusted IPC sender");
      await expect(
        handler({ sender: f.window.webContents, senderFrame: {} }),
      ).rejects.toThrow("Untrusted IPC sender");
    }
    expect(f.store.getApiKey).not.toHaveBeenCalled();
    expect(f.store.listConversations).not.toHaveBeenCalled();
    expect(f.terminal.close).not.toHaveBeenCalled();
  });

  it("only bootstraps from the current main frame, not a previous frame after reload", async () => {
    const f = fixture();
    const oldFrame = f.window.webContents.mainFrame;
    f.window.webContents.mainFrame = {};
    await expect(
      bridge.handlers.get("hello:bootstrap")!({
        sender: f.window.webContents,
        senderFrame: oldFrame,
      }),
    ).rejects.toThrow("Untrusted");
    await expect(
      bridge.handlers.get("hello:bootstrap")!({
        sender: f.window.webContents,
        senderFrame: f.window.webContents.mainFrame,
      }),
    ).resolves.toMatchObject({ settings: { apiKeySet: false }, browsers: [] });
  });

  it("removes every channel when the app is shutting down", () => {
    const f = fixture();
    f.unregister();
    expect(bridge.handlers.size).toBe(0);
  });

  it("waits for Pi session cleanup before deleting conversation storage and native children", async () => {
    const f = fixture();
    let stopped!: () => void;
    f.chat.deleteSession.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          stopped = resolve;
        }),
    );
    const deletion = f.call("conversations.delete", "chat");
    expect(f.terminal.close).not.toHaveBeenCalled();
    expect(f.browser.closeConversation).not.toHaveBeenCalled();
    expect(f.store.deleteConversation).not.toHaveBeenCalled();
    stopped();
    await deletion;
    expect(f.chat.deleteSession).toHaveBeenCalledWith("chat");
    expect(f.terminal.close.mock.calls).toEqual([["own-terminal"]]);
    expect(f.browser.closeConversation.mock.calls).toEqual([["chat"]]);
    expect(f.store.deleteConversation.mock.calls).toEqual([["chat"]]);
  });

  it("never hands executable, file or credential-bearing URLs to the operating system", async () => {
    const f = fixture();
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "hello://app/index.html",
      "data:text/html,test",
      "https://name:password@example.com",
    ]) {
      await expect(f.call("system.openExternal", url)).rejects.toThrow();
    }
    expect(bridge.openExternal).not.toHaveBeenCalled();
    await f.call("system.openExternal", "https://example.com/docs");
    expect(bridge.openExternal.mock.calls).toEqual([
      ["https://example.com/docs"],
    ]);
  });

  it("validates app browser action names before dispatch and never interpolates a command", async () => {
    const f = fixture();
    await expect(
      f.call("browser.action", "tab", "executeJavaScript"),
    ).rejects.toThrow("Unknown browser action");
    await expect(
      f.call("browser.navigate", "tab", { url: "https://example.com" }),
    ).rejects.toThrow("Invalid address");
    expect(f.browser.navigate).not.toHaveBeenCalled();
  });
});

// A chat waiting while the person is elsewhere: a native notification that
// brings that chat forward, and the count on the Dock (user, 28.09).
describe("notifications and the Dock", () => {
  it("shows a notification for a chat of this app, and a click brings the window and that chat forward", async () => {
    const f = fixture();
    bridge.notices.length = 0;
    await expect(f.call("system.notify", { title: "Invoices", body: "Saved all four invoices.", conversationId: "chat" })).resolves.toBe(true);
    const [shown] = bridge.notices;
    expect(shown.options).toEqual({ title: "Invoices", body: "Saved all four invoices." });
    expect(shown.show).toHaveBeenCalledOnce();
    shown.listeners.get("click")!();
    expect(f.window.restore).toHaveBeenCalled();
    expect(f.window.focus).toHaveBeenCalled();
    expect(f.window.webContents.send).toHaveBeenCalledWith("hello:focus-conversation", "chat");
    await expect(f.call("system.notify", { title: "x", body: "y", conversationId: "someone-else" })).rejects.toThrow(/not found/);
    expect(bridge.notices).toHaveLength(1);
  });

  it("sets the Dock count, and clears it for anything that is not a small whole number", async () => {
    const f = fixture();
    await f.call("system.badge", 3);
    expect(bridge.setBadgeCount).toHaveBeenLastCalledWith(3);
    for (const odd of [-1, 2.5, "7", 5000, undefined]) {
      await f.call("system.badge", odd);
      expect(bridge.setBadgeCount).toHaveBeenLastCalledWith(0);
    }
  });
});
