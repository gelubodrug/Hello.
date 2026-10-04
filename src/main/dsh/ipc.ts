import { ipcMain, shell, type BrowserWindow } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import type { DshService } from './service';
import type { DshSurface } from './surface';

/** The DSH tools' place in Hello's library, which Settings switches. */
export interface DshToolsControl {
  inLibrary(): boolean;
  set(wanted: boolean): Promise<boolean>;
}

/**
 * The window's handles on the DSH surface. Same rule as every other bridge:
 * only the app's own top frame may call; the surface's page, a guest like
 * any other, reaches none of this.
 */
export function registerDshIPC(window: BrowserWindow, service: DshService, surface: DshSurface, tools?: DshToolsControl): () => void {
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
  handle('start', accept => service.start({ acceptProfileChange: accept === true }));
  handle('stop', () => service.stop());
  handle('restart', () => service.restart());
  handle('update', () => service.update());
  handle('useBundled', () => service.useBundled());
  handle('restore', id => {
    if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id)) throw new Error('Invalid restore point.');
    return service.restore(id);
  });
  handle('attach', () => surface.mintAttach());
  handle('detach', nonce => { if (typeof nonce === 'string') surface.detach(nonce); });
  handle('reload', () => surface.reload());
  handle('setUseHelloModel', value => service.setUseHelloModel(value === true));
  handle('toolsInLibrary', () => tools?.inLibrary() ?? false);
  handle('setToolsInLibrary', value => tools?.set(value === true) ?? false);
  handle('revealLogs', () => {
    const folder = service.status().logFile.replace(/\/[^/]+$/, '');
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true, mode: 0o700 });
    return shell.openPath(folder).then(() => undefined);
  });
  return () => { for (const channel of registered) ipcMain.removeHandler(channel); };
}
