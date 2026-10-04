import { ClipboardItem, clipboard, type Input, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { BrowserTab, PageModeEvent, PageModeExitReason, PageModeKind, PagePick, PageRect } from "../../shared/types";
import { boundedPageUrl, composeRefBlock, cropBox, parseFiberInfo, parseProbeAnnotations, parseProbeBatch, parseRect, type AnnotationShot, type ProbeEvent } from "../../shared/page-mode-format";
import type { BrowserPageEvent } from "./manager";
import { PAGE_MODE_PROBE, PAGE_MODE_WAIT_MS, PAGE_MODE_WORLD_ID, fiberProbe, probeCall } from "./page-mode-probe";

/** What the controller needs from the browser: read a tab, and hear when it changes. */
export interface PageModePages {
  pageFor(tabId: string): { tab: BrowserTab; contents?: WebContents } | undefined;
  observePages(listener: (event: BrowserPageEvent) => void): () => void;
}

/** A kind's say around a capture — Annotate hides its draft marker, then puts it back. */
export interface PageModeKindHooks {
  beforeCapture?(context: PageModeKindContext): Promise<void> | void;
  afterCapture?(context: PageModeKindContext): Promise<void> | void;
}
export interface PageModeKindContext {
  tabId: string;
  armId: string;
  kind: PageModeKind;
  /** Runs a command of this kind inside the page's isolated world (`__HELLO_PAGE_MODE__.call`). */
  call(method: string, args?: unknown[]): Promise<unknown>;
}

interface Arming {
  tabId: string;
  kind: PageModeKind;
  armId: string;
  contents: WebContents;
  lastHover: string;
  ended: Promise<null>;
  end(): void;
  unwire(): void;
}

const KINDS: readonly PageModeKind[] = ["design", "annotate"];
const LABELS: Record<PageModeKind, string> = { design: "Design", annotate: "Annotate" };
/** Captures only need to live until they are attached or copied. */
const CAPTURE_TTL_MS = 24 * 60 * 60 * 1000;
/** Attachments take images up to 5 MiB; stay under it with room to spare. */
const CAPTURE_MAX_BYTES = 4.5 * 1024 * 1024;
const FIBER_TIMEOUT_MS = 800;
const SHOT_TIMEOUT_MS = 1500;

const timeout = <T>(work: Promise<T>, ms: number): Promise<T | null> =>
  new Promise(done => {
    const timer = setTimeout(() => done(null), ms);
    work.then(value => { clearTimeout(timer); done(value); }, () => { clearTimeout(timer); done(null); });
  });

/**
 * Design / Annotate on one tab: the human points at the page and says
 * something about it. One mode per tab; it needs Read or Full, and it ends
 * the moment that stops being true — grant lowered, page navigated, tab
 * hidden, closed, or Escape. Human-only: no agent tool reaches this.
 */
export class PageModeController {
  private arms = new Map<string, Arming>();
  private hooks = new Map<PageModeKind, PageModeKindHooks>();
  private unobserve: () => void;
  private disposed = false;
  readonly capturesDir: string;

  constructor(private options: {
    pages: PageModePages;
    emit(event: PageModeEvent): void;
    dataDir: string;
    /** Kinds the page probe implements. Annotate joins when its lane lands. */
    kinds?: readonly PageModeKind[];
  }) {
    this.capturesDir = join(options.dataDir, "page-captures");
    this.unobserve = options.pages.observePages(event => this.onPage(event));
    void this.prune();
  }

  /** Lets a kind act around captures. */
  defineKind(kind: PageModeKind, hooks: PageModeKindHooks): void {
    this.hooks.set(kind, hooks);
  }

  armed(tabId: string): { kind: PageModeKind; armId: string } | null {
    const arming = this.arms.get(tabId);
    return arming ? { kind: arming.kind, armId: arming.armId } : null;
  }

  async arm(tabId: string, kind: PageModeKind): Promise<{ armId: string }> {
    if (this.disposed) throw new Error("The browser is closed.");
    if (!KINDS.includes(kind)) throw new Error("Unknown page mode.");
    if (!(this.options.kinds ?? ["design"]).includes(kind)) throw new Error(`${LABELS[kind]} is not available yet.`);
    const { tab, contents } = this.readable(tabId, LABELS[kind]);
    if (tab.url === "about:blank" || tab.error) throw new Error("Open a page first.");
    // The page's own load: ads that keep loading frames never finish (user, 30.09).
    if (contents.isLoadingMainFrame()) throw new Error("Wait for this page to finish loading.");
    // One mode per tab: a new arming replaces the old one without an exit,
    // because the window asked for the switch and already knows.
    const previous = this.arms.get(tabId);
    if (previous) this.teardown(previous);

    const armId = randomUUID();
    let end!: () => void;
    const ended = new Promise<null>(done => { end = () => done(null); });
    const arming: Arming = { tabId, kind, armId, contents, lastHover: "", ended, end, unwire: () => {} };
    this.arms.set(tabId, arming);
    arming.unwire = this.wire(arming);
    let ok: unknown;
    try {
      ok = await this.isolated(contents, `${PAGE_MODE_PROBE};${probeCall("arm", [kind, armId], "false")}`);
    } catch {
      ok = false;
    }
    if (this.arms.get(tabId) !== arming) throw new Error("The page changed before the mode could start.");
    if (ok !== true) {
      this.teardown(arming);
      throw new Error(`This page could not enter ${LABELS[kind]} mode.`);
    }
    // The grant is checked again after the page answered: Off chosen meanwhile wins.
    if (this.options.pages.pageFor(tabId)?.tab.control === "off") {
      this.exit(arming, "revoked");
      throw new Error("Read access was turned off.");
    }
    void this.listen(arming);
    return { armId };
  }

  /** Ends the mode the window asked to end. Without armId, whatever is armed on the tab. */
  disarm(tabId: string, armId?: string): void {
    const arming = this.arms.get(tabId);
    if (!arming || (armId && arming.armId !== armId)) return;
    this.teardown(arming);
  }

  /** Ends the current pick; the page highlights again and the mode stays. */
  async release(tabId: string, armId: string): Promise<void> {
    const arming = this.arms.get(tabId);
    if (!arming || arming.armId !== armId || arming.contents.isDestroyed()) return;
    // The grant is main's to check on every call, not something an arming vouches for.
    const { contents } = this.readable(tabId, LABELS[arming.kind]);
    if (contents !== arming.contents) return;
    await this.isolated(contents, probeCall("release", [armId], "false")).catch(() => {});
  }

  /**
   * A PNG of the tab's viewport, or of `rect` within it, saved under app data.
   * Reading pixels is reading the page, so it needs Read like any read. The
   * picture is taken without the mode's own overlay in it.
   */
  async capture(tabId: string, rect?: PageRect): Promise<{ path: string; annotations?: AnnotationShot }> {
    const { tab, contents } = this.readable(tabId, "capture");
    if (!/^[\w-]{1,100}$/.test(tab.conversationId)) throw new Error("This tab belongs to no chat.");
    const box = rect === undefined ? undefined : parseRect(rect);
    if (rect !== undefined && (!box || box.w < 1 || box.h < 1)) throw new Error("Invalid capture area.");
    const arming = this.arms.get(tabId);
    const hooks = arming && arming.contents === contents ? this.hooks.get(arming.kind) : undefined;
    const context = arming && hooks ? this.context(arming) : undefined;
    let viewport: { w: number; h: number } | null = null;
    let extra: unknown = null;
    let image: Electron.NativeImage;
    try {
      if (context) await hooks?.beforeCapture?.(context);
      const prepared = await timeout(
        this.isolated(contents, probeCall("beforeShot", [], "({viewport:{w:window.innerWidth,h:window.innerHeight}})")),
        SHOT_TIMEOUT_MS,
      );
      const size = (prepared as { viewport?: { w?: unknown; h?: unknown } } | null)?.viewport;
      if (size && typeof size.w === "number" && typeof size.h === "number" && size.w > 0 && size.h > 0)
        viewport = { w: size.w, h: size.h };
      extra = (prepared as { extra?: unknown } | null)?.extra ?? null;
      image = await contents.capturePage();
    } finally {
      if (!contents.isDestroyed()) await timeout(this.isolated(contents, probeCall("afterShot", [], "true")), SHOT_TIMEOUT_MS);
      if (context) await Promise.resolve(hooks?.afterCapture?.(context)).catch(() => {});
    }
    // Off chosen while the picture was being taken means no picture.
    this.readable(tabId, "capture");
    if (image.isEmpty()) throw new Error("The page could not be captured.");
    let picture = image;
    if (box) {
      if (!viewport) throw new Error("The page did not report its size.");
      const crop = cropBox(box, viewport, image.getSize());
      if (!crop) throw new Error("That element is outside the visible page.");
      picture = image.crop(crop);
    }
    let png = picture.toPNG();
    while (png.length > CAPTURE_MAX_BYTES) {
      const width = Math.floor(picture.getSize().width * 0.7);
      if (width < 64) break;
      picture = picture.resize({ width, quality: "good" });
      png = picture.toPNG();
    }
    const folder = join(this.capturesDir, tab.conversationId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, `${randomUUID()}.png`);
    await writeFile(path, png, { mode: 0o600, flag: "wx" });
    // Annotate's markers are drawn into the page, so they are in the picture;
    // the list says what each one means and whether it made it into the frame.
    // A mode that ended or changed while the picture was taken has no list to give.
    if (arming?.kind === "annotate" && arming.contents === contents && this.arms.get(tabId) === arming) {
      const annotations = parseProbeAnnotations(extra, contents.getURL());
      if (annotations) return { path, annotations };
    }
    return { path };
  }

  /** Text, with a picture this controller saved, onto the clipboard as one item. */
  async copy(text: string, path?: string): Promise<void> {
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 1024 * 1024) throw new Error("This note is too large to copy.");
    if (path === undefined) {
      await clipboard.writeText(text);
      return;
    }
    const target = resolve(path);
    if (!target.startsWith(resolve(this.capturesDir) + sep) || extname(target) !== ".png")
      throw new Error("Only a page capture can be copied.");
    const png = await readFile(target);
    await clipboard.write([new ClipboardItem({ "text/plain": text, "image/png": new Blob([png], { type: "image/png" }) })]);
  }

  /** A deleted chat takes its captures with it. */
  async removeConversation(conversationId: string): Promise<void> {
    if (!/^[\w-]{1,100}$/.test(conversationId)) return;
    await rm(join(this.capturesDir, conversationId), { recursive: true, force: true });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unobserve();
    for (const arming of [...this.arms.values()]) this.teardown(arming);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** The tab, its live page, and proof it may be read — or the reason it may not. */
  private readable(tabId: string, purpose: string): { tab: BrowserTab; contents: WebContents } {
    const page = this.options.pages.pageFor(tabId);
    if (!page) throw new Error("This browser tab is closed.");
    if (page.tab.control === "off")
      throw new Error(purpose === "capture" ? "Allow Read on this tab to capture it." : `Allow Read on this tab to use ${purpose}.`);
    if (!page.contents || page.contents.isDestroyed()) throw new Error("This page is not open in the app window.");
    return { tab: page.tab, contents: page.contents };
  }

  private isolated(contents: WebContents, code: string): Promise<unknown> {
    return contents.executeJavaScriptInIsolatedWorld(PAGE_MODE_WORLD_ID, [{ code }]);
  }

  private context(arming: Arming): PageModeKindContext {
    return {
      tabId: arming.tabId, armId: arming.armId, kind: arming.kind,
      call: (method, args = []) => {
        if (this.arms.get(arming.tabId) !== arming || arming.contents.isDestroyed()) return Promise.resolve(null);
        if (!/^[a-zA-Z]+$/.test(method)) return Promise.reject(new Error("Invalid page mode command."));
        return this.isolated(arming.contents, probeCall("call", [arming.kind, method, args]));
      },
    };
  }

  /** Everything that ends a mode from the page's side: leaving it, losing it, Escape. */
  private wire(arming: Arming): () => void {
    const { contents } = arming;
    const onInput = (event: Electron.Event, input: Input) => {
      // Escape inside an IME composition cancels the composition, not the mode.
      if (input.type !== "keyDown" || input.key !== "Escape" || input.isComposing) return;
      event.preventDefault();
      this.exit(arming, "escape");
    };
    const onNavigation = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      // A new document is a new page: nothing picked in the old one applies.
      if (details.isMainFrame && !details.isSameDocument) this.exit(arming, "navigated");
    };
    const onGone = () => this.exit(arming, "hidden");
    contents.on("before-input-event", onInput);
    contents.on("did-start-navigation", onNavigation);
    contents.on("render-process-gone", onGone);
    contents.once("destroyed", onGone);
    return () => {
      if (contents.isDestroyed()) return;
      contents.removeListener("before-input-event", onInput);
      contents.removeListener("did-start-navigation", onNavigation);
      contents.removeListener("render-process-gone", onGone);
      contents.removeListener("destroyed", onGone);
    };
  }

  private onPage(event: BrowserPageEvent): void {
    if (event.type === "active") {
      // Another tab shown hides this one. No tab shown is not proof of that: a
      // hidden pane mounting says so too, and the pane that really stops showing
      // its tab lets go of the mode itself.
      if (event.id === null) return;
      for (const arming of [...this.arms.values()]) if (arming.tabId !== event.id) this.exit(arming, "hidden");
      return;
    }
    const id = event.type === "updated" ? event.tab.id : event.id;
    const arming = this.arms.get(id);
    if (!arming) return;
    if (event.type === "closed") this.exit(arming, "closed");
    // A page dropped as its tab closes is a close, not a hide.
    else if (event.type === "detached") this.exit(arming, this.options.pages.pageFor(id) ? "hidden" : "closed");
    else if (event.tab.control === "off") this.exit(arming, "revoked");
  }

  /** The long poll: the page answers as soon as something happens, or empty after a moment. */
  private async listen(arming: Arming): Promise<void> {
    while (this.arms.get(arming.tabId) === arming) {
      let raw: unknown;
      try {
        raw = await Promise.race([
          this.isolated(arming.contents, probeCall("wait", [arming.armId, PAGE_MODE_WAIT_MS])),
          arming.ended,
        ]);
      } catch {
        raw = null;
      }
      if (this.arms.get(arming.tabId) !== arming) return;
      const batch = parseProbeBatch(raw);
      // The page no longer holds this arming: its document went away under us.
      if (!batch || batch.armId !== arming.armId) {
        this.exit(arming, arming.contents.isDestroyed() ? "hidden" : "navigated");
        return;
      }
      for (const event of batch.events) {
        if (this.arms.get(arming.tabId) !== arming) return;
        await this.deliver(arming, event);
      }
    }
  }

  private async deliver(arming: Arming, event: ProbeEvent): Promise<void> {
    const { tabId, armId } = arming;
    if (event.type === "hover") {
      const key = JSON.stringify(event.rect);
      if (key === arming.lastHover) return;
      arming.lastHover = key;
      this.options.emit({ type: "hover", tabId, armId, rect: event.rect });
      return;
    }
    if (event.type === "released") {
      this.options.emit({ type: "released", tabId, armId });
      return;
    }
    if (event.type === "marks") {
      this.options.emit({ type: "marks", tabId, armId, count: event.count });
      if (event.mark) await this.readMark(arming, event.mark);
      return;
    }
    const fiber = parseFiberInfo(await timeout(arming.contents.mainFrame.executeJavaScript(fiberProbe(event.token)), FIBER_TIMEOUT_MS));
    if (this.arms.get(tabId) !== arming || arming.contents.isDestroyed()) return;
    // The address is main's to report, never the page's.
    const url = boundedPageUrl(arming.contents.getURL());
    const pick: PagePick = {
      kind: arming.kind, armId, tabId, url,
      selector: event.selector, tag: event.tag, text: event.text, styles: event.styles,
      ref: composeRefBlock({ component: fiber.component, file: fiber.file, tag: event.tag, text: event.text, styles: event.styles, dom: event.dom, url }),
      rect: event.rect, viewport: event.viewport, at: new Date().toISOString(),
    };
    arming.lastHover = JSON.stringify(event.rect);
    this.options.emit({ type: "picked", tabId, armId, pick, point: event.point });
  }

  /** Annotate: what component a new marker sits on, read once from the page world and handed back to it. */
  private async readMark(arming: Arming, mark: { n: number; token: string }): Promise<void> {
    const fiber = parseFiberInfo(await timeout(arming.contents.mainFrame.executeJavaScript(fiberProbe(mark.token)), FIBER_TIMEOUT_MS));
    if (!fiber.component || this.arms.get(arming.tabId) !== arming) return;
    await this.context(arming).call("setAt", [arming.armId, mark.n, fiber.component, fiber.file]).catch(() => null);
  }

  private exit(arming: Arming, reason: PageModeExitReason): void {
    if (this.arms.get(arming.tabId) !== arming) return;
    this.teardown(arming);
    if (!this.disposed) this.options.emit({ type: "exit", tabId: arming.tabId, armId: arming.armId, reason });
  }

  private teardown(arming: Arming): void {
    if (this.arms.get(arming.tabId) === arming) this.arms.delete(arming.tabId);
    arming.unwire();
    arming.end();
    // A page that is only parked gets its clicks back now, not on its next
    // load; a document already on its way out simply has no probe to answer.
    if (!arming.contents.isDestroyed())
      void this.isolated(arming.contents, probeCall("disarm", [arming.armId], "true")).catch(() => {});
  }

  private async prune(): Promise<void> {
    try {
      const now = Date.now();
      for (const chat of await readdir(this.capturesDir)) {
        const folder = join(this.capturesDir, chat);
        for (const name of await readdir(folder).catch(() => [] as string[])) {
          const file = join(folder, name);
          const info = await stat(file).catch(() => null);
          if (info?.isFile() && now - info.mtimeMs > CAPTURE_TTL_MS) await rm(file, { force: true });
        }
      }
    } catch {
      /* No captures yet. */
    }
  }
}
