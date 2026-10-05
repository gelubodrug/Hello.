// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppSettings,
  HelloAPI,
  LibraryResource,
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
import { MenuButton, type MenuItem } from "../src/renderer/ui/primitives";
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
  attachClipboard: vi.fn(),
  chooseFiles: vi.fn(),
  pathsForFiles: vi.fn(),
  conversationUpdate: vi.fn(),
  stop: vi.fn(),
  retry: vi.fn(),
  approve: vi.fn(),
  models: vi.fn(),
  catalog: vi.fn(),
  localServers: vi.fn(),
  settingsGet: vi.fn(),
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
      attachClipboard: mocks.attachClipboard,
      send: mocks.send,
      stop: mocks.stop,
      retry: mocks.retry,
      approve: mocks.approve,
      onEvent: vi.fn(() => () => {}),
    },
    settings: {
      models: mocks.models,
      catalog: mocks.catalog,
      localServers: mocks.localServers,
      get: mocks.settingsGet,
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
    system: { pathsForFiles: mocks.pathsForFiles, chooseFiles: mocks.chooseFiles, openExternal: vi.fn().mockResolvedValue(undefined), copy: mocks.copy },
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
/** Lets pending timers and promises land, the way a person waits a moment. */
async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
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
  const node = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(
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
    onEditMessage: vi.fn(),
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
  mocks.localServers.mockResolvedValue([]);
  mocks.settingsGet.mockResolvedValue(settings);
  mocks.catalog.mockResolvedValue([
    { name: "Local", endpointUrl: settings.endpointUrl, active: true, models: [{ id: "test-model" }, { id: "second-model" }] },
  ]);
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

describe("real conversation controls", () => {
  it("sends on Enter, clears only the submitted draft and persists the new draft state", async () => {
    await render(view());
    const field = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Message"]',
    )!;
    await fill(field, "A real user task");
    await act(async () => {
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(mocks.send).toHaveBeenCalledWith(
      conversation.id,
      "A real user task",
      [],
    );
    expect(field.value).toBe("");
    expect(localStorage.getItem("hello.draft.test-chat")).toBe("");
  });
  it('stages a dropped image without sending, permits removal, and submits its owned ID with an empty text draft', async () => {
    await render(view());
    const transfer = { types: ['Files'], files: [new File(['image fixture'], 'diagram.png')], getData: () => '' };
    const drop = async () => {
      await act(async () => {
        const event = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: transfer });
        document.querySelector('.conversation-view')!.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      });
    };
    await drop();
    expect(mocks.attach).toHaveBeenCalledWith(conversation.id, ['/drops/diagram.png']);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(document.querySelector('.composer-attachments')?.textContent).toContain('diagram.png');
    await click(button('Remove attachment diagram.png'));
    expect(document.querySelector('.composer-attachments')).toBeNull();
    await drop();
    await click(button('Send message'));
    expect(mocks.send).toHaveBeenCalledWith(conversation.id, '', ['image-id']);
    expect(document.querySelector('.composer-attachments')).toBeNull();
  });
  it('shows failed attachment imports without silently sending a path or changing folders', async () => {
    mocks.attach.mockRejectedValueOnce(new Error('Unsupported file format'));
    await render(view());
    await act(async () => {
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [new File(['x'], 'document.bin')] } });
      document.querySelector('.conversation-view')!.dispatchEvent(event);
    });
    expect(document.body.textContent).toContain('Unsupported file format');
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.conversationUpdate).not.toHaveBeenCalled();
  });
  it("does not submit Shift+Enter or an IME composition", async () => {
    await render(view());
    const field = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Message"]',
    )!;
    await fill(field, "unfinished");
    await act(async () => {
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
        }),
      );
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: true,
          bubbles: true,
        }),
      );
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(field.value).toBe("unfinished");
  });
  it("restores a rejected draft and shows the actual request failure", async () => {
    mocks.send.mockRejectedValueOnce(new Error("Model endpoint is offline"));
    await render(view());
    const field = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Message"]',
    )!;
    await fill(field, "Keep my draft");
    await click(button("Send message"));
    expect(field.value).toBe("Keep my draft");
    expect(host.textContent).toContain("Model endpoint is offline");
  });
  it("stops an actual streaming message and does not expose another send", async () => {
    await render(
      view([
        {
          id: "m1",
          conversationId: conversation.id,
          role: "assistant",
          content: "Working",
          status: "streaming",
          createdAt: 1,
        },
      ]),
    );
    await click(button("Stop response"));
    expect(mocks.stop).toHaveBeenCalledWith(conversation.id);
    expect(document.querySelector('[aria-label="Send message"]')).toBeNull();
    expect(
      document.querySelector('[role="status"]')?.textContent,
    ).toContain("Generating response");
  });
  it("loads real models and saves the explicitly selected model", async () => {
    await render(view());
    await click(button("Choose model"));
    expect(mocks.catalog).toHaveBeenCalledOnce();
    await click(button("second-model"));
    expect(mocks.settingsSave).toHaveBeenCalledWith({ model: "second-model" });
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ model: "second-model" }),
    );
  });
  it("reuses a user message without deleting an existing draft or rewriting history", async () => {
    await render(
      view([
        {
          id: "u1",
          conversationId: conversation.id,
          role: "user",
          content: "Original message",
          status: "complete",
          createdAt: 1,
        },
      ]),
    );
    const field = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Message"]',
    )!;
    await fill(field, "Already writing");
    await click(button("Use as draft"));
    expect(field.value).toBe("Already writing\n\nOriginal message");
    expect(mocks.send).not.toHaveBeenCalled();
    await click(button("Copy your message"));
    expect(mocks.copy).toHaveBeenCalledWith({ text: "Original message" });
  });
});

