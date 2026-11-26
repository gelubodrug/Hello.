// @vitest-environment jsdom
// Annotate → chat composer (A3 end of the flow): what ConversationView does with
// the quote AnnotateBar hands it. API mocks mirror tests/renderer-interactions.test.tsx.
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, ChatAttachment, ChatQuote, Conversation, HelloAPI } from "../src/shared/types";
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
      // A waiting picture is a card that shows itself (user, 26.11): its thumbnail is read through main.
      previewAttachment: async () => "data:image/png;base64,iVBORw0KGgo=",
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
const conversation: Conversation = { id: "annotate-chat", title: "Annotate", folder: null, createdAt: 1, updatedAt: 1 };
const settings: AppSettings = { endpointUrl: "http://localhost:1234/v1", model: "test-model", apiKeySet: false, temperature: 0.7, systemPrompt: "", connections: [] };
const TEXT = "⟦Hello-annotations⟧ 1 marker on https://example.test/\n#1 yellow — Too dim";
const picture: ChatAttachment = { id: "capture-id", name: "capture.png", kind: "image", size: 10 };
const view = (quote: ChatQuote | null, onQuoteConsumed = vi.fn()) =>
  createElement(ConversationView, {
    conversation, settings, messages: [], workers: [],
    onSettingsChange: vi.fn(), onFolderChange: vi.fn(), onTerminal: vi.fn(), onWorker: vi.fn(),
    quote, onQuoteConsumed, reportError: vi.fn(),
  });
const attachmentNames = () => [...document.querySelectorAll('.composer-attachments button[aria-label^="Remove attachment "]')]
  .map(item => item.getAttribute("aria-label")!.replace("Remove attachment ", ""));

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
  mocks.stop.mockResolvedValue(undefined);
  mocks.approve.mockResolvedValue(undefined);
  mocks.copy.mockResolvedValue(undefined);
  mocks.conversationUpdate.mockImplementation(async (id, patch) => ({ ...conversation, id, ...patch }));
  mocks.extensionsDiscover.mockResolvedValue({ mcp: [], skills: [] });
  mocks.notebookList.mockResolvedValue([]);
  mocks.notebookOnChange.mockImplementation(() => () => {});
  mocks.models.mockResolvedValue([{ id: "test-model" }]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("annotations arriving in the composer", () => {
  it("A3: verbatim text (not a > quote) and the picture as an attachment; the quote is consumed once", async () => {
    const consumed = vi.fn();
    await act(async () => { root.render(view({ text: TEXT, verbatim: true, attachments: [picture] }, consumed)); });
    const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
    expect(field.value).toBe(`${TEXT}\n\n`);
    expect(attachmentNames()).toEqual(["capture.png"]);
    expect(consumed).toHaveBeenCalledTimes(1);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("composer already holds 8 attachments → the words still land, and the error says the page picture was not attached (no local path in the draft)", async () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ id: `kept-${i}`, name: `kept-${i}.txt`, kind: "text", size: 1 }));
    localStorage.setItem(`hello.draft.${conversation.id}.attachments`, JSON.stringify(eight));
    await act(async () => { root.render(view({ text: TEXT, verbatim: true, attachments: [picture] })); });
    const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
    expect(field.value).toBe(`${TEXT}\n\n`);
    expect(field.value).not.toContain("shot:");
    expect(field.value).not.toMatch(/\/data\/|page-captures/);
    expect(attachmentNames()).toHaveLength(8);
    expect(attachmentNames()).not.toContain("capture.png");
    expect(document.body.textContent).toContain("Attach up to 8 files per message.");
    expect(document.body.textContent).toContain("The page picture was not attached");
  });

  it("the last free slot takes the first page picture; a second quote keeps its words, is refused its picture and says so", async () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ id: `kept-${i}`, name: `kept-${i}.txt`, kind: "text", size: 1 }));
    localStorage.setItem(`hello.draft.${conversation.id}.attachments`, JSON.stringify(seven));
    const second: ChatAttachment = { id: "capture-2", name: "capture-2.png", kind: "image", size: 10 };
    await act(async () => { root.render(view({ text: "first", verbatim: true, attachments: [picture] })); });
    expect(attachmentNames()).toHaveLength(8);
    expect(document.body.textContent).not.toContain("The page picture was not attached");
    await act(async () => { root.render(view({ text: "second", verbatim: true, attachments: [second] })); });
    const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
    expect(field.value).toBe("first\n\n\n\nsecond\n\n");
    expect(attachmentNames()).toContain("capture.png");
    expect(attachmentNames()).not.toContain("capture-2.png");
    expect(document.body.textContent).toContain("The page picture was not attached");
  });
});

describe("any quote arriving in the composer", () => {
  it("audit A3b: words that would make the message longer than main takes are refused with the next step; the draft stays", async () => {
    const kept = "k".repeat(199_990);
    localStorage.setItem(`hello.draft.${conversation.id}`, kept);
    const consumed = vi.fn();
    await act(async () => { root.render(view({ text: "From `notes.txt` (line 2):\n```\nbeta\n```", verbatim: true }, consumed)); });
    const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
    expect(field.value).toBe(kept);
    expect(consumed).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Adding this would make the message longer than 200,000 characters. Send or shorten the draft, then add it again.");
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
