// @vitest-environment jsdom
// Composer attachment chips: double-click (or Enter) on a picture opens it in a
// dialog read back through main. API mocks mirror tests/page-mode-annotate-composer.test.tsx.
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, ChatAttachment, Conversation, HelloAPI } from "../src/shared/types";
import { ConversationView } from "../src/renderer/chat/ConversationView";

const mocks = vi.hoisted(() => ({
  extensionsList: vi.fn<HelloAPI['extensions']['list']>(async () => []),
  extensionsActive: vi.fn<HelloAPI['extensions']['active']>(async () => []),
  extensionsSetActive: vi.fn<HelloAPI['extensions']['setActive']>(async () => []),
  extensionsStatus: vi.fn<HelloAPI['extensions']['status']>(async () => []),
  extensionsDiscover: vi.fn<HelloAPI['extensions']['discover']>(),
  extensionsImportDiscovered: vi.fn<HelloAPI['extensions']['importDiscovered']>(),
  send: vi.fn(),
  attach: vi.fn(),
  previewAttachment: vi.fn(),
  pathsForFiles: vi.fn(),
  conversationUpdate: vi.fn(),
  stop: vi.fn(),
  retry: vi.fn(),
  approve: vi.fn(),
  models: vi.fn(),
  catalog: vi.fn(),
  settingsSave: vi.fn(),
  settingsRemember: vi.fn(),
  settingsUse: vi.fn(),
  settingsForget: vi.fn(),
  notebookList: vi.fn(),
  notebookSave: vi.fn(),
  notebookDelete: vi.fn(),
  notebookOnChange: vi.fn(),
  copy: vi.fn(),
}));
vi.mock("../src/renderer/api", () => ({
  api: {
    chat: {
      attach: mocks.attach,
      previewAttachment: mocks.previewAttachment,
      send: mocks.send,
      stop: mocks.stop,
      retry: mocks.retry,
      approve: mocks.approve,
      onEvent: vi.fn(() => () => {}),
    },
    settings: {
      catalog: mocks.catalog,
      models: mocks.models,
      save: mocks.settingsSave,
      rememberConnection: mocks.settingsRemember,
      useConnection: mocks.settingsUse,
      forgetConnection: mocks.settingsForget,
    },
    notebooks: {
      list: mocks.notebookList,
      save: mocks.notebookSave,
      delete: mocks.notebookDelete,
      onChange: mocks.notebookOnChange,
    },
    system: { pathsForFiles: mocks.pathsForFiles, openExternal: vi.fn().mockResolvedValue(undefined), copy: mocks.copy },
    conversations: { update: mocks.conversationUpdate },
    extensions: {
      list: mocks.extensionsList,
      active: mocks.extensionsActive,
      setActive: mocks.extensionsSetActive,
      status: mocks.extensionsStatus,
      discover: mocks.extensionsDiscover,
      importDiscovered: mocks.extensionsImportDiscovered,
      onChange: vi.fn(() => () => {}),
    },
  },
  onNativeBrowserFocus: vi.fn(() => () => {}),
}));
vi.mock("shiki", () => ({
  codeToTokens: async (code: string) => ({
    tokens: [[{ content: code, color: "#fff" }]],
  }),
}));

let root: Root;
let host: HTMLDivElement;
const conversation: Conversation = { id: "preview-chat", title: "Preview", folder: null, createdAt: 1, updatedAt: 1 };
const settings: AppSettings = { endpointUrl: "http://localhost:1234/v1", model: "test-model", apiKeySet: false, temperature: 0.7, systemPrompt: "", connections: [] };
const PICTURE_URL = "data:image/png;base64,iVBORw0KGgo=";
const picture: ChatAttachment = { id: "ff7aa255-0000-4000-8000-000000000001", name: "ff7aa255-capture.png", kind: "image", size: 10 };
const notes: ChatAttachment = { id: "ff7aa255-0000-4000-8000-000000000002", name: "notes.txt", kind: "text", size: 4 };
const view = () =>
  createElement(ConversationView, {
    conversation, settings, messages: [], workers: [],
    onSettingsChange: vi.fn(), onFolderChange: vi.fn(), onTerminal: vi.fn(), onWorker: vi.fn(),
    quote: null, onQuoteConsumed: vi.fn(), reportError: vi.fn(),
  });