describe("provider thinking and tool disclosures", () => {
  it.each(["file_read", "file_list"])(
    "preserves %s output as literal text, including Markdown syntax",
    async (name) => {
      const output =
        "## A file heading\n\n- A list item\n\n```ts\nconst value = 1;\n```";
      await render(
        createElement(ToolPart, {
          part: {
            type: "tool",
            id: "t-file",
            name,
            input: "{}",
            output,
            status: "complete",
          },
        }),
      );
      await click(host.querySelector("button")!);
      const blocks = host.querySelectorAll(".code-block pre code");
      expect(blocks).toHaveLength(2);
      expect(blocks[1].textContent).toBe(output);
      expect(host.querySelector(".tool-detail h2")).toBeNull();
    },
  );
  it("never opens or closes supplied thinking automatically as its phase changes", async () => {
    const part = {
      type: "thinking" as const,
      text: "Provider-supplied reasoning",
      durationMs: 1500,
    };
    await render(createElement(ThinkingPart, { part, active: true }));
    expect(host.textContent).not.toContain("Provider-supplied reasoning");
    await render(createElement(ThinkingPart, { part, active: false }));
    expect(host.textContent).not.toContain("Provider-supplied reasoning");
    expect(host.textContent).toContain("Thought 1.5s");
    await click(host.querySelector("button")!);
    expect(host.textContent).toContain("Provider-supplied reasoning");
    await render(createElement(ThinkingPart, { part, active: true }));
    await render(createElement(ThinkingPart, { part, active: false }));
    expect(host.textContent).toContain("Provider-supplied reasoning");
  });
  it("renders JSON tool output as code, with real status and duration", async () => {
    await render(
      createElement(ToolPart, {
        part: {
          type: "tool",
          id: "t1",
          name: "browser_read",
          input: '{"tab":"abc"}',
          output: '{"title":"A page"}',
          status: "complete",
          durationMs: 400,
        },
      }),
    );
    expect(host.textContent).not.toContain("Completed");
    expect(host.textContent).not.toContain("0.4s");
    await click(host.querySelector("button")!);
    expect(host.textContent).toContain("Completed · 0.4s");
    expect(host.textContent).toContain("400 ms");
    expect(host.querySelectorAll(".code-block")).toHaveLength(2);
    expect(host.textContent).toContain('"title": "A page"');
  });
  it("keeps brief thinking quiet and preserves a manual opening after it finishes", async () => {
    const part = { type: "thinking" as const, text: "Original reasoning", durationMs: 612 };
    await render(createElement(ThinkingPart, { part, active: false }));
    expect(host.textContent).toBe("Thought briefly");
    await click(host.querySelector("button")!);
    expect(host.textContent).not.toContain("Duration:");
    expect(host.querySelector("button")?.title).toBe("Thinking duration: 0.612s (612 ms)");
    await render(createElement(ThinkingPart, { part, active: true }));
    await render(createElement(ThinkingPart, { part, active: false }));
    expect(host.textContent).toContain("Original reasoning");
    expect(host.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
  });
  it.each([true, false])(
    "sends an explicit approval decision (%s), once while pending",
    async (allow) => {
      await render(
        createElement(ToolPart, {
          part: {
            type: "tool",
            id: "t1",
            name: "browser_click",
            input: "{}",
            status: "approval",
            approvalId: "approval-1",
          },
        }),
      );
      await click(button(allow ? "Allow once" : "Decline"));
      expect(mocks.approve).toHaveBeenCalledWith("approval-1", allow);
      expect(button("Allow once").disabled).toBe(true);
      expect(button("Decline").disabled).toBe(true);
    },
  );
});

describe("compact activity timeline", () => {
  const tool = { type: "tool" as const, id: "search", name: "web_search", input: '{"query":"weather"}', status: "complete" as const,
    output: JSON.stringify({ kind: "web_search", query: "weather", engine: "example", results: [], note: "" }) };
  const message: Message = { id: "activity", conversationId: "test-chat", role: "assistant", createdAt: 1, status: "streaming", content: "Answer",
    parts: [{ type: "thinking", text: "Original reasoning", durationMs: 612 }, tool,
      { type: "text", text: "Checking the source." }, { ...tool, id: "next", name: "file_read", input: "{}", output: "Original output" },
      { type: "text", text: "Answer" }] };
  const show = (value: Message) => render(createElement(MessageContent, { message: value, sources: [] }));
  const summary = () => host.querySelector<HTMLButtonElement>(".activity-summary")!;
  const detail = () => host.querySelector<HTMLDivElement>(".activity-detail .activity-entries")!;
  const tail = () => host.querySelector<HTMLDivElement>(".activity-tail .activity-entries");
  const reveal = () => host.querySelector<HTMLDivElement>(".activity-reveal")!;

  it("groups interleaved commentary once, leaves the answer outside and collapses successful work on completion", async () => {
    await show(message);
    expect(host.querySelectorAll(".activity-group")).toHaveLength(1);
    expect(summary().textContent).toContain("1 search · 1 tool");
    // While the reply is still arriving the whole list stays folded: only the
    // work happening now shows, in place, under the summary.
    expect(reveal().dataset.open).toBe('false');
    expect(Array.from(tail()!.children).map(node => node.className)).toEqual(["activity-note", "tool-part"]);
    expect(tail()!.textContent).toContain("Checking the source.");
    expect(tail()!.textContent).not.toContain("Answer");
    expect(host.lastElementChild?.textContent).toBe("Answer");
    expect(host.querySelector('.thinking-part[data-active="true"]')).toBeNull();
    await show({ ...message, status: "complete" });
    expect(reveal().dataset.open).toBe('false');
    expect(reveal().getAttribute('aria-hidden')).toBe('true');
    expect(reveal().inert).toBe(true);
    // Opened once, the steps stay mounted through a roll-up: no abrupt unmount.
    await click(summary());
    expect(detail().children).toHaveLength(4);
    await click(summary());
    expect(reveal().dataset.open).toBe('false');
    expect(detail().children).toHaveLength(4);
  });
  it("respects explicitly opened activity and tool details after completion", async () => {
    await show(message);
    await click(summary());
    await click(summary());
    await click(host.querySelector(".tool-part button")!);
    await show({ ...message, status: "complete" });
    expect(reveal().dataset.open).toBe('true');
    expect(host.querySelector(".tool-part button")?.getAttribute("aria-expanded")).toBe("true");
  });
  it("respects an explicit collapse while keeping failures and approvals visible", async () => {
    const needsAttention: Message = { ...message, status: "complete", parts: [
      { ...tool, status: "error", output: "Original error" },
      { ...tool, id: "approval", name: "file_write", status: "approval", approvalId: "approval-1" },
      { type: "text", text: "Answer" },
    ] };
    await show(needsAttention);
    expect(reveal().dataset.open).toBe('true');
    expect(button("Allow once").disabled).toBe(false);
    await click(summary());
    await show({ ...needsAttention, content: "Updated answer" });
    expect(reveal().dataset.open).toBe('false');
    expect(summary().textContent).toContain("1 failed · Needs approval");
    await click(summary());
    expect(button("Allow once").disabled).toBe(false);
  });
  it("preserves a manual thinking choice when the first tool arrives and ends its active state", async () => {
    const thought = { type: "thinking" as const, text: "Original reasoning", durationMs: 612 };
    await show({ ...message, parts: [thought] });
    await click(host.querySelector(".thinking-part button")!);
    await show({ ...message, parts: [thought, { ...tool, status: "running", output: undefined }] });
    expect(host.querySelector('.thinking-part[data-active="true"]')).toBeNull();
    expect(host.querySelector(".thinking-part button")?.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector(".thinking-body")?.textContent).toContain("Original reasoning");
    expect(summary().textContent).toContain("Running");
  });
  it("folds commentary long enough to be a wall down to the one row its neighbours are", async () => {
    const wall = { type: "text" as const, text: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n\n") };
    // jsdom reports no layout, so measurement has to be stood in for.
    const heights = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(400);
    try {
      await show({ ...message, parts: [{ type: "thinking", text: "Reasoning", durationMs: 5 }, wall, tool] });
      const note = host.querySelector<HTMLElement>('.activity-note')!;
      expect(note.dataset.folded).toBe('true');
      // The same row as the thinking and the tool: a title and a chevron.
      const row = note.querySelector<HTMLButtonElement>('.disclosure-button')!;
      expect(row.textContent).toContain('line 0');
      expect(row.getAttribute('aria-expanded')).toBe('false');
      await click(row);
      expect(note.dataset.folded).toBeUndefined();
      expect(note.textContent).toContain('line 39');
    } finally { heights.mockRestore(); }
  });

  it("says a short remark outright rather than making it a row to open", async () => {
    const heights = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(20);
    try {
      await show({ ...message, parts: [{ type: "text", text: "Checking the source." }, tool] });
      const note = host.querySelector<HTMLElement>('.activity-note')!;
      expect(note.querySelector('.disclosure-button')).toBeNull();
      expect(note.textContent).toContain('Checking the source.');
    } finally { heights.mockRestore(); }
  });

  it("opens the whole run as a continuation of the tail, and never shows both", async () => {
    await show(message);
    expect(tail()).not.toBeNull();
    await click(summary());
    // One list at a time: the tail is the folded state of the same steps.
    expect(reveal().dataset.open).toBe('true');
    expect(tail()).toBeNull();
    expect(Array.from(detail().children).map(node => node.className)).toEqual(["thinking-part", "tool-part", "activity-note", "tool-part"]);
  });
  it("says a long run of the same work once, and keeps every step behind it", async () => {
    const parts = Array.from({ length: 25 }, (_, index) => ({ ...tool, id: `tool-${index}` }));
    await show({ ...message, parts });
    // Twenty-five searches are one sentence, not twenty-five rows.
    const row = tail()!.querySelector<HTMLButtonElement>('.disclosure-button')!;
    expect(row.textContent).toContain('Ran 25 searches');
    expect(tail()!.querySelectorAll('.tool-part')).toHaveLength(1);
    await click(summary());
    // Opening the run shows each step, and nothing is truncated.
    await click(detail().querySelector<HTMLButtonElement>('.disclosure-button')!);
    expect(detail().querySelectorAll('.tool-part')).toHaveLength(26);
    // The timeline never grows a scrollbar of its own.
    expect(host.querySelector('.activity-detail')?.getAttribute('role')).toBe('region');
    expect(getComputedStyle(host.querySelector('.activity-detail')!).maxHeight).toBe('');
  });
});

describe('chat selection context menu', () => {
  const message: Message = { id: 'selection', conversationId: conversation.id, role: 'assistant',
    content: 'A **bold** answer with [a link](https://example.test).', status: 'complete', createdAt: 1 };
  const open = async (selected = true) => {
    const prose = host.querySelector<HTMLElement>('.message-assistant > .markdown')!;
    if (selected) {
      const range = document.createRange();
      range.selectNodeContents(prose.querySelector('strong')!);
      window.getSelection()?.addRange(range);
    }
    await act(async () => { prose.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 })); });
  };
  it('copies a selection captured before focus changes, and attaches it without sending', async () => {
    await render(view([message]));
    await open();
    window.getSelection()?.removeAllRanges();
    await click(button('Copy'));
    expect(mocks.copy).toHaveBeenCalledWith(expect.objectContaining({ text: 'bold' }));
    const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
    await fill(field, 'Existing draft');
    await open();
    await click(button('Attach selection as context'));
    expect(field.value).toBe('Existing draft\n\n> bold\n\n');
    expect(mocks.send).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field);
  });
  it('distinguishes rendered text from original Markdown and disables selection-only actions without a selection', async () => {
    await render(view([message]));
    await open(false);
    expect(button('Copy').disabled).toBe(true);
    expect(button('Attach selection as context').disabled).toBe(true);
    await click(button('Copy message'));
    expect(mocks.copy).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'A bold answer with a link.' }));
    await open(false);
    await click(button('Copy message as Markdown'));
    expect(mocks.copy).toHaveBeenLastCalledWith({ text: message.content });
  });
  it('reports native copy failures without changing the message', async () => {
    mocks.copy.mockRejectedValueOnce(new Error('Clipboard unavailable'));
    await render(view([message]));
    await open(false);
    await click(button('Copy message as Markdown'));
    expect(host.textContent).toContain('Clipboard unavailable');
    expect(message.content).toContain('**bold**');
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('gives focus back to the message after an action that left it in the menu', async () => {
    await render(view([message]));
    await open(false);
    const item = button('Copy message');
    item.focus();
    await click(item);
    expect(document.activeElement).toBe(host.querySelector('.message-assistant'));
  });
  it('uses the captured selection for Command-C while the context menu owns focus', async () => {
    await render(view([message]));
    await open();
    window.getSelection()?.removeAllRanges();
    const menu = document.querySelector('[aria-label="Chat text actions"]')!;
    await act(async () => { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true })); });
    expect(mocks.copy).toHaveBeenCalledWith(expect.objectContaining({ text: 'bold' }));
  });
});

