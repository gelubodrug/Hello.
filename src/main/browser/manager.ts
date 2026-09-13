import { BrowserWindow, session } from "electron";
import type { HandlerDetails, Session, WebContents, WebPreferences } from "electron";
import { randomUUID } from "node:crypto";
import type {
  AgentControl,
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
}
/**
 * What happened to a tab's page, for main-process observers that must stop
 * using it (page modes). Observers see; they never decide anything here.
 */
export type BrowserPageEvent =
  | { type: "updated"; tab: BrowserTab }
  | { type: "active"; id: string | null }
  | { type: "detached"; id: string }
  | { type: "closed"; id: string };
/** How long a main-process operation waits for the window to host a page. */
export const BROWSER_ATTACH_TIMEOUT_MS = 10_000;
export const BROWSER_OPERATION_TIMEOUT_MS = 15_000;
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
};
interface BrowserOptions {
  window: BrowserWindow;
  initial: BrowserTab[];
  conversationExists(id: string): boolean;
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
  private blockDownload = (event: { preventDefault(): void }) =>
    event.preventDefault();
  private hideForShellLoad = () => this.setActive(null);
  private pageObservers = new Set<(event: BrowserPageEvent) => void>();
  constructor(private options: BrowserOptions) {
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
            control: "off",
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
  private securePartition(partition: Session): void {
    partition.setPermissionCheckHandler(() => false);
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    partition.on("will-download", this.blockDownload);
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
    selected.removeListener("will-download", this.blockDownload);
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
      this.options.save({ ...record.tab, control: "off" });
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
      try {
        browserURL(details.url);
      } catch {
        return { action: "deny" };
      }
      // A <webview> cannot adopt an existing WebContents, so a popup becomes a
      // real child window instead of a tab. That keeps what a tab could not:
      // its opener, postMessage and the POST body Chromium already prepared.
      return {
        action: "allow",
        outlivesOpener: true,
        overrideBrowserWindowOptions: {
          width: 900,
          height: 700,
          title: "Hello.",
          backgroundColor: "#171819",
          autoHideMenuBar: true,
          webPreferences: this.preferences(record),
        },
      };
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
      record.tab.error = null;
      this.publish(record);
    });
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
        this.publish(record);
      },
    );
    contents.on("render-process-gone", () => {
      if (record.contents !== contents) return;
      this.cancelPending(record, new Error("The page stopped responding."));
      record.tab.error = "The page stopped responding. Reload to try again.";
      record.tab.loading = false;
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
    const text = await this.operation(
      record,
      () =>
        frame.executeJavaScript(`(() => {
      const text = document.body?.innerText?.slice(0, 28000) || '';
      const controls = [...document.querySelectorAll('a[href],button,input,textarea,select,[role="button"]')]
        .filter(el => el.getBoundingClientRect().width && el.getBoundingClientRect().height).slice(0,80)
        .map(el => { const id = el.id ? '#' + CSS.escape(el.id) : null;
          const selector = id || (el.tagName.toLowerCase() + (el.getAttribute('name') ? '[name=' + JSON.stringify(el.getAttribute('name')) + ']' : ''));
          return selector + ': ' + (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || '').slice(0,140);
        });
      return text + '\\n\\nVisible controls (selectors may match more than one element):\\n' + controls.join('\\n');
    })()`),
      { signal },
    );
    // Revocation during a pending read must not deliver the page to the agent.
    checkAgentAccess(
      this.record(id).tab,
      conversationId ?? record.tab.conversationId,
    );
    if (frame.isDestroyed() || contents.mainFrame !== frame)
      throw new Error("The page changed during this read.");
    if (typeof text !== "string")
      throw new Error("The page did not return text.");
    return {
      title: record.tab.title,
      url: record.tab.url,
      text: text.slice(0, 45_000),
    };
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
    selector = "",
    value: string | number = "",
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const record = this.record(id);
    checkAgentAccess(record.tab, conversationId, true);
    if (!["click", "type", "scroll"].includes(action))
      throw new Error("Unknown browser action.");
    if (selector.length > 1000 || String(value).length > 16000)
      throw new Error("Browser action is too large.");
    const script =
      action === "scroll"
        ? `window.scrollBy({top:${Math.max(-5000, Math.min(5000, Number(value) || 0))},behavior:'instant'}); 'Scrolled page.'`
        : `(() => {const elements = document.querySelectorAll(${JSON.stringify(selector)}); if(elements.length !== 1) throw new Error('Selector must match exactly one element.'); const el=elements[0]; if(!el.getBoundingClientRect().width) throw new Error('Element is not visible.');
        ${action === "click" ? `el.click(); return 'Clicked element.';` : `if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error('Element is not a text field.'); if(el.type === 'password' || el.type === 'file') throw new Error('Sensitive fields cannot be filled by this tool.'); const setter=Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,'value').set; setter.call(el,${JSON.stringify(String(value))}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return 'Entered text.';`}
      })()`;
    const contents = await this.whenAttached(record, signal);
    // WebContents.executeJavaScript queues until load completion. Never enqueue a
    // mutation that could run after Off/Read was selected during a slow load.
    if (contents.isLoading())
      throw new Error(
        "Wait for this page to finish loading before controlling it.",
      );
    const frame = contents.mainFrame;
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
    if (typeof result !== "string")
      throw new Error("The page did not return an action result.");
    return result.slice(0, 1000);
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
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.partition.removeListener("will-download", this.blockDownload);
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
