/**
 * How an agent names the element it wants — a CSS selector, the words a person
 * sees on it, or both, and which one when several match — and the page scripts
 * that act on it. Pure: this module writes the scripts; the browser manager
 * decides whether a tab may run them, and runs them in the page's main world.
 *
 * Why words: browser_read listed a control as `button: enable this API`, and
 * the model, holding a tool that took only CSS, sent
 * `button:has-text("enable this API")` (Playwright, not CSS) three times, then
 * `button` (dozens of matches), then guessed pixels. The words it had were the
 * right handle; the tool could not take them.
 */
export interface ElementTarget {
  /** A control's ref from the latest browser_read of this page: `e12`. */
  ref?: string;
  /** CSS selector. Alone, exactly one visible element must match it. */
  selector?: string;
  /** The words on the element — aria-label, text, placeholder, its <label>, a
   *  button's value — compared with case and spacing folded. Elements whose
   *  words equal it win over those merely containing it. */
  label?: string;
  /** Which of several matches, counting from 0 in page order. */
  nth?: number;
}

/** What a person can act on, and what browser_read lists as a control. */
export const CONTROL_SELECTOR = [
  "a[href]", "button", "input", "textarea", "select", "summary",
  '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]', '[role="tab"]', '[role="option"]', '[role="checkbox"]',
  '[role="radio"]', '[role="switch"]', '[role="combobox"]', '[role="textbox"]',
  '[contenteditable="true"]',
].join(",");

/**
 * Page-side helpers every script starts with: folding, an element's words,
 * visibility, a short description, and the lookup. Plain ES2017, since it
 * runs inside whatever page the tab shows.
 */