// S209 F1: ↑ in an empty composer brings back what you sent.
describe("the composer's history", () => {
  const said = (id: string, content: string, role: "user" | "assistant" = "user"): Message =>
    ({ id, conversationId: conversation.id, role, content, status: "complete", createdAt: 1 });
  const thread = [said("u1", "First question"), said("a1", "First answer", "assistant"), said("u2", "Second question"), said("a2", "Second answer", "assistant")];
  const press = async (field: HTMLTextAreaElement, key: string) => {
    await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
    await settle();
  };
  const composer = () => document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
  it("walks back through what you sent from an empty composer, and Esc clears it", async () => {
    await render(view(thread));
    await press(composer(), "ArrowUp");
    expect(composer().value).toBe("Second question");
    await press(composer(), "ArrowUp");
    expect(composer().value).toBe("First question");
    // The oldest stays the oldest.
    await press(composer(), "ArrowUp");
    expect(composer().value).toBe("First question");
    await press(composer(), "ArrowDown");
    expect(composer().value).toBe("Second question");
    await press(composer(), "ArrowDown");
    expect(composer().value).toBe("");
    await press(composer(), "ArrowUp");
    await press(composer(), "Escape");
    expect(composer().value).toBe("");
  });
  it("leaves words you are writing alone, and stops walking once you type", async () => {
    await render(view(thread));
    await fill(composer(), "My own draft");
    await press(composer(), "ArrowUp");
    expect(composer().value).toBe("My own draft");
    await fill(composer(), "");
    await press(composer(), "ArrowUp");
    expect(composer().value).toBe("Second question");
    await fill(composer(), "Second question, again");
    await press(composer(), "ArrowUp");
    expect(composer().value).toBe("Second question, again");
  });
});

// S209 F4: attachments by paste and by the native picker, the same as a drop.
describe("attaching by paste and by the picker", () => {
  const composer = () => document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
  const paste = async (data: { files?: File[]; items?: Array<{ kind: string; type: string }>; types?: string[] }) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: data.files ?? [], items: data.items ?? [], types: data.types ?? [] } });
    await act(async () => { composer().dispatchEvent(event); });
    await settle();
    return event;
  };
  const picture = (name: string) => ({ files: [new File(["x"], name, { type: "image/png" })], items: [{ kind: "file", type: "image/png" }], types: ["Files"] });
  it("attaches a copied file by its path, a picture through main, and leaves words alone", async () => {
    mocks.attachClipboard.mockResolvedValue({ attachments: [{ id: "pasted", name: "Pasted image.png", kind: "image", size: 10 }] });
    await render(view());
    await paste(picture("diagram.png"));
    expect(mocks.attach).toHaveBeenCalledWith(conversation.id, ["/drops/diagram.png"]);
    expect(mocks.attachClipboard).not.toHaveBeenCalled();
    // A screenshot: a picture with no file behind it.
    mocks.pathsForFiles.mockReturnValue([""]);
    await paste(picture("image.png"));
    expect(mocks.attachClipboard).toHaveBeenCalledWith(conversation.id);
    expect(host.textContent).toContain("Pasted image.png");
    mocks.attach.mockClear();
    mocks.attachClipboard.mockClear();
    const words = await paste({ items: [{ kind: "string", type: "text/plain" }], types: ["text/plain"] });
    expect(words.defaultPrevented).toBe(false);
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.attachClipboard).not.toHaveBeenCalled();
  });
  it("attaches what the picker returns, does nothing on cancel, and refuses more than eight", async () => {
    await render(view());
    mocks.chooseFiles.mockResolvedValueOnce(null);
    await click(button("Attach files…"));
    expect(mocks.attach).not.toHaveBeenCalled();
    mocks.chooseFiles.mockResolvedValueOnce(["/files/a.md", "/files/b.png"]);
    await click(button("Attach files…"));
    expect(mocks.attach).toHaveBeenCalledWith(conversation.id, ["/files/a.md", "/files/b.png"]);
    mocks.attach.mockClear();
    mocks.chooseFiles.mockResolvedValueOnce(Array.from({ length: 9 }, (_, index) => `/files/${index}.md`));
    await click(button("Attach files…"));
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Attach up to 8 files per message");
  });
});

