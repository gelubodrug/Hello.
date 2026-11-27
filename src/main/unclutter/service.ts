/**
 * Unclutter — the person's ad and slop blocker for the browser pane.
 *
 * A web page in a tab is kept clean by rules learned once per template of a
 * site (an article page of one news site, its home page, its search): main
 * installs the cleaner into the page's isolated world on every load and hands
 * it the rules saved for the page type it is on. Learning them is an analysis
 * the person asks for (or, with Auto on, a page type seen for the first time):
 * the page lists its candidate blocks, the chosen model classifies them a
 * batch at a time — Decider V1.3 on OpenRouter by default, or OpenJev on this
 * Mac — and the ones it is sure are ads, consent banners, upsells, newsletter
 * or social nags become the type's rules.
 *
 * This is the person's own switch, like an ad blocker, not the agent's: the
 * tab's AI Mode does not gate it, and nothing it reads goes to the chat model
 * or any agent tool — the redacted candidates go to the chosen model only
 * (openrouter.ai for Decider, 127.0.0.1 for OpenJev). It never
 * touches a generated document, a previewed file or a local dev server: those
 * are the person's or the model's own pages, never clutter.
 */
import type { WebContents } from 'electron';
import type { BrowserTab } from '../../shared/types';
import { UNCLUTTER_CLASSIFIERS, type UnclutterClassifierId, type UnclutterOverview, type UnclutterSwitches, type UnclutterTabState } from '../../shared/unclutter';
import type { BrowserPageEvent } from '../browser/manager';
import {
  ANALYSIS_VERSION, POLICY_VERSION, batches, evaluationRequest, parseContext, parseProfile, parseSettings, parseSnapshot,
  rulesFromAnswers, shouldAutoAnalyze, type PageContext, type UnclutterProfile, type UnclutterRule,
} from './model';

/** A model Unclutter asks: its name, its request's model id, how many blocks one request holds, and its lifecycle. */
export interface UnclutterClassifierHost {
  readonly name: string;
  readonly model: string;
  readonly batchSize: number;
  status(): Promise<{ state: 'ready' | 'starting' | 'stopped' | 'missing'; detail: string; ownHelper: boolean }>;
  ask(body: unknown, signal?: AbortSignal): Promise<unknown>;
  /** Stops what Hello started for it; false when nothing was. */
  stop(): boolean;
  dispose(): void;
}
import { UNCLUTTER_WORLD_ID, unclutterCall } from './page';

export interface UnclutterPages {
  pageFor(tabId: string): { tab: BrowserTab; contents?: WebContents } | undefined;
  observePages(listener: (event: BrowserPageEvent) => void): () => void;
}
export interface UnclutterStore {
  getUnclutterProfile(key: string): unknown;
  saveUnclutterProfile(profile: UnclutterProfile): void;
  deleteUnclutterProfile(key: string): void;
  getUnclutterSettings(): unknown;
  saveUnclutterSettings(settings: UnclutterSwitches): void;
}
interface Options {
  pages: UnclutterPages;
  store: UnclutterStore;
  classifiers: Record<UnclutterClassifierId, UnclutterClassifierHost>;
  emit(state: UnclutterTabState): void;
  /** Delays, for tests. */
  settleMs?: number;
  autoMs?: number;
}
interface TabState {
  context: PageContext | null;
  hidden: number;
  analyzing: { done: number; total: number } | null;
  error: string | null;
  timer?: ReturnType<typeof setTimeout>;
  autoTimer?: ReturnType<typeof setTimeout>;
  /** Bumped by every sync, so a late answer for an older page is dropped. */
  revision: number;
}

const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|.+\.localhost|.+\.test)$/i;

