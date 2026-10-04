// @vitest-environment jsdom
// Annotate, the half that lives in the page: criteria A1, A5, A7, A8 against the
// real PAGE_MODE_PROBE. The [RISC] findings of the first test round are fixed;
// their tests now pin the fixed behaviour.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PAGE_MODE_PROBE, probeCall } from '../src/main/browser/page-mode-probe';
import { parseProbeAnnotations, parseProbeBatch } from '../src/shared/page-mode-format';
import { dispatchTrusted } from './trusted-event';

interface Bridge {
  arm(kind: string, armId: string): boolean;
  disarm(armId?: string): boolean;
  wait(armId: string, ms: number): Promise<unknown>;
  beforeShot(): Promise<{ viewport: { w: number; h: number }; extra: unknown }>;
  afterShot(): boolean;
  call(kind: string, method: string, args: unknown[]): unknown;
  hints(list: unknown[]): Array<{ n: number; note: string; x: number; y: number; width: number; height: number }>;
  clearHints(): boolean;
  hintsWait(ms: number): Promise<number[]>;
}
const run = (code: string): unknown => (0, eval)(code);
const bridge = () => (window as unknown as { __HELLO_PAGE_MODE__: Bridge }).__HELLO_PAGE_MODE__;

const roots: ShadowRoot[] = [];
beforeAll(() => {
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const root = attach.call(this, init);
    roots.push(root);
    return root;
  };
  run(PAGE_MODE_PROBE);
});
const markerRoot = () => roots.find(root => (root.host as HTMLElement).hasAttribute('data-hello-annotations'))!;
/** The person's click (trusted); the probe ignores anything a script dispatches. */
const click = (target: EventTarget, x: number, y: number) =>
  dispatchTrusted(target, new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y }));
const pendingInput = () => markerRoot().querySelector<HTMLInputElement>('.mark input');
const key = (target: EventTarget, init: KeyboardEventInit) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, composed: true, ...init }));
/** Drop a marker at (x, y) and commit `text` with Enter. */
const note = (target: Element, x: number, y: number, text: string) => {
  click(target, x, y);
  const input = pendingInput()!;
  input.value = text;
  key(input, { key: 'Enter' });
};
const drain = async (armId: string) => parseProbeBatch(await bridge().wait(armId, 50))?.events ?? [];
const shotMarks = async () => {
  const shot = await bridge().beforeShot();
  bridge().afterShot();
  return parseProbeAnnotations(shot.extra, 'https://example.test/')!.marks;
};