const PAGE_HELPERS = `
const fold = value => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
const inner = el => fold(el.innerText != null ? el.innerText : el.textContent);
const words = el => {
  const attr = name => fold(el.getAttribute(name));
  if (/^(input|textarea|select)$/i.test(el.tagName)) {
    const labelled = el.labels && el.labels[0] ? inner(el.labels[0]) : '';
    const pressed = /^(button|submit|reset)$/i.test(el.type || '') ? fold(el.value) : '';
    return attr('aria-label') || attr('placeholder') || labelled || pressed || attr('title');
  }
  const picture = el.querySelector ? el.querySelector('img[alt]') : null;
  return attr('aria-label') || inner(el) || attr('title') || attr('alt') || (picture ? fold(picture.getAttribute('alt')) : '');
};
// An inline link around a whole card has no width of its own: its content's
// box is where it is, for reading, clicking and marking alike (user, 30.09).
const boxOf = el => {
  const own = el.getBoundingClientRect();
  if ((own.width > 0 && own.height > 0) || !el.firstElementChild || !document.createRange) return own;
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const inner = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
    return inner && inner.width > 0 && inner.height > 0 ? inner : own;
  } catch (error) { return own; }
};
// Clipped away by what holds it: a screen-reader-only block (1x1, overflow
// hidden, clip-path inset(50%)), a menu or accordion closed to nothing — there
// for assistive technology, never for the person's eyes (user, 30.09: a hidden
// nav repeated the names of the cards, and the marks went on it). Once per node.
const clipMemo = new WeakMap();
const clippedAway = node => {
  if (!node || node === document.documentElement || !window.getComputedStyle) return false;
  if (clipMemo.has(node)) return clipMemo.get(node);
  const style = getComputedStyle(node);
  let away = /inset\\(\\s*50%/.test(style.clipPath || '') || /rect\\(\\s*0(px)?[ ,]+0(px)?[ ,]+0(px)?[ ,]+0(px)?\\s*\\)/.test(style.clip || '');
  if (!away && /hidden|clip/.test([style.overflow, style.overflowX, style.overflowY].join(' '))) {
    const box = node.getBoundingClientRect();
    away = box.width <= 2 || box.height <= 2;
  }
  away = away || clippedAway(node.parentElement);
  clipMemo.set(node, away);
  return away;
};
const visible = el => {
  const box = boxOf(el);
  if (!(box.width > 0 && box.height > 0)) return false;
  const style = window.getComputedStyle ? getComputedStyle(el) : null;
  return (!style || style.visibility !== 'hidden') && !clippedAway(el);
};
// Hidden from use: a modal's background (aria-hidden, inert) takes no clicks
// while the dialog is open — what an accessibility tree leaves out too.
const shut = (el, root) => {
  for (let node = el; node && node !== root; node = node.parentElement)
    if (node.getAttribute && (node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('inert'))) return true;
  return false;
};
// The dialog on top of the page when one is open modally: only it takes clicks.
const topDialog = () => {
  const open = Array.from(document.querySelectorAll('dialog[open], [aria-modal="true"]')).filter(el => {
    if (!visible(el)) return false;
    if (el.tagName === 'DIALOG') { try { return el.matches(':modal'); } catch (error) { return false; } }
    return true;
  });
  return open.length ? open[open.length - 1] : null;
};
const dialogName = el => fold(el.getAttribute('aria-label'))
  || fold((el.getAttribute('aria-labelledby') || '').split(/\\s+/).map(id => { const node = id ? document.getElementById(id) : null; return node ? inner(node) : ''; }).join(' '))
  || (() => { const heading = el.querySelector('h1, h2, h3, [role="heading"]'); return heading ? inner(heading) : ''; })();
const dialogSaid = dialog => { const name = dialogName(dialog); return 'the open dialog' + (name ? ' ' + JSON.stringify(name.slice(0, 60)) : ''); };
// What a person could use now: inside the dialog on top when one is open, and
// not in a part of the page hidden from use. A page that hides everything,
// its controls too, has used aria-hidden wrongly: those are shown anyway.
const usable = selector => {
  const dialog = topDialog();
  const root = dialog || document.body || document.documentElement;
  const all = Array.from(root.querySelectorAll(selector)).filter(visible);
  const open = all.filter(el => !shut(el, root));
  return { dialog, list: open.length || !all.length ? open : all };
};
const inView = el => { const box = boxOf(el); return box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth; };
// What is over a control's centre, when it is not the control: it would take the click.
const covering = el => {
  if (!document.elementFromPoint) return null;
  const box = boxOf(el);
  const x = box.left + box.width / 2, y = box.top + box.height / 2;
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
  const hit = document.elementFromPoint(x, y);
  if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return null;
  const label = hit.closest ? hit.closest('label') : null;
  return label && label.control === el ? null : hit;
};
// Transparent until the pointer is over its row: a "Pin" beside every chat.
const faint = el => {
  if (!window.getComputedStyle) return false;
  for (let node = el, depth = 0; node && depth < 4; node = node.parentElement, depth += 1)
    if (getComputedStyle(node).opacity === '0') return true;
  return false;
};
const role = el => {
  const explicit = fold(el.getAttribute('role')).toLowerCase();
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'text';
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    const type = fold(el.getAttribute('type') || 'text').toLowerCase();
    return type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : /^(button|submit|reset|image)$/.test(type) ? 'button' : type === 'range' ? 'slider' : 'textbox';
  }
  return el.isContentEditable ? 'textbox' : tag;
};
const stateFlags = el => {
  const flags = [];
  const attr = name => el.getAttribute(name);
  const tag = el.tagName.toLowerCase();
  const type = fold(el.type).toLowerCase();
  if (el.disabled || attr('aria-disabled') === 'true') flags.push('disabled');
  if (attr('aria-expanded') === 'true') flags.push('expanded');
  const checked = (tag === 'input' && (type === 'checkbox' || type === 'radio')) ? el.checked
    : attr('aria-checked') === 'true' ? true : attr('aria-checked') === 'false' ? false : null;
  if (checked === true) flags.push('checked');
  if (checked === false) flags.push('unchecked');
  if (attr('aria-selected') === 'true' || attr('aria-current')) flags.push('selected');
  if (tag === 'select') { const chosen = el.options[el.selectedIndex]; if (chosen) flags.push('= ' + JSON.stringify(fold(chosen.text).slice(0, 60))); }
  else if ((tag === 'input' || tag === 'textarea') && !/^(password|checkbox|radio|button|submit|reset|file|hidden|image)$/.test(type))
    flags.push(fold(el.value) ? '= ' + JSON.stringify(fold(el.value).slice(0, 60)) : 'empty');
  // Where a link goes, whole enough to use: the query stays (an item?id=… link
  // is its id), another site keeps its scheme so it can be fetched, and an
  // address too long to list is shortened in the middle, visibly — a silently
  // cut one read as a real address and was fetched into a 404 (29.09).
  if (tag === 'a' && attr('href')) { try { const url = new URL(el.href); const whole = url.origin === location.origin ? url.pathname + url.search : url.href; flags.push('→ ' + (whole.length > 160 ? whole.slice(0, 110) + '…' + whole.slice(-40) : whole)); } catch (error) { /* not a URL */ } }
  return flags;
};
const flagged = flags => flags.length ? ' (' + flags.join(', ') + ')' : '';
const describe = el => role(el) + ' ' + JSON.stringify(words(el).slice(0, 80));
// The same, with enough of the words to quote from: an element cut at 80
// characters reads as a page that cuts its own text, and sends the model
// looking for a truncation that is not there (user, 09.10).
const quoted = el => { const all = words(el); return role(el) + ' ' + JSON.stringify(all.slice(0, 200)) + (all.length > 200 ? '…' : ''); };
// A label of three words or more also names an element whose words hold all of
// its words in their order, with some left out between: a long title quoted
// with its middle dropped (user, 09.10: "Because you joined r/Qwen_AI
// Introducing Infernix 5h ago" for a card that also says what Infernix is).
const tokens = text => text.toLowerCase().split(' ')
  .map(word => word.replace(/^[^a-z0-9\\u00c0-\\uffff]+|[^a-z0-9\\u00c0-\\uffff]+$/g, '')).filter(Boolean);
const inOrder = (have, wanted) => {
  const want = tokens(wanted);
  if (want.length < 3) return false;
  let at = 0;
  for (const word of tokens(have)) if (word === want[at] && ++at === want.length) return true;
  return false;
};
const shows = (el, wanted) => { const have = words(el).toLowerCase(); return have.includes(wanted) || inOrder(have, wanted); };
// The refs of the latest browser_read of this page — gone with the page.
const REFS = '__helloAgentRefs';
const find = target => {
  // What the given ref turned out to be, when its words were not the label's.
  let refSaid = '';
  if (target.ref != null) {
    const match = /^e(\\d{1,4})$/i.exec(fold(target.ref));
    const stored = window[REFS];
    const list = stored && Array.isArray(stored.list) ? stored.list : [];
    const index = match ? Number(match[1]) - (stored && stored.start > 0 ? stored.start : 1) : -1;
    const el = index >= 0 ? list[index] : undefined;
    const dialog = topDialog();
    const wanted = target.label != null ? fold(target.label).toLowerCase() : '';
    const problem = !el ? 'Ref ' + JSON.stringify(target.ref) + ' is not from the latest browser_read of this page. Read the page again and use a current ref.'
      : !el.isConnected || !visible(el) ? 'Ref ' + fold(target.ref) + ' (' + describe(el) + ') is gone or hidden now. Read the page again.'
      : dialog && !dialog.contains(el) ? 'Ref ' + fold(target.ref) + ' (' + describe(el) + ') is behind ' + dialogSaid(dialog) + ', which takes every click now. Close the dialog first (its close button, or browser_press Escape).'
      : wanted && !shows(el, wanted) ? 'Ref ' + fold(target.ref) + ' is ' + quoted(el) + ', not ' + JSON.stringify(target.label) + '.'
      : '';
    if (!problem) return el;
    if (el && wanted && !shows(el, wanted)) refSaid = problem;
    // A ref that no longer holds, given with the words: the words decide.
    if (target.label == null && target.selector == null) throw new Error(problem);
  }
  let reach;
  try { reach = usable(target.selector || ${JSON.stringify(CONTROL_SELECTOR)}); }
  catch (error) { throw new Error(JSON.stringify(target.selector) + ' is not a CSS selector (Playwright syntax such as :has-text() is not CSS). To pick an element by the words on it, give label instead.'); }
  let found = reach.list;
  const scope = target.selector ? ' matching ' + JSON.stringify(target.selector) : '';
  if (target.label != null) {
    const wanted = fold(target.label).toLowerCase();
    const exact = found.filter(el => words(el).toLowerCase() === wanted);
    const part = exact.length ? exact : found.filter(el => words(el).toLowerCase().includes(wanted));
    found = part.length ? part : found.filter(el => inOrder(words(el).toLowerCase(), wanted));
  }
  // "2 visible elements matching "button" show "Enable"" / "2 visible elements match "button"".
  const counted = (count) => count + ' visible ' + (count === 1 ? 'element' : 'elements') + scope + (target.label != null
    ? (count === 1 ? ' shows ' : ' show ') + JSON.stringify(target.label)
    : (count === 1 ? ' matches' : ' match') + (target.selector ? '' : ' ' + JSON.stringify(target.selector)));
  if (!found.length && reach.dialog) {
    // Behind an open dialog is not nowhere: say where it is, and what to do.
    let behind = Array.from(document.querySelectorAll(target.selector || ${JSON.stringify(CONTROL_SELECTOR)})).filter(el => visible(el) && !reach.dialog.contains(el));
    if (target.label != null) { const wanted = fold(target.label).toLowerCase(); behind = behind.filter(el => words(el).toLowerCase().includes(wanted)); }
    if (behind.length) throw new Error(describe(behind[0]) + ' is behind ' + dialogSaid(reach.dialog) + ', which takes every click now. Close the dialog first (its close button, or browser_press Escape), then click it.');
  }
  if (!found.length) throw new Error(target.label != null
    ? 'No visible element' + scope + ' shows ' + JSON.stringify(target.label) + '.' + (refSaid
      ? ' ' + refSaid + ' Give part of its words exactly as the page shows them.'
      : ' browser_read lists the visible controls with their words.')
    : 'No visible element matches ' + JSON.stringify(target.selector) + '. browser_read lists the visible controls.');
  if (target.nth != null) {
    if (target.nth >= found.length) throw new Error('nth ' + target.nth + ' is out of range: only ' + counted(found.length) + '.');
    return found[target.nth];
  }
  if (found.length > 1) throw new Error(counted(found.length) + ': ' + found.slice(0, 8).map((el, index) => index + ': ' + describe(el)).join('; ') + (found.length > 8 ? '; …' : '') + '. Say which with label, a narrower selector, or nth.');
  return found[0];
};
`;

