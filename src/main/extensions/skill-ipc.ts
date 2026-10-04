import { ipcMain, type BrowserWindow } from 'electron';
import type { SkillCatalog } from './skill-catalog';

/** The composer's / menu on the skill catalog. Only the app's own top frame may call. */
export function registerSkillIPC(window: BrowserWindow, catalog: Pick<SkillCatalog, 'local' | 'search' | 'use'>, changed: () => void): () => void {
  const registered: string[] = [];
  const handle = (name: string, run: (...args: any[]) => unknown) => {
    const channel = `hello:skills.${name}`;
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender.');
      return run(...args);
    });
    registered.push(channel);
  };
  const text = (value: unknown, name: string, limit: number) => {
    if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`Invalid ${name}.`);
    return value.trim();
  };
  handle('list', () => catalog.local());
  handle('search', (query, online) => catalog.search(typeof query === 'string' ? query.slice(0, 200) : '', { online: online === true }));
  handle('use', async (id, conversationId) => {
    const used = await catalog.use(text(id, 'skill', 8192), text(conversationId, 'chat', 200));
    changed();
    return used;
  });
  return () => { for (const channel of registered) ipcMain.removeHandler(channel); };
}
