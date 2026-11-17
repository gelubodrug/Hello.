import { dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { extname } from 'node:path';
import { parseCell, type SheetCellEdit, type SheetValue } from '../../shared/sheets';
import type { Workbooks } from './workbooks';

const id = (value: unknown, label = 'ID'): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error(`Invalid ${label}.`);
  return value;
};
const input = (value: unknown): SheetValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new Error('Invalid cell value.');
};

/**
 * The window's handles on a chat's workbooks, under the same rule as every
 * bridge: the app's own top frame only. The renderer names a workbook by id
 * and a cell by reference; every path is chosen in a native dialog here or
 * resolved against the chat's folder by main, never taken from the renderer.
 */
export function registerSheetsIPC(window: BrowserWindow, books: Workbooks, folderOf: (conversationId: string) => string | null): () => void {
  const channels: string[] = [];
  const handle = (name: string, run: (...args: unknown[]) => unknown) => {
    const channel = `hello:sheets.${name}`;
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender.');
      return run(...args);
    });
    channels.push(channel);
  };
  handle('list', conversationId => books.list(id(conversationId)));
  handle('snapshot', (conversationId, workbook) => books.snapshot(id(conversationId), id(workbook, 'workbook')));
  handle('create', (conversationId, title) => books.create(id(conversationId), typeof title === 'string' ? title : 'Workbook'));
  handle('open', async conversationId => {
    const chat = id(conversationId);
    const folder = folderOf(chat);
    const picked = await dialog.showOpenDialog(window, {
      title: 'Open a workbook', properties: ['openFile'], ...(folder ? { defaultPath: folder } : {}),
      filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    // A file of the chat's folder is worked on where it is; anything else is copied in and left alone.
    if (folder) {
      try { return await books.openFile(chat, picked.filePaths[0], 'person'); }
      catch (error) { if (!(error instanceof Error) || !/outside this chat’s folder|symlink target/.test(error.message)) throw error; }
    }
    return books.importCopy(chat, picked.filePaths[0]);
  });
  handle('edit', async (conversationId, workbook, sheet, edits) => {
    if (!Array.isArray(edits) || edits.length > 20_000) throw new Error('Invalid edits.');
    const cells = (edits as SheetCellEdit[]).map(edit => ({ ...parseCell(String(edit?.cell ?? '')), input: input(edit?.input) }));
    const result = await books.write(id(conversationId), id(workbook, 'workbook'), id(sheet, 'sheet'), cells, 'person');
    return { info: result.info, errors: result.recalc.errors, recalculated: result.recalc.recalculated };
  });
  handle('save', async (conversationId, workbook) => (await books.save(id(conversationId), id(workbook, 'workbook'), 'person')).info);
  handle('export', async (conversationId, workbook) => {
    const chat = id(conversationId), book = id(workbook, 'workbook');
    const info = await books.get(chat, book);
    const name = `${info.title.replace(/\.xlsx$/i, '').replace(/[/\\:]/g, '-') || 'Workbook'}.xlsx`;
    const folder = folderOf(chat);
    const picked = await dialog.showSaveDialog(window, {
      title: 'Export workbook', defaultPath: folder ? `${folder}/${name}` : name,
      filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
    });
    if (picked.canceled || !picked.filePath) return null;
    const target = extname(picked.filePath).toLowerCase() === '.xlsx' ? picked.filePath : `${picked.filePath}.xlsx`;
    await books.exportTo(chat, book, target);
    shell.showItemInFolder(target);
    return target;
  });
  // What the pane shows: a workbook id, a sheet name, a range. Validated in main; never a path, never cell contents.
  handle('select', (conversationId, view) => {
    if (view === null || view === undefined) { books.setView(id(conversationId), null); return; }
    const shown = view as { workbook?: unknown; sheet?: unknown; range?: unknown };
    books.setView(id(conversationId), { workbook: id(shown.workbook, 'workbook'), sheet: id(shown.sheet, 'sheet'),
      ...(shown.range === undefined ? {} : { range: id(shown.range, 'range') }) });
  });
  handle('remove', async (conversationId, workbook) => {
    const chat = id(conversationId), book = id(workbook, 'workbook');
    const info = await books.get(chat, book);
    const kept = info.source === 'file';
    const answer = await dialog.showMessageBox(window, {
      type: 'warning', buttons: [kept ? 'Close' : 'Delete', 'Cancel'], defaultId: 1, cancelId: 1,
      message: kept ? `Close ${info.title}?` : `Delete ${info.title}?`,
      detail: kept
        ? (info.dirty ? 'Its unsaved changes are discarded. The file in the folder stays as it is.' : 'The file in the folder stays as it is.')
        : 'This workbook is kept only in Hello. Export it first to keep a copy.',
    });
    if (answer.response !== 0) return false;
    await books.remove(chat, book);
    return true;
  });
  return () => { for (const channel of channels) ipcMain.removeHandler(channel); };
}