// Second review (05.10): Edit left focus on a button that had just gone.
describe("editing your message", () => {
  const mine: Message = { id: "mine", conversationId: conversation.id, role: "user", content: "Fix the bug", status: "complete", createdAt: 1 };
  it("puts the caret at the end of the words, and gives focus back to the message after", async () => {
    await render(view([mine]));
    await click(button("Edit"));
    const area = document.querySelector<HTMLTextAreaElement>('[aria-label="Edit your message"]')!;
    expect(document.activeElement).toBe(area);
    expect(area.selectionStart).toBe("Fix the bug".length);
    await act(async () => { area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(document.activeElement).toBe(host.querySelector(".message-user"));
  });
});

// Second review (05.10): a round trip to main that takes long showed a dead button.
describe("a slow copy", () => {
  it("says it is under way after a second, and not before", async () => {
    const reply: Message = { id: "slow", conversationId: conversation.id, role: "assistant", content: "Answer", status: "complete", createdAt: 1 };
    mocks.copy.mockReturnValue(new Promise(() => {}));
    await render(view([reply]));
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      await click(button("Copy response"));
      expect(button("Copy response").querySelector(".spin")).toBeNull();
      await act(async () => { vi.advanceTimersByTime(1000); });
      expect(button("Copy response").querySelector(".spin")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("settings shared controls", () => {
  it("keeps a searchable model menu above Settings and Escape closes only the menu", async () => {
    mocks.models.mockResolvedValue([{ id: "aion-labs/aion-2.0" }, { id: "vendor/fast:free" }, { id: "vendor/large:free" }]);
    const closeSettings = vi.fn();
    await render(createElement(SettingsDialog, { open: true, settings, onSaved: vi.fn(), onClose: closeSettings, dataPath: "/test/data", version: "0.1.0", extensionsCount: 0 }));
    await settle();
    // The page asks the address on screen for its models; nothing is saved to do it.
    expect(mocks.models).toHaveBeenCalledWith(settings.endpointUrl);
    expect(mocks.settingsSave).not.toHaveBeenCalled();
    await click(button("Available models"));
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.style.zIndex).toBe("300");
    // The field names itself after what it searches, so every menu that grows a
    // search box does not announce itself as a model list.
    const search = menu.querySelector<HTMLInputElement>('input[aria-label=\'search models try "free"\']')!;
    expect(search.placeholder).toBe('search models try "free"');
    await fill(search, "FREE");
    expect(menu.querySelectorAll('[role^="menuitem"]')).toHaveLength(2);
    expect(menu.textContent).not.toContain("aion-labs");
    expect(mocks.settingsSave).not.toHaveBeenCalled();
    await fill(search, "no matching model");
    expect(menu.querySelector('[role="status"]')?.textContent).toBe("Nothing matches your search.");
    await fill(search, "large free");
    await act(async () => { search.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter", bubbles:true})); });
    expect(field("Model").value).toBe("vendor/large:free");
    await click(button("Available models"));
    const reopened = document.querySelector<HTMLInputElement>('.menu-search input')!;
    expect(reopened.value).toBe("");
    await act(async () => { reopened.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true})); });
    expect(closeSettings).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    // Settings is a page now, not a dialog: Escape closes the menu, not it.
    expect(document.querySelector('.settings-page')).not.toBeNull();
  });
  it.each(["preserve", "remove", "replace"])("handles the masked saved key intuitively: %s", async action => {
    await render(createElement(SettingsDialog, {open:true, settings:{...settings,apiKeySet:true}, onSaved:vi.fn(), onClose:vi.fn(), dataPath:"/test/data", version: "0.1.0", extensionsCount: 0}));
    const field = document.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(field.value).toBe("•".repeat(24));
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    if (action === "remove") await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", {key:"Backspace",bubbles:true})); });
    if (action === "replace") await fill(field, "new-test-credential");
    await click(button("Save settings"));
    const patch = mocks.settingsSave.mock.calls[0][0];
    if (action === "preserve") expect(patch).not.toHaveProperty("apiKey");
    else expect(patch.apiKey).toBe(action === "remove" ? "" : "new-test-credential");
    expect(JSON.stringify(patch)).not.toContain("•");
  });
  it("does not carry a saved mask into a different endpoint", async () => {
    await render(createElement(SettingsDialog, {open:true, settings:{...settings,apiKeySet:true}, onSaved:vi.fn(), onClose:vi.fn(), dataPath:"/test/data", version: "0.1.0", extensionsCount: 0}));
    await fill(document.querySelector<HTMLInputElement>('input[placeholder="http://localhost:1234/v1"]')!, "https://other.example/v1");
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
    await click(button("Save settings"));
    expect(mocks.settingsSave.mock.calls[0][0]).not.toHaveProperty("apiKey");
  });
  it("fills a provider preset into the form and shows what that provider needs", async () => {
    await render(createElement(SettingsDialog, {open:true, settings, onSaved:vi.fn(), onClose:vi.fn(), dataPath:"/test/data", version: "0.1.0", extensionsCount: 0}));
    await click(button("Providers"));
    await click(menuItem("OpenRouter"));
    expect(field("Endpoint URL").value).toBe("https://openrouter.ai/api/v1");
    expect(field("Model").placeholder).toBe("deepseek/deepseek-r1:free");
    expect(document.body.textContent).toContain("openrouter.ai/keys");
  });
  it("never carries a typed key or model to a different provider", async () => {
    await render(createElement(SettingsDialog, {open:true, settings, onSaved:vi.fn(), onClose:vi.fn(), dataPath:"/test/data", version: "0.1.0", extensionsCount: 0}));
    await click(button("Add API key"));
    const keyField = document.querySelector<HTMLInputElement>('input[type="password"]')!;
    await fill(keyField, "test-only-credential");
    await fill(field("Model"), "local-model");
    await click(button("Providers"));
    await click(menuItem("OpenRouter"));
    expect(field("Endpoint URL").value).toBe("https://openrouter.ai/api/v1");
    expect(keyField.value).toBe("");
    expect(field("Model").value).toBe("");
    await click(button("Save settings"));
    const patch = mocks.settingsSave.mock.calls.at(-1)![0];
    expect(patch).not.toHaveProperty("apiKey");
    expect(JSON.stringify(patch)).not.toContain("test-only-credential");
    expect(JSON.stringify(patch)).not.toContain("local-model");
  });
  it("switches between kept connections and keeps the one on screen", async () => {
    const kept = {
      ...settings,
      connections: [
        { name: "Local LM Studio", endpointUrl: "http://localhost:1234/v1", model: "qwen", apiKeySet: false },
        { name: "OpenRouter", endpointUrl: "https://openrouter.ai/api/v1", model: "free-model", apiKeySet: true },
      ],
    };
    mocks.settingsUse.mockResolvedValue({ ...kept, endpointUrl: "https://openrouter.ai/api/v1", model: "free-model", apiKeySet: true });
    mocks.settingsSave.mockResolvedValue(kept);
    mocks.settingsRemember.mockResolvedValue(kept);
    await render(createElement(SettingsDialog, {open:true, settings: kept, onSaved:vi.fn(), onClose:vi.fn(), dataPath:"/test/data", version: "0.1.0", extensionsCount: 0}));
    await click(button("Saved connections"));
    await click(menuItem("OpenRouter"));
    expect(mocks.settingsUse).toHaveBeenCalledWith("https://openrouter.ai/api/v1");
    // The form must show what the store returned, not the connection left behind.
    expect(field("Endpoint URL").value).toBe("https://openrouter.ai/api/v1");
    expect(field("Model").value).toBe("free-model");
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("•".repeat(24));
    await click(button("Saved connections"));
    await click(menuItem("Update “OpenRouter”"));
    expect(mocks.settingsSave).toHaveBeenCalledWith(
      expect.objectContaining({ endpointUrl: "https://openrouter.ai/api/v1", model: "free-model" }),
    );
    expect(mocks.settingsSave.mock.calls.at(-1)![0]).not.toHaveProperty("apiKey");
    expect(mocks.settingsRemember).toHaveBeenCalledWith("OpenRouter");
  });
  it("uses the shared keyboard menu for reasoning effort and saves only the selected value", async () => {
    const saved = vi.fn();
    await render(
      createElement(SettingsDialog, {
        open: true,
        settings,
        onSaved: saved,
        onClose: vi.fn(),
        dataPath: "/test/app-data",
	        version: "0.1.0",
	        extensionsCount: 0,
      }),
    );
    expect(document.querySelector("select")).toBeNull();
    await click(button("Advanced"));
    await click(button("Reasoning effort"));
    expect(
      document.querySelector('[role="menu"]')?.classList.contains("menu-popup"),
    ).toBe(true);
    await click(button("High"));
    expect(mocks.settingsSave).not.toHaveBeenCalled();
    expect(button("Reasoning effort").textContent).toBe("High");
    await click(button("Save settings"));
    expect(mocks.settingsSave).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: "high" }),
    );
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: "high" }),
    );
  });
});