/**
 * Where the element is, so that main can click it the way a person does —
 * real mouse input at its centre, scrolled into view first. A DOM click was
 * not one: a menu that opens on pointerdown stayed shut, and the model went
 * on to guess pixels and hit the row below (user, 24.09: Neon's invoice
 * menu, "Request support" for "Download"). When something else is over the
 * centre, the click is dispatched to the element itself, and the result says
 * what covers it.
 */
export function locateScript(target: ElementTarget): string {
  return `(() => {${PAGE_HELPERS}
const el = find(${JSON.stringify(target)});
const what = describe(el);
// Instant, never smooth: the centre is measured right after the scroll.
if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
const box = boxOf(el);
const left = Math.max(0, box.left), top = Math.max(0, box.top);
const right = Math.min(window.innerWidth, box.right), bottom = Math.min(window.innerHeight, box.bottom);
if (right <= left || bottom <= top) throw new Error(what + ' is outside the viewport even after scrolling to it.');
const x = Math.round((left + right) / 2), y = Math.round((top + bottom) / 2);
const hit = document.elementFromPoint ? document.elementFromPoint(x, y) : null;
if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) { el.click(); return { what, x, y, covered: describe(hit) }; }
return { what, x, y };
})()`;
}

/** Where an element is, as boxScript measures it: in its own frame's viewport, and the path that finds it again. */
export interface ElementBox { what: string; left: number; top: number; width: number; height: number; inView: boolean; path?: string;
  /** It moves by itself (a ticker, a marquee): a mark cannot stay on it. */
  moving?: boolean }

