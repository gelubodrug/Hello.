import { ipcMain, type BrowserWindow } from 'electron';
import type { PiEngine } from './pi-engine';

/** The window's handles on the Pi engine, under the same rule as every bridge: the app's own top frame only. */
export function registerPiEngineIPC(window: BrowserWindow, engine: PiEngine): () => void {
  const channels: string[] = [];
  const handle = (name: string, run: () => unknown) => {
    const channel = `hello:pi-engine.${name}`;
    ipcMain.handle(channel, async event => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender.');
      return run();
    });
    channels.push(channel);
  };
  handle('status', () => engine.status());
  handle('update', () => engine.update());
  handle('useBundled', () => engine.useBundled());
  return () => { for (const channel of channels) ipcMain.removeHandler(channel); };
}