describe('annotate probe — criteria', () => {
  afterEach(() => {
    bridge().disarm();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    Object.defineProperty(window, 'scrollX', { value: 0, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  });

  it('A8: injects nothing into the page until armed, and removes all of it on disarm', () => {
    document.body.innerHTML = '<p id="p">text</p>';
    expect(document.querySelector('[data-hello-annotations],[data-hello-page-mode]')).toBeNull();
    expect(bridge().arm('annotate', 'a8')).toBe(true);
    expect(document.querySelector('[data-hello-annotations]')).not.toBeNull();
    note(document.getElementById('p')!, 20, 200, 'kept');
    click(document.getElementById('p')!, 40, 220); // a second note left open
    expect(bridge().disarm('a8')).toBe(true);
    expect(document.querySelector('[data-hello-annotations],[data-hello-page-mode],[data-hello-pick]')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('cursor')).toBe('');
  });

  it('A8: switching Annotate → Design takes the marker layer and the crosshair away', () => {
    document.body.innerHTML = '<p id="p">text</p>';
    bridge().arm('annotate', 'sw-1');
    note(document.getElementById('p')!, 20, 200, 'kept');
    expect(bridge().arm('design', 'sw-2')).toBe(true);
    expect(document.querySelector('[data-hello-annotations]')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('cursor')).toBe('');
    expect(bridge().call('annotate', 'setAt', ['sw-1', 1, 'X', null])).toBeNull();
  });

  it('A8: a cursor the page set itself is put back on exit', () => {
    document.documentElement.style.setProperty('cursor', 'wait');
    bridge().arm('annotate', 'cur');
    expect(document.documentElement.style.getPropertyValue('cursor')).toBe('crosshair');
    bridge().disarm('cur');
    expect(document.documentElement.style.getPropertyValue('cursor')).toBe('wait');
    document.documentElement.style.removeProperty('cursor');
  });

  it('A1: a pin sits at page coordinates (client + scroll), in a layer at the document origin', () => {
    document.body.innerHTML = '<p id="p">text</p>';
    Object.defineProperty(window, 'scrollX', { value: 30, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 900, configurable: true });
    bridge().arm('annotate', 'a1');
    click(document.getElementById('p')!, 120, 200);
    const mark = markerRoot().querySelector<HTMLElement>('.mark')!;
    expect(mark.style.left).toBe('150px');
    expect(mark.style.top).toBe('1100px');
    const host = markerRoot().host as HTMLElement;
    expect(host.style.getPropertyValue('position')).toBe('absolute');
    expect(host.style.getPropertyPriority('position')).toBe('important');
  });

  it('A1: `at` is only a textual hint — the DOM path of what was under the click', async () => {
    document.body.innerHTML = '<main><section class="hero big"><h1 id="t">Title</h1></section></main>';
    bridge().arm('annotate', 'at');
    note(document.getElementById('t')!, 50, 100, 'Too tight');
    const [mark] = await shotMarks();
    expect(mark).toMatchObject({ n: 1, text: 'Too tight', at: 'main > section.hero.big > h1#t' });
    note(document.querySelector('section')!, 60, 300, 'Hero');
    expect((await shotMarks())[1].at).toBe('main > section.hero.big');
  });

  it('A7: Enter commits; an empty note is thrown away without a marks event; IME Enter does not commit', async () => {
    document.body.innerHTML = '<p id="p">text</p>';
    const p = document.getElementById('p')!;
    bridge().arm('annotate', 'a7-enter');
    click(p, 20, 200);
    const input = pendingInput()!;
    input.value = 'still composing';
    key(input, { key: 'Enter', isComposing: true });
    expect(pendingInput()).not.toBeNull();
    input.value = '   ';
    key(input, { key: 'Enter' });
    expect(markerRoot().querySelectorAll('.mark')).toHaveLength(0);
    expect(await drain('a7-enter')).toEqual([]);

    note(p, 30, 210, 'Real note');
    expect(markerRoot().querySelectorAll('.mark')).toHaveLength(1);
    expect(markerRoot().querySelector('.mark .label')!.textContent).toBe('Real note');
    const events = await drain('a7-enter');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'marks', count: 1, mark: { n: 2 } });
  });

  it('A7: numbers are never reused and the 6 colours cycle by number', async () => {
    document.body.innerHTML = '<p id="p">text</p>';
    const p = document.getElementById('p')!;
    bridge().arm('annotate', 'a7-colors');
    for (let i = 1; i <= 7; i++) note(p, 10 * i, 200, `note ${i}`);
    const marks = await shotMarks();
    expect(marks.map(mark => mark.color)).toEqual(['yellow', 'blue', 'pink', 'green', 'orange', 'purple', 'yellow']);
    expect(marks.map(mark => mark.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('A7: deleting the open note keeps the committed count; deleting a committed pin lowers it; numbers move on', async () => {
    document.body.innerHTML = '<p id="p">text</p>';
    const p = document.getElementById('p')!;
    bridge().arm('annotate', 'a7-del');
    note(p, 20, 200, 'one');
    click(p, 40, 300); // #2 open, not committed
    await drain('a7-del');
    const [first, open] = [...markerRoot().querySelectorAll<HTMLElement>('.mark .pin')];
    const rects = new Map<Element, DOMRect>([
      [first, { left: 100, top: 100, right: 124, bottom: 124, width: 24, height: 24 } as DOMRect],
      [open, { left: 300, top: 300, right: 324, bottom: 324, width: 24, height: 24 } as DOMRect],
    ]);
    const zero = { left: -1, top: -1, right: -1, bottom: -1, width: 0, height: 0 } as DOMRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) { return rects.get(this) ?? zero; });

    click(open, 310, 310);
    expect(markerRoot().querySelectorAll('.mark')).toHaveLength(1);
    expect(pendingInput()).toBeNull();
    expect(await drain('a7-del')).toEqual([]);

    click(first, 110, 110);
    expect(markerRoot().querySelectorAll('.mark')).toHaveLength(0);
    expect(p.hasAttribute('data-hello-pick')).toBe(false);
    expect(await drain('a7-del')).toEqual([{ type: 'marks', count: 0 }]);

    vi.restoreAllMocks();
    click(p, 60, 400);
    expect(pendingInput()!.placeholder).toBe('#3 what is wrong or wanted here');
  });

  it('A7: a committed note cannot be edited — clicking its label opens nothing', async () => {
    document.body.innerHTML = '<p id="p">text</p>';
    bridge().arm('annotate', 'a7-edit');
    note(document.getElementById('p')!, 20, 200, 'final');
    const label = markerRoot().querySelector<HTMLElement>('.mark .label')!;
    const pin = markerRoot().querySelector<HTMLElement>('.mark .pin')!;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return (this === pin ? { left: 0, top: 0, right: 24, bottom: 24, width: 24, height: 24 } : { left: 60, top: 0, right: 200, bottom: 24, width: 140, height: 24 }) as DOMRect;
    });
    click(label, 80, 10);
    expect(pendingInput()).toBeNull();
    expect(markerRoot().querySelectorAll('.mark')).toHaveLength(1);
    expect(label.textContent).toBe('final');
  });

  it('A7: a click away commits a note with words (and does nothing else)', async () => {
    document.body.innerHTML = '<p id="p">text</p>';
    const p = document.getElementById('p')!;
    bridge().arm('annotate', 'a7-away');
    click(p, 20, 200);
    pendingInput()!.value = 'by click away';
    click(p, 400, 400);
    expect(pendingInput()).toBeNull();
    expect(markerRoot().querySelectorAll('.mark')).toHaveLength(1);
    expect((await shotMarks())[0]).toMatchObject({ n: 1, text: 'by click away' });
  });

  it('A7: Escape in a note is left to main — the probe itself neither commits nor drops', () => {
    document.body.innerHTML = '<p id="p">text</p>';
    bridge().arm('annotate', 'a7-esc');
    click(document.getElementById('p')!, 20, 200);
    pendingInput()!.value = 'typing';
    key(pendingInput()!, { key: 'Escape' });
    expect(pendingInput()!.value).toBe('typing');
    // Main's before-input-event → exit → disarm is what throws it away:
    bridge().disarm('a7-esc');
    expect(document.querySelector('[data-hello-annotations]')).toBeNull();
  });

  it('A6: the note being typed leaves the picture; committed pins stay and each reports inView', async () => {
    document.body.innerHTML = '<p id="p">text</p>';
    const p = document.getElementById('p')!;
    bridge().arm('annotate', 'a6');
    note(p, 20, 200, 'in');
    note(p, 40, 220, 'out');
    click(p, 60, 240);
    const nodes = [...markerRoot().querySelectorAll<HTMLElement>('.mark')];
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const top = this === nodes[1] || this.parentElement?.parentElement === nodes[1] ? 5000 : 10;
      // The marker point is 0×0; its pin has a box.
      const size = this.classList.contains('pin') ? 24 : 0;
      return { left: 10, top, right: 10 + size, bottom: top + size, width: size, height: size } as DOMRect;
    });
    const shot = await bridge().beforeShot();
    expect(nodes[0].style.opacity).toBe('');
    expect(nodes[2].style.opacity).toBe('0');
    expect((markerRoot().host as HTMLElement).style.visibility).toBe('');
    expect((shot.extra as { marks: Array<{ n: number; inView: boolean }> }).marks.map(m => [m.n, m.inView])).toEqual([[1, true], [2, false]]);
    bridge().afterShot();
    expect(nodes[2].style.opacity).toBe('');
  });

  it('A6: Send/Copy with a note typed but not committed commits it into the picture and the list; an empty one is dropped as before', async () => {
    document.body.innerHTML = '<p id="p">text</p>';
    const p = document.getElementById('p')!;
    bridge().arm('annotate', 'a6-typed');
    note(p, 20, 200, 'kept');
    click(p, 40, 220);
    pendingInput()!.value = '  typed   but not entered ';
    await drain('a6-typed');
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 10, right: 34, bottom: 34, width: 24, height: 24 } as DOMRect);
    const shot = await bridge().beforeShot();
    bridge().afterShot();
    expect(pendingInput()).toBeNull();
    const nodes = [...markerRoot().querySelectorAll<HTMLElement>('.mark')];
    expect(nodes).toHaveLength(2);
    expect(nodes[1].style.opacity).toBe('');
    expect(nodes[1].querySelector('.label')!.textContent).toBe('typed but not entered');
    expect((shot.extra as { marks: Array<{ n: number; text: string; inView: boolean }> }).marks.map(m => [m.n, m.text, m.inView]))
      .toEqual([[1, 'kept', true], [2, 'typed but not entered', true]]);
    expect(await drain('a6-typed')).toEqual([expect.objectContaining({ type: 'marks', count: 2, mark: expect.objectContaining({ n: 2 }) })]);

    click(p, 60, 240);
    pendingInput()!.value = '   ';
    const empty = await bridge().beforeShot();
    bridge().afterShot();
    expect((empty.extra as { marks: unknown[] }).marks).toHaveLength(2);
    expect(markerRoot().querySelectorAll('.mark')).toHaveLength(3);
    expect(await drain('a6-typed')).toEqual([]);
  });

  it('setAt: refuses non-strings, and a marker already deleted', async () => {
    document.body.innerHTML = '<p id="p">text</p>';
    const p = document.getElementById('p')!;
    bridge().arm('annotate', 'setat');
    note(p, 20, 200, 'one');
    const call = (args: unknown[]) => run(probeCall('call', ['annotate', 'setAt', ['setat', ...args]]));
    expect(call([1, '', null])).toBe(false);
    expect(call([1, 42, null])).toBe(false);
    expect(call([99, 'Card', null])).toBe(false);
    expect(run(probeCall('call', ['annotate', 'setAt', ['another-arming', 1, 'Card', null]]))).toBe(false);
    expect(run(probeCall('call', ['annotate', 'setAt', [1, 'Card', null]]))).toBe(false);
    const pin = markerRoot().querySelector<HTMLElement>('.mark .pin')!;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return (this === pin ? { left: 0, top: 0, right: 24, bottom: 24, width: 24, height: 24 } : { left: -9, top: -9, right: -9, bottom: -9, width: 0, height: 0 }) as DOMRect;
    });
    click(pin, 5, 5);
    expect(call([1, 'Card', 'src/Card.tsx:1'])).toBe(false);
  });

  it('setAt: a non-string file is ignored rather than printed', async () => {
    document.body.innerHTML = '<button id="b">Go</button>';
    bridge().arm('annotate', 'setat-file');
    note(document.getElementById('b')!, 20, 200, 'one');
    expect(run(probeCall('call', ['annotate', 'setAt', ['setat-file', 1, 'Card', { evil: true }]]))).toBe(true);
    expect((await shotMarks())[0].at).toBe('Card <button>');
  });

  it('a late disarm from a replaced arming does not end its successor', () => {
    document.body.innerHTML = '<p id="p">text</p>';
    bridge().arm('annotate', 'old');
    bridge().arm('annotate', 'new');
    note(document.getElementById('p')!, 20, 200, 'survives');
    expect(bridge().disarm('old')).toBe(false);
    expect(markerRoot().querySelectorAll('.mark')).toHaveLength(1);
  });

  it('A5: re-arming starts from #1 with nothing left over', async () => {
    document.body.innerHTML = '<p id="p">text</p>';
    const p = document.getElementById('p')!;
    bridge().arm('annotate', 'first');
    note(p, 20, 200, 'one'); note(p, 30, 200, 'two');
    bridge().disarm('first');
    bridge().arm('annotate', 'second');
    expect(await shotMarks()).toEqual([]);
    expect(p.hasAttribute('data-hello-pick')).toBe(false);
    note(p, 20, 200, 'fresh');
    expect((await shotMarks())[0].n).toBe(1);
  });

  it('setAt names its arming: after a re-arm, a late setAt for the old #1 does not land on the new #1', async () => {
    document.body.innerHTML = '<p id="p">text</p>';
    const p = document.getElementById('p')!;
    bridge().arm('annotate', 'r-old');
    note(p, 20, 200, 'old note');
    bridge().disarm('r-old');
    bridge().arm('annotate', 'r-new');
    note(p, 20, 200, 'new note');
    expect(run(probeCall('call', ['annotate', 'setAt', ['r-old', 1, 'StaleFromOldArming', null]]))).toBe(false);
    expect((await shotMarks())[0].at).toBe('p#p');
    expect(run(probeCall('call', ['annotate', 'setAt', ['r-new', 1, 'Fresh', null]]))).toBe(true);
    expect((await shotMarks())[0].at).toBe('Fresh <p>');
  });

  it('untrusted (page- or agent-dispatched) clicks drop no marker and reach the page', async () => {
    document.body.innerHTML = '<p id="p">text</p>';
    const p = document.getElementById('p')!;
    let pageSawClick = 0;
    p.addEventListener('click', () => { pageSawClick += 1; });
    bridge().arm('annotate', 'untrusted');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    expect(event.isTrusted).toBe(false);
    p.dispatchEvent(event);
    p.click();
    expect(markerRoot().querySelectorAll('.mark')).toHaveLength(0);
    expect(pageSawClick).toBe(2);
    expect(event.defaultPrevented).toBe(false);
    // Nor can a script remove a pin the person dropped.
    note(p, 20, 200, 'mine');
    const pin = markerRoot().querySelector<HTMLElement>('.mark .pin')!;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 24, bottom: 24, width: 24, height: 24 } as DOMRect);
    pin.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: 5, clientY: 5 }));
    expect(markerRoot().querySelectorAll('.mark')).toHaveLength(1);
    expect(await drain('untrusted')).toEqual([expect.objectContaining({ type: 'marks', count: 1 })]);
  });

  it('a page that detaches the marker layer, or collapses it to no box, gets its pins reported outside the picture', async () => {
    document.body.innerHTML = '<p id="p">text</p>';
    bridge().arm('annotate', 'detached');
    note(document.getElementById('p')!, 20, 200, 'visible?');
    const host = document.querySelector<HTMLElement>('[data-hello-annotations]')!;
    // Connected but with no box (display:none by script): 0,0,0,0 — not in the picture.
    const measure = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } as DOMRect);
    expect((await shotMarks())[0].inView).toBe(false);
    // Detached, even if something still measures: not in the picture.
    host.remove(); // page script: document.querySelector('[data-hello-annotations]').remove()
    measure.mockReturnValue({ left: 10, top: 10, right: 34, bottom: 34, width: 24, height: 24 } as DOMRect);
    const [mark] = await shotMarks();
    expect(host.isConnected).toBe(false);
    expect(mark.inView).toBe(false);
  });

  it('mousedown inside the open note keeps its default (caret placement, selection) and does not bubble to the page', () => {
    document.body.innerHTML = '<p id="p">text</p>';
    bridge().arm('annotate', 'mousedown');
    click(document.getElementById('p')!, 20, 200);
    const pageSaw = vi.fn();
    document.addEventListener('mousedown', pageSaw);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true });
    dispatchTrusted(pendingInput()!, down);
    document.removeEventListener('mousedown', pageSaw);
    expect(down.defaultPrevented).toBe(false);
    expect(pageSaw).not.toHaveBeenCalled();
    // Outside the marker layer a press is still the mode's.
    const outside = new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true });
    dispatchTrusted(document.getElementById('p')!, outside);
    expect(outside.defaultPrevented).toBe(true);
  });

  it('keydown/keyup/keypress from typing a note stop at the marker layer — the page’s own document listeners (site hotkeys) never see them', () => {
    document.body.innerHTML = '<p id="p">text</p>';
    bridge().arm('annotate', 'keys');
    click(document.getElementById('p')!, 20, 200);
    const seen: string[] = [];
    const onKey = (event: Event) => seen.push(event.type);
    const types = ['keydown', 'keyup', 'keypress'];
    for (const type of types) { document.addEventListener(type, onKey); window.addEventListener(type, onKey); }
    const input = pendingInput()!;
    key(input, { key: 'k' });
    input.dispatchEvent(new KeyboardEvent('keypress', { key: 'k', bubbles: true, composed: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'k', bubbles: true, composed: true }));
    for (const type of types) { document.removeEventListener(type, onKey); window.removeEventListener(type, onKey); }
    // A page listener in the capture phase runs before any of this; no layer can stop that.
    expect(seen).toEqual([]);
    expect(pendingInput()).not.toBeNull();
  });
});

