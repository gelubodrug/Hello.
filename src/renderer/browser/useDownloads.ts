import { useEffect, useState } from 'react';
import type { BrowserDownload } from '../../shared/types';
import { api } from '../api';

/**
 * This chat's downloads, newest first, kept current: the list once, then
 * every change main tells the window about — progress while a file saves,
 * its end, a row removed. One list per chat, whichever tab the file came from.
 */
export function useDownloads(conversationId: string): BrowserDownload[] {
  const [downloads, setDownloads] = useState<BrowserDownload[]>([]);
  useEffect(() => {
    let dropped = false;
    setDownloads([]);
    // A preload from before downloads had a list: the button shows nothing, the pane still works.
    const bridge = api.browser.downloads as typeof api.browser.downloads | undefined;
    if (!bridge) return;
    void bridge.list(conversationId).then(list => { if (!dropped) setDownloads(list); }).catch(() => {});
    const stop = bridge.onChange(event => {
      if (event.type === 'removed') {
        if (event.conversationId === conversationId) setDownloads(current => current.filter(item => item.id !== event.id));
        return;
      }
      const { download } = event;
      if (download.conversationId !== conversationId) return;
      setDownloads(current => {
        const rest = current.filter(item => item.id !== download.id);
        return [download, ...rest].sort((a, b) => b.startedAt - a.startedAt);
      });
    });
    return () => { dropped = true; stop(); };
  }, [conversationId]);
  return downloads;
}