/**
 * Where an element is, without touching it: its box in this frame's viewport
 * and what it is — for a mark the person is shown (browser_mark). With
 * `reveal` it is scrolled into view first, on a page at Full only.
 */
export function boxScript(target: ElementTarget, reveal = false): string {
  return `(async () => {${PAGE_HELPERS}
const el = find(${JSON.stringify(target)});
${reveal ? "if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });" : ''}
const measure = () => boxOf(el);
const box = measure();
// Something that moves by itself (user, 30.09: a ticker at the top repeated
// the names of the cards below it, and the marks slid away with it): a
// looping animation on it or around it, or a place on the page that changes
// while it is measured. A page scrolled meanwhile is not movement.
const loops = node => typeof node.getAnimations === 'function' && node.getAnimations().some(animation =>
  animation.playState === 'running' && animation.effect && typeof animation.effect.getTiming === 'function' && animation.effect.getTiming().iterations === Infinity);
let moving = false;
for (let node = el; node && node !== document.documentElement && !moving; node = node.parentElement) moving = loops(node);
if (!moving) {
  const x = box.left + window.scrollX, y = box.top + window.scrollY;
  await new Promise(resolve => setTimeout(resolve, 150));
  const again = measure();
  moving = Math.abs(again.left + window.scrollX - x) > 2 || Math.abs(again.top + window.scrollY - y) > 2;
}
// The element itself, not a place on the screen (user, 30.09: marks that
// stay on their element when the page is resized): a CSS path, from its id
// where one is unique, that finds it again — in Hello's own world, and after a reload.
const unique = node => node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1;
const steps = [];
for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
  if (unique(node)) { steps.unshift('#' + CSS.escape(node.id)); break; }
  const tag = node.tagName.toLowerCase();
  const same = node.parentElement ? [...node.parentElement.children].filter(child => child.tagName === node.tagName) : [];
  steps.unshift(same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(node) + 1) + ')' : tag);
}
const path = steps.join(' > ');
return { what: describe(el), left: box.left, top: box.top, width: box.width, height: box.height,
  inView: box.bottom > 0 && box.right > 0 && box.top < window.innerHeight && box.left < window.innerWidth,
  ...(path && document.querySelector(path) === el ? { path } : {}), ...(moving ? { moving: true } : {}) };
})()`;
}

