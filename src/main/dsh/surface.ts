import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { net, session, type Session, type WebContents, type WebPreferences } from 'electron';
import type { HostReady } from './host';
import { attachNonce, attachUrl, DSH_PARTITION, hostOrigin, navigationFor, parseBootFailure, parseSetCookie } from './surface-rules';

/**
 * The DSH surface's one page: dsh's web client, in a <webview> of the window.
 *
 * Main owns every part of it that matters. The renderer asks for a guest with
 * a nonce minted here and sets nothing else; the guest gets a partition of its
 * own, no preload, no Node, and only the host's origin to live on. The login
 * token the host hands out is exchanged here, in that partition's session, so
 * the page receives a cookie and the renderer never sees the token.
 */
export interface SurfaceOptions {
  /** A web link the page wanted to open: it goes to a browser tab of the person's. */
  openLink(url: string): void;
  downloadsFolder(): string;
  log(line: string): void;
  /** The page itself is gone (crashed or closed); the status line says so. */
  onGone(reason: string): void;
  /** dsh's client could not activate these plugin entries; its boot stopped. */
  onBootFailure?(entries: string[]): void;
}

const ATTACH_TIMEOUT_MS = 30_000;

export class DshSurface {
  private partition?: Session;
  private origin?: string;
  private contents?: WebContents;
  private nonces = new Set<string>();
  private pending?: string;
  private boundNonce?: string;

  constructor(private readonly options: SurfaceOptions) {}

  /** The origin the page lives on while a host runs. */
  get connectedOrigin(): string | undefined {
    return this.origin;
  }

