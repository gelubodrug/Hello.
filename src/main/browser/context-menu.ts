import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

/** What the menu can do to the page it was opened on. */
export interface PageMenuActions {
  lookUp(): void;
  cut(): void;
  copy(): void;
  paste(): void;
  selectAll(): void;
  copyText(text: string): void;
  copyImage(): void;
  saveImage(): void;
}

type PageMenuParams = Pick<ContextMenuParams, "selectionText" | "isEditable" | "editFlags" | "linkURL" | "mediaType" | "srcURL">;

/**
 * What a right-click on a page offers (user, 05.10: "nothing, not even a
 * Copy"): Look Up, Copy and Select All for selected words, as macOS has them;
 * Cut and Paste in a field; a link's address; an image's copy, its saving
 * (as a download of the chat, like any other) and its address. A line sets
 * each group apart. A page that draws its own menu keeps it: Chromium asks
 * for this one only when the page did not.
 */
export function pageMenu(params: PageMenuParams, actions: PageMenuActions, platform: NodeJS.Platform = process.platform): MenuItemConstructorOptions[] {
  const selected = params.selectionText.trim().length > 0;
  const shortcut = (key: string) => ({ accelerator: `CmdOrCtrl+${key}`, registerAccelerator: false });
  const groups: MenuItemConstructorOptions[][] = [];
  if (params.mediaType === "image" && params.srcURL)
    groups.push([
      { label: "Copy Image", click: actions.copyImage },
      { label: "Save Image", click: actions.saveImage },
      { label: "Copy Image Address", click: () => actions.copyText(params.srcURL) },
    ]);
  if (params.linkURL) groups.push([{ label: "Copy Link Address", click: () => actions.copyText(params.linkURL) }]);
  if (selected && platform === "darwin") groups.push([{ label: "Look Up", click: actions.lookUp }]);
  if (params.isEditable)
    groups.push([
      { label: "Cut", ...shortcut("X"), enabled: params.editFlags.canCut, click: actions.cut },
      { label: "Copy", ...shortcut("C"), enabled: params.editFlags.canCopy, click: actions.copy },
      { label: "Paste", ...shortcut("V"), enabled: params.editFlags.canPaste, click: actions.paste },
    ]);
  else if (selected) groups.push([{ label: "Copy", ...shortcut("C"), click: actions.copy }]);
  groups.push([{ label: "Select All", ...shortcut("A"), click: actions.selectAll }]);
  return groups.flatMap((group, index) => (index ? [{ type: "separator" as const }, ...group] : group));
}