const chip = (name: string) => [...document.querySelectorAll<HTMLElement>(".composer-attachment")].find(item => item.title === name)!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const dblclick = async (target: Element) => {
  await act(async () => { target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
};
const key = async (target: Element, name: string) => {
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); });
};
const render = async (items: ChatAttachment[]) => {
  localStorage.setItem(`hello.draft.${conversation.id}.attachments`, JSON.stringify(items));
  await act(async () => { root.render(view()); });
};

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  // Node ≥ 25 exposes its own (unconfigured, undefined) localStorage over jsdom's; give the composer a real one.
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); }, clear: () => store.clear(), key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  mocks.send.mockResolvedValue(undefined);
  mocks.previewAttachment.mockResolvedValue(PICTURE_URL);
  mocks.stop.mockResolvedValue(undefined);
  mocks.approve.mockResolvedValue(undefined);
  mocks.copy.mockResolvedValue(undefined);
  mocks.conversationUpdate.mockImplementation(async (id, patch) => ({ ...conversation, id, ...patch }));
  mocks.extensionsDiscover.mockResolvedValue({ mcp: [], skills: [] });
  mocks.notebookList.mockResolvedValue([]);
  mocks.notebookOnChange.mockImplementation(() => () => {});
  mocks.models.mockResolvedValue([{ id: "test-model" }]);
  mocks.catalog.mockResolvedValue([{ endpointUrl: settings.endpointUrl, models: [{ id: settings.model }] }]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("composer attachment preview", () => {
  it('warns about pictures and screenshots for a listed text-only model', async () => {
    mocks.catalog.mockResolvedValue([{ endpointUrl: settings.endpointUrl, models: [{ id: settings.model, vision: false }] }]);
    await render([picture]);
    expect(host.textContent).toContain('This model is text-only and cannot read images or screenshots.');
  });
  it("double-clicking an image chip opens its picture in a dialog; Escape closes it", async () => {
    await render([picture, notes]);
    await dblclick(chip(picture.name));
    expect(mocks.previewAttachment).toHaveBeenCalledWith(conversation.id, picture.id);
    expect(dialog()?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.getElementById(dialog()!.getAttribute("aria-labelledby")!)?.textContent).toBe(picture.name);
    const image = dialog()!.querySelector("img")!;
    expect(image.getAttribute("src")).toBe(PICTURE_URL);
    expect(image.alt).toBe(picture.name);
    await key(document.activeElement ?? dialog()!, "Escape");
    expect(dialog()).toBeNull();
    // Closing is only closing: the chip is still there to send.
    expect(chip(picture.name)).toBeTruthy();
  });

  it("a non-image chip does not open a preview and is not a focus stop", async () => {
    await render([picture, notes]);
    await dblclick(chip(notes.name));
    await key(chip(notes.name), "Enter");
    expect(chip(notes.name).hasAttribute("tabindex")).toBe(false);
    expect(mocks.previewAttachment).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it("Enter on a focused image chip opens it; the backdrop and the close button close it", async () => {
    await render([picture]);
    const target = chip(picture.name);
    expect(target.tabIndex).toBe(0);
    await key(target, "Enter");
    expect(dialog()).not.toBeNull();
    await act(async () => { document.querySelector<HTMLElement>(".dialog-backdrop")!.click(); });
    expect(dialog()).toBeNull();
    await dblclick(chip(picture.name));
    // A click inside the picture is not a click on the backdrop.
    await act(async () => { dialog()!.querySelector("img")!.click(); });
    expect(dialog()).not.toBeNull();
    await act(async () => { dialog()!.querySelector<HTMLElement>(`button[aria-label="Close ${picture.name}"]`)!.click(); });
    expect(dialog()).toBeNull();
  });

  it("a picture main refuses shows the reason instead of an image", async () => {
    mocks.previewAttachment.mockRejectedValueOnce(new Error("This attachment changed on disk. Drop the file again."));
    await render([picture]);
    await dblclick(chip(picture.name));
    expect(dialog()?.querySelector("img")).toBeNull();
    expect(dialog()?.textContent).toContain("This attachment changed on disk.");
  });

  it("clicking the remove button still removes the chip without opening a preview", async () => {
    await render([picture]);
    const remove = document.querySelector<HTMLElement>(`button[aria-label="Remove attachment ${picture.name}"]`)!;
    await act(async () => { remove.click(); });
    expect(document.querySelector(".composer-attachments")).toBeNull();
    expect(mocks.previewAttachment).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });
});