  private ownSession(): Session {
    if (this.partition) return this.partition;
    const partition = session.fromPartition(DSH_PARTITION);
    // The client copies text with the clipboard API and may fill the screen;
    // everything else a page can ask for — camera, microphone, location,
    // notifications, MIDI — is refused.
    const allowed = (permission: string) => permission === 'clipboard-sanitized-write' || permission === 'fullscreen';
    partition.setPermissionCheckHandler((_contents, permission) => allowed(permission));
    partition.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed(permission)));
    partition.on('will-download', (_event, item) => {
      const folder = this.options.downloadsFolder();
      const name = item.getFilename() || 'download';
      const extension = extname(name);
      const stem = name.slice(0, name.length - extension.length) || 'download';
      let target = join(folder, name);
      for (let index = 2; existsSync(target); index++) target = join(folder, `${stem} ${index}${extension}`);
      item.setSavePath(target);
      this.options.log(`DSH surface download: ${target}`);
    });
    this.partition = partition;
    return partition;
  }

  /**
   * Trades the host's one-time token for its session cookie, in the surface's
   * partition, then shows the client. Called on every host start: the port,
   * and so the origin and cookie, change each time.
   */
  async connect(ready: HostReady): Promise<void> {
    const origin = hostOrigin(ready.url);
    const partition = this.ownSession();
    // Each start mints a cookie bound to its own port; the ones of earlier
    // starts only pile up in the jar.
    for (const stale of await partition.cookies.get({ domain: '127.0.0.1' }))
      if (stale.name.startsWith('dsh-auth-')) await partition.cookies.remove(`${origin}/`, stale.name).catch(() => {});
    const headers = await new Promise<string[]>((resolve, reject) => {
      const request = net.request({ method: 'GET', url: ready.url, session: partition, redirect: 'manual', useSessionCookies: true });
      const timer = setTimeout(() => { request.abort(); reject(new Error('The DSH host did not answer its login.')); }, 15_000);
      request.on('redirect', (_status, _method, _redirectUrl, responseHeaders) => {
        clearTimeout(timer);
        const cookies = responseHeaders['set-cookie'] ?? responseHeaders['Set-Cookie'] ?? [];
        request.abort();
        resolve(Array.isArray(cookies) ? cookies : [String(cookies)]);
      });
      request.on('response', response => {
        clearTimeout(timer);
        const cookies = response.headers['set-cookie'] ?? [];
        response.on('data', () => {});
        resolve(Array.isArray(cookies) ? cookies : [String(cookies)]);
      });
      request.on('error', error => { clearTimeout(timer); reject(error); });
      request.end();
    });
    for (const header of headers) {
      const cookie = parseSetCookie(header);
      if (!cookie) continue;
      await partition.cookies.set({
        url: `${origin}/`,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path ?? '/',
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
        ...(cookie.expirationDate ? { expirationDate: cookie.expirationDate } : {}),
      });
    }
    // With session cookies on, the network stack keeps the Set-Cookie itself;
    // the jar is what tells whether the login took.
    if (!(await partition.cookies.get({ domain: '127.0.0.1' })).some(cookie => cookie.name.startsWith('dsh-auth-')))
      throw new Error('The DSH host accepted no login from Hello.');
    this.origin = origin;
    if (this.contents && !this.contents.isDestroyed()) void this.contents.loadURL(`${origin}/`).catch(() => {});
  }

  /** The host stopped: the page stays where it is, and shows nothing new. */
  disconnect(): void {
    this.origin = undefined;
  }

  /** A one-time URL the window may create the surface's guest with. */
  mintAttach(): string {
    const nonce = randomUUID();
    this.nonces.add(nonce);
    setTimeout(() => this.nonces.delete(nonce), ATTACH_TIMEOUT_MS).unref?.();
    return attachUrl(nonce);
  }

  /** The window's door for the surface's <webview>; false for any other tag. */
  approveGuestAttach(preferences: WebPreferences, params: Record<string, string>): boolean {
    const nonce = attachNonce(params.src);
    if (!nonce || !this.nonces.has(nonce)) return false;
    const pinned: WebPreferences = {
      partition: DSH_PARTITION,
      session: this.ownSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
    };
    for (const key of Object.keys(preferences)) delete (preferences as Record<string, unknown>)[key];
    Object.assign(preferences, pinned);
    for (const key of ['preload', 'nodeintegration', 'nodeintegrationinsubframes', 'webpreferences', 'disablewebsecurity', 'plugins'])
      delete params[key];
    params.partition = DSH_PARTITION;
    // window.open reaches this surface's handler, which answers it.
    params.allowpopups = 'true';
    this.pending = nonce;
    return true;
  }

  /** True when the guest just attached is the surface's, which this binds. */
  adoptGuest(contents: WebContents): boolean {
    const nonce = this.pending;
    if (!nonce) return false;
    this.pending = undefined;
    this.nonces.delete(nonce);
    if (this.contents && this.contents !== contents && !this.contents.isDestroyed()) this.contents.close();
    this.contents = contents;
    this.boundNonce = nonce;
    this.wire(contents);
    if (this.origin) void contents.loadURL(`${this.origin}/`).catch(() => {});
    return true;
  }

  /** The window let go of the guest it created with this nonce. */
  detach(nonce: string): void {
    if (!nonce || nonce !== this.boundNonce) return;
    const contents = this.contents;
    this.contents = undefined;
    this.boundNonce = undefined;
    if (contents && !contents.isDestroyed()) contents.close();
  }

  /** Reloads the client, for the person's Reload. */
  reload(): void {
    if (this.contents && !this.contents.isDestroyed() && this.origin) void this.contents.loadURL(`${this.origin}/`).catch(() => {});
  }

  private wire(contents: WebContents): void {
    contents.setWindowOpenHandler(({ url }) => {
      if (navigationFor(url, undefined) === 'elsewhere') this.options.openLink(url);
      return { action: 'deny' };
    });
    const guard = (event: Electron.Event, url: string) => {
      const decision = navigationFor(url, this.origin);
      if (decision === 'allow') return;
      event.preventDefault();
      if (decision === 'elsewhere') this.options.openLink(url);
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('console-message', (event: unknown, _level?: unknown, legacyMessage?: unknown) => {
      const message = (event as { message?: unknown })?.message ?? legacyMessage;
      const entries = parseBootFailure(message);
      if (entries) this.options.onBootFailure?.(entries);
    });
    contents.on('render-process-gone', (_event, details) => {
      this.options.onGone(details.reason === 'clean-exit' ? 'The DSH page closed.' : `The DSH page stopped (${details.reason}).`);
    });
    contents.on('destroyed', () => {
      if (this.contents === contents) {
        this.contents = undefined;
        this.boundNonce = undefined;
      }
    });
  }

  dispose(): void {
    const contents = this.contents;
    this.contents = undefined;
    if (contents && !contents.isDestroyed()) contents.close();
  }
}
