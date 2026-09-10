// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppSettings,
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

const mocks = vi.hoisted(() => ({
  extensionsList: vi.fn(async () => []),
  extensionsActive: vi.fn(async () => []),
  extensionsSetActive: vi.fn(async () => []),
  extensionsStatus: vi.fn(async () => []),
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
  localStorage.clear();
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
  mocks.models.mockResolvedValue(["test-model", "second-model"]);
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
    expect(mocks.models).toHaveBeenCalledOnce();
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
  const detail = () => host.querySelector<HTMLDivElement>(".activity-entries")!;
  const reveal = () => host.querySelector<HTMLDivElement>(".activity-reveal")!;

  it("groups interleaved commentary once, leaves the answer outside and collapses successful work on completion", async () => {
    await show(message);
    expect(host.querySelectorAll(".activity-group")).toHaveLength(1);
    expect(summary().textContent).toContain("1 search · 1 tool");
    expect(reveal().dataset.open).toBe('true');
    expect(Array.from(detail().children).map(node => node.className)).toEqual(["thinking-part", "tool-part", "markdown", "tool-part"]);
    expect(detail().textContent).toContain("Checking the source.");
    expect(detail().textContent).not.toContain("Answer");
    expect(host.lastElementChild?.textContent).toBe("Answer");
    expect(host.querySelector('.thinking-part[data-active="true"]')).toBeNull();
    await show({ ...message, status: "complete" });
    expect(reveal().dataset.open).toBe('false');
    expect(reveal().getAttribute('aria-hidden')).toBe('true');
    expect(reveal().inert).toBe(true);
    expect(detail().children).toHaveLength(4); // Retained throughout roll-up; no abrupt unmount.
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
  it("keeps all subtools available behind the bounded viewport rather than truncating their data", async () => {
    const parts = Array.from({ length: 25 }, (_, index) => ({ ...tool, id: `tool-${index}` }));
    await show({ ...message, parts });
    expect(detail().querySelectorAll('.tool-part')).toHaveLength(25);
    expect(host.querySelector('.activity-detail')?.getAttribute('tabindex')).toBe('0');
    expect(host.querySelector('.activity-detail')?.getAttribute('role')).toBe('region');
    expect(host.querySelector('.tool-detail')).toBeNull();
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
  it('uses the captured selection for Command-C while the context menu owns focus', async () => {
    await render(view([message]));
    await open();
    window.getSelection()?.removeAllRanges();
    const menu = document.querySelector('[aria-label="Chat text actions"]')!;
    await act(async () => { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true })); });
    expect(mocks.copy).toHaveBeenCalledWith(expect.objectContaining({ text: 'bold' }));
  });
});

describe("settings shared controls", () => {
  it("keeps a searchable model menu above Settings and Escape closes only the menu", async () => {
    mocks.models.mockResolvedValue(["aion-labs/aion-2.0", "vendor/fast:free", "vendor/large:free"]);
    const closeSettings = vi.fn();
    await render(createElement(SettingsDialog, { open: true, settings, onSaved: vi.fn(), onClose: closeSettings, dataPath: "/test/data", version: "0.1.0", extensionsCount: 0 }));
    await click(button("Save connection & load models"));
    mocks.settingsSave.mockClear();
    await click(button("Available models"));
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.style.zIndex).toBe("300");
    const search = menu.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
    expect(search.placeholder).toBe('search models try "free"');
    await fill(search, "FREE");
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
    expect(menu.textContent).not.toContain("aion-labs");
    expect(mocks.settingsSave).not.toHaveBeenCalled();
    await fill(search, "no matching model");
    expect(menu.querySelector('[role="status"]')?.textContent).toBe("No models match your search.");
    await fill(search, "large free");
    await act(async () => { search.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter", bubbles:true})); });
    expect(field("Model").value).toBe("vendor/large:free");
    await click(button("Available models"));
    const reopened = document.querySelector<HTMLInputElement>('[aria-label="Search models"]')!;
    expect(reopened.value).toBe("");
    await act(async () => { reopened.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true})); });
    expect(closeSettings).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
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
  it("switches between kept connections and keeps the one on screen under a name", async () => {
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
    await fill(field("Keep this connection as"), "Work account");
    await click(button("Update"));
    expect(mocks.settingsSave).toHaveBeenCalledWith(
      expect.objectContaining({ endpointUrl: "https://openrouter.ai/api/v1", model: "free-model" }),
    );
    expect(mocks.settingsSave.mock.calls.at(-1)![0]).not.toHaveProperty("apiKey");
    expect(mocks.settingsRemember).toHaveBeenCalledWith("Work account");
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
      },
      {
        id: "n2",
        conversationId: conversation.id,
        kind: "tasks",
        title: "Second",
        body: "Other task",
        createdAt: 2,
        updatedAt: 2,
      },
    ];
    mocks.notebookList.mockImplementation(async () => [...rows]);
    mocks.notebookSave.mockImplementation(async input => {
      const index = rows.findIndex(row => row.id === input.id);
      const saved = { ...rows[index], ...input, updatedAt: rows[index].updatedAt + 1 };
      rows[index] = saved;
      return saved;
    });
    await render(
      createElement(Notebook, {
        conversationId: conversation.id,
        kind: "tasks",
      }),
    );
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
      kind: 'tasks', title: 'Audit', body: '- [ ] Check entry points', createdAt: 1, updatedAt: 10 };
    let latest = original;
    mocks.notebookList.mockImplementation(async () => [latest]);
    let rejectSave!: (reason: Error) => void;
    mocks.notebookSave.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject; }));
    await render(createElement(Notebook, { conversationId: conversation.id, kind: 'tasks' }));
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
      kind: 'tasks', title: 'Audit', body: '- [ ] Check entry points', createdAt: 1, updatedAt: 10 };
    let latest = original;
    mocks.notebookList.mockImplementation(async () => [latest]);
    let finishSave!: (saved: NotebookEntry) => void;
    mocks.notebookSave.mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; }));
    await render(createElement(Notebook, { conversationId: conversation.id, kind: 'tasks' }));
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
    expect(mocks.notebookList).toHaveBeenCalledTimes(3);
  });
});