/** PURE. Whether a tab shows a web page Unclutter may clean. */
export function eligible(tab: BrowserTab): boolean {
  // A generated document or a previewed file has a source and is served from a
  // local address; a popup a site opened (pageOwned) is an ordinary web page.
  if (tab.source || tab.partition || tab.error) return false;
  try {
    const url = new URL(tab.url);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !LOCAL_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

/** PURE. How many rules of each kind a profile holds. */
export function categoriesOf(rules: UnclutterRule[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const rule of rules) if (rule.enabled) out[rule.category] = (out[rule.category] ?? 0) + 1;
  return out;
}

export class UnclutterService {
  private tabs = new Map<string, TabState>();
  private activeId: string | null = null;
  /** Page types analysed unasked in this run: Auto asks once per type. */
  private attempted = new Set<string>();
  /** One analysis at a time, app-wide: OpenJev answers one question at a time, Decider's free tier counts requests. */
  private running: { tabId: string; controller: AbortController } | null = null;
  private unobserve: () => void;
  private disposed = false;

  constructor(private readonly options: Options) {
    this.unobserve = options.pages.observePages(event => this.onPage(event));
  }

  switches(): UnclutterSwitches {
    return parseSettings(this.options.store.getUnclutterSettings());
  }

  private classifier(id = this.switches().classifier): UnclutterClassifierHost {
    return this.options.classifiers[id];
  }

  private profile(key: string): UnclutterProfile | null {
    return parseProfile(this.options.store.getUnclutterProfile(key));
  }

  private state(tabId: string): TabState {
    let state = this.tabs.get(tabId);
    if (!state) {
      state = { context: null, hidden: 0, analyzing: null, error: null, revision: 0 };
      this.tabs.set(tabId, state);
    }
    return state;
  }

  /** The tab as the window shows it. */
  tabState(tabId: string): UnclutterTabState {
    const page = this.options.pages.pageFor(tabId);
    const state = this.tabs.get(tabId);
    const ok = !!page && eligible(page.tab);
    const context = ok ? state?.context ?? null : null;
    const profile = context ? this.profile(context.key) : null;
    return {
      tabId,
      eligible: ok,
      ...(context ? { label: context.label, origin: context.origin } : {}),
      hidden: ok ? state?.hidden ?? 0 : 0,
      profile: profile ? { enabled: profile.enabled, rules: profile.rules.filter(rule => rule.enabled).length, analyzedAt: profile.analyzedAt, categories: categoriesOf(profile.rules) } : null,
      analyzing: state?.analyzing ?? null,
      error: state?.error ?? null,
    };
  }

  private publish(tabId: string): void {
    if (!this.disposed) this.options.emit(this.tabState(tabId));
  }

  async overview(tabId: string): Promise<UnclutterOverview> {
    const page = this.options.pages.pageFor(tabId);
    // The count moves as the page builds: ask the page itself.
    if (page?.contents && eligible(page.tab) && this.tabs.get(tabId)?.context) {
      try {
        const counted = await this.call(page.contents, 'count') as { hidden?: unknown } | null;
        if (typeof counted?.hidden === 'number') this.state(tabId).hidden = counted.hidden;
      } catch { /* The page is between documents; the last count stands. */ }
    }
    const switches = this.switches();
    const classifier = this.classifier(switches.classifier);
    const status = await classifier.status();
    return { switches, classifier: { id: switches.classifier, name: classifier.name, state: status.state, detail: status.detail, ownHelper: status.ownHelper }, tab: this.tabState(tabId) };
  }

  private call(contents: WebContents, method: Parameters<typeof unclutterCall>[0], args: unknown[] = []): Promise<unknown> {
    return contents.executeJavaScriptInIsolatedWorld(UNCLUTTER_WORLD_ID, [{ code: unclutterCall(method, args) }]);
  }

  private onPage(event: BrowserPageEvent): void {
    if (this.disposed) return;
    if (event.type === 'active') {
      this.activeId = event.id;
      if (event.id) this.schedule(event.id);
      return;
    }
    if (event.type === 'detached' || event.type === 'closed') {
      const state = this.tabs.get(event.id);
      if (state) { clearTimeout(state.timer); clearTimeout(state.autoTimer); }
      if (event.type === 'closed') {
        this.tabs.delete(event.id);
        if (this.running?.tabId === event.id) this.running.controller.abort();
      } else if (state) state.context = null;
      return;
    }
    this.schedule(event.tab.id);
  }

  /** A page changes many times while it loads; it is cleaned once it settles a little. */
  private schedule(tabId: string): void {
    const state = this.state(tabId);
    clearTimeout(state.timer);
    state.timer = setTimeout(() => void this.sync(tabId), this.options.settleMs ?? 250);
  }

  /** Install the cleaner and hand it this page type's rules — none, when Unclutter or the type is off. */
  async sync(tabId: string): Promise<void> {
    const page = this.options.pages.pageFor(tabId);
    const state = this.state(tabId);
    const revision = ++state.revision;
    if (!page?.contents || !eligible(page.tab)) {
      const had = state.context !== null || state.hidden > 0;
      state.context = null;
      state.hidden = 0;
      if (page?.contents && had) await this.call(page.contents, 'restore').catch(() => {});
      if (had) this.publish(tabId);
      return;
    }
    const contents = page.contents;
    try {
      const context = parseContext(await this.call(contents, 'context'));
      if (revision !== state.revision) return;
      const switches = this.switches();
      const profile = this.profile(context.key);
      const rules = switches.enabled && profile?.enabled ? profile.rules : [];
      const applied = await this.call(contents, 'apply', [context.key, rules]) as { hidden?: unknown } | null;
      if (revision !== state.revision) return;
      const changed = state.context?.key !== context.key;
      state.context = context;
      state.hidden = typeof applied?.hidden === 'number' ? applied.hidden : 0;
      if (changed) state.error = null;
      this.publish(tabId);
      this.maybeAuto(tabId, context, switches, profile);
    } catch {
      // A page between documents, or one that refuses scripts: nothing to clean yet.
    }
  }

  private maybeAuto(tabId: string, context: PageContext, switches: UnclutterSwitches, profile: UnclutterProfile | null): void {
    const state = this.state(tabId);
    clearTimeout(state.autoTimer);
    if (this.running || tabId !== this.activeId || !shouldAutoAnalyze(switches, profile, this.attempted.has(context.key))) return;
    // Let client-rendered banners and ads mount before the page is listed.
    state.autoTimer = setTimeout(() => {
      if (this.disposed || this.running || tabId !== this.activeId || state.context?.key !== context.key) return;
      this.attempted.add(context.key);
      void this.analyze(tabId).catch(() => { /* The tab shows the error. */ });
    }, this.options.autoMs ?? 1500);
  }

  /** Learn this page type's rules from the page as it is now, then apply them. */
  async analyze(tabId: string): Promise<UnclutterTabState> {
    if (this.running) throw new Error(this.running.tabId === tabId ? 'This page is already being analysed.' : 'Another page is being analysed. Try again when it finishes.');
    const page = this.options.pages.pageFor(tabId);
    if (!page?.contents || !eligible(page.tab)) throw new Error('Unclutter cleans web pages only, not generated documents, previewed files or local servers.');
    if (!this.switches().enabled) throw new Error('Unclutter is off.');
    const contents = page.contents;
    const classifier = this.classifier();
    const state = this.state(tabId);
    const controller = new AbortController();
    this.running = { tabId, controller };
    state.error = null;
    state.analyzing = { done: 0, total: 0 };
    this.publish(tabId);
    try {
      const snapshot = parseSnapshot(await this.call(contents, 'snapshot'));
      const groups = batches(snapshot.candidates, classifier.batchSize);
      state.analyzing = { done: 0, total: groups.length };
      this.publish(tabId);
      const rules: UnclutterRule[] = [];
      for (const group of groups) {
        if (controller.signal.aborted) throw new Error('The tab closed during the analysis.');
        const answer = await classifier.ask(evaluationRequest(snapshot.context.kind, group, classifier.model), controller.signal);
        rules.push(...rulesFromAnswers(answer, group, classifier.name));
        state.analyzing = { done: state.analyzing.done + 1, total: groups.length };
        this.publish(tabId);
      }
      const previous = this.profile(snapshot.context.key);
      const profile: UnclutterProfile = {
        key: snapshot.context.key,
        label: snapshot.context.label,
        origin: snapshot.context.origin,
        // A type the person switched off stays off; a fresh analysis does not overrule them.
        enabled: previous?.enabled ?? true,
        version: POLICY_VERSION,
        analysisVersion: ANALYSIS_VERSION,
        analyzedAt: Date.now(),
        candidateCount: snapshot.candidates.length,
        rules: rules.slice(0, 60),
      };
      this.options.store.saveUnclutterProfile(profile);
      state.analyzing = null;
      await this.sync(tabId);
      return this.tabState(tabId);
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'The analysis failed.';
      throw error;
    } finally {
      state.analyzing = null;
      this.running = null;
      if (this.tabs.has(tabId)) this.publish(tabId);
    }
  }

  /** Unclutter on or off everywhere, whether new page types are analysed unasked, and which model classifies. */
  setSwitches(next: Partial<UnclutterSwitches>): UnclutterSwitches {
    const previous = this.switches();
    if (next.classifier !== undefined && !UNCLUTTER_CLASSIFIERS.some(entry => entry.id === next.classifier)) throw new Error('Unknown Unclutter model.');
    const switches = { ...previous, ...next };
    this.options.store.saveUnclutterSettings(switches);
    // The model left behind frees what Hello started for it (OpenJev's 27 GB),
    // unless an analysis under way is still asking it.
    if (switches.classifier !== previous.classifier && !this.running) this.classifier(previous.classifier).stop();
    for (const tabId of this.tabs.keys()) this.schedule(tabId);
    return switches;
  }

  /** This page type's rules on or off, keeping what was learned. */
  setTypeEnabled(tabId: string, enabled: boolean): UnclutterTabState {
    const key = this.tabs.get(tabId)?.context?.key;
    const profile = key ? this.profile(key) : null;
    if (!profile) throw new Error('This page type has not been analysed yet.');
    this.options.store.saveUnclutterProfile({ ...profile, enabled });
    this.resyncType(profile.key);
    return this.tabState(tabId);
  }

  /** Forget what was learned about this page type: its blocks show again. */
  forgetType(tabId: string): UnclutterTabState {
    const key = this.tabs.get(tabId)?.context?.key;
    if (!key) throw new Error('This page has no page type yet.');
    this.options.store.deleteUnclutterProfile(key);
    this.attempted.add(key);
    this.resyncType(key);
    return this.tabState(tabId);
  }

  private resyncType(key: string): void {
    for (const [tabId, state] of this.tabs) if (state.context?.key === key) this.schedule(tabId);
  }

  stopOpenJev(): boolean {
    return this.options.classifiers.openjev.stop();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unobserve();
    this.running?.controller.abort();
    for (const state of this.tabs.values()) { clearTimeout(state.timer); clearTimeout(state.autoTimer); }
    this.tabs.clear();
    for (const classifier of new Set(Object.values(this.options.classifiers))) classifier.dispose();
  }
}