/**
 * A page script's exception reaches main as its whole stack — "Error: No
 * visible element…\n    at find (<anonymous>:147:28)…" (user, 30.09) — lines of
 * Hello's own injected script that tell neither the model nor the person
 * anything. Only its words are kept. Electron hands it over as that text, not
 * as an Error, and a CLI then read only "Hello tool execution failed.": it
 * becomes an Error here, with its words.
 */
export function pageScriptError(error: unknown): unknown {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error
    : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message
      : undefined;
  if (text === undefined) return error;
  const lines = text.split('\n');
  const stack = lines.findIndex(line => /^\s+at .*<anonymous>/.test(line));
  if (error instanceof Error && stack < 1) return error;
  return new Error((stack < 1 ? lines : lines.slice(0, stack)).join('\n').replace(/^(?:Uncaught )?[A-Za-z]*Error: /, '').trim() || 'The page script failed.');
}

/** Set a text field's value the way a framework notices, without submitting;
 *  or choose a <select>'s option by its text or value. */
export function typeScript(target: ElementTarget, value: string): string {
  return `(() => {${PAGE_HELPERS}
const el = find(${JSON.stringify(target)});
if (el instanceof HTMLSelectElement) {
  const wanted = fold(${JSON.stringify(value)}).toLowerCase();
  const options = Array.from(el.options);
  const option = options.find(item => fold(item.value).toLowerCase() === wanted || fold(item.text).toLowerCase() === wanted);
  if (!option) throw new Error(describe(el) + ' has no option ' + JSON.stringify(${JSON.stringify(value)}) + '; its options are ' + options.map(item => JSON.stringify(fold(item.text).slice(0, 60))).join(', ') + '.');
  el.value = option.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'Chose ' + JSON.stringify(fold(option.text).slice(0, 80)) + ' in ' + describe(el) + '.';
}
if (el.isContentEditable && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
  if (el.focus) el.focus();
  el.textContent = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'Entered text into ' + describe(el) + '.';
}
if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error(describe(el) + ' is not a text field.');
if (el.type === 'password' || el.type === 'file') throw new Error('Sensitive fields cannot be filled by this tool.');
const setter = Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
setter.call(el, ${JSON.stringify(value)});
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
return 'Entered text into ' + describe(el) + '.';
})()`;
}

