import { ipcMain, shell, type BrowserWindow } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import type { DshService } from './service';
import type { DshSurface } from './surface';

/**
 * The window's handles on the DSH surface. Same rule as every other bridge:
 * only the app's own top frame may call; the surface's page, a guest like
 * any other, reaches none of this.
 */
export function registerDshIPC(window: BrowserWindow, service: DshService, surface: DshSurface): () => void {
  const registered: string[] = [];
  const handle = (name: string, run: (...args: any[]) => unknown) => {
    const channel = `hello:dsh.${name}`;
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender.');
      return run(...args);
    });
    registered.push(channel);
  };
  handle('status', () => service.status());
  handle('install', () => service.install());
  handle('start', () => service.start());
  handle('stop', () => service.stop());
  handle('restart', () => service.restart());
  handle('update', () => service.update());
  handle('attach', () => surface.mintAttach());
  handle('detach', nonce => { if (typeof nonce === 'string') surface.detach(nonce); });
  handle('reload', () => surface.reload());
  handle('revealLogs', () => {
    const folder = service.status().logFile.replace(/\/[^/]+$/, '');
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true, mode: 0o700 });
    return shell.openPath(folder).then(() => undefined);
  });
  return () => { for (const channel of registered) ipcMain.removeHandler(channel); };
}
