import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BrowserWindow, session, type Session } from 'electron';
import { publicIP, type PageRenderer } from './web-tools';

/**
 * A real browser page nobody sees, for what a plain request cannot read
 * (user, 26.11: "ce e asta cu duck??? nu găsim un headless browser… are și
 * chrome mai deștept decât această căutare"). A search the engine answers with
 * a bot check, and a page that is empty until its scripts run, were handed
 * back to the model with instructions to open a tab and read it — three steps
 * of a small model's attention for one search. Hello has a browser; it does
 * that itself, out of sight, and the tool answers as if nothing had happened.
 *
 * The page is nobody's: a session of its own that is never written to disk and
 * shares nothing with the browser pane — no cookies, no sign-ins — so a page
 * read this way is the page a stranger would get. It reaches public hosts
 * only, opens no window, saves no file, is granted no permission and makes no
 * sound, and it is gone the moment it has been read.
 */
const PARTITION = 'hello-web-reader';
const LOAD_MS = 15_000;
/** After the page says it loaded: time for what its scripts fetch and draw. */
const SETTLE_MS = 1_200;
const MAX_HTML = 2_000_000;
const AT_ONCE = 2;

const hosts = new Map<string, Promise<boolean>>();
/** Whether a host is on the public internet: the same rule the plain request follows, asked once per host. */
function publicHost(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  let known = hosts.get(host);
  if (!known) {
    known = (async () => {
      if (isIP(host)) return publicIP(host);
      if (!host.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host)) return false;
      try {
        const addresses = await lookup(host, { all: true, verbatim: true });
        return addresses.length > 0 && addresses.every(item => publicIP(item.address));
      } catch {
        return false;
      }
    })();
    hosts.set(host, known);
    if (hosts.size > 2_000) hosts.delete(hosts.keys().next().value!);
  }
  return known;
}

let prepared: Session | undefined;
function readerSession(): Session {
  if (prepared) return prepared;
  const own = session.fromPartition(PARTITION);
  own.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  own.setPermissionCheckHandler(() => false);
  own.on('will-download', event => event.preventDefault());
  own.webRequest.onBeforeRequest((details, callback) => {
    let url: URL;
    try { url = new URL(details.url); } catch { callback({ cancel: true }); return; }
    if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') { callback({}); return; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') { callback({ cancel: true }); return; }
    void publicHost(url.hostname).then(open => callback(open ? {} : { cancel: true }), () => callback({ cancel: true }));
  });
  prepared = own;
  return own;
}

let running = 0;
const waiting: Array<() => void> = [];
async function turn(signal: AbortSignal): Promise<() => void> {
  if (running >= AT_ONCE) await new Promise<void>((resolve, reject) => {
    const go = () => { signal.removeEventListener('abort', stop); resolve(); };
    const stop = () => { waiting.splice(waiting.indexOf(go), 1); reject(signal.reason); };
    signal.addEventListener('abort', stop, { once: true });
    waiting.push(go);
  });
  running += 1;
  return () => { running -= 1; waiting.shift()?.(); };
}

/** The renderer main hands to the web tools. */
export function createWebReader(): PageRenderer {
  return async (url, signal) => {
    signal.throwIfAborted();
    const release = await turn(signal);
    const window = new BrowserWindow({
      show: false, width: 1280, height: 900, focusable: false, skipTaskbar: true,
      webPreferences: { session: readerSession(), sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, images: false, backgroundThrottling: false, spellcheck: false },
    });
    const contents = window.webContents;
    const close = () => { if (!window.isDestroyed()) window.destroy(); };
    signal.addEventListener('abort', close, { once: true });
    try {
      contents.setAudioMuted(true);
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      // A browser's own name: the app's would be asked whether it is a robot.
      contents.setUserAgent(`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`);
      await Promise.race([
        contents.loadURL(url),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('The page took too long to load.')), LOAD_MS)),
      ]);
      await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
      signal.throwIfAborted();
      const html: unknown = await contents.executeJavaScript(`document.documentElement.outerHTML.slice(0, ${MAX_HTML})`, true);
      if (typeof html !== 'string') throw new Error('The page gave nothing to read.');
      return { url: contents.getURL() || url, html };
    } finally {
      signal.removeEventListener('abort', close);
      close();
      release();
    }
  };
}
