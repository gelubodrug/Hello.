import { BrowserWindow, session } from "electron";
import type { DownloadItem, HandlerDetails, Session, WebContents, WebFrameMain, WebPreferences } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type {
  AgentControl,
  BrowserDownload,
  BrowserDownloadEvent,
  BrowserTab,
  BrowserLifecycleEvent,
  BrowserContent,
  ViewBounds,
} from "../../shared/types";
import {
  browserURL,
  checkAgentAccess,
  checkAgentOwnership,
  isAgentControl,
  safeBounds,
} from "./policy";
import {
  AGENT_INPUT_WORLD_ID,
  DOWNLOAD_FINISH_MS,
  DOWNLOAD_START_MS,
  VIEWPORT_SCRIPT,
  checkPointerInViewport,
  checkRegionInViewport,
  encodeFrame,
  keyEvents,
  pause,
  pointerEvents,
  type PointerAction,
  type Screenshot,
  type ScreenshotRequest,
} from "./agent-input";
import {
  ERASE_SCRIPT, FRAME_BOXES_SCRIPT, READ_HEADER, hitScript, locateScript, matchesUrl, scanScript, typeScript, waitScript,
  type ElementTarget, type ScanResult, type WaitCondition,
} from "./agent-target";

interface PendingOperation {
  cancel(error: Error): void;
  mutation: boolean;
  navigation: boolean;
}
interface RecordTab {
  tab: BrowserTab;
  partition?: string;
  /** The renderer's <webview> guest, once this manager has adopted it. */
  contents?: WebContents;
  /** Resolved by adoptGuest(); an operation that arrives first waits on it. */
  waiting?: Array<(contents: WebContents) => void>;
  /** Set when a page was discarded for cause; only an explicit reload clears it. */
  blocked?: boolean;
  /** Set while the window is unmounting this tab's guest on purpose. */
  detaching?: boolean;
  /** The nonce the current guest was created with, so a stale unmount cannot close a newer page. */
  attachNonce?: string;
  /** The slot a chat's generated document lives in, reused by the next one. */
  artifact?: boolean;
  /** Set while its document is being served again after a restart. */
  serving?: boolean;
  /** The exact address this chat's generated document is being served at. */
  servedUrl?: string;
  pending: Set<PendingOperation>;
  navigation: number;
  /** The frames the latest read numbered, each with its range of refs and where it sits on the page. */
  refs?: FrameRefs[];
}
interface FrameRefs {
  frame: WebFrameMain;
  /** Where the frame sits in the page, in page CSS px; (0, 0) for the main frame. */
  offset: { x: number; y: number };
  /** What browser_read calls it: "" for the main frame. */
  label: string;
  start: number;
  end: number;
}
/** How many frames one read looks into, and how deep. */
const FRAME_LIMIT = 12;
const FRAME_DEPTH = 3;
/** How much of a child frame's text a read takes. */
const FRAME_TEXT_LIMIT = 6_000;
/** How often a wait looks again. */
const WAIT_POLL_MS = 250;
/**
 * What happened to a tab's page, for main-process observers that must stop
 * using it (page modes). Observers see; they never decide anything here.
 */
export type BrowserPageEvent =
  | { type: "updated"; tab: BrowserTab }
  | { type: "active"; id: string | null }
  | { type: "detached"; id: string }
  | { type: "closed"; id: string };
/** A file name a page proposed, made safe for the chat's folder: no path in
 *  it, nothing hidden, nothing unprintable, and never empty. */
export function safeFileName(proposed: string): string {
  const name = basename(proposed.replace(/[\\/]+/g, "/"))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return name || "download";
}
/** The path that name gets in the folder, numbered rather than overwriting. */
export function uniquePath(folder: string, name: string): string {
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length) || name;
  let candidate = join(folder, name);
  for (let index = 2; existsSync(candidate) && index < 1_000; index += 1)
    candidate = join(folder, `${stem}-${index}${extension}`);
  return candidate;
}
/** How long a main-process operation waits for the window to host a page. */
export const BROWSER_ATTACH_TIMEOUT_MS = 10_000;
export const BROWSER_OPERATION_TIMEOUT_MS = 15_000;
/** A click on something that speaks of a download waits this long for it to appear… */
export const DOWNLOAD_NOTICE_MS = 3_000;
/** …and any other click only glances, so an ordinary click is not three seconds slower. */
export const DOWNLOAD_GLANCE_MS = 400;
/** The words on a control that make a download likely, so the click's result waits for it. */
const SPEAKS_OF_DOWNLOAD = /download|export|save|pdf|csv|zip|xlsx|descarc|invoice|factur|receipt/i;
/** …and this long more for it to finish, so a small file is reported saved. */
export const DOWNLOAD_SETTLE_MS = 1_500;
/** Progress is told to the window at most this often. */
const DOWNLOAD_PROGRESS_MS = 250;
/**
 * What a pointer action's point was on, for its result: a click on a control
 * says the control and its ref, and that a ref finds it wherever the page has
 * scrolled while a point does not.
 */
function landing(hit: unknown, action: PointerAction["action"]): string {
  if (!hit || typeof hit !== "object") return "";
  const { what, ref, control } = hit as { what?: unknown; ref?: unknown; control?: unknown };
  if (typeof what !== "string" || !what) return "";
  const verb = action === "drag" ? "It started on" : action === "hover" ? "It is over" : "It landed on";
  const handle = typeof ref === "string" && /^e\d{1,4}$/.test(ref) ? ref : "";
  const on = `${verb} ${what.slice(0, 160)}${handle ? ` (${handle})` : ""}`;
  if (action !== "click" || control !== true) return ` ${on}.`;
  return ` ${on} — a control. Click controls with browser_click ${handle ? `ref "${handle}"` : "label"}: it finds the control wherever the page has scrolled, and a point does not.`;
}
/** Where a file came from, for the list: origin and path, never a query string or credentials. */
export function sourceOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
    return `${parsed.origin}${parsed.pathname}`.slice(0, 2000);
  } catch {
    return undefined;
  }
}
const browserPreferences: WebPreferences = {
  partition: "persist:hello-web",
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webviewTag: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  backgroundThrottling: true,
  // The built-in PDF viewer: an invoice, a statement, a paper open in the
  // tab like any page. Without it a PDF is a download, and downloads are
  // refused here.
  plugins: true,
};
interface BrowserOptions {
  window: BrowserWindow;
  initial: BrowserTab[];
  conversationExists(id: string): boolean;
  /** The folder attached to a chat, where a page's download lands first. */
  folderFor?(id: string): string | null;
  /** Where a download lands when the chat has no folder: the system's Downloads. */
  downloadsFolder?(): string | null;
  /** This chat's downloads from earlier sessions, oldest first. */
  initialDownloads?: BrowserDownload[];
  saveDownload?(download: BrowserDownload): void;
  removeDownload?(id: string): void;
  /** A download changed, or left the list — for the window's downloads panel. */
  downloadEvent?(event: BrowserDownloadEvent): void;
  save(tab: BrowserTab): void;
  remove(id: string): void;
  emit(tab: BrowserTab): void;
  lifecycle?(event: BrowserLifecycleEvent): void;
  /** Produces a page again from its handle and returns the address it is at now. */
  serve?(conversationId: string, source: string): Promise<string>;
}