// An agent shows the person where to look (user, 30.09: "a pointer for
// agents"): Annotate's pins and notes, placed by browser_mark on a layer of
// their own, with an outline around each element, a chat bubble indexing them,
// and an × on each for the person to keep only what they want.
describe('marks an agent places', () => {
  const hintRoot = () => roots.filter(root => (root.host as HTMLElement).hasAttribute('data-hello-hints')).at(-1)!;
  const tap = (node: Element) => dispatchTrusted(node, new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
  afterEach(() => { bridge().clearHints(); bridge().disarm(); });

  it('draws numbered pins with notes and outlines, with no mode on and apart from the person’s markers', () => {
    document.body.innerHTML = '<p id="p">text</p>';
    const drawn = bridge().hints([
      { n: 1, left: 40, top: 300, width: 320, height: 90, note: 'Cheapest:  $3,500,\nBuy It Now' },
      { n: 2, left: 40, top: 420, width: 320, height: 90, note: 'Same, auction' },
    ]);
    // What was drawn, in page px, for main to keep with the page.
    expect(drawn).toEqual([
      { n: 1, note: 'Cheapest: $3,500, Buy It Now', x: 40, y: 300, width: 320, height: 90 },
      { n: 2, note: 'Same, auction', x: 40, y: 420, width: 320, height: 90 },
    ]);
    const root = hintRoot();
    expect([...root.querySelectorAll('.mark.hint .label span')].map(node => node.textContent)).toEqual(['#1 Cheapest: $3,500, Buy It Now', '#2 Same, auction']);
    const box = root.querySelector<HTMLElement>('.box')!;
    expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual(['40px', '300px', '320px', '90px']);
    // One after the other on reveal.
    expect([...root.querySelectorAll<HTMLElement>('.box')].map(node => node.style.getPropertyValue('--d'))).toEqual(['0ms', '90ms']);
    expect(markerRoot()?.querySelectorAll('.mark').length ?? 0).toBe(0);
  });

  it('keeps them in a chat bubble that lists them, scrolls to one, and puts one away at its ×', async () => {
    document.body.innerHTML = '<p id="p">text</p>';
    const scrolled: unknown[] = [];
    window.scrollTo = ((options: unknown) => { scrolled.push(options); }) as typeof window.scrollTo;
    bridge().hints([{ n: 1, left: 10, top: 900, width: 50, height: 20, note: 'one' }, { n: 2, left: 10, top: 1400, width: 50, height: 20, note: 'two' }]);
    const root = hintRoot();
    expect(root.querySelector('.bubble .count')?.textContent).toBe('2');
    const chips = () => [...root.querySelectorAll<HTMLElement>('.chip')];
    expect(chips().map(chip => chip.querySelector('.t')?.textContent)).toEqual(['#1 one', '#2 two']);
    tap(chips()[1]);
    expect(scrolled.at(-1)).toMatchObject({ top: 1400 - window.innerHeight / 3 });
    expect(root.querySelectorAll('.box')[1].classList.contains('pulse')).toBe(true);
    // A page's own script cannot put a mark away; the person's click on its × does.
    const waited = bridge().hintsWait(5_000);
    root.querySelector<HTMLElement>('.mark.hint .x')!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(root.querySelectorAll('.mark.hint')).toHaveLength(2);
    tap(chips()[0].querySelector('.x')!);
    await expect(waited).resolves.toEqual([{ n: 2, x: 10, y: 1400, width: 50, height: 20 }]);
    expect([...root.querySelectorAll('.mark.hint .label span')].map(node => node.textContent)).toEqual(['#2 two']);
    expect(root.querySelector('.bubble .count')?.textContent).toBe('1');
    // The last one away: nothing is left, not even the bubble.
    tap(root.querySelector('.mark.hint .x')!);
    expect(document.querySelector('[data-hello-hints]')).toBeNull();
  });

  it('evaporates them all at a double click on the bubble — the person’s, not a script’s', async () => {
    document.body.innerHTML = '<p id="p">text</p>';
    bridge().hints([{ n: 1, left: 10, top: 10, width: 50, height: 20, note: 'one' }, { n: 2, left: 10, top: 60, width: 50, height: 20, note: 'two' }]);
    const bubble = hintRoot().querySelector<HTMLElement>('.bubble')!;
    expect(bubble.title).toContain('double-click to clear them');
    bubble.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
    await new Promise(resolve => setTimeout(resolve, 260));
    expect(document.querySelector('[data-hello-hints]')).not.toBeNull();
    const waited = bridge().hintsWait(5_000);
    dispatchTrusted(bubble, new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true }));
    await expect(waited).resolves.toEqual([]);
    expect(document.querySelector('[data-hello-hints]')).toBeNull();
  });

  it('draws kept marks where they were on the page, and replaces or clears them', () => {
    document.body.innerHTML = '<p id="p">text</p>';
    expect(bridge().hints([{ n: 3, x: 40, y: 1300, width: 320, height: 90, note: 'kept' }])).toEqual([{ n: 3, note: 'kept', x: 40, y: 1300, width: 320, height: 90 }]);
    expect(hintRoot().querySelector<HTMLElement>('.box')!.style.top).toBe('1300px');
    bridge().hints([{ n: 1, left: 0, top: 0, width: 10, height: 10, note: 'new' }]);
    expect([...hintRoot().querySelectorAll('.label span')].map(node => node.textContent)).toEqual(['#1 new']);
    expect(bridge().hints([])).toEqual([]);
    expect(document.querySelector('[data-hello-hints]')).toBeNull();
  });
});