describe("the extensions a chat can use", () => {
  const picker = () => createElement(ExtensionsPicker, {
    conversationId: "chat-1", busy: false, onError: vi.fn(),
  });
  const held = (id: string, name: string): LibraryResource => ({
    id, kind: 'skill', name, description: '', source: '', version: '',
    fingerprint: '', state: 'ready', detail: '', entries: [], createdAt: 1, updatedAt: 1,
  });

  it("offers what the other agent tools already have, and turning one on is one click", async () => {
    mocks.extensionsList.mockResolvedValue([]);
    mocks.extensionsDiscover.mockResolvedValue({
      mcp: [{ id: 'mcp:1', name: 'od-orchestrator', source: 'Codex', configPath: '/c', command: 'node', args: [], envNames: [], transport: 'stdio' }],
      skills: [{ id: 'skill:1', name: 'frontend-design', description: 'Visual design guidance', source: 'Claude Code', path: '/s' }],
    });
    mocks.extensionsImportDiscovered.mockResolvedValue(held('imported-1', 'frontend-design'));
    mocks.extensionsSetActive.mockResolvedValue(['imported-1']);
    await render(picker());
    await click(button("Extensions (2 available, none on)"));
    // Nothing had to be imported in Settings for either of these to be here.
    expect(menuItem("frontend-design").textContent).toContain("from Claude Code");
    expect(menuItem("od-orchestrator").textContent).toContain("from Codex");
    await click(menuItem("frontend-design"));
    expect(mocks.extensionsImportDiscovered).toHaveBeenCalledWith('skill', 'skill:1');
    expect(mocks.extensionsSetActive).toHaveBeenCalledWith('chat-1', 'imported-1', true);
    // The menu is a set being assembled, not a destination: it stays open.
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  it("narrows by kind with one tap, and drops a heading left with nothing under it", async () => {
    mocks.extensionsList.mockResolvedValue([held('a', 'alpha')]);
    mocks.extensionsDiscover.mockResolvedValue({
      mcp: [{ id: 'mcp:1', name: 'od-orchestrator', source: 'Codex', configPath: '/c', command: 'node', args: [], envNames: [], transport: 'stdio' }],
      skills: [{ id: 'skill:1', name: 'frontend-design', description: '', source: 'Claude Code', path: '/s' }],
    });
    await render(picker());
    await click(button("Extensions (3 available, none on)"));
    expect(menuItem("od-orchestrator")).toBeDefined();
    await click([...document.querySelectorAll<HTMLButtonElement>('.menu-filter')].find(node => node.textContent === 'Skills')!);
    // Only skills remain, and the provenance heading follows what is left.
    expect(document.body.textContent).toContain('frontend-design');
    expect(document.body.textContent).not.toContain('od-orchestrator');
    expect(document.body.textContent).toContain('Found on this Mac');
    await click([...document.querySelectorAll<HTMLButtonElement>('.menu-filter')].find(node => node.textContent === 'MCP')!);
    // Nothing of this kind was found on the Mac beyond the one server, and the
    // library has no MCP entry, so the heading keeps its item and no more.
    expect(document.body.textContent).toContain('od-orchestrator');
    expect(document.body.textContent).not.toContain('alpha');
  });

  it("keeps the menu open while several are switched on and off", async () => {
    mocks.extensionsList.mockResolvedValue([held('a', 'alpha'), held('b', 'beta')]);
    mocks.extensionsActive.mockResolvedValue([]);
    mocks.extensionsSetActive.mockImplementation(async (_id, resourceId) => [resourceId]);
    await render(picker());
    await click(button("Extensions (2 available, none on)"));
    // A toggle says whether it is on, not only with its check mark.
    expect(menuItem("alpha").getAttribute("role")).toBe("menuitemcheckbox");
    expect(menuItem("alpha").getAttribute("aria-checked")).toBe("false");
    await click(menuItem("alpha"));
    await vi.waitFor(() => expect(menuItem("alpha").getAttribute("aria-checked")).toBe("true"));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await click(menuItem("beta"));
    expect(mocks.extensionsSetActive).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });
});

describe("menus and notebook persistence", () => {
  it("enters the CLI submenu without launching a generic worker, then runs the chosen action", async () => {
    const launch = vi.fn();
    await render(
      createElement(MenuButton, {
        label: "Add tool",
        items: [
          {
            id: "workers",
            label: "CLI worker…",
            children: [
              {
                id: "claude",
                label: "Claude Code",
                action: () => launch("claude"),
              },
              {
                id: "codex",
                label: "Codex CLI",
                action: () => launch("codex"),
              },
            ],
          },
        ],
        children: "+",
      }),
    );
    await click(button("Add tool"));
    await click(button("CLI worker…"));
    expect(launch).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')?.textContent).toContain(
      "Back",
    );
    await click(menuItem("Codex CLI"));
    expect(launch).toHaveBeenCalledWith("codex");
  });
  // Free first (user, 01.10): a pill inside the search field, on at every
  // opening; switched off, the rest of the list comes back.
  it("opens on what its search pill keeps, lists everything with it off, and starts on it again at the next opening", async () => {
    const keeps = (item: MenuItem) => item.id.endsWith(":free");
    await render(createElement(MenuButton, {
      label: "Choose model",
      searchPlaceholder: "Search models",
      searchPill: { label: "Free", title: "Free models only", keeps },
      items: [
        { id: "a:free", label: "Qwen Coder", group: "OpenRouter", action: () => {} },
        { id: "b", label: "Claude Sonnet", group: "OpenRouter", action: () => {} },
        { id: "c", label: "GPT", group: "OpenAI", action: () => {} },
      ],
      children: "Model",
    }));
    const listed = () => [...document.querySelectorAll('[role^="menuitem"] .menu-item-copy')].map(node => node.textContent);
    const pill = () => document.querySelector<HTMLButtonElement>(".menu-search-field > .menu-search-pill")!;
    await click(button("Choose model"));
    expect(pill().getAttribute("aria-pressed")).toBe("true");
    expect(listed()).toEqual(["Qwen Coder"]);
    // A kind with nothing left in it is not offered while the pill is on.
    expect(document.querySelector(".menu-filters")).toBeNull();
    await click(pill());
    expect(pill().getAttribute("aria-pressed")).toBe("false");
    expect(listed()).toEqual(["Qwen Coder", "Claude Sonnet", "GPT"]);
    expect([...document.querySelectorAll(".menu-filter")].map(node => node.textContent)).toEqual(["", "OpenRouter", "OpenAI"]);
    await click(button("Choose model"));
    await click(button("Choose model"));
    expect(pill().getAttribute("aria-pressed")).toBe("true");
    expect(listed()).toEqual(["Qwen Coder"]);
  });
  it("supports keyboard menu navigation and Escape returns focus to its trigger", async () => {
    await render(
      createElement(MenuButton, {
        label: "Actions",
        items: [
          { id: "one", label: "One" },
          { id: "disabled", label: "Disabled", disabled: true },
          { id: "two", label: "Two" },
        ],
        children: "Open",
      }),
    );
    await click(button("Actions"));
    const menu = document.querySelector('[role="menu"]')!;
    await act(async () => {
      menu.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(document.activeElement?.textContent).toBe("Two");
    await act(async () => {
      menu.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(button("Actions"));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
  const notebookProps = () => ({ conversation, onConversationChange: vi.fn(), reportError: vi.fn() });
  it("flushes an edited entry before changing selection and restores its own title when returning", async () => {
    const rows: NotebookEntry[] = [
      {
        id: "n1",
        conversationId: conversation.id,
        kind: "tasks",
        title: "First",
        body: "Old text",
        createdAt: 1,
        updatedAt: 1,
        shared: true,
      },
      {
        id: "n2",
        conversationId: conversation.id,
        kind: "tasks",
        title: "Second",
        body: "Other task",
        createdAt: 2,
        updatedAt: 2,
        shared: true,
      },
    ];
    mocks.notebookList.mockImplementation(async (_id: string, kind: string) => rows.filter(row => row.kind === kind));
    mocks.notebookSave.mockImplementation(async input => {
      const index = rows.findIndex(row => row.id === input.id);
      const saved = { ...rows[index], ...input, updatedAt: rows[index].updatedAt + 1 };
      rows[index] = saved;
      return saved;
    });
    await render(createElement(Notebook, notebookProps()));
    const field = document.querySelector<HTMLInputElement>('[aria-label="Entry title"]')!;
    await fill(field, "Updated first");
    await click(button("Second"));
    expect(mocks.notebookSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: "n1", title: "Updated first", expectedUpdatedAt: 1 }),
    );
    expect(field.value).toBe("Second");
    await click(button("Updated first"));
    expect(field.value).toBe("Updated first");
  });
  it("keeps a stale draft after a CLI change and can save it separately without reverting completion", async () => {
    const original: NotebookEntry = { id: 'conflict-note', conversationId: conversation.id,
      kind: 'tasks', title: 'Audit', body: '- [ ] Check entry points', createdAt: 1, updatedAt: 10, shared: true };
    let latest = original;
    mocks.notebookList.mockImplementation(async (_id: string, kind: string) => kind === 'tasks' ? [latest] : []);
    let rejectSave!: (reason: Error) => void;
    mocks.notebookSave.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject; }));
    await render(createElement(Notebook, notebookProps()));
    const field = document.querySelector<HTMLInputElement>('[aria-label="Entry title"]')!;
    await fill(field, 'My draft title');
    await act(async () => { field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(mocks.notebookSave).toHaveBeenCalledWith(expect.objectContaining({ id: original.id, expectedUpdatedAt: 10 }));

    latest = { ...original, body: '- [x] Check entry points', updatedAt: 11 };
    const notify = mocks.notebookOnChange.mock.calls.at(-1)![0] as (event: NotebookChange) => void;
    await act(async () => { notify({ conversationId: conversation.id, kind: 'tasks' }); });
    await act(async () => { rejectSave(new Error('Notebook changed since this draft was opened.')); });
    expect(field.value).toBe('My draft title');
    expect(host.textContent).toContain('Draft conflict');
    expect(JSON.parse(localStorage.getItem(`hello.notebook.${original.id}`)!)).toMatchObject({
      title: 'My draft title', body: original.body, expectedUpdatedAt: 10,
    });
    expect(latest.body).toBe('- [x] Check entry points');

    await click(button('Save draft as new'));
    expect(mocks.notebookSave).toHaveBeenLastCalledWith({ conversationId: conversation.id,
      kind: 'tasks', title: 'My draft title (draft)', body: original.body });
    expect(field.value).toBe('My draft title (draft)');
    expect(localStorage.getItem(`hello.notebook.${original.id}`)).toBeNull();
    expect(latest.body).toBe('- [x] Check entry points');
  });
  it("refreshes a CLI update arriving after our commit but before the save response", async () => {
    const original: NotebookEntry = { id: 'racing-note', conversationId: conversation.id,
      kind: 'tasks', title: 'Audit', body: '- [ ] Check entry points', createdAt: 1, updatedAt: 10, shared: true };
    let latest = original;
    mocks.notebookList.mockImplementation(async (_id: string, kind: string) => kind === 'tasks' ? [latest] : []);
    let finishSave!: (saved: NotebookEntry) => void;
    mocks.notebookSave.mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; }));
    await render(createElement(Notebook, notebookProps()));
    const field = document.querySelector<HTMLInputElement>('[aria-label="Entry title"]')!;
    await fill(field, 'My saved title');
    await act(async () => { field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    latest = { ...original, title: 'Updated by CLI', body: '- [x] Check entry points', updatedAt: 12 };
    const notify = mocks.notebookOnChange.mock.calls.at(-1)![0] as (event: NotebookChange) => void;
    await act(async () => { notify({ conversationId: conversation.id, kind: 'tasks' }); });
    expect(field.value).toBe('My saved title');
    await act(async () => { finishSave({ ...original, title: 'My saved title', updatedAt: 11 }); });
    expect(field.value).toBe('Updated by CLI');
    expect(localStorage.getItem(`hello.notebook.${original.id}`)).toBeNull();
    // Load, the CLI's change, and once more after our save settled: each reads every section.
    expect(mocks.notebookList.mock.calls.filter(call => call[1] === 'tasks')).toHaveLength(3);
  });
});

// Presets are additive (user, 14.09): the picker shows every kept connection's
// models side by side, and picking one on another connection switches to it.
describe("the model picker across kept connections", () => {
  it("lists them all, names a connection that could not answer, and switches to the one picked", async () => {
    mocks.catalog.mockResolvedValue([
      { name: "OpenRouter", endpointUrl: "https://openrouter.ai/api/v1", active: true, models: [{ id: "vendor/large:free" }],
        // A refresh that failed on a connection whose models are known: the
        // models stand, and the reason is not shown over them (user, 17.09).
        error: "Could not reach https://openrouter.ai/api/v1: Connect Timeout Error" },
      { name: "llama.cpp · 8081", endpointUrl: "http://localhost:8081/v1", active: false, models: [{ id: "/Users/q/Models/Nex-N2.5-mini-Q8_0.gguf", contextWindow: 262144 }] },
      { name: "LM Studio", endpointUrl: "http://localhost:1234/v1", active: false, models: [],
        error: "Could not reach http://localhost:1234/v1: nothing is listening there." },
    ]);
    await render(view());
    await click(button("Choose model"));
    expect(document.body.textContent).toContain("Could not reach http://localhost:1234/v1");
    expect(document.body.textContent).toContain("vendor/large:free");
    expect(document.body.textContent).not.toContain("Connect Timeout Error");
    // Shown by its file name; sent to the server by its whole id.
    await click(menuItem("Nex-N2.5-mini-Q8_0.gguf"));
    expect(mocks.settingsSave).toHaveBeenCalledWith({ endpointUrl: "http://localhost:8081/v1", model: "/Users/q/Models/Nex-N2.5-mini-Q8_0.gguf" });
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ endpointUrl: "http://localhost:8081/v1", model: "/Users/q/Models/Nex-N2.5-mini-Q8_0.gguf" }),
    );
  });
});