/** How many controls one read lists, across a page and its frames. */
export const READ_CONTROLS = 120;
/** The line above the controls in what browser_read returns. */
export const READ_HEADER = 'Controls — ref role "words" (state) @ (x, y), the centre in viewport CSS px. browser_click ref: "e3" clicks one (label: "words" also works when they are unique); browser_type ref sets a field; browser_pointer aims at (x, y). A control inside a frame says so and is clicked by its ref like any other. Refs and points hold until the page changes: after a click that opened or changed something, read again.';
/** What the overlay of an annotated screenshot is called in the page. */
export const ANNOTATION_ID = '__hello-annotate';
export interface ScanOptions {
  /** The number of this frame's first ref: refs run on across frames. */
  start: number;
  /** Where this frame sits in the page, so the centres are page coordinates. */
  offset: { x: number; y: number };
  /** Draw each ref on the page, for an annotated screenshot. */
  draw?: boolean;
  /** How much of the frame's text to take. */
  textLimit?: number;
}
export interface ScanResult { text: string; lines: string[]; count: number; /** What was left out, and why. */ note?: string }
/**
 * One frame's words and controls, each with a ref, its role, the words on it,
 * its state and its centre — the way agent-browser's snapshot names things,
 * so that a control with no words (a "⋮" menu button) is still one the model
 * can name. The refs of the latest scan stay on the frame, with their start,
 * so that a later click by ref finds the same element. With draw, each ref
 * is also written on the page, at its control, until erased.
 */
export function scanScript(options: ScanOptions): string {
  const { start, offset, draw = false, textLimit = 28_000 } = options;
  return `(() => {${PAGE_HELPERS}
const readable = node => node ? String((node.innerText != null ? node.innerText : node.textContent) || '') : '';
const reach = usable(${JSON.stringify(CONTROL_SELECTOR)});
const dialog = reach.dialog;
// With a dialog open, it is what the page is now: its words, and only its controls.
const text = dialog
  ? '[' + dialogSaid(dialog).replace(/^the open/, 'A') + ' is open over the page. Only it takes clicks now, and only its controls are listed. Close it (its close button, or browser_press Escape) to reach the page behind.]\\n' + readable(dialog).slice(0, ${textLimit})
  : readable(document.body).slice(0, ${textLimit});
// What can be used right now first, then what needs a scroll, then what is covered or shows on hover.
const ranked = reach.list.map((el, order) => {
  const onScreen = inView(el);
  const cover = onScreen ? covering(el) : null;
  const hidden = onScreen && !cover && faint(el);
  return { el, order, cover, hidden, onScreen, tier: !onScreen ? 1 : cover || hidden ? 2 : 0 };
}).sort((a, b) => a.tier - b.tier || a.order - b.order);
const shown = ranked.slice(0, ${READ_CONTROLS});
const found = shown.map(item => item.el);
const stored = { start: ${start}, list: found };
try { Object.defineProperty(window, REFS, { value: stored, configurable: true, writable: true, enumerable: false }); } catch (error) { window[REFS] = stored; }
const old = document.getElementById(${JSON.stringify(ANNOTATION_ID)});
if (old) old.remove();
const layer = ${draw} && document.body ? document.createElement('div') : null;
if (layer) {
  layer.id = ${JSON.stringify(ANNOTATION_ID)};
  layer.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;font:11px/1 system-ui,sans-serif;');
  document.body.appendChild(layer);
}
// What loops on its own (a ticker, a marquee), found once for the whole read:
// a control inside it moves by itself, and is said to (user, 30.09).
let looping = [];
try {
  looping = (typeof document.getAnimations === 'function' ? document.getAnimations() : [])
    .filter(animation => animation.playState === 'running' && animation.effect && typeof animation.effect.getTiming === 'function'
      && animation.effect.getTiming().iterations === Infinity && animation.effect.target && animation.effect.target.nodeType === 1)
    .map(animation => animation.effect.target);
} catch (error) { looping = []; }
const lines = shown.map((item, index) => {
  const el = item.el;
  const box = boxOf(el);
  const ref = 'e' + (${start} + index);
  const where = (!item.onScreen ? ['off screen, ' + (box.top >= innerHeight ? 'below' : box.bottom <= 0 ? 'above' : 'beside')]
    : item.cover ? ['covered by ' + describe(item.cover)] : item.hidden ? ['shows on hover'] : [])
    .concat(looping.some(target => target === el || target.contains(el)) ? ['moves by itself'] : []);
  if (layer) {
    const tag = document.createElement('div');
    tag.textContent = ref;
    tag.setAttribute('style', 'position:absolute;left:' + Math.max(0, Math.round(box.left)) + 'px;top:' + Math.max(0, Math.round(box.top) - 12) + 'px;padding:1px 3px;background:#ffe600;color:#000;border:1px solid #000;border-radius:3px;');
    layer.appendChild(tag);
  }
  return ref + ' ' + role(el) + ' ' + JSON.stringify(words(el).slice(0, 140)) + flagged(stateFlags(el).concat(where)) + ' @ (' + Math.round(box.left + box.width / 2 + ${offset.x}) + ', ' + Math.round(box.top + box.height / 2 + ${offset.y}) + ')';
});
const notes = [];
const left = ranked.length - shown.length;
if (left > 0) notes.push(left + ' more ' + (left === 1 ? 'control is' : 'controls are') + ' not listed — the ones further off screen or covered. Name one by label, or scroll to it and read again.');
if (dialog) {
  const behind = Array.from(document.querySelectorAll(${JSON.stringify(CONTROL_SELECTOR)})).filter(el => visible(el) && !dialog.contains(el)).length;
  if (behind) notes.push(behind + ' ' + (behind === 1 ? 'control' : 'controls') + ' of the page behind ' + dialogSaid(dialog) + ' ' + (behind === 1 ? 'is' : 'are') + ' not listed: nothing behind it takes a click while it is open.');
}
return { text, lines, count: found.length, note: notes.join(' ') };
})()`;
}
/**
 * What is at a point of the page, before a pointer action is sent there: the
 * element, the control it belongs to and that control's ref from the latest
 * read. A point guessed from an old read hit the row below — or the page
 * behind a dialog — and nothing said so (user, 24.09).
 */