// A mark stays on its element (user, 30.09: "tied to the marked elements…
// arranged back even when the page is resized").
describe('a mark on its element', () => {
  const hintRoot = () => roots.filter(root => (root.host as HTMLElement).hasAttribute('data-hello-hints')).at(-1)!;
  const settle = () => new Promise(resolve => setTimeout(resolve, 60));
  afterEach(() => { bridge().clearHints(); });
  const boxed = (el: Element, box: { left: number; top: number; width: number; height: number }) => {
    el.getBoundingClientRect = () => ({ ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => ({}) }) as DOMRect;
  };

  it('follows its element when the page is resized, and hides while it is hidden', async () => {
    document.body.innerHTML = '<main><article id="listing">Mac Studio</article></main>';
    const listing = document.getElementById('listing')!;
    boxed(listing, { left: 40, top: 300, width: 320, height: 90 });
    const [drawn] = bridge().hints([{ n: 1, left: 40, top: 300, width: 320, height: 90, note: 'Cheapest', path: '#listing' }]);
    expect(drawn).toMatchObject({ x: 40, y: 300, path: '#listing' });
    // The window narrows and the listing moves down and shrinks: the mark goes with it.
    boxed(listing, { left: 24, top: 520, width: 280, height: 110 });
    window.dispatchEvent(new Event('resize'));
    await settle();
    const box = hintRoot().querySelector<HTMLElement>('.box')!;
    expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual(['24px', '520px', '280px', '110px']);
    expect(hintRoot().querySelector<HTMLElement>('.mark.hint')!.style.top).toBe('520px');
    // Collapsed away: the mark is hidden, not left on whatever took its place.
    boxed(listing, { left: 0, top: 0, width: 0, height: 0 });
    window.dispatchEvent(new Event('resize'));
    await settle();
    expect(box.style.visibility).toBe('hidden');
    // Where it is now is what main keeps.
    boxed(listing, { left: 24, top: 600, width: 280, height: 110 });
    window.dispatchEvent(new Event('resize'));
    await settle();
    await expect(bridge().hintsWait(50)).resolves.toEqual([{ n: 1, x: 24, y: 600, width: 280, height: 110 }]);
  });

  it('finds its element again by its path when the page renders it anew', async () => {
    document.body.innerHTML = '<ul><li>one</li><li>two</li></ul>';
    boxed(document.querySelectorAll('li')[1], { left: 10, top: 100, width: 50, height: 20 });
    bridge().hints([{ n: 1, left: 10, top: 100, width: 50, height: 20, note: 'Here', path: 'body > ul > li:nth-of-type(2)' }]);
    // The list is rendered again: a new node in the same place.
    document.body.innerHTML = '<ul><li>one</li><li>two</li></ul>';
    boxed(document.querySelectorAll('li')[1], { left: 10, top: 180, width: 50, height: 20 });
    window.dispatchEvent(new Event('resize'));
    await settle();
    expect(hintRoot().querySelector<HTMLElement>('.box')!.style.top).toBe('180px');
  });
});

