// Univer, loaded only when a workbook is first shown: the grid is a large
// module and most chats never open one.
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import enUS from '@univerjs/preset-sheets-core/locales/en-US';
import '@univerjs/preset-sheets-core/lib/index.css';

export type Grid = ReturnType<typeof mountGrid>;

/**
 * One grid in one element. It draws and takes typing; it is not the workbook.
 * The toolbar, the sheet bar and the context menu are off because what they
 * change — formats, sheets, rows — is not something this pane reports to
 * main, and a change main never hears of is one the next reload would undo.
 * The formulas are computed here in the page for what the person types; the
 * values kept in the file are main's.
 */
export function mountGrid(container: HTMLElement, dark: boolean) {
  const { univer, univerAPI } = createUniver({
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: mergeLocales(enUS) },
    darkMode: dark,
    presets: [UniverSheetsCorePreset({ container, toolbar: false, contextMenu: false, footer: false })],
  });
  return { univer, univerAPI };
}
