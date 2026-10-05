import { describe, expect, it, vi } from "vitest";
import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";
import { pageMenu, type PageMenuActions } from "../src/main/browser/context-menu";

// User, 05.10: a right-click on a page in Hello's browser showed nothing, not
// even Copy; macOS offers Look Up, Copy and Select All for selected words.
const actions = (): PageMenuActions => ({
  lookUp: vi.fn(), cut: vi.fn(), copy: vi.fn(), paste: vi.fn(), selectAll: vi.fn(),
  copyText: vi.fn(), copyImage: vi.fn(), saveImage: vi.fn(),
});
const flags = { canCut: false, canCopy: false, canPaste: false } as ContextMenuParams["editFlags"];
const page = (over: Partial<ContextMenuParams> = {}) =>
  ({ selectionText: "", isEditable: false, editFlags: flags, linkURL: "", mediaType: "none", srcURL: "", ...over }) as ContextMenuParams;
const labels = (items: MenuItemConstructorOptions[]) => items.map(item => item.type === "separator" ? "—" : item.label);
const click = (items: MenuItemConstructorOptions[], label: string) =>
  (items.find(item => item.label === label)!.click as () => void)();

describe("the menu a right-click on a page opens", () => {
  it("offers Look Up, Copy and Select All for selected words, as macOS does", () => {
    const act = actions();
    const items = pageMenu(page({ selectionText: "Google LLC" }), act, "darwin");
    expect(labels(items)).toEqual(["Look Up", "—", "Copy", "—", "Select All"]);
    expect(items.find(item => item.label === "Copy")).toMatchObject({ accelerator: "CmdOrCtrl+C", registerAccelerator: false });
    click(items, "Look Up");
    click(items, "Copy");
    click(items, "Select All");
    expect(act.lookUp).toHaveBeenCalled();
    expect(act.copy).toHaveBeenCalled();
    expect(act.selectAll).toHaveBeenCalled();
    // Look Up is the Mac's dictionary; elsewhere there is none to offer.
    expect(labels(pageMenu(page({ selectionText: "Google LLC" }), act, "linux"))).toEqual(["Copy", "—", "Select All"]);
  });

  it("offers Select All alone where nothing is selected", () => {
    expect(labels(pageMenu(page(), actions(), "darwin"))).toEqual(["Select All"]);
  });

  it("cuts, copies and pastes in a field, each only when it can", () => {
    const items = pageMenu(page({ isEditable: true, editFlags: { ...flags, canPaste: true } }), actions(), "darwin");
    expect(labels(items)).toEqual(["Cut", "Copy", "Paste", "—", "Select All"]);
    expect(items.filter(item => item.enabled !== undefined).map(item => [item.label, item.enabled]))
      .toEqual([["Cut", false], ["Copy", false], ["Paste", true]]);
  });

  it("copies and saves an image, and copies its address and a link's", () => {
    const act = actions();
    const items = pageMenu(page({ mediaType: "image", srcURL: "https://example.com/a.png", linkURL: "https://example.com/page" }), act, "darwin");
    expect(labels(items)).toEqual(["Copy Image", "Save Image", "Copy Image Address", "—", "Copy Link Address", "—", "Select All"]);
    click(items, "Copy Image");
    click(items, "Save Image");
    click(items, "Copy Image Address");
    click(items, "Copy Link Address");
    expect(act.copyImage).toHaveBeenCalled();
    expect(act.saveImage).toHaveBeenCalled();
    expect(act.copyText).toHaveBeenNthCalledWith(1, "https://example.com/a.png");
    expect(act.copyText).toHaveBeenNthCalledWith(2, "https://example.com/page");
  });
});
