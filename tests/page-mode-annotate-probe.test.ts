// @vitest-environment jsdom
// Annotate, the half that lives in the page: criteria A1, A5, A7, A8 against the
// real PAGE_MODE_PROBE. Tests titled [RISC] pin current behaviour that is worth a
// decision; they are not claims that the behaviour is wanted.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PAGE_MODE_PROBE, probeCall } from '../src/main/browser/page-mode-probe';
import { parseProbeAnnotations, parseProbeBatch } from '../src/shared/page-mode-format';

interface Bridge {
  arm(kind: string, armId: string): boolean;
  disarm(armId?: string): boolean;
  wait(armId: string, ms: number): Promise<unknown>;
  beforeShot(): Promise<{ viewport: { w: number; h: number }; extra: unknown }>;
  afterShot(): boolean;
  call(kind: string, method: string, args: unknown[]): unknown;
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
const click = (target: EventTarget, x: number, y: number) =>
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y }));
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
    expect(bridge().call('annotate', 'setAt', [1, 'X', null])).toBeNull();
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
      const top = this === nodes[1] ? 5000 : 10;
      return { left: 10, top, right: 10, bottom: top, width: 0, height: 0 } as DOMRect;
    });
    const shot = await bridge().beforeShot();
    expect(nodes[0].style.opacity).toBe('');
    expect(nodes[2].style.opacity).toBe('0');
    expect((markerRoot().host as HTMLElement).style.visibility).toBe('');
    expect((shot.extra as { marks: Array<{ n: number; inView: boolean }> }).marks.map(m => [m.n, m.inView])).toEqual([[1, true], [2, false]]);
    bridge().afterShot();
    expect(nodes[2].style.opacity).toBe('');
  });

  it('setAt: refuses non-strings, and a marker already deleted', async () => {
    document.body.innerHTML = '<p id="p">text</p>';
    const p = document.getElementById('p')!;
    bridge().arm('annotate', 'setat');
    note(p, 20, 200, 'one');
    const call = (args: unknown[]) => run(probeCall('call', ['annotate', 'setAt', args]));
    expect(call([1, '', null])).toBe(false);
    expect(call([1, 42, null])).toBe(false);
    expect(call([99, 'Card', null])).toBe(false);
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
    expect(run(probeCall('call', ['annotate', 'setAt', [1, 'Card', { evil: true }]]))).toBe(true);
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

  it('[RISC] setAt carries no armId: after a re-arm, a late setAt for #1 lands on the NEW #1 (main alone prevents it)', async () => {
    document.body.innerHTML = '<p id="p">text</p>';
    const p = document.getElementById('p')!;
    bridge().arm('annotate', 'r-old');
    note(p, 20, 200, 'old note');
    bridge().disarm('r-old');
    bridge().arm('annotate', 'r-new');
    note(p, 20, 200, 'new note');
    expect(run(probeCall('call', ['annotate', 'setAt', [1, 'StaleFromOldArming', null]]))).toBe(true);
    expect((await shotMarks())[0].at).toBe('StaleFromOldArming <p>');
  });

  it('[RISC] untrusted (page-dispatched) clicks drop markers too — the probe never checks isTrusted', () => {
    document.body.innerHTML = '<p id="p">text</p>';
    bridge().arm('annotate', 'untrusted');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    expect(event.isTrusted).toBe(false);
    document.getElementById('p')!.dispatchEvent(event);
    expect(markerRoot().querySelectorAll('.mark')).toHaveLength(1);
  });

  it('[RISC] a page that detaches or hides the marker layer still gets its pins reported inView (not in the picture)', async () => {
    document.body.innerHTML = '<p id="p">text</p>';
    bridge().arm('annotate', 'detached');
    note(document.getElementById('p')!, 20, 200, 'visible?');
    const host = document.querySelector<HTMLElement>('[data-hello-annotations]')!;
    host.remove(); // page script: document.querySelector('[data-hello-annotations]').remove()
    // A detached node measures 0,0,0,0 in Chromium too — which passes the inView test.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } as DOMRect);
    const [mark] = await shotMarks();
    expect(host.isConnected).toBe(false);
    expect(mark.inView).toBe(true);
  });

  it('[RISC] mousedown inside the open note is preventDefault-ed (inOverlay knows only the Design overlay) — no caret placement or text selection by mouse', () => {
    document.body.innerHTML = '<p id="p">text</p>';
    bridge().arm('annotate', 'mousedown');
    click(document.getElementById('p')!, 20, 200);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true });
    pendingInput()!.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it('[RISC] keyup/keypress from typing a note reach the page’s own document listeners (site hotkeys)', () => {
    document.body.innerHTML = '<p id="p">text</p>';
    bridge().arm('annotate', 'keys');
    click(document.getElementById('p')!, 20, 200);
    const seen: string[] = [];
    const onKey = (event: Event) => seen.push(event.type);
    document.addEventListener('keyup', onKey);
    window.addEventListener('keydown', onKey, true);
    const input = pendingInput()!;
    key(input, { key: 'k' });
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'k', bubbles: true, composed: true }));
    document.removeEventListener('keyup', onKey);
    window.removeEventListener('keydown', onKey, true);
    expect(seen).toEqual(['keydown', 'keyup']);
  });
});
