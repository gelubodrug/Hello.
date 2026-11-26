/**
 * Unclutter — the half that lives in the page.
 *
 * Ported from kitze/unclutter (MIT, lib/dom.ts, lib/page-context.ts and
 * entrypoints/cleaner.content.ts at 9115ce4; its notice is LICENSE.unclutter
 * beside this file); see docs/PROVENANCE.md. The
 * safety core — what is protected, which selectors are ever applied, what is
 * redacted before anything leaves the page, and that a consent dialog is only
 * hidden, never answered — is the original's, line for line.
 *
 * Hello's guest has no preload and no content scripts, so main injects this
 * into an ISOLATED WORLD of its own (not the page modes' one): it shares the
 * DOM with the page but not a single JS object, so a page can neither read
 * the rules nor switch the cleaner off. With no channel from a guest back to
 * main, main asks: `context()`, `apply(key, rules)`, `count()`, `snapshot()`.
 * Between asks the cleaner keeps itself current: a mutation re-applies the
 * rules it holds, and an address that is another page type drops them until
 * main sends that type's own.
 *
 * `unclutterPage` must stay self-contained — it is sent to the page as its
 * source text, so it may use nothing from this module or any other.
 */

/** Isolated world Unclutter runs in. Electron's preload world is 999; page modes are 1207, agent input 1208. */
export const UNCLUTTER_WORLD_ID = 1209;