// User, 04.10 (the design audit, point 3): the transcript is read with the
// keyboard too — arrows between messages, ⌘C on one copies it.
describe("the transcript from the keyboard", () => {
  const said = (id: string, role: "user" | "assistant", content: string): Message =>
    ({ id, conversationId: conversation.id, role, content, status: "complete", createdAt: 1 });
  const key = (target: Element, init: KeyboardEventInit) =>
    act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });

  it("moves between messages with the arrows, Home and End, and copies the one focused", async () => {
    // jsdom lays nothing out; Chromium scrolls the message into view.
    Element.prototype.scrollIntoView ??= function scrollIntoView() {};
    await render(view([said("u1", "user", "First question"), said("a1", "assistant", "First answer"), said("u2", "user", "Second question")]));
    const articles = [...document.querySelectorAll<HTMLElement>("article.message")];
    articles[0].focus();
    await key(articles[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(articles[1]);
    await key(articles[1], { key: "End" });
    expect(document.activeElement).toBe(articles[2]);
    await key(articles[2], { key: "Home" });
    expect(document.activeElement).toBe(articles[0]);
    await key(articles[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(articles[0]);
    articles[1].focus();
    await key(articles[1], { key: "c", metaKey: true });
    expect(mocks.copy).toHaveBeenCalledWith(expect.objectContaining({ text: "First answer" }));
  });

  // User, 04.10 (the second design audit): what a chat found was lost once it
  // scrolled away; a reply worth keeping becomes a Runbook chapter.
  it("keeps a reply as a Runbook chapter, titled by its heading", async () => {
    mocks.notebookSave.mockResolvedValue({});
    await render(view([said("a1", "assistant", "## Weather in Bucharest\n\nSunny, 24°C.")]));
    await click(button("Save to Runbook"));
    expect(mocks.notebookSave).toHaveBeenCalledWith({ conversationId: conversation.id, kind: "runbook", title: "Weather in Bucharest", body: expect.stringContaining("Sunny, 24°C.") });
    expect(button("Saved to Runbook")).toBeDefined();
  });
});

// User, 01.10: the list is kept for minutes, so its "active" connection can be
// the one in use before the last pick; a model picked there was saved alone,
// onto the local server, and every turn after failed with "model not found".
describe("the model picker after switching connections", () => {
  it("saves the model with its connection whenever that connection is not the one in use now", async () => {
    mocks.catalog.mockResolvedValue([
      { name: "OpenRouter", endpointUrl: "https://openrouter.ai/api/v1", active: true, models: [{ id: "dots-studio/dots-3-note-preview:free", free: true }] },
      { name: "oMLX", endpointUrl: "http://localhost:8000/v1", active: false, models: [{ id: "Qwen3-Coder-Next-6bit", free: true }] },
    ]);
    // The settings already point at oMLX; the list still says OpenRouter.
    await render(createElement(ConversationView, { ...view().props, settings: { ...settings, endpointUrl: "http://localhost:8000/v1", model: "Qwen3-Coder-Next-6bit" } }));
    await click(button("Choose model"));
    expect(menuItem("Qwen3-Coder-Next-6bit").querySelector("svg")).not.toBeNull();
    await click(menuItem("dots-studio/dots-3-note-preview:free"));
    expect(mocks.settingsSave).toHaveBeenCalledWith({ endpointUrl: "https://openrouter.ai/api/v1", model: "dots-studio/dots-3-note-preview:free" });
  });
});

// Each chat keeps the model it last used (user, 04.10: "nothing fancy").
describe("the model a chat runs on", () => {
  it("shows the chat's own model, and a pick is this chat's from its next turn and the selection for a new one", async () => {
    mocks.catalog.mockResolvedValue([
      { name: "OpenRouter", endpointUrl: "https://openrouter.ai/api/v1", active: false, models: [{ id: "qwen/qwen3-coder:free", free: true }] },
      { name: "Local", endpointUrl: settings.endpointUrl, active: true, models: [{ id: "test-model", free: true }, { id: "second-model", free: true }] },
    ]);
    const onFolderChange = vi.fn();
    const own = { ...conversation, model: { endpointUrl: "https://openrouter.ai/api/v1", id: "qwen/qwen3-coder:free" } };
    await render(createElement(ConversationView, { ...view().props, conversation: own, onFolderChange }));
    // The chat's model, not the selection in Settings.
    expect(button("Choose model").textContent).toContain("qwen/qwen3-coder:free");
    await click(button("Choose model"));
    expect(menuItem("qwen/qwen3-coder:free").querySelector("svg")).not.toBeNull();
    expect(menuItem("test-model").querySelector("svg")).toBeNull();
    // One choice among several, said to a screen reader too.
    expect(menuItem("qwen/qwen3-coder:free").getAttribute("role")).toBe("menuitemradio");
    expect(menuItem("qwen/qwen3-coder:free").getAttribute("aria-checked")).toBe("true");
    expect(menuItem("test-model").getAttribute("aria-checked")).toBe("false");
    await click(menuItem("second-model"));
    expect(mocks.settingsSave).toHaveBeenCalledWith({ model: "second-model" });
    await vi.waitFor(() => expect(mocks.conversationUpdate).toHaveBeenCalledWith(own.id, { model: { endpointUrl: settings.endpointUrl, id: "second-model" } }));
    await vi.waitFor(() => expect(onFolderChange).toHaveBeenCalledWith(expect.objectContaining({ model: { endpointUrl: settings.endpointUrl, id: "second-model" } })));
  });
});

// Free first (user, 01.10): the picker opens on the models that cost nothing —
// the person's own servers and those priced at zero — and the rest come back
// with the pill switched off.
describe("the model picker's Free pill", () => {
  it("opens on free models and shows the others with Free switched off", async () => {
    mocks.catalog.mockResolvedValue([
      { name: "OpenRouter", endpointUrl: "https://openrouter.ai/api/v1", active: true,
        models: [{ id: "qwen/qwen3-coder:free", free: true }, { id: "anthropic/claude-sonnet-4.5" }] },
      { name: "oMLX", endpointUrl: "http://localhost:8000/v1", active: false, models: [{ id: "Qwen3-Coder-Next", free: true }] },
    ]);
    await render(view());
    await click(button("Choose model"));
    const pill = document.querySelector<HTMLButtonElement>(".menu-search-pill")!;
    expect(pill.textContent).toBe("Free");
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    expect(document.body.textContent).toContain("qwen/qwen3-coder:free");
    expect(document.body.textContent).toContain("Qwen3-Coder-Next");
    expect(document.body.textContent).not.toContain("anthropic/claude-sonnet-4.5");
    await click(pill);
    await click(menuItem("anthropic/claude-sonnet-4.5"));
    expect(mocks.settingsSave).toHaveBeenCalledWith({ endpointUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4.5" });
  });

  it("is not offered where it would choose nothing", async () => {
    mocks.catalog.mockResolvedValue([
      { name: "oMLX", endpointUrl: "http://localhost:8000/v1", active: true, models: [{ id: "Qwen3-Coder-Next", free: true }] },
    ]);
    await render(view());
    await click(button("Choose model"));
    expect(document.querySelector(".menu-search-pill")).toBeNull();
    expect(menuItem("Qwen3-Coder-Next")).toBeDefined();
  });
});

// "fă să citească serverul" (user, 14.09): Settings finds the server running on
// this Mac, says under the address whether it answers, and keeps the numbers
// and the rest out of the way under Advanced.
describe("settings read the server", () => {
  const llama = {
    name: "llama.cpp · 8081",
    endpointUrl: "http://localhost:8081/v1",
    models: [{ id: "/Users/q/Models/Nex-N2.5-mini-GGUF/Nex-N2.5-mini-Q8_0.gguf", contextWindow: 262144 }],
  };
  const dead = { ...settings, endpointUrl: "http://localhost:8080/v1", model: "", contextWindow: 512000, maxOutputTokens: 32768 };
  const open = (value: AppSettings = dead) =>
    render(createElement(SettingsDialog, { open: true, settings: value, onSaved: vi.fn(), onClose: vi.fn(), dataPath: "/test/data", version: "0.1.0", extensionsCount: 0 }));

  it("shows the running server, says the address on screen does not answer, and uses the server in one click", async () => {
    mocks.localServers.mockResolvedValue([llama]);
    mocks.models.mockRejectedValue(new Error("Could not reach http://localhost:8080/v1: nothing is listening there."));
    await open();
    await settle();
    const row = document.querySelector<HTMLButtonElement>(".settings-server")!;
    expect(row.textContent).toContain("llama.cpp · 8081");
    expect(row.textContent).toContain("Nex-N2.5-mini-Q8_0.gguf · 262K tokens");
    const status = document.querySelector(".settings-status")!;
    expect(status.getAttribute("data-state")).toBe("error");
    expect(status.textContent).toContain("Could not reach http://localhost:8080/v1");
    await click(button("Use llama.cpp · 8081"));
    const patch = mocks.settingsSave.mock.calls.at(-1)![0];
    expect(patch).toMatchObject({ endpointUrl: "http://localhost:8081/v1", model: llama.models[0].id });
    // Nothing meant for another address travels: no key, no limits claimed.
    expect(patch).not.toHaveProperty("apiKey");
    expect(patch).not.toHaveProperty("contextWindow");
    expect(patch).not.toHaveProperty("maxOutputTokens");
  });

  it("says a server answers, and takes its only model without being told", async () => {
    mocks.models.mockResolvedValue(llama.models);
    await open({ ...dead, endpointUrl: llama.endpointUrl });
    await settle();
    expect(document.querySelector(".settings-status")!.textContent).toBe("Connected · Nex-N2.5-mini-Q8_0.gguf · 262K tokens");
    expect(field("Model").value).toBe(llama.models[0].id);
  });

  it("keeps a local server's key field out of the way until it is asked for", async () => {
    await open();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    await click(button("Add API key"));
    expect(document.querySelector('input[type="password"]')).not.toBeNull();
  });

  it("puts the numbers and the choices under Advanced, and shows the limits main now holds", async () => {
    mocks.settingsGet.mockResolvedValue({ ...dead, contextWindow: 262144, maxOutputTokens: 32768 });
    await open();
    expect(document.body.textContent).not.toContain("Temperature");
    expect(document.body.textContent).not.toContain("Tool approvals");
    await click(button("Advanced"));
    await settle();
    expect(document.querySelectorAll(".settings-numbers input")).toHaveLength(3);
    expect(field("Context (tokens)").value).toBe("262144");
    expect(document.body.textContent).toContain("Tool approvals");
    expect(document.body.textContent).not.toContain("Endpoint URL");
  });
});

// Settings already found the models; the picker must not rediscover them on
// every open, and progress is a spinner rather than a sentence (user, 17.09).
describe("the model picker keeps what it read", () => {
  it("reads once for the chat, shows the list again without asking, and spins while it has nothing", async () => {
    let settleCatalog: (value: unknown) => void = () => {};
    mocks.catalog.mockReturnValueOnce(new Promise(resolve => { settleCatalog = resolve; }));
    await render(view());
    await click(button("Choose model"));
    expect(document.querySelector(".menu-item .spin")).not.toBeNull();
    expect(document.body.textContent).not.toContain("Loading models");
    await act(async () => { settleCatalog([{ name: "Local", endpointUrl: settings.endpointUrl, active: true, models: [{ id: "test-model" }] }]); });
    expect(menuItem("test-model")).toBeDefined();
    expect(mocks.catalog).toHaveBeenCalledOnce();
    // Closing, reopening and picking a model never asks the network again.
    await click(button("Choose model"));
    await click(button("Choose model"));
    await click(menuItem("test-model"));
    expect(mocks.catalog).toHaveBeenCalledOnce();
  });
});

// A restart keeps the transcript for the person and draws where the model's
// memory begins (user, 24.09: "reload, reset, fără să pierd taburile").
describe("a restarted chat", () => {
  const said = (id: string, createdAt: number, role: "user" | "assistant" = "user"): Message =>
    ({ id, conversationId: conversation.id, role, content: `said ${id}`, status: "complete", createdAt });
  const line = () => document.querySelector('[role="separator"][aria-label="Chat restarted"]');

  it("draws the line before the first message since the restart, and after the last when nothing came since", async () => {
    await render(createElement(ConversationView, { ...view().props, conversation: { ...conversation, freshFrom: 100 },
      messages: [said("a", 10), said("b", 20, "assistant"), said("c", 150)], onEditMessage: vi.fn() }));
    const marker = line();
    expect(marker?.textContent).toBe("Restarted — the model starts fresh from here");
    expect(marker?.previousElementSibling?.textContent).toContain("said b");
    expect(marker?.nextElementSibling?.textContent).toContain("said c");
    await render(createElement(ConversationView, { ...view().props, conversation: { ...conversation, freshFrom: 100 },
      messages: [said("a", 10), said("b", 20, "assistant")], onEditMessage: vi.fn() }));
    expect(line()?.previousElementSibling?.textContent).toContain("said b");
    expect(line()?.nextElementSibling).toBeNull();
    // The answer above the line cannot be retried: the model has forgotten it.
    expect(document.querySelector('[aria-label="Retry response"]')).toBeNull();
    await render(view([said("a", 10), said("b", 20, "assistant")]));
    expect(line()).toBeNull();
    expect(document.querySelector('[aria-label="Retry response"]')).not.toBeNull();
  });
});

// Which model wrote a reply, on the reply; how full the window is, under the composer.
describe("the model per reply and the context meter", () => {
  it("names the model beside a reply's usage and shows the meter under the composer", async () => {
    await render(createElement(ConversationView, { ...view().props, settings: { ...settings, contextWindow: 32_000 },
      messages: [{ id: "r1", conversationId: conversation.id, role: "assistant", content: "Done.", status: "complete", createdAt: 1,
        model: "/models/qwen3.6-27b.gguf", usage: { input: 84_863, output: 717, context: 9_600, cost: 0.004 } }] }));
    const usage = document.querySelector(".message-usage");
    expect(usage?.textContent).toBe("qwen3.6-27b.gguf · 84,863 in · 717 out · $0.0040");
    const meter = document.querySelector(".composer-wrap .context-meter");
    expect(meter?.textContent).toContain("30% of 32k");
  });
});
