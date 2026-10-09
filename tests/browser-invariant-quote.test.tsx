// @vitest-environment jsdom
// Invariant: the old "Add page to chat" quote (plain text, quoted with "> ") builds exactly the draft dbfb5eb built.
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppSettings,
  HelloAPI,
  LibraryResource,
  ChatQuote,
  ChatQuoteExtra,
  Conversation,
  Message,
  NotebookChange,
  NotebookEntry,
} from "../src/shared/types";
import {
  ConversationView,
  MessageContent,
  ThinkingPart,
  ToolPart,
} from "../src/renderer/chat/ConversationView";
import { Notebook } from "../src/renderer/notebook/Notebook";
import { MenuButton } from "../src/renderer/ui/primitives";
import { SettingsDialog } from "../src/renderer/settings/SettingsDialog";
import { ExtensionsPicker } from "../src/renderer/chat/ExtensionsPicker";

const mocks = vi.hoisted(() => ({
  extensionsList: vi.fn<HelloAPI['extensions']['list']>(async () => []),
  extensionsActive: vi.fn<HelloAPI['extensions']['active']>(async () => []),
  extensionsSetActive: vi.fn<HelloAPI['extensions']['setActive']>(async () => []),
  extensionsStatus: vi.fn<HelloAPI['extensions']['status']>(async () => []),
  extensionsDiscover: vi.fn<HelloAPI['extensions']['discover']>(),
  extensionsImportDiscovered: vi.fn<HelloAPI['extensions']['importDiscovered']>(),
  send: vi.fn(),
  attach: vi.fn(),
  pathsForFiles: vi.fn(),
  conversationUpdate: vi.fn(),
  stop: vi.fn(),
  retry: vi.fn(),
  approve: vi.fn(),
  models: vi.fn(),
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
      send: mocks.send,
      stop: mocks.stop,
      retry: mocks.retry,
      approve: mocks.approve,
      onEvent: vi.fn(() => () => {}),
    },
    settings: {
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
const conversation: Conversation = {
  id: "test-chat",
  title: "Test conversation",
  folder: null,
  createdAt: 1,
  updatedAt: 1,
};
const settings: AppSettings = {
  endpointUrl: "http://localhost:1234/v1",
  model: "test-model",
  apiKeySet: false,
  temperature: 0.7,
  systemPrompt: "",
  connections: [],
};
const onSettingsChange = vi.fn();
const onError = vi.fn();

async function render(node: ReactElement) {
  await act(async () => {
    root.render(node);
  });
}
async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}
async function fill(
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  await act(async () => {
    const prototype =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      field,
      value,
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
/** The input a form label names, matched on the label's own text. */
function field(label: string) {
  const node = [...document.querySelectorAll("label")]
    .find(item => item.firstChild?.textContent?.trim() === label)
    ?.querySelector("input");
  expect(node, `field ${label}`).toBeDefined();
  return node!;
}
/** A menu entry, matched on its label and not on the detail line under it. */
function menuItem(label: string) {
  const node = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    item => (item.querySelector(".menu-item-copy")?.firstChild?.textContent ?? item.textContent)?.trim() === label,
  );
  expect(node, `menu item ${label}`).toBeDefined();
  return node!;
}
function button(label: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) =>
      item.getAttribute("aria-label") === label ||
      item.textContent?.trim() === label,
  );
  expect(node, `button ${label}`).toBeDefined();
  return node!;
}
const view = (messages: Message[] = []) =>
  createElement(ConversationView, {
    conversation,
    settings,
    messages,
    workers: [],
    onSettingsChange,
    onFolderChange: vi.fn(),
    onTerminal: vi.fn(),
    onWorker: vi.fn(),
    quote: null,
    onQuoteConsumed: vi.fn(),
    reportError: onError,
  });

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.copy.mockResolvedValue(undefined);
  window.getSelection()?.removeAllRanges();
  // Node ≥ 25 exposes its own (unconfigured, undefined) localStorage over jsdom's; give the composer a real one.
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); }, clear: () => store.clear(), key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  mocks.send.mockResolvedValue(undefined);
  mocks.attach.mockResolvedValue({ attachments: [{ id: 'image-id', name: 'diagram.png', kind: 'image', size: 100 }] });
  mocks.pathsForFiles.mockReturnValue(['/drops/diagram.png']);
  mocks.conversationUpdate.mockImplementation(async (id, patch) => ({ ...conversation, id, ...patch }));
  mocks.stop.mockResolvedValue(undefined);
  mocks.approve.mockResolvedValue(undefined);
  mocks.models.mockResolvedValue([{ id: "test-model" }, { id: "second-model" }]);
  mocks.extensionsDiscover.mockResolvedValue({ mcp: [], skills: [] });
  mocks.settingsSave.mockImplementation(async (patch) => ({
    ...settings,
    ...patch,
  }));
  mocks.notebookList.mockResolvedValue([]);
  mocks.notebookSave.mockImplementation(async (entry) => ({
    ...entry,
    id: entry.id || "new-entry",
    createdAt: 1,
    updatedAt: Date.now(),
  }));
  mocks.notebookDelete.mockResolvedValue(undefined);
  mocks.notebookOnChange.mockImplementation(() => () => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

/** ConversationView's quote effect exactly as it was at dbfb5eb, when a quote was a string. */
const draftAtBase = (current: string, quote: string) =>
  `${current}${current ? "\n\n" : ""}${quote
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}\n\n`;
const withQuote = (quote: ChatQuote | null, onQuoteConsumed = vi.fn()) =>
  createElement(ConversationView, {
    conversation,
    settings,
    messages: [],
    workers: [],
    onSettingsChange,
    onFolderChange: vi.fn(),
    onTerminal: vi.fn(),
    onWorker: vi.fn(),
    quote,
    onQuoteConsumed,
    reportError: onError,
  });
/** What BrowserPane's "Add page to chat" hands App, and App hands the view: `{ ...undefined, text }`. */
const pageQuote = (text: string): ChatQuote => ({ ...(undefined as ChatQuoteExtra | undefined), text });
const page = "Page: Example Domain\nSource: https://example.com/\n\nExample Domain\n\n  indented > line\n\nMore information...";

describe("browser invariant: the page quote draft", () => {
  it("builds the same draft as before into an empty composer", async () => {
    const consumed = vi.fn();
    await render(withQuote(pageQuote(page), consumed));
    const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
    expect(field.value).toBe(draftAtBase("", page));
    expect(consumed).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(field);
  });

  it("appends to an existing draft, twice in a row, exactly as before and without attachments", async () => {
    await render(withQuote(null));
    const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
    await fill(field, "Existing draft");
    await render(withQuote(pageQuote(page)));
    await render(withQuote(null));
    await render(withQuote(pageQuote("Page: B\nSource: https://b.test/\n\nb")));
    expect(field.value).toBe(draftAtBase(draftAtBase("Existing draft", page), "Page: B\nSource: https://b.test/\n\nb"));
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(mocks.send).toHaveBeenCalledWith(conversation.id, expect.any(String), []);
  });
});