/** One native viewport; inactive pages stay alive without covering application chrome. */
export class BrowserManager {
  private records = new Map<string, RecordTab>();
  private activeId: string | null = null;
  private disposed = false;
  private partition = session.fromPartition("persist:hello-web");
  private previewPartitions = new Map<string, Session>();
  /** One-time permissions for the window to create a guest for a given tab. */
  private attachNonces = new Map<string, string>();
  /** The record whose guest Electron is attaching right now. */
  private pendingGuest?: { record: RecordTab; nonce: string };
  /** This chat's downloads, by id, oldest first — every session's. */
  private downloads = new Map<string, BrowserDownload>();
  /** The ones still saving, so one can be cancelled. */
  private items = new Map<string, DownloadItem>();
  /**
   * A download lands in the chat's attached folder, or — like any browser's —
   * in the system Downloads folder, and it lands on the CHAT's list, not on a
   * tab: a "Download invoice" that opens a popup for the file put it on a tab
   * the person never saw and the model never checked, so the click came back
   * with nothing and the model reported "0 downloads confirmed" over files
   * that were on disk (user, 24.09: "ca în Chrome, profesional"). The popup
   * that only carried a file is closed again, as a browser closes it, and the
   * download is the opener's. Only a download from no page of ours is refused.
   */
  private onDownload = (event: { preventDefault(): void }, item?: DownloadItem, contents?: WebContents) => {
    const record = contents
      ? [...this.records.values()].find(candidate => candidate.contents === contents)
      : undefined;
    if (!record || !item) { event.preventDefault(); return; }
    const name = safeFileName(item.getFilename?.() ?? "");
    // A popup that turned into a download never showed a page: it goes, the
    // way a browser closes the tab a download link opened, and the file is
    // the opener's.
    const carrier = record.tab.openerId && (contents?.getURL?.() ?? "about:blank") === "about:blank"
      ? record : undefined;
    const tabId = carrier?.tab.openerId && this.records.has(carrier.tab.openerId) ? carrier.tab.openerId : record.tab.id;
    const download: BrowserDownload = {
      id: randomUUID(), conversationId: record.tab.conversationId, tabId, name,
      url: sourceOf(item.getURL?.()), mimeType: item.getMimeType?.() || undefined,
      state: "saving", startedAt: Date.now(), bytes: 0,
      ...(item.getTotalBytes?.() > 0 ? { total: item.getTotalBytes() } : {}),
    };
    const folder = this.options.folderFor?.(record.tab.conversationId) ?? this.options.downloadsFolder?.() ?? null;
    if (!folder) {
      event.preventDefault();
      this.noteDownload({ ...download, state: "refused", reason: "there is no folder to save into", finishedAt: Date.now() });
      return;
    }
    download.path = uniquePath(folder, name);
    download.name = basename(download.path);
    item.setSavePath(download.path);
    this.items.set(download.id, item);
    this.noteDownload(download);
    let published = Date.now();
    item.on("updated", () => {
      const now = Date.now();
      if (now - published < DOWNLOAD_PROGRESS_MS) return;
      published = now;
      const total = item.getTotalBytes();
      this.noteDownload({ ...download, bytes: item.getReceivedBytes(), ...(total > 0 ? { total } : {}) }, false);
    });
    item.once("done", (_event, state) => {
      this.items.delete(download.id);
      const total = item.getTotalBytes();
      const done: BrowserDownload = {
        ...this.downloads.get(download.id) ?? download,
        state: state === "completed" ? "saved" : state === "cancelled" ? "cancelled" : "failed",
        ...(state === "completed" ? {} : { reason: state === "cancelled" ? "cancelled" : "interrupted" }),
        bytes: item.getReceivedBytes(), ...(total > 0 ? { total } : {}), finishedAt: Date.now(),
      };
      if (!this.downloads.has(download.id)) return; // Removed from the list while saving.
      this.noteDownload(done);
      if (!this.disposed) this.options.lifecycle?.({ type: "downloaded", id: done.tabId ?? record.tab.id, conversationId: done.conversationId, download: { ...done } });
    });
    if (carrier) setImmediate(() => { if (this.records.get(carrier.tab.id) === carrier) this.close(carrier.tab.id, true); });
  };
  /** Keep, tell the window, and — unless it is a progress tick — keep on disk. */
  private noteDownload(download: BrowserDownload, persist = true): void {
    if (this.disposed) return;
    this.downloads.set(download.id, download);
    if (persist) this.options.saveDownload?.({ ...download });
    this.options.downloadEvent?.({ type: "updated", download: { ...download } });
  }
  /** This chat's downloads, newest first. */
  downloadsOf(conversationId: string): BrowserDownload[] {
    return [...this.downloads.values()].filter(download => download.conversationId === conversationId)
      .sort((a, b) => b.startedAt - a.startedAt).map(download => ({ ...download }));
  }
  private download(id: string): BrowserDownload {
    const download = this.downloads.get(id);
    if (!download) throw new Error("This download is no longer listed.");
    return download;
  }
  /** Where this chat's downloads land: its folder, else the system's Downloads. */
  downloadFolder(conversationId: string): string {
    const folder = this.options.folderFor?.(conversationId) ?? this.options.downloadsFolder?.() ?? null;
    if (!folder) throw new Error("There is no folder to save into.");
    return folder;
  }
  /** The saved file's path, for opening or revealing it. */
  downloadPath(id: string): string {
    const download = this.download(id);
    if (download.state !== "saved" || !download.path) throw new Error(download.state === "saving" ? "This file is still being saved." : "This file was not saved.");
    if (!existsSync(download.path)) throw new Error("This file is no longer where it was saved.");
    return download.path;
  }
  cancelDownload(id: string): void {
    const download = this.download(id);
    if (download.state !== "saving") return;
    this.items.get(id)?.cancel();
  }
  /** Off the list; a file being saved is cancelled first. The file stays. */
  removeDownload(id: string): void {
    const download = this.download(id);
    this.items.get(id)?.cancel();
    this.items.delete(id);
    this.downloads.delete(id);
    this.options.removeDownload?.(id);
    this.options.downloadEvent?.({ type: "removed", id, conversationId: download.conversationId });
  }
  /** Every finished download of this chat off the list. */
  clearDownloads(conversationId: string): void {
    for (const download of this.downloadsOf(conversationId))
      if (download.state !== "saving") this.removeDownload(download.id);
  }
  /**
   * What this chat saved, or could not, since a moment — for the result of
   * the click that caused it. A page takes a moment to ask, and a generated
   * invoice a few more: the wait is for the first download to appear, then a
   * short one for it to finish.
   */
  private async downloadsSince(conversationId: string, since: number, signal?: AbortSignal, patienceMs = DOWNLOAD_GLANCE_MS): Promise<string> {
    const fresh = () => this.downloadsOf(conversationId).filter(download => download.startedAt >= since);
    for (let waited = 0; !fresh().length && waited < patienceMs; waited += 100) await pause(100, signal);
    for (let waited = 0; fresh().some(download => download.state === "saving") && waited < DOWNLOAD_SETTLE_MS; waited += 200) await pause(200, signal);
    const downloads = fresh();
    if (!downloads.length) return "";
    return " " + downloads.map(download => download.state === "refused"
      ? `The page offered a download (${download.name || "a file"}) and it was refused: ${download.reason}.`
      : download.state === "saved"
        ? `Saved ${download.name} → ${download.path}${download.bytes ? ` (${download.bytes} bytes)` : ""}. It is on disk now; do not look for another way to fetch it.`
        : download.state === "saving"
          ? `Download started: ${download.name} → ${download.path}${download.total ? ` (${download.bytes ?? 0} of ${download.total} bytes)` : ""}; still saving. It will be on disk in a moment — browser_downloads shows when; do not look for another way to fetch it.`
          : `The download of ${download.name} ${download.state === "cancelled" ? "was cancelled" : `failed (${download.reason ?? "interrupted"})`}.`,
    ).join(" ");
  }
  private hideForShellLoad = () => this.setActive(null);
  private pageObservers = new Set<(event: BrowserPageEvent) => void>();
  constructor(private options: BrowserOptions) {
    for (const download of options.initialDownloads ?? []) this.downloads.set(download.id, { ...download });
    for (const saved of options.initial) {
      let url = "about:blank";
      try {
        url = browserURL(saved.url);
      } catch {
        /* Never restore a non-web URL. */
      }
      if (options.conversationExists(saved.conversationId))
        this.records.set(saved.id, {
          tab: {
            ...saved,
            url,
            // The grant the human set on this page comes back with it (user,
            // 22.09: "să se rețină setările paginilor AI permission între
            // sesiuni"). A generated document is the exception: its Full is
            // granted again when it is served again, never restored blind.
            control: !saved.source && isAgentControl(saved.control) ? saved.control : "off",
            loading: false,
            canGoBack: false,
            canGoForward: false,
          },
          pending: new Set(),
          navigation: 0,
          // A restored document keeps its slot and its own session: the page is
          // the same generated page, and it is still not the signed-in web.
          ...(saved.source
            ? { artifact: true, partition: `hello-preview-${randomUUID()}` }
            : {}),
        });
    }
    this.securePartition(this.partition);
    options.window.webContents.on("did-start-loading", this.hideForShellLoad);
  }
  /**
   * Every permission a page asks for is refused — but one: filling the
   * screen, as a video does in any browser. Chromium asks the session for
   * `fullscreen` before requestFullscreen() does anything, and the flat
   * refusal left every video's full-screen button dead (user, 26.09: "de ce
   * full screen la video nu face nimic?"). Only the page of the tab on screen
   * gets it: a tab out of sight never takes over the window.
   */
  private securePartition(partition: Session): void {
    partition.setPermissionCheckHandler((contents, permission) => permission === "fullscreen" && this.isShown(contents));
    partition.setPermissionRequestHandler((contents, permission, callback) => callback(permission === "fullscreen" && this.isShown(contents)));
    partition.on("will-download", this.onDownload);
  }
  /** Whether a page is the one the window is showing now. */
  private isShown(contents: WebContents | null | undefined): boolean {
    if (!contents || this.disposed || !this.activeId) return false;
    return this.records.get(this.activeId)?.contents === contents;
  }
  private preferences(record: RecordTab, native?: WebPreferences): WebPreferences {
    let selected = this.partition;
    if (record.partition) {
      const existing = this.previewPartitions.get(record.partition);
      if (existing) selected = existing;
      else {
        selected = session.fromPartition(record.partition);
        this.securePartition(selected);
        this.previewPartitions.set(record.partition, selected);
      }
    }
    // Explicit session wins over Electron's partition option. Never retain a
    // native popup option that would put generated HTML into the signed-in web
    // session, or merge cookie/storage origins between different previews.
    return { ...native, ...browserPreferences, partition: record.partition ?? "persist:hello-web", session: selected };
  }
  /**
   * The window's only door for a <webview>. The renderer may ask for a guest,
   * but every preference that decides what that guest can do is written here,
   * over whatever the tag asked for: a page still gets no Node, no preload it
   * chose, no nested webviews, and only a partition this manager owns. The
   * tag's own src is forced blank; navigation stays a main-process decision.
   */
  approveGuestAttach(preferences: WebPreferences, params: Record<string, string>): boolean {
    // The tag may only ask for a page by presenting a nonce this manager minted
    // for one tab. Everything else about the guest is decided here.
    const record = this.recordForNonce(params.src);
    if (!record) return false;
    const wanted = record.partition ?? "persist:hello-web";
    const pinned = this.preferences(record);
    for (const key of Object.keys(preferences)) delete (preferences as Record<string, unknown>)[key];
    Object.assign(preferences, pinned);
    delete (preferences as Record<string, unknown>).preload;
    delete params.preload;
    delete params.nodeintegration;
    delete params.nodeintegrationinsubframes;
    delete params.webpreferences;
    delete params.disablewebsecurity;
    params.partition = wanted;
    // Electron emits did-attach-webview for this same guest immediately after
    // this handler returns, and the guest has no URL yet at that point. The
    // record resolved here is what binds it; the nonce is checked again when
    // its first navigation commits.
    this.pendingGuest = { record, nonce: this.nonceOf(params.src)! };
    // window.open is answered by this manager's handler on the guest itself.
    params.allowpopups = "true";
    return true;
  }
  /** A one-time URL the window may create a guest with, for this tab only. */
  mintAttach(tabId: string): string {
    const record = this.record(tabId);
    if (record.blocked)
      throw new Error("This page was stopped. Reload it to continue.");
    const nonce = randomUUID();
    this.attachNonces.set(nonce, record.tab.id);
    // A nonce the window never uses must not keep a tab attachable for ever.
    setTimeout(() => this.attachNonces.delete(nonce), BROWSER_ATTACH_TIMEOUT_MS * 3).unref?.();
    // An empty document every session can open, carrying in its own URL which
    // tab the guest belongs to. A custom scheme would need a handler in each
    // partition; this needs none.
    return `about:blank#hello-attach-${nonce}`;
  }
  private nonceOf(src: unknown): string | undefined {
    if (typeof src !== "string") return undefined;
    return /^about:blank#hello-attach-([\da-f-]{36})$/i.exec(src.trim())?.[1];
  }
  private recordForNonce(src: unknown): RecordTab | undefined {
    const nonce = this.nonceOf(src);
    const tabId = nonce && this.attachNonces.get(nonce);
    if (!tabId) return undefined;
    return this.records.get(tabId);
  }
  /**
   * Binds a guest the window just created to the tab whose nonce it carries,
   * and puts on it every rule a page of ours runs under.
   */
  adoptGuest(contents: WebContents): void {
    const pending = this.pendingGuest;
    this.pendingGuest = undefined;
    if (!pending || contents.hostWebContents !== this.options.window.webContents) {
      contents.close();
      return;
    }
    const { record, nonce } = pending;
    this.attachNonces.delete(nonce);
    record.attachNonce = nonce;
    // The URL this guest was created with must be the one that was approved.
    contents.once("did-navigate", (_event, url) => {
      if (this.nonceOf(url) && this.nonceOf(url) !== nonce) {
        record.contents = undefined;
        contents.close();
      }
    });
    if (record.contents && record.contents !== contents && !record.contents.isDestroyed())
      record.contents.close();
    record.contents = contents;
    this.wire(record, contents);
    // A page asked for by an operation is loaded by that operation. Only a tab
    // the window mounted on its own — created, restored, reopened — is loaded
    // here, and then exactly once. Each waiter removes itself from the array as
    // it settles, so whether anyone was waiting is read before resolving them.
    const waiting = record.waiting ?? [];
    const awaited = waiting.length > 0;
    record.waiting = [];
    for (const resolve of [...waiting]) resolve(contents);
    if (!awaited && record.tab.url !== "about:blank")
      void contents.loadURL(record.tab.url).catch(() => {});
  }
  /** The page for this tab, as it is right now. */
  private contentsFor(record: RecordTab): WebContents {
    const contents = record.contents;
    if (!contents || contents.isDestroyed())
      throw new Error("This page is not open in the app window.");
    return contents;
  }
  /** The page for this tab, waiting for the window to host it if it must. */
  private whenAttached(record: RecordTab, signal?: AbortSignal): Promise<WebContents> {
    if (record.contents && !record.contents.isDestroyed()) return Promise.resolve(record.contents);
    if (record.blocked) return Promise.reject(new Error("This page was stopped. Reload it to continue."));
    // Tell the window this tab needs a page; it answers by creating a guest.
    this.options.emit({ ...record.tab });
    return new Promise<WebContents>((resolve, reject) => {
      const waiters = (record.waiting ??= []);
      const drop = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        const at = waiters.indexOf(settle);
        if (at >= 0) waiters.splice(at, 1);
      };
      const settle = (contents: WebContents) => { drop(); resolve(contents); };
      const abort = () => { drop(); reject(new Error("The pending browser action was stopped.")); };
      const timer = setTimeout(() => {
        drop();
        reject(new Error("This page is not open in the app window."));
      }, BROWSER_ATTACH_TIMEOUT_MS);
      waiters.push(settle);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  private releasePreviewPartition(partition?: string): void {
    if (!partition || [...this.records.values()].some(record => record.partition === partition)) return;
    const selected = this.previewPartitions.get(partition);
    if (!selected) return;
    this.previewPartitions.delete(partition);
    selected.removeListener("will-download", this.onDownload);
    // These uniquely named memory partitions are never reused or persisted.
    void selected.clearStorageData().catch(() => {});
    void selected.clearCache().catch(() => {});
  }
  /** Read-only: a tab as it is now and the page hosting it, if one is attached. */
  pageFor(tabId: string): { tab: BrowserTab; contents?: WebContents } | undefined {
    const record = this.records.get(tabId);
    if (!record || this.disposed) return undefined;
    const contents = record.contents && !record.contents.isDestroyed() ? record.contents : undefined;
    return { tab: { ...record.tab }, ...(contents ? { contents } : {}) };
  }
  /** Told after a tab changes, is shown or hidden, loses its page or closes. */
  observePages(listener: (event: BrowserPageEvent) => void): () => void {
    this.pageObservers.add(listener);
    return () => this.pageObservers.delete(listener);
  }
  private notifyPage(event: BrowserPageEvent): void {
    for (const listener of [...this.pageObservers]) {
      try { listener(event); } catch { /* An observer never breaks the browser. */ }
    }
  }
  list(conversationId?: string): BrowserTab[] {
    return [...this.records.values()]
      .map(({ tab }) => ({ ...tab }))
      .filter(
        (tab) => !conversationId || tab.conversationId === conversationId,
      );
  }
  private record(id: string): RecordTab {
    const record = this.records.get(id);
    if (!record || this.disposed)
      throw new Error("This browser tab is closed.");
    return record;
  }
  listForAgent(conversationId: string): Array<BrowserTab & { visible: boolean }> {
    return this.list(conversationId).map(tab => ({ ...tab, visible: tab.id === this.activeId }));
  }
  private publish(record: RecordTab): void {
    if (this.disposed || !this.records.has(record.tab.id)) return;
    // Site-opened tabs can contain short-lived authentication state in their URL.
    // Keep them live in this session, not in the restore database.
    // A generated document outlives the session it was made in: its tab is
    // saved by the handle that can produce it again, never by a local URL
    // whose port dies with the app.
    if (record.tab.source)
      this.options.save({ ...record.tab, control: "off", url: "about:blank", loading: false });
    else if (!record.tab.pageOwned && !record.tab.sessionOnly)
      // With its grant: what the human chose for this page is kept for it.
      this.options.save({ ...record.tab });
    this.options.emit({ ...record.tab });
    this.notifyPage({ type: "updated", tab: { ...record.tab } });
  }
  private cancelPending(
    record: RecordTab,
    error: Error,
    mutationsOnly = false,
    keepNavigation = false,
  ): void {
    for (const operation of [...record.pending])
      if ((!mutationsOnly || operation.mutation) && !(keepNavigation && operation.navigation)) operation.cancel(error);
  }
  /**
   * Destroying the guest is what stops a pending script: the frame it would run
   * in is gone. The window keeps its element, but no new page may be created
   * for this tab until the user asks for one, or the discard would be undone by
   * the next remount.
   */
  private discardView(record: RecordTab, error?: Error): void {
    const contents = record.contents;
    record.contents = undefined;
    record.blocked = true;
    record.detaching = false;
    if (contents && !contents.isDestroyed()) contents.close();
    if (this.activeId === record.tab.id) this.activeId = null;
    if (contents) this.notifyPage({ type: "detached", id: record.tab.id });
    if (error) {
      record.tab.error = `${error.message} Reload this page to continue.`;
      record.tab.loading = false;
      record.tab.progress = null;
      this.publish(record);
    }
  }
  private operation<T>(
    record: RecordTab,
    start: () => Promise<T>,
    options: {
      signal?: AbortSignal;
      mutation?: boolean;
      navigation?: boolean;
      onCancel?(): void;
    } = {},
  ): Promise<T> {
    options.signal?.throwIfAborted();
    this.record(record.tab.id);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        record.pending.delete(pending);
        options.signal?.removeEventListener("abort", abort);
      };
      const finish = (error?: unknown, result?: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error !== undefined) reject(error);
        else resolve(result as T);
      };
      const pending: PendingOperation = {
        mutation: Boolean(options.mutation),
        navigation: Boolean(options.navigation),
        cancel: (error) => {
          if (settled) return;
          // Settle first: closing the native view can synchronously emit more events.
          finish(error);
          options.onCancel?.();
        },
      };
      const abort = () =>
        pending.cancel(new Error("Browser operation stopped."));
      const timeout = setTimeout(
        () => pending.cancel(new Error("Browser operation timed out.")),
        BROWSER_OPERATION_TIMEOUT_MS,
      );
      record.pending.add(pending);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        return;
      }
      try {
        start().then(
          (result) => finish(undefined, result),
          (error) => finish(error),
        );
      } catch (error) {
        finish(error);
      }
    });
  }
  /** Every rule a page of ours runs under, put on the guest at adoption. */
  private wire(record: RecordTab, contents: WebContents): void {
    contents.on("focus", () => {
      if (
        this.disposed || record.contents !== contents || this.activeId !== record.tab.id ||
        this.options.window.webContents.isDestroyed()
      ) return;
      // A click in this native view cannot bubble to the app's DOM menus.
      this.options.window.webContents.send("hello:browser-focus");
    });
    contents.setWindowOpenHandler((details) => {
      if (record.contents !== contents || this.disposed) return { action: "deny" };
      let url: string;
      try {
        url = browserURL(details.url);
      } catch {
        return { action: "deny" };
      }
      // A page that opens a window gets a TAB beside the one it came from,
      // never a window of its own outside the app: an invoice's "View" opened
      // a native window the human had to hunt for and the agent could not see
      // at all (user, 22.09). What a child window would have kept — its
      // opener, postMessage, a POST body Chromium had already prepared — is
      // given up for that; a blank popup has nothing to show and is refused.
      if (!/^https?:/i.test(url)) return { action: "deny" };
      const popup = this.newRecord(record.tab.conversationId, url, record.tab.id, record.partition);
      // It is the opener's page carrying on in another tab, so the human's
      // grant on that page goes with it: a "View" the agent clicked opens
      // something the agent can read.
      popup.tab.control = record.tab.control;
      this.publish(popup);
      this.options.lifecycle?.({
        type: "opened",
        tab: { ...popup.tab },
        foreground: details.disposition !== "background-tab",
      });
      void this.navigate(popup.tab.id, url).catch(() => {
        /* A failed load is shown on the tab itself. */
      });
      return { action: "deny" };
    });
    // window.close() destroys the native contents, not just its pixels. Remove
    // the corresponding pill and let the renderer return to the opener.
    // A destroyed guest is not a closed tab: the window unmounts and remounts
    // pages as panes come and go. Only the page asking to close is a close, and
    // the window reports that through browser.close when its element says so.
    contents.once("destroyed", () => {
      if (record.contents !== contents) return;
      record.contents = undefined;
      record.detaching = false;
    });
    // Remote popup resize/move requests must never move the Hello. host window.
    contents.on("content-bounds-updated", (event) => event.preventDefault());
    contents.on("will-navigate", (event, url) => {
      try {
        browserURL(url);
      } catch {
        event.preventDefault();
      }
    });
    contents.on("will-redirect", (event, url) => {
      try {
        browserURL(url);
      } catch {
        event.preventDefault();
      }
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    const refresh = () => {
      if (contents.isDestroyed() || record.contents !== contents) return;
      // The URL main minted to claim this guest is a door, not a destination:
      // adopting it would put main's own handshake in the address bar.
      const reported = contents.getURL();
      const url = this.nonceOf(reported) ? "about:blank" : reported;
      // A generated page can send itself somewhere; the grant does not follow.
      if (url && url !== "about:blank") this.endOwnWork(record, url);
      record.tab = {
        ...record.tab,
        ...(url && !record.tab.error ? { url } : {}),
        title:
          (this.nonceOf(contents.getTitle()) ? "" : contents.getTitle()) ||
          (url === "about:blank" ? "New tab" : record.tab.title),
        loading: contents.isLoading(),
        progress: contents.isLoading() ? (record.tab.progress ?? 0) : null,
        canGoBack: contents.navigationHistory.canGoBack(),
        canGoForward: contents.navigationHistory.canGoForward(),
      };
      this.publish(record);
    };
    contents.on("did-start-loading", () => {
      if (contents.isDestroyed() || record.contents !== contents) return;
      // getURL can still be the previous page (or about:blank) at load start.
      // Keep the requested address until a navigation actually commits.
      record.tab.loading = true;
      record.tab.progress = 0;
      record.tab.error = null;
      this.publish(record);
    });
    // Electron's WebContents typing omits this event in some versions.
    (contents.on as (event: string, fn: (...a: unknown[]) => void) => void)(
      "did-change-loading-progress",
      (_event, progress) => {
        if (contents.isDestroyed() || record.contents !== contents) return;
        record.tab.progress = Math.round((progress as number) * 100);
        this.publish(record);
      },
    );
    contents.on("did-stop-loading", refresh);
    contents.on("did-navigate", refresh);
    contents.on("did-navigate-in-page", refresh);
    contents.on("page-title-updated", refresh);
    contents.on(
      "did-fail-load",
      (_event, code, description, failedURL, isMainFrame) => {
        if (code === -3 || !isMainFrame || record.contents !== contents) return;
        try { if (failedURL) record.tab.url = browserURL(failedURL); } catch { /* Keep the last allowed address. */ }
        record.tab.error = description || "The page could not be loaded.";
        record.tab.loading = false;
        record.tab.progress = null;
        this.publish(record);
      },
    );
    contents.on("render-process-gone", () => {
      if (record.contents !== contents) return;
      this.cancelPending(record, new Error("The page stopped responding."));
      record.tab.error = "The page stopped responding. Reload to try again.";
      record.tab.loading = false;
      record.tab.progress = null;
      this.publish(record);
    });
    // The page a record already carries is loaded by adoptGuest, once.
  }
  create(conversationId: string, url = "about:blank"): BrowserTab {
    const record = this.newRecord(conversationId, url);
    this.publish(record);
    return { ...record.tab };
  }
  /** Open a requested result for the human. This grants no page inspection or DOM access. */
  async agentOpen(
    conversationId: string,
    url: string,
    signal?: AbortSignal,
    options: { sessionOnly?: boolean; isolated?: boolean; source?: string } = {},
  ): Promise<BrowserTab> {
    signal?.throwIfAborted();
    const destination = browserURL(url);
    if (!/^https?:/i.test(destination)) throw new Error('Agent opening requires an HTTP/HTTPS destination.');
    const record = this.newRecord(conversationId, destination, undefined,
      options.isolated ? `hello-preview-${randomUUID()}` : undefined);
    if (options.sessionOnly) record.tab.sessionOnly = true;
    if (options.source) { record.tab.source = options.source; record.servedUrl = url; }
    this.publish(record);
    this.options.lifecycle?.({ type: 'opened', tab: { ...record.tab }, foreground: true, userRequested: true });
    await this.navigate(record.tab.id, destination, signal, conversationId);
    return { ...this.record(record.tab.id).tab };
  }
  /**
   * Show a document this app generated for a chat. A second version is the same
   * page becoming better, not a second page: it replaces what the chat is
   * already showing, so revising a design does not bury the browser under a tab
   * per revision and does not move the reader somewhere else. Each version is
   * served from its own local origin, so nothing carries over between them.
   */
  async agentShow(conversationId: string, url: string, signal?: AbortSignal, source?: string): Promise<BrowserTab> {
    signal?.throwIfAborted();
    const shown = [...this.records.values()].find(
      record => record.artifact && record.tab.conversationId === conversationId);
    if (!shown) {
      const tab = await this.agentOpen(conversationId, url, signal, { sessionOnly: true, isolated: true });
      const record = this.record(tab.id);
      record.artifact = true;
      if (source) record.tab.source = source;
      this.grantOwnWork(record, url);
      this.publish(record);
      return { ...record.tab };
    }
    if (source) shown.tab.source = source;
    shown.servedUrl = url;
    await this.navigate(shown.tab.id, url, signal, conversationId);
    this.grantOwnWork(shown, url);
    const tab = { ...this.record(shown.tab.id).tab };
    // The pane may be closed or showing another tool; bring the revision forward
    // exactly as a first showing would.
    this.options.lifecycle?.({ type: 'opened', tab, foreground: true, userRequested: true });
    return tab;
  }
  /**
   * A page the model wrote, read by the model. It is served from an isolated
   * local session with no cookies and nothing signed in, and every word in it
   * came from the model in the first place, so reading it back reveals nothing
   * it did not already know — while not being able to look at its own work is
   * how it ships a page it never checked. The grant belongs to the document,
   * not to the tab: navigate this tab anywhere else and it is Off again.
   */
  private grantOwnWork(record: RecordTab, url: string): void {
    record.servedUrl = url;
    // Only a document the model wrote. A preview of the person's own HTML is
    // their file, and reading it is a grant only they can give.
    if (record.tab.source?.startsWith("artifact:")) record.tab.control = "full";
  }
  /** Leaving its own document ends the grant that came with it. */
  private endOwnWork(record: RecordTab, url: string): void {
    if (!record.tab.source || url === record.servedUrl) return;
    record.tab.control = "off";
    record.tab.source = undefined;
    record.servedUrl = undefined;
    record.artifact = false;
  }
  private newRecord(conversationId: string, url: string, openerId?: string, partition?: string): RecordTab {
    if (this.disposed) throw new Error("The browser is closed.");
    if (!this.options.conversationExists(conversationId))
      throw new Error("Choose a chat first.");
    const tab: BrowserTab = {
      id: randomUUID(),
      conversationId,
      title: "New tab",
      url: browserURL(url),
      control: "off",
      loading: false,
      progress: null,
      canGoBack: false,
      canGoForward: false,
      ...(openerId ? { pageOwned: true, openerId } : {}),
      ...(partition ? { sessionOnly: true } : {}),
    };
    const record: RecordTab = { tab, pending: new Set(), navigation: 0, ...(partition ? { partition } : {}) };
    this.records.set(tab.id, record);
    return record;
  }
  async navigate(
    id: string,
    input: string,
    signal?: AbortSignal,
    agentConversationId?: string,
  ): Promise<void> {
    signal?.throwIfAborted();
    const url = browserURL(input);
    const record = this.record(id);
    if (agentConversationId) {
      checkAgentOwnership(record.tab, agentConversationId);
      if (!/^https?:/i.test(url)) throw new Error('Agent navigation requires an HTTP/HTTPS destination.');
    }
    this.cancelPending(record, new Error("The page navigated."));
    const navigation = ++record.navigation;
    const previous = record.tab.url;
    // An explicit navigation is the gesture that lifts a discard.
    record.blocked = false;
    const contents = await this.whenAttached(record, signal);
    this.endOwnWork(record, url);
    record.tab.url = url;
    record.tab.error = null;
    record.tab.loading = url !== "about:blank";
    record.tab.progress = url !== "about:blank" ? 0 : null;
    this.publish(record);
    try {
      await this.operation(record, () => contents.loadURL(url), {
        signal,
        navigation: true,
        onCancel: () => {
          if (record.contents === contents && !contents.isDestroyed()) contents.stop();
        },
      });
    } catch (error) {
      if (!this.records.has(id) || record.navigation !== navigation)
        throw error;
      if (String(error).includes("ERR_ABORTED")) return;
      record.tab.loading = false;
      record.tab.progress = null;
      record.tab.error = `Could not load ${new URL(url === "about:blank" ? previous : url).hostname || "this page"}.`;
      this.publish(record);
      throw new Error(record.tab.error);
    }
  }
  action(id: string, action: string): void | Promise<void> {
    const record = this.record(id);
    // A cancelled agent action or a crashed page can leave a recoverable tab
    // with no page at all. Reload then means: ask for a page and navigate once,
    // rather than reloading a destroyed frame or starting two competing loads.
    if (action === "reload" && (!record.contents || record.contents.isDestroyed() || record.tab.error)) {
      if (record.contents?.isDestroyed()) record.contents = undefined;
      return this.navigate(id, record.tab.url);
    }
    const contents = this.contentsFor(record);
    if (action === "back" && contents.navigationHistory.canGoBack())
      contents.navigationHistory.goBack();
    else if (action === "forward" && contents.navigationHistory.canGoForward())
      contents.navigationHistory.goForward();
    else if (action === "reload") {
      record.tab.error = null;
      this.publish(record);
      contents.reload();
    } else if (action === "stop") contents.stop();
  }
  /**
   * The window is dropping one page element on purpose; the tab stays. The
   * nonce says which page: a host unmounting late must not close the page a
   * newer host has already put in its place.
   */
  detach(id: string, nonce?: string): void {
    const record = this.records.get(id);
    if (!record?.contents) return;
    if (nonce && record.attachNonce !== nonce) return;
    record.detaching = true;
    if (!record.contents.isDestroyed()) record.contents.close();
    record.contents = undefined;
    record.attachNonce = undefined;
    if (this.activeId === id) this.activeId = null;
    this.notifyPage({ type: "detached", id });
  }
  /** The page this window is showing, as the agent's tab list reports it. */
  setActive(id: string | null): void {
    if (this.disposed) return;
    this.activeId = id && this.records.has(id) ? id : null;
    this.notifyPage({ type: "active", id: this.activeId });
    if (this.activeId) void this.serveAgain(this.records.get(this.activeId)!);
  }
  /**
   * A generated document restored from a previous run has no live address: the
   * port that served it died with the app. Ask for it again the moment someone
   * looks at the tab, so the page is where they left it.
   */
  private async serveAgain(record: RecordTab): Promise<void> {
    const { source, conversationId } = record.tab;
    if (!source || record.tab.url !== "about:blank" || record.serving) return;
    record.serving = true;
    try {
      const url = await this.options.serve?.(conversationId, source);
      if (url && this.records.get(record.tab.id) === record && record.tab.url === "about:blank") {
        record.servedUrl = url;
        await this.navigate(record.tab.id, url);
        this.grantOwnWork(record, url);
        this.publish(record);
      }
    } catch (error) {
      record.tab.error = error instanceof Error ? error.message : "This document could not be opened again.";
      this.publish(record);
    } finally {
      record.serving = false;
    }
  }
  control(id: string, mode: AgentControl): BrowserTab {
    if (!isAgentControl(mode)) throw new Error("Unknown Agent control mode.");
    const record = this.record(id);
    record.tab.control = mode;
    if (mode !== "full")
      this.cancelPending(
        record,
        new Error("Agent control was revoked."),
        mode === "read",
        true,
      );
    this.publish(record);
    return { ...record.tab };
  }
  async read(
    id: string,
    conversationId?: string,
    signal?: AbortSignal,
  ): Promise<BrowserContent> {
    signal?.throwIfAborted();
    const record = this.record(id);
    checkAgentAccess(record.tab, conversationId ?? record.tab.conversationId);
    if (record.tab.url === "about:blank" && !record.tab.pageOwned)
      return { title: "New tab", url: "about:blank", text: "" };
    const contents = await this.whenAttached(record, signal);
    const frame = contents.mainFrame;
    const scanned = await this.scan(record, contents, signal, false);
    // Revocation during a pending read must not deliver the page to the agent.
    checkAgentAccess(
      this.record(id).tab,
      conversationId ?? record.tab.conversationId,
    );
    if (frame.isDestroyed() || contents.mainFrame !== frame)
      throw new Error("The page changed during this read.");
    return {
      title: record.tab.title,
      url: record.tab.url,
      text: `${scanned.text}\n\n${scanned.lines.length ? `${READ_HEADER}\n${scanned.lines.join("\n")}` : "(No controls on this page yet.)"}${scanned.notes.length ? `\n${scanned.notes.join("\n")}` : ""}`.slice(0, 45_000),
    };
  }
  /**
   * The page and the frames inside it, each frame scanned in its own world:
   * a payment field or an embedded widget lives in an iframe, and a read
   * that stops at the main frame never sees it (user, 24.09). Refs run on
   * across frames, and a frame's centres are moved to page coordinates by
   * where its <iframe> sits, so a click by ref lands on the page as it is.
   * A frame that is blank, hidden, gone or off the page is left out.
   */
  private async scan(record: RecordTab, contents: WebContents, signal: AbortSignal | undefined, draw: boolean): Promise<{ text: string; lines: string[]; notes: string[]; frames: FrameRefs[] }> {
    const placed: Array<{ frame: WebFrameMain; offset: { x: number; y: number }; label: string; depth: number }> =
      [{ frame: contents.mainFrame, offset: { x: 0, y: 0 }, label: "", depth: 0 }];
    for (let at = 0; at < placed.length && placed.length < FRAME_LIMIT; at += 1) {
      const parent = placed[at];
      const kids = parent.frame.frames ?? []; // A page of the window's own has no frames to speak of.
      if (parent.depth >= FRAME_DEPTH || parent.frame.isDestroyed() || !kids.length) continue;
      let boxes: Array<{ name: string; src: string; x: number; y: number; width: number; height: number }> = [];
      try {
        const listed = await this.operation(record, () => parent.frame.executeJavaScript(FRAME_BOXES_SCRIPT), { signal });
        if (Array.isArray(listed)) boxes = listed.filter(box => box && typeof box === "object" && typeof box.x === "number" && typeof box.y === "number");
      } catch { continue; }
      const taken = new Set<number>();
      for (const child of kids) {
        if (placed.length >= FRAME_LIMIT) break;
        if (child.isDestroyed() || !child.url || child.url === "about:blank") continue;
        // Its <iframe>: by name, else by address, else the next one not yet taken.
        const index = boxes.findIndex((box, i) => !taken.has(i) && child.name && box.name === child.name);
        const byUrl = index < 0 ? boxes.findIndex((box, i) => !taken.has(i) && box.src && (box.src === child.url || child.url.startsWith(box.src))) : index;
        const box = byUrl >= 0 ? byUrl : boxes.findIndex((_, i) => !taken.has(i));
        if (box < 0) continue;
        taken.add(box);
        placed.push({ frame: child, offset: { x: parent.offset.x + boxes[box].x, y: parent.offset.y + boxes[box].y },
          label: `frame "${child.name || sourceOf(child.url) || child.url}"`, depth: parent.depth + 1 });
      }
    }
    let start = 1;
    let text = "";
    const lines: string[] = [];
    const notes: string[] = [];
    const frames: FrameRefs[] = [];
    for (const entry of placed) {
      let result: ScanResult;
      try {
        const answered = await this.operation(record, () => entry.frame.executeJavaScript(
          scanScript({ start, offset: entry.offset, draw, textLimit: entry.label ? FRAME_TEXT_LIMIT : 28_000 })), { signal });
        // A page answering with its words alone has no controls to list.
        const scanned = typeof answered === "string" ? { text: answered, lines: [], count: 0 } : answered;
        if (!scanned || typeof scanned !== "object" || typeof (scanned as ScanResult).text !== "string" || !Array.isArray((scanned as ScanResult).lines)) {
          if (!entry.label) throw new Error("The page did not return text.");
          continue;
        }
        result = scanned as ScanResult;
      } catch (error) {
        if (!entry.label) throw error;
        continue; // A frame that navigated away or refused is not the page.
      }
      const count = Math.max(0, Math.min(result.lines.length, Number(result.count) || 0));
      frames.push({ frame: entry.frame, offset: entry.offset, label: entry.label, start, end: start + count - 1 });
      start += count;
      lines.push(...result.lines.slice(0, count).map(line => (entry.label ? `${line} [in ${entry.label}]` : line)));
      if (typeof result.note === "string" && result.note.trim())
        notes.push(entry.label ? `${result.note.trim()} [in ${entry.label}]` : result.note.trim());
      text += entry.label ? (result.text.trim() ? `\n\n--- ${entry.label} ---\n${result.text}` : "") : result.text;
    }
    record.refs = frames;
    return { text, lines, notes, frames };
  }
  /** The frame a ref belongs to, from the latest read of this tab. */
  private frameOf(record: RecordTab, target: ElementTarget, contents: WebContents): { frame: WebFrameMain; offset: { x: number; y: number } } {
    if (!target.ref) return { frame: contents.mainFrame, offset: { x: 0, y: 0 } };
    const number = Number(/^e(\d{1,4})$/i.exec(target.ref.trim())?.[1]);
    const owner = record.refs?.find(entry => number >= entry.start && number <= entry.end);
    if (!owner) throw new Error(`Ref ${target.ref} is not from the latest browser_read of this page. Read the page again and use a current ref.`);
    if (owner.frame.isDestroyed()) throw new Error(`Ref ${target.ref} was in a frame that is gone now. Read the page again.`);
    return { frame: owner.frame, offset: owner.offset };
  }
  async agentNavigate(
    conversationId: string,
    id: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<string> {
    checkAgentOwnership(this.record(id).tab, conversationId);
    await this.navigate(id, url, signal, conversationId);
    return `Navigated to ${this.record(id).tab.url}`;
  }
  async agentAction(
    conversationId: string,
    id: string,
    action: "click" | "type" | "scroll",
    target: ElementTarget = {},
    value: string | number = "",
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const record = this.record(id);
    checkAgentAccess(record.tab, conversationId, true);
    if (!["click", "type", "scroll"].includes(action))
      throw new Error("Unknown browser action.");
    if ((target.selector?.length ?? 0) > 1000 || (target.label?.length ?? 0) > 500 || String(value).length > 16000)
      throw new Error("Browser action is too large.");
    const script =
      action === "scroll"
        ? `window.scrollBy({top:${Math.max(-5000, Math.min(5000, Number(value) || 0))},behavior:'instant'}); 'Scrolled page.'`
        : action === "click"
          ? locateScript(target)
          : typeScript(target, String(value));
    const contents = await this.whenAttached(record, signal);
    // WebContents.executeJavaScript queues until load completion. Never enqueue a
    // mutation that could run after Off/Read was selected during a slow load.
    if (contents.isLoading())
      throw new Error(
        "Wait for this page to finish loading before controlling it.",
      );
    const since = Date.now();
    // A ref names its frame too; words and selectors are looked for in the main frame.
    const { frame, offset } = action === "scroll" ? { frame: contents.mainFrame, offset: { x: 0, y: 0 } } : this.frameOf(record, target, contents);
    checkAgentAccess(this.record(id).tab, conversationId, true);
    const result = await this.operation(
      record,
      () => frame.executeJavaScript(script),
      {
        signal,
        mutation: true,
        onCancel: () => {
          if (record.contents === contents) {
            this.discardView(
              record,
              new Error("The pending browser action was stopped."),
            );
            this.cancelPending(
              record,
              new Error("The browser frame was closed."),
            );
          }
        },
      },
    );
    if (action !== "click") {
      if (typeof result !== "string") throw new Error("The page did not return an action result.");
      return result.slice(0, 1000);
    }
    // The page said where the control is; the click is real mouse input from
    // here, the way a person's is — a DOM click left a menu that opens on
    // pointerdown shut. Covered, it was clicked directly, and that is said.
    const spot = result as { what?: unknown; x?: unknown; y?: unknown; covered?: unknown } | null;
    if (!spot || typeof spot !== "object" || typeof spot.what !== "string" || typeof spot.x !== "number" || typeof spot.y !== "number")
      throw new Error("The page did not say where the element is.");
    const what = spot.what.slice(0, 200);
    // The frame said where in itself; the page is where the mouse goes.
    const x = Math.round(spot.x + offset.x);
    const y = Math.round(spot.y + offset.y);
    let said: string;
    if (typeof spot.covered === "string")
      said = `Clicked ${what} directly: its centre (${x}, ${y}) is covered by ${spot.covered.slice(0, 120)}. If nothing happened, close what covers it and click again.`;
    else {
      const click: PointerAction = { action: "click", x, y, button: "left", clickCount: 1 };
      checkPointerInViewport(click, await this.viewport(record, contents, signal));
      await this.sendPointer(record, contents, conversationId, click, signal);
      said = `Clicked ${what} at (${x}, ${y}).`;
    }
    return said + await this.downloadsSince(record.tab.conversationId, since, signal, SPEAKS_OF_DOWNLOAD.test(what) ? DOWNLOAD_NOTICE_MS : DOWNLOAD_GLANCE_MS);
  }
  /**
   * One key, as from the keyboard: Enter to send what was typed, Escape to
   * close what opened, arrows to move. Re-checked like every event main sends.
   */
  async agentKey(conversationId: string, id: string, key: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const events = keyEvents(key);
    const record = this.record(id);
    const contents = await this.agentPage(record, conversationId, true, signal);
    const navigation = record.navigation;
    await this.operation(record, async () => {
      for (const event of events) {
        checkAgentAccess(this.record(id).tab, conversationId, true);
        if (record.contents !== contents || contents.isDestroyed() || record.navigation !== navigation)
          throw new Error("The page changed during this key press.");
        contents.sendInputEvent(event);
      }
    }, { signal, mutation: true });
    return `Pressed ${key}.`;
  }
  /**
   * The page's viewport in CSS pixels, read in a world of its own: a page
   * script cannot redefine what it reports there.
   */
  private async viewport(record: RecordTab, contents: WebContents, signal?: AbortSignal): Promise<Screenshot["viewport"]> {
    const size = await this.operation(record,
      () => contents.executeJavaScriptInIsolatedWorld(AGENT_INPUT_WORLD_ID, [{ code: VIEWPORT_SCRIPT }]),
      { signal });
    const { w, h } = (size ?? {}) as { w?: unknown; h?: unknown };
    if (typeof w !== "number" || typeof h !== "number" || !(w > 0) || !(h > 0))
      throw new Error("The page did not report its viewport size.");
    return { width: Math.floor(w), height: Math.floor(h) };
  }
  /** The attached, loaded page an agent tool may act on, checked like agentAction. */
  private async agentPage(record: RecordTab, conversationId: string, mutation: boolean, signal?: AbortSignal): Promise<WebContents> {
    checkAgentAccess(record.tab, conversationId, mutation);
    const contents = await this.whenAttached(record, signal);
    if (contents.isLoading())
      throw new Error("Wait for this page to finish loading before using it.");
    checkAgentAccess(this.record(record.tab.id).tab, conversationId, mutation);
    return contents;
  }
  /**
   * Real mouse input, sent by main to the tab's guest. Coordinates are page
   * CSS pixels and must lie inside the viewport. Every event is re-checked
   * against the grant and the page first: revoked, stopped, navigated or
   * unmounted, and nothing more reaches the page.
   */
  async agentPointer(conversationId: string, id: string, action: PointerAction, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const record = this.record(id);
    const contents = await this.agentPage(record, conversationId, true, signal);
    const since = Date.now();
    checkPointerInViewport(action, await this.viewport(record, contents, signal));
    // What is at the point, asked before the input goes: after it, the page may be another.
    const at = action.action === "drag" ? action.from : action;
    let landed = "";
    try {
      landed = landing(await this.operation(record, () => contents.mainFrame.executeJavaScript(hitScript(at.x, at.y)), { signal }), action.action);
    } catch { /* The page would not say; the input still goes, as asked. */ }
    await this.sendPointer(record, contents, conversationId, action, signal);
    return landed + (action.action === "click" ? await this.downloadsSince(record.tab.conversationId, since, signal) : "");
  }
  /** The events of one pointer action, each re-checked before it is sent. */
  private async sendPointer(record: RecordTab, contents: WebContents, conversationId: string, action: PointerAction, signal?: AbortSignal): Promise<void> {
    const id = record.tab.id;
    const navigation = record.navigation;
    const events = pointerEvents(action, contents.getZoomFactor());
    let stopped = false;
    await this.operation(record, async () => {
      for (const { event, delayMs } of events) {
        if (delayMs) await pause(delayMs);
        if (stopped) return;
        checkAgentAccess(this.record(id).tab, conversationId, true);
        if (record.contents !== contents || contents.isDestroyed() || record.navigation !== navigation)
          throw new Error("The page changed during this pointer action.");
        contents.sendInputEvent(event);
      }
    }, { signal, mutation: true, onCancel: () => { stopped = true; } });
  }
  /**
   * Save what a page can reach into the chat's folder: the document open in
   * the tab (an invoice PDF shown in it), or the file behind one of its links,
   * fetched with the page's own session. A shell has no such session, and a
   * model told the browser "cannot download" goes looking for one (user,
   * 23.09: curl after curl at a Stripe invoice, the same paragraph each time).
   * Needs Full, like the click on a Download link that ends the same way; the
   * file lands where onDownload puts every download, or is refused there.
   */
  async agentDownload(conversationId: string, id: string, url: string | undefined, signal?: AbortSignal): Promise<BrowserDownload> {
    signal?.throwIfAborted();
    const record = this.record(id);
    const contents = await this.agentPage(record, conversationId, true, signal);
    const target = browserURL(url ?? record.tab.url);
    if (target === "about:blank") throw new Error("This tab shows no page to download from.");
    // What this tab started since the request, as long as the tab is still there.
    const since = Date.now();
    const noted = (): BrowserDownload | undefined => {
      if (this.records.get(id) !== record) throw new Error("The tab was closed while its download was starting.");
      return this.downloadsOf(record.tab.conversationId).find(download => download.tabId === id && download.startedAt >= since);
    };
    contents.downloadURL(target);
    let download = noted();
    for (let waited = 0; !download && waited < DOWNLOAD_START_MS; waited += 100) {
      await pause(100, signal);
      download = noted();
    }
    if (!download)
      throw new Error(`Nothing started downloading from ${target} within ${DOWNLOAD_START_MS / 1000} s: that address is not a file the page can fetch. Read the page for the file's own link and use that address.`);
    for (let waited = 0; download.state === "saving" && waited < DOWNLOAD_FINISH_MS; waited += 250) {
      await pause(250, signal);
      download = this.downloads.get(download.id) ?? download;
    }
    return { ...download };
  }
  /**
   * Pictures of what the tab is painting, taken by main. Reading pixels is
   * reading the page, so it needs Read like any read, checked again after
   * every picture: Off chosen while one was taken means no picture.
   */
  async agentScreenshot(conversationId: string, id: string, request: ScreenshotRequest, signal?: AbortSignal): Promise<Screenshot> {
    signal?.throwIfAborted();
    const record = this.record(id);
    const contents = await this.agentPage(record, conversationId, false, signal);
    const navigation = record.navigation;
    const viewport = await this.viewport(record, contents, signal);
    if (request.region) checkRegionInViewport(request.region, viewport);
    // Annotated: each control's ref is written on the page before the
    // picture and taken off after, and the picture comes with the list — so
    // what the model sees is what browser_click takes (agent-browser's
    // --annotate; user, 24.09).
    const drawn = request.refs ? await this.scan(record, contents, signal, true) : undefined;
    const frames: Screenshot["frames"] = [];
    try {
      for (let index = 0; index < request.frames; index++) {
        if (index) await pause(request.intervalMs, signal);
        checkAgentAccess(this.record(id).tab, conversationId);
        if (record.contents !== contents || contents.isDestroyed() || record.navigation !== navigation)
          throw new Error("The page changed during this screenshot.");
        const image = await this.operation(record, () => contents.capturePage(), { signal });
        checkAgentAccess(this.record(id).tab, conversationId);
        if (image.isEmpty())
          throw new Error("The page returned no picture. A tab whose pane is not on screen may have nothing painted; say so rather than retrying.");
        frames.push(encodeFrame(image, viewport, request.region));
      }
    } finally {
      for (const entry of drawn?.frames ?? [])
        if (!entry.frame.isDestroyed()) void entry.frame.executeJavaScript(ERASE_SCRIPT).catch(() => { /* the page went */ });
    }
    return { frames, viewport, ...(drawn ? { legend: drawn.lines.join("\n") } : {}) };
  }
  /**
   * Wait for the page to be somewhere — words on it, a control, an address,
   * the load done, or simply a while — instead of reading a page still
   * arriving (agent-browser's wait; user, 24.09). Words and controls are
   * read, so they need Read; an address, the load and time are the tab's.
   */
  async agentWait(conversationId: string, id: string, condition: WaitCondition, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const record = this.record(id);
    const inspects = condition.text !== undefined || condition.target !== undefined;
    if (inspects) checkAgentAccess(record.tab, conversationId); else checkAgentOwnership(record.tab, conversationId);
    const began = Date.now();
    const elapsed = () => `${((Date.now() - began) / 1000).toFixed(1)} s`;
    if (condition.ms !== undefined) {
      await pause(condition.ms, signal);
      return `Waited ${condition.ms} ms.`;
    }
    const wanted = condition.text !== undefined ? `the words ${JSON.stringify(condition.text)}`
      : condition.target ? `a control ${JSON.stringify(condition.target)}`
        : condition.url !== undefined ? `an address matching ${JSON.stringify(condition.url)}` : "the page to finish loading";
    const contents = await this.whenAttached(record, signal);
    for (;;) {
      if (inspects) checkAgentAccess(this.record(id).tab, conversationId);
      const tab = this.record(id).tab;
      let holds = false;
      if (condition.url !== undefined) holds = matchesUrl(tab.url, condition.url);
      else if (!inspects) holds = !tab.loading && !contents.isLoading();
      else if (!contents.isLoading()) {
        try {
          holds = (await this.operation(record, () => contents.mainFrame.executeJavaScript(waitScript(condition)), { signal })) === true;
        } catch { holds = false; } // Mid-navigation: not yet.
      }
      if (holds) return `Waited ${elapsed()}: ${wanted} — there now. Read the page again before acting on it.`;
      if (Date.now() - began >= condition.timeoutMs)
        throw new Error(`Waited ${elapsed()} and ${wanted} did not come. browser_read shows what the page has now; do not wait again for the same thing.`);
      await pause(WAIT_POLL_MS, signal);
    }
  }
  close(id: string, notify = false): void {
    const record = this.records.get(id);
    if (!record) return;
    this.records.delete(id);
    this.cancelPending(record, new Error("This browser tab is closed."));
    this.discardView(record);
    this.releasePreviewPartition(record.partition);
    if (this.activeId === id) this.activeId = null;
    if (!record.tab.pageOwned && !record.tab.sessionOnly) this.options.remove(id);
    this.notifyPage({ type: "closed", id });
    if (notify && !this.disposed) this.options.lifecycle?.({
      type: "closed", id, conversationId: record.tab.conversationId,
      openerId: record.tab.openerId && this.records.has(record.tab.openerId) ? record.tab.openerId : undefined,
    });
  }
  closeConversation(conversationId: string): void {
    for (const tab of this.list(conversationId)) this.close(tab.id);
    // The chat is gone: its downloads leave the list (the store drops its rows).
    for (const download of this.downloadsOf(conversationId)) {
      this.items.get(download.id)?.cancel();
      this.items.delete(download.id);
      this.downloads.delete(download.id);
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.partition.removeListener("will-download", this.onDownload);
    this.options.window.webContents.removeListener(
      "did-start-loading",
      this.hideForShellLoad,
    );
    for (const record of this.records.values()) {
      this.cancelPending(record, new Error("The browser is closed."));
      this.discardView(record);
    }
    this.records.clear();
    for (const partition of [...this.previewPartitions.keys()]) this.releasePreviewPartition(partition);
  }
}