export function hitScript(x: number, y: number): string {
  return `(() => {${PAGE_HELPERS}
const hit = document.elementFromPoint ? document.elementFromPoint(${Number(x)}, ${Number(y)}) : null;
if (!hit) return null;
const control = hit.closest ? hit.closest(${JSON.stringify(CONTROL_SELECTOR)}) : null;
const stored = window[REFS];
const list = stored && Array.isArray(stored.list) ? stored.list : [];
const index = control ? list.indexOf(control) : -1;
return { what: describe(control || hit), ref: index >= 0 ? 'e' + (stored.start + index) : '', control: !!control };
})()`;
}
/** Take the annotation overlay off a frame. */
export const ERASE_SCRIPT = `(() => { const layer = document.getElementById(${JSON.stringify(ANNOTATION_ID)}); if (layer) layer.remove(); return true; })()`;
/**
 * Where a frame's child frames sit: each visible <iframe>, by name and
 * address, with its box in this frame's viewport — so that a control in a
 * frame gets page coordinates, and a real click lands on it.
 */
export const FRAME_BOXES_SCRIPT = `(() => {
const fold = value => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
return Array.from(document.querySelectorAll('iframe')).map(el => {
  const box = el.getBoundingClientRect();
  return { name: fold(el.getAttribute('name')), src: fold(el.src || el.getAttribute('src')), x: box.left, y: box.top, width: box.width, height: box.height };
}).filter(box => box.width > 0 && box.height > 0);
})()`;
export interface WaitCondition {
  /** Words the page shows, case and spacing folded. */
  text?: string;
  /** A control that is there, named like a click target. */
  target?: ElementTarget;
  /** The tab's address contains this, or matches it with * wildcards. */
  url?: string;
  /** The page has finished loading. */
  load?: boolean;
  /** Just this long, in ms. */
  ms?: number;
  timeoutMs: number;
}
/** Whether the page shows the words, or has the control — true or false, never a throw. */
export function waitScript(condition: Pick<WaitCondition, 'text' | 'target'>): string {
  return `(() => {${PAGE_HELPERS}
${condition.text !== undefined ? `if (!fold(document.body ? (document.body.innerText != null ? document.body.innerText : document.body.textContent) : '').toLowerCase().includes(${JSON.stringify(condition.text)}.replace(/\\s+/g, ' ').trim().toLowerCase())) return false;` : ''}
${condition.target ? `try { find(${JSON.stringify(condition.target)}); } catch (error) { return false; }` : ''}
return true;
})()`;
}
/** Whether an address is the one waited for: a substring, or a * pattern. */
export function matchesUrl(url: string, wanted: string): boolean {
  const pattern = wanted.trim();
  if (!pattern) return false;
  if (!pattern.includes('*')) return url.includes(pattern);
  const source = pattern.split('*').map(part => part.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}$`, 'i').test(url) || new RegExp(source, 'i').test(url);
}
