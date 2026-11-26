import { ipcMain, type BrowserWindow } from 'electron';
import type { UnclutterService } from './service';

const id = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('Invalid tab.');
  return value;
};
const flag = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new Error('Invalid switch.');
  return value;
};

/**
 * The window's handles on Unclutter, under the same rule as every bridge: the
 * app's own top frame only. The renderer names a tab; which page that is, its
 * page type and what may be done to it are main's to decide.
 */
export function registerUnclutterIPC(window: BrowserWindow, unclutter: UnclutterService): () => void {
  const channels: string[] = [];
  const handle = (name: string, run: (...args: unknown[]) => unknown) => {
    const channel = `hello:unclutter.${name}`;
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender.');
      return run(...args);
    });
    channels.push(channel);
  };
  handle('overview', tabId => unclutter.overview(id(tabId)));
  handle('analyze', tabId => unclutter.analyze(id(tabId)));
  handle('setTypeEnabled', (tabId, enabled) => unclutter.setTypeEnabled(id(tabId), flag(enabled)));
  handle('forgetType', tabId => unclutter.forgetType(id(tabId)));
  handle('setSwitches', input => {
    const value = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
    if (!value || Object.keys(value).some(key => key !== 'enabled' && key !== 'auto')) throw new Error('Invalid switches.');
    return unclutter.setSwitches({
      ...(value.enabled !== undefined ? { enabled: flag(value.enabled) } : {}),
      ...(value.auto !== undefined ? { auto: flag(value.auto) } : {}),
    });
  });
  handle('stopOpenJev', () => unclutter.stopOpenJev());
  return () => { for (const channel of channels) ipcMain.removeHandler(channel); };
}