/* eslint-disable @typescript-eslint/no-explicit-any */
export function unclutterPage(W: any): boolean {
  if (W.__HELLO_UNCLUTTER__) return true;
  const doc: Document = W.document;
  const POLICY_VERSION = 1;

  // ── lib/dom.ts ────────────────────────────────────────────────────────────
  const structural = 'html,body,main,article,nav,[role="main"],[role="navigation"]';
  const sensitive = 'input[type="password"],input[type="email"],input[type="text"],input:not([type]),textarea,[contenteditable="true"]';
  const protectedSelector = `${structural},header,h1,form,input,textarea,select,[contenteditable="true"],dialog`;
  const clutter = /(?:^|[-_\s])(?:ad|ads|advert|advertisement|advertising|sponsor|sponsored|promo|promotion|banner|newsletter|subscribe|subscription|upsell|popup|modal|overlay|share|social|recommendations|related|cookie|consent)(?:$|[-_\s])/i;
  // Stable vendor prefixes survive per-session numeric IDs (Sourcepoint).
  const consentPrefixes = ['sp_message_container_', 'sp_message_iframe_'];
  const stable = (value: string) => value.length >= 3 && value.length < 90 && /^[a-zA-Z_][\w-]*$/.test(value) && !/\d{4}|[a-f0-9]{8}|^(css|sc|jsx)-/i.test(value);
  const identity = (el: Element) => `${el.id} ${el.getAttribute('class') ?? ''} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''} ${el.getAttribute('data-testid') ?? ''} ${el.getAttribute('data-component') ?? ''}`;

  function isCookieNotice(el: Element): boolean {
    if (consentPrefixes.some(prefix => el.id.startsWith(prefix))) return true;
    const name = identity(el);
    if (/cookie|consent|onetrust|didomi|privacy[-_ ]?(?:manager|modal|dialog)/i.test(name)) return true;
    if (!el.matches('[role="dialog"],[aria-modal="true"]')) return false;
    const text = el.textContent ?? '';
    return /cookies|consent|privacy choices/i.test(text) && /accept|reject|agree|manage|preferences/i.test(text);
  }

  function isProtected(el: Element): boolean {
    const cookie = isCookieNotice(el);
    // Cookie controls may contain headings/checkbox forms. Never weaken core
    // content, credential, payment, authentication or native-modal protections.
    const selector = cookie ? `${structural},${sensitive},dialog` : protectedSelector;
    if (el.matches(selector) || el.querySelector(selector)) return true;
    if (el.closest('[contenteditable="true"]') || (!cookie && el.closest('form'))) return true;
    if (/paywall|sign[-_ ]?in|log[-_ ]?in|captcha|checkout|payment/i.test(identity(el))) return true;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (/sign in to continue|subscribe to (?:read|continue)|verify you are human/i.test(text)) return true;
    if (cookie) return text.length > 20_000;
    return text.length > 2000 || Array.from(el.querySelectorAll('p')).some(p => (p.textContent?.length ?? 0) > 600);
  }

  function matchingElements(selector: string): Element[] {
    const ordinary = /^[a-z][a-z0-9-]*(?:\[data-(?:testid|component|test|qa)="[\w-]{3,89}"\]|#[\w-]{3,89}|\.[\w-]{3,89})$/;
    const consentPrefix = /^(?:div|iframe)\[id\^="(sp_message_container_|sp_message_iframe_)"\]$/;
    if (!ordinary.test(selector) && !consentPrefix.test(selector)) return [];
    try {
      const elements = Array.from(doc.querySelectorAll(selector));
      if (elements.length > 20 || elements.some(isProtected)) return [];
      return elements;
    } catch {
      return [];
    }
  }

  function selectorFor(el: Element): string | null {
    const tag = el.tagName.toLowerCase();
    const options: string[] = [];
    const prefix = consentPrefixes.find(value => el.id.startsWith(value));
    if (prefix && ['div', 'iframe'].includes(tag)) options.push(`${tag}[id^="${prefix}"]`);
    for (const attr of ['data-testid', 'data-component', 'data-test', 'data-qa']) {
      const value = el.getAttribute(attr);
      if (value && stable(value)) options.push(`${tag}[${attr}="${value}"]`);
    }
    if (stable(el.id)) options.push(`${tag}#${el.id}`);
    const classes = Array.from(el.classList).filter(stable).sort((a, b) => Number(clutter.test(b)) - Number(clutter.test(a)));
    options.push(...classes.map(c => `${tag}.${c}`));
    return options.find(selector => matchingElements(selector).includes(el)) ?? null;
  }

  function redact(text: string): string {
    return text
      .replace(/https?:\/\/\S+/g, '[URL]')
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
      .replace(/\b(?:\d[ -]?){8,}\b/g, '[number]');
  }

  /** `fixed 70x70 bottom-left`: a block with no words of its own (an icon, a
   *  bell) is still told apart by how big it is and where it floats. */
  function placement(el: Element, position: string): string {
    if (position !== 'fixed' && position !== 'sticky') return position;
    const box = el.getBoundingClientRect();
    const width = W.innerWidth || 1, height = W.innerHeight || 1;
    const vertical = box.top + box.height / 2 < height / 3 ? 'top' : box.top + box.height / 2 > (height * 2) / 3 ? 'bottom' : 'middle';
    const horizontal = box.left + box.width / 2 < width / 3 ? 'left' : box.left + box.width / 2 > (width * 2) / 3 ? 'right' : 'center';
    return `${position} ${Math.min(9999, Math.round(box.width))}x${Math.min(9999, Math.round(box.height))} ${vertical}-${horizontal}`;
  }

  function collectCandidates(): unknown[] {
    // Consent UI often arrives at the very end of body, after thousands of nodes.
    const priority = Array.from(doc.querySelectorAll('[role="dialog"],[aria-modal="true"],[id^="sp_message_"],[id*="cookie" i],[id*="consent" i],#onetrust-banner-sdk,#didomi-host')).slice(0, 100);
    // A link or button that floats over the page on its own — a "subscribe"
    // tab pinned to an edge, a cookie-settings button, a notification bell —
    // is clutter no container holds (user, 26.11, zf.ro). Only floating ones:
    // a link in the page's flow is content.
    const floating = Array.from(doc.querySelectorAll('a,button')).slice(0, 4000)
      .filter(el => ['fixed', 'sticky'].includes(W.getComputedStyle(el).position));
    const elements = Array.from(new Set([...priority, ...Array.from(doc.querySelectorAll('aside,section,div,[role="dialog"],iframe')).slice(0, 6000), ...floating.slice(0, 40)]));
    const seen = new Set<string>();
    const output: unknown[] = [];
    for (const el of elements) {
      if (output.length >= 60) break;
      const cookie = isCookieNotice(el);
      const signals = `${cookie ? 'Cookie consent overlay. Hide visually only; do not accept or reject consent. ' : ''}${identity(el)} ${el.getAttribute('role') ?? ''}`;
      const position = W.getComputedStyle(el).position ?? 'static';
      if (!cookie && !clutter.test(signals) && !el.matches('aside,[role="dialog"],iframe') && !['fixed', 'sticky'].includes(position)) continue;
      if (isProtected(el)) continue;
      const selector = selectorFor(el);
      if (!selector || seen.has(selector)) continue;
      seen.add(selector);
      const copy = el.cloneNode(true) as Element;
      copy.querySelectorAll('script,style,noscript,svg,input,textarea,select,[contenteditable]').forEach(node => node.remove());
      output.push({
        id: `e${output.length}`,
        selector,
        tag: el.tagName.toLowerCase().slice(0, 30),
        signals: redact(signals).slice(0, 300),
        text: redact((copy.textContent ?? '').replace(/\s+/g, ' ').trim()).slice(0, 450),
        position: placement(el, String(position)).slice(0, 30),
        count: matchingElements(selector).length,
      });
    }
    return output;
  }

  const emptyLabel = /^(?:advertisement|advertising|advert|ad|sponsored|sponsored content)?$/i;
  function emptyAfterHiding(el: Element, hidden: Set<Element>, depth = 0): boolean {
    if (hidden.has(el) || el.matches('script,style,noscript,template')) return true;
    if (depth > 8 || el.matches('img,video,audio,canvas,svg,iframe,button,input,select,textarea,[role="button"]')) return false;
    // A background image or generated text may be useful even with no text nodes.
    const computed = W.getComputedStyle(el);
    if (computed?.backgroundImage && computed.backgroundImage !== 'none') return false;
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3 && !emptyLabel.test((node.textContent ?? '').trim())) return false;
      if (node.nodeType === 1 && !emptyAfterHiding(node as Element, hidden, depth + 1)) return false;
    }
    return true;
  }

  function collapseTargets(roots: Element[]): Set<Element> {
    const next = new Set(roots);
    for (const root of roots) {
      let parent = root.parentElement;
      for (let depth = 0; parent && depth < 5; depth++, parent = parent.parentElement) {
        if (!parent.matches('div,section,aside') || isProtected(parent) || !emptyAfterHiding(parent, next)) break;
        next.add(parent);
      }
    }
    return next;
  }

  // ── lib/page-context.ts ───────────────────────────────────────────────────
  function hash(value: string): string {
    let result = 2166136261;
    for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
    return (result >>> 0).toString(36);
  }
  function structuredTypes(): string[] {
    const found = new Set<string>();
    const visit = (item: unknown, depth: number): void => {
      if (!item || typeof item !== 'object' || depth > 6) return;
      if (Array.isArray(item)) {
        for (const child of item.slice(0, 40)) visit(child, depth + 1);
        return;
      }
      const obj = item as Record<string, unknown>;
      const types = Array.isArray(obj['@type']) ? obj['@type'] : [obj['@type']];
      for (const type of types) if (typeof type === 'string') found.add(type.toLowerCase());
      for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage']) visit(obj[key], depth + 1);
    };
    for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]')).slice(0, 10)) {
      try {
        if ((script.textContent?.length ?? 0) < 100_000) visit(JSON.parse(script.textContent ?? ''), 0);
      } catch {
        /* Invalid publisher metadata is optional. */
      }
    }
    return Array.from(found);
  }
  function pageContext(): { key: string; label: string; origin: string; kind: string } {
    const url = new URL(W.location.href);
    const segments = url.pathname.split('/').filter(Boolean);
    const types = structuredTypes();
    const og = doc.querySelector('meta[property="og:type"]')?.getAttribute('content') ?? '';
    const hasArticle = types.some(t => /article|blogposting/.test(t)) || og === 'article' || !!doc.querySelector('main article h1, article [itemprop="articleBody"], [itemtype$="Article"]');
    const isSearch = /^(search|find)$/i.test(segments[0] ?? '') || url.searchParams.has('q') || url.searchParams.has('s');
    const queryArticle = hasArticle && (url.searchParams.has('p') || url.searchParams.has('article'));
    const kind = isSearch ? 'search'
      : segments.length === 0 && !queryArticle ? 'home'
      : types.includes('product') || og.startsWith('product') ? 'product'
      : hasArticle ? 'article'
      : types.some(t => /collectionpage|itemlist/.test(t)) ? 'listing'
      : 'page';
    // Detail leaves and numeric IDs vary; their route family does not.
    let route = segments.map(s => (/^\d+$/.test(s) || /^[a-f\d-]{16,}$/i.test(s) ? ':id' : s));
    if (kind === 'article' || kind === 'product') {
      route = route.filter((_, i) => i === segments.length - 1 || !/^\d{1,4}$/.test(segments[i] ?? ''));
      if (route.length) route[route.length - 1] = ':detail';
    } else if (route.length > 1 && (route[route.length - 1]?.split('-').length ?? 0) >= 4) {
      route[route.length - 1] = ':detail';
    }
    // Stable main-shell semantics distinguish templates without hashing text or ads.
    const main = doc.querySelector('main, [role="main"]');
    const anchor = main?.getAttribute('data-component') ?? main?.getAttribute('data-testid') ?? main?.tagName ?? 'body';
    const shell = `${anchor.slice(0, 100)}|${doc.querySelector('article') ? 'article' : ''}`;
    const routeLabel = `/${route.join('/')}`;
    const label = `${kind} · ${routeLabel}`.slice(0, 200);
    const key = `${url.origin}|v${POLICY_VERSION}|${hash(`${kind}|${routeLabel}|${shell}`)}`;
    return { key, label, origin: url.origin, kind };
  }

  // ── createCleaner ─────────────────────────────────────────────────────────
  // Not crypto.randomUUID: a plain-http page is no secure context.
  const attribute = `data-unclutter-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const style = doc.createElement('style');
  style.textContent = `[${attribute}] { display: none !important; min-height: 0 !important; height: 0 !important; margin: 0 !important; padding: 0 !important; }`;
  type SavedStyle = { value: string; priority: string; applied: string; appliedPriority: string };
  const marked = new Set<Element>();
  const overrides = new Map<HTMLElement, Map<string, SavedStyle>>();
  const release = (el: HTMLElement, property: string) => {
    const saved = overrides.get(el)?.get(property);
    if (!saved) return;
    if (el.style.getPropertyValue(property) === saved.applied && el.style.getPropertyPriority(property) === saved.appliedPriority) {
      if (saved.value) el.style.setProperty(property, saved.value, saved.priority);
      else el.style.removeProperty(property);
    }
    overrides.get(el)?.delete(property);
    if (!overrides.get(el)?.size) overrides.delete(el);
  };
  const override = (el: HTMLElement, property: string, value: string) => {
    const props = overrides.get(el) ?? new Map<string, SavedStyle>();
    const previous = props.get(property);
    if (!previous || el.style.getPropertyValue(property) !== previous.applied || el.style.getPropertyPriority(property) !== previous.appliedPriority) {
      const original = { value: el.style.getPropertyValue(property), priority: el.style.getPropertyPriority(property) };
      el.style.setProperty(property, value, 'important');
      props.set(property, { ...original, applied: value, appliedPriority: el.style.getPropertyPriority(property) });
      overrides.set(el, props);
    }
  };
  const restore = () => {
    for (const el of marked) el.removeAttribute(attribute);
    marked.clear();
    for (const [el, props] of Array.from(overrides)) for (const property of Array.from(props.keys())) release(el, property);
    style.remove();
  };
  type Rule = { selector: string; enabled: boolean };
  const applyRules = (rules: Rule[]): number => {
    const roots = Array.from(new Set(rules.filter(r => r.enabled).flatMap(r => matchingElements(r.selector))));
    const next = collapseTargets(roots);
    const contains = (el: Element) => Array.from(next).some(hidden => hidden === el || hidden.contains(el));
    const overlay = roots.some(el => isCookieNotice(el) || W.getComputedStyle(el).position === 'fixed');
    // Never unlock behind an unrelated visible modal (e.g. login or payment).
    const otherModal = Array.from(doc.querySelectorAll('dialog[open],[aria-modal="true"],[role="dialog"]'))
      .some(el => !contains(el) && W.getComputedStyle(el).display !== 'none' && !el.hasAttribute('hidden'));
    for (const el of Array.from(marked))
      if (!next.has(el)) {
        el.removeAttribute(attribute);
        if ('style' in el) release(el as HTMLElement, 'display');
        marked.delete(el);
      }
    for (const el of next) {
      if (!marked.has(el)) {
        el.setAttribute(attribute, '');
        marked.add(el);
      }
      // Inline !important beats stylesheet rules; preserve and override display.
      if ('style' in el) override(el as HTMLElement, 'display', 'none');
    }
    for (const el of [doc.documentElement, doc.body]) {
      if (!el) continue;
      if (overlay && !otherModal) {
        const computed = W.getComputedStyle(el);
        for (const property of ['overflow-x', 'overflow-y'])
          if (/hidden|clip/.test(computed?.getPropertyValue(property) ?? '') || overrides.get(el)?.has(property)) override(el, property, 'auto');
      } else {
        release(el, 'overflow-x');
        release(el, 'overflow-y');
      }
    }
    if (marked.size && !style.isConnected) (doc.head ?? doc.documentElement).append(style);
    if (!marked.size) style.remove();
    // Count outermost hidden blocks, not nested wrappers and their children.
    return Array.from(next).filter(el => !Array.from(next).some(parent => parent !== el && parent.contains(el))).length;
  };

  // ── The content script's loop, driven by main ─────────────────────────────
  const S = { key: '', rules: [] as Rule[], hidden: 0, timer: 0 as any, applying: false };
  const run = () => {
    S.timer = 0;
    S.applying = true;
    try {
      // Another page type (an app that never reloads): its rules are not these.
      if (S.key && pageContext().key !== S.key) {
        S.key = '';
        S.rules = [];
      }
      S.hidden = applyRules(S.rules);
    } catch {
      restore();
      S.hidden = 0;
    } finally {
      // The cleaner's own attribute and style writes are not the page changing.
      observer.takeRecords();
      S.applying = false;
    }
  };
  const schedule = () => {
    if (S.applying || !S.rules.length) return;
    W.clearTimeout(S.timer);
    S.timer = W.setTimeout(run, 180);
  };
  const observer = new W.MutationObserver(schedule);
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id', 'data-testid', 'data-component', 'content', 'style'] });

  Object.defineProperty(W, '__HELLO_UNCLUTTER__', {
    value: {
      context: () => pageContext(),
      /** The rules of the page type `key` names — nothing when the page is no longer that type. */
      apply(key: string, rules: Rule[]) {
        W.clearTimeout(S.timer);
        S.key = pageContext().key === key ? key : '';
        S.rules = S.key && Array.isArray(rules) ? rules.slice(0, 60) : [];
        run();
        return { key: S.key, hidden: S.hidden };
      },
      count: () => ({ key: S.key, hidden: S.hidden }),
      snapshot: () => ({ context: pageContext(), candidates: collectCandidates() }),
      restore() {
        W.clearTimeout(S.timer);
        S.key = '';
        S.rules = [];
        S.hidden = 0;
        restore();
        observer.takeRecords();
        return true;
      },
    },
  });
  return true;
}

/** The source main sends: install once, then one call, its result as JSON-safe data. */
export function unclutterCall(method: 'context' | 'apply' | 'count' | 'snapshot' | 'restore', args: unknown[] = []): string {
  // A bundler that keeps function names wraps inner functions in `__name(…)`, a
  // helper the page does not have; a no-op stands in for it.
  return `var __name=function(f){return f};(${unclutterPage.toString()})(window);window.__HELLO_UNCLUTTER__.${method}(...${JSON.stringify(args)})`;
}
