// @vitest-environment jsdom
// The page scripts behind browser_click, browser_type and browser_read, run
// against a real DOM: an element is named by the words on it, not only by CSS.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ANNOTATION_ID, ERASE_SCRIPT, FRAME_BOXES_SCRIPT, READ_CONTROLS, READ_HEADER, boxScript, hitScript, locateScript, matchesUrl, pageScriptError, scanScript, typeScript, waitScript } from '../src/main/browser/agent-target';

// jsdom lays nothing out: here an element is as big as its data-box says and
// invisible without one — the same visibility test the scripts apply.
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const [x, y, width, height] = (this.getAttribute('data-box') ?? '0,0,0,0').split(',').map(Number);
    return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect;
  };
  const scope = globalThis as { CSS?: { escape(value: string): string } };
  if (!scope.CSS) scope.CSS = { escape: value => value };
});
afterEach(() => { document.body.innerHTML = ''; });

const run = (script: string) => (0, eval)(script) as string & Record<string, unknown>;
const scan = (start = 1, offset = { x: 0, y: 0 }, draw = false) => run(scanScript({ start, offset, draw })) as unknown as { text: string; lines: string[]; count: number; note: string };
const clicks: string[] = [];
function page(html: string) {
  document.body.innerHTML = html;
  clicks.length = 0;
  document.querySelectorAll('[data-box]').forEach(el =>
    el.addEventListener('click', () => clicks.push(el.id || el.tagName.toLowerCase())));
}

describe('an element named by its words, its ref or a selector', () => {
  it('locates the one control whose words match, case and spacing folded, at its centre', () => {
    page(`<button data-box="10,10,80,30">Keyboard shortcuts</button>
      <button id="enable" data-box="20,300,90,36" aria-label="enable this API">Enable</button>
      <button data-box="120,300,90,36" aria-label="try this API, with an external link">Try this API</button>`);
    expect(run(locateScript({ label: 'Enable This  API' }))).toEqual({ what: 'button "enable this API"', x: 65, y: 318 });
    // The click itself is main's: nothing was dispatched in the page.
    expect(clicks).toEqual([]);
  });

  it('prefers the exact match over one that merely contains the words', () => {
    page('<button id="a" data-box="0,0,50,20">Enable</button><button id="b" data-box="0,40,50,20">Enable billing</button>');
    expect(run(locateScript({ label: 'enable' }))).toEqual({ what: 'button "Enable"', x: 25, y: 10 });
  });

  it('falls back to containing words, and lists the candidates when several remain', () => {
    page('<a id="x" href="#" data-box="0,0,50,20">Open settings</a><button id="y" data-box="0,40,50,20">Settings menu</button>');
    expect(() => run(locateScript({ label: 'settings' }))).toThrow(
      '2 visible elements show "settings": 0: link "Open settings"; 1: button "Settings menu". Say which with label, a narrower selector, or nth.',
    );
    expect(run(locateScript({ label: 'settings', nth: 1 }))).toMatchObject({ what: 'button "Settings menu"', x: 25, y: 50 });
    expect(run(locateScript({ label: 'settings', selector: 'a' }))).toMatchObject({ what: 'link "Open settings"' });
    expect(() => run(locateScript({ label: 'settings', nth: 2 }))).toThrow('nth 2 is out of range: only 2 visible elements show "settings".');
  });

  it('ignores what is not visible', () => {
    page('<button id="hidden">Enable</button><button id="shown" data-box="0,0,50,20">Enable</button>');
    expect(run(locateScript({ label: 'Enable' }))).toMatchObject({ what: 'button "Enable"', x: 25, y: 10 });
    expect(() => run(locateScript({ label: 'Disable' }))).toThrow(
      'No visible element shows "Disable". browser_read lists the visible controls with their words.',
    );
  });

  it('names Playwright syntax for what it is instead of leaking a SyntaxError', () => {
    page('<button data-box="0,0,50,20">Enable</button>');
    expect(() => run(locateScript({ selector: 'button:has-text("Enable")' }))).toThrow(
      '"button:has-text(\\"Enable\\")" is not a CSS selector (Playwright syntax such as :has-text() is not CSS). To pick an element by the words on it, give label instead.',
    );
  });

  it('a bare selector still needs exactly one visible match, and says who matched', () => {
    page('<button id="a" data-box="0,0,50,20">One</button><button id="b" data-box="0,30,50,20">Two</button>');
    expect(() => run(locateScript({ selector: 'button' }))).toThrow('2 visible elements matching "button" match: 0: button "One"; 1: button "Two".');
    expect(() => run(locateScript({ selector: '#nothing' }))).toThrow('No visible element matches "#nothing". browser_read lists the visible controls.');
    expect(run(locateScript({ selector: '#b' }))).toMatchObject({ what: 'button "Two"' });
  });

  // agent-browser's way: a snapshot hands out refs, a click takes one — so a
  // "⋮" button with no words is still a thing the model can name (user,
  // 24.09: pixels guessed from an old read hit the row below).
  it('finds a control by the ref the latest read gave it, and refuses a ref that is stale or invented', () => {
    page('<button data-box="0,0,40,40" aria-label="menu"></button><button id="dots" data-box="0,50,40,40"></button><a id="pay" href="/pay" data-box="0,100,80,20">Pay invoice</a>');
    scan();
    expect(run(locateScript({ ref: 'e2' }))).toEqual({ what: 'button ""', x: 20, y: 70 });
    expect(run(locateScript({ ref: 'E3' }))).toMatchObject({ what: 'link "Pay invoice"' });
    expect(() => run(locateScript({ ref: 'e9' }))).toThrow('Ref "e9" is not from the latest browser_read of this page. Read the page again and use a current ref.');
    // Refs run on across frames: a frame scanned from e7 answers to e8, not e2.
    expect(scan(7).lines[1]).toMatch(/^e8 button ""/);
    expect(run(locateScript({ ref: 'e8' }))).toEqual({ what: 'button ""', x: 20, y: 70 });
    expect(() => run(locateScript({ ref: 'e2' }))).toThrow(/not from the latest browser_read/);
    scan();
    document.getElementById('dots')!.remove();
    expect(() => run(locateScript({ ref: 'e2' }))).toThrow('Ref e2 (button "") is gone or hidden now. Read the page again.');
  });

  it('says what covers the centre, and clicks the control directly then', () => {
    page('<button id="under" data-box="0,0,50,20">Download</button><div id="over" data-box="0,0,300,300">Request billing support</div>');
    const over = document.getElementById('over')!;
    (document as Document & { elementFromPoint(x: number, y: number): Element | null }).elementFromPoint = () => over;
    try {
      expect(run(locateScript({ label: 'Download' }))).toEqual({ what: 'button "Download"', x: 25, y: 10, covered: 'div "Request billing support"' });
      expect(clicks).toEqual(['under']);
    } finally {
      delete (document as Partial<Document>).elementFromPoint;
    }
  });
});

describe('a field named by its label', () => {
  it('fills the field whose <label> or placeholder says so, and tells frameworks', () => {
    page('<label for="name">Your name</label><input id="name" data-box="0,0,100,20"><input placeholder="Search" data-box="0,30,100,20">');
    const events: string[] = [];
    const name = document.getElementById('name') as HTMLInputElement;
    name.addEventListener('input', () => events.push('input'));
    name.addEventListener('change', () => events.push('change'));
    expect(run(typeScript({ label: 'your name' }, 'Ada'))).toBe('Entered text into textbox "Your name".');
    expect(name.value).toBe('Ada');
    expect(events).toEqual(['input', 'change']);
    expect(run(typeScript({ label: 'search' }, 'globe'))).toBe('Entered text into textbox "Search".');
  });

  it('chooses a <select> option by its text or value, and lists the options otherwise', () => {
    page('<select aria-label="Plan" data-box="0,0,100,20"><option value="free">Free</option><option value="pro">Pro plan</option></select>');
    const select = document.querySelector('select')!;
    const events: string[] = [];
    select.addEventListener('change', () => events.push('change'));
    expect(run(typeScript({ label: 'Plan' }, 'pro plan'))).toBe('Chose "Pro plan" in combobox "Plan".');
    expect(select.value).toBe('pro');
    expect(events).toEqual(['change']);
    expect(run(typeScript({ label: 'Plan' }, 'FREE'))).toBe('Chose "Free" in combobox "Plan".');
    expect(() => run(typeScript({ label: 'Plan' }, 'team'))).toThrow('combobox "Plan" has no option "team"; its options are "Free", "Pro plan".');
  });

  it('refuses a password field and a non-field', () => {
    page('<input type="password" aria-label="Password" data-box="0,0,100,20"><button data-box="0,30,50,20">Go</button>');
    expect(() => run(typeScript({ label: 'Password' }, 'x'))).toThrow(/Sensitive fields/);
    expect(() => run(typeScript({ label: 'Go' }, 'x'))).toThrow('button "Go" is not a text field.');
  });

  it('writes into an editable region, which is a textbox too', () => {
    page('<div id="note" contenteditable="true" aria-label="Note" data-box="0,0,200,40"></div>');
    const note = document.getElementById('note')!;
    Object.defineProperty(note, 'isContentEditable', { value: true });
    const events: string[] = [];
    note.addEventListener('input', () => events.push('input'));
    expect(run(typeScript({ label: 'Note' }, 'Paid today'))).toBe('Entered text into textbox "Note".');
    expect(note.textContent).toBe('Paid today');
    expect(events).toEqual(['input']);
  });
});

describe('browser_read lists controls with a ref, a role, their words, state and centre', () => {
  it('gives each visible control a ref, its role, words, state and centre in CSS px, and the header says how to use them', () => {
    page(`<p>Hello there</p>
      <button id="enable" data-box="20,300,90,36" aria-label="enable this API">Enable</button>
      <a href="/x">unseen</a>
      <input name="q" placeholder="Search" data-box="200,10,300,30">
      <input type="checkbox" aria-label="Remember me" checked data-box="0,50,20,20">
      <a href="/pay?x=1" data-box="0,80,80,20">Pay invoice</a>
      <button aria-expanded="true" disabled data-box="0,110,40,20">More</button>
      <select aria-label="Plan" data-box="0,140,100,20"><option>Free</option><option selected>Pro</option></select>`);
    const result = scan();
    expect(result.text).toContain('Hello there');
    expect(result.count).toBe(6);
    expect(result.lines).toEqual([
      'e1 button "enable this API" @ (65, 318)',
      'e2 textbox "Search" (empty) @ (350, 25)',
      'e3 checkbox "Remember me" (checked) @ (10, 60)',
      'e4 link "Pay invoice" (→ /pay?x=1) @ (40, 90)',
      'e5 button "More" (disabled, expanded) @ (20, 120)',
      'e6 combobox "Plan" (= "Pro") @ (50, 150)',
    ]);
    expect(READ_HEADER).toContain('browser_click ref: "e3" clicks one');
    expect(READ_HEADER).toContain('browser_pointer aims at (x, y)');
    expect(READ_HEADER).toContain('after a click that opened or changed something, read again');
    // A frame's centres are moved to where the frame sits on the page.
    expect(scan(1, { x: 100, y: 200 }).lines[0]).toBe('e1 button "enable this API" @ (165, 518)');
    // Another site's link keeps its scheme and whole path; one too long to list
    // is visibly shortened, never silently cut into an address that 404s.
    page(`<a href="https://blog.conan.io/cpp/conan/gamedev/godot/cmake/2026/09/29/Using-Any-Cpp-Library-In-Godot.html" data-box="0,0,80,20">Godot</a>
      <a href="https://example.com/${'a'.repeat(200)}/end.html" data-box="0,30,80,20">Long</a>`);
    const links = scan().lines;
    expect(links[0]).toBe('e1 link "Godot" (→ https://blog.conan.io/cpp/conan/gamedev/godot/cmake/2026/09/29/Using-Any-Cpp-Library-In-Godot.html) @ (40, 10)');
    expect(links[1]).toMatch(/→ https:\/\/example\.com\/a+…a+\/end\.html\)/);
  });

  // agent-browser's --annotate: the refs written on the page for the picture,
  // and taken off after (user, 24.09).
  it('writes each ref on the page for an annotated screenshot, and erases them', () => {
    page('<button id="a" data-box="20,300,90,36">One</button><button id="b" data-box="120,300,90,36">Two</button>');
    const result = scan(4, { x: 0, y: 0 }, true);
    expect(result.lines).toEqual(['e4 button "One" @ (65, 318)', 'e5 button "Two" @ (165, 318)']);
    const layer = document.getElementById(ANNOTATION_ID)!;
    expect([...layer.children].map(tag => tag.textContent)).toEqual(['e4', 'e5']);
    expect((layer.children[1] as HTMLElement).getAttribute('style')).toContain('left:120px;top:288px');
    // Scanned again without draw: the old overlay goes, none comes.
    scan();
    expect(document.getElementById(ANNOTATION_ID)).toBeNull();
    scan(1, { x: 0, y: 0 }, true);
    expect(run(ERASE_SCRIPT)).toBe(true);
    expect(document.getElementById(ANNOTATION_ID)).toBeNull();
  });

  it('lists a frame’s child frames by name, address and box, and waits for words, a control or an address', () => {
    page('<iframe name="pay" src="https://js.stripe.com/v3/elements" data-box="100,200,300,100"></iframe><iframe src="about:blank"></iframe><p>Invoice   paid</p><button data-box="0,0,50,20">Done</button>');
    expect(run(FRAME_BOXES_SCRIPT)).toEqual([{ name: 'pay', src: 'https://js.stripe.com/v3/elements', x: 100, y: 200, width: 300, height: 100 }]);
    expect(run(waitScript({ text: 'invoice PAID' }))).toBe(true);
    expect(run(waitScript({ text: 'refunded' }))).toBe(false);
    expect(run(waitScript({ target: { label: 'done' } }))).toBe(true);
    expect(run(waitScript({ target: { label: 'Cancel' } }))).toBe(false);
    expect(run(waitScript({ target: { ref: 'e9' } }))).toBe(false);
    expect(matchesUrl('https://checkout.stripe.com/c/pay/cs_123/done', '/done')).toBe(true);
    expect(matchesUrl('https://checkout.stripe.com/c/pay/cs_123/done', 'https://*.stripe.com/*/done')).toBe(true);
    expect(matchesUrl('https://checkout.stripe.com/c/pay/cs_123', 'https://*.stripe.com/*/done')).toBe(false);
    expect(matchesUrl('https://example.test/a.b', 'a.b')).toBe(true);
    expect(matchesUrl('https://example.test/', '')).toBe(false);
  });
});

// The read was 120 controls of the page behind ChatGPT's settings dialog —
// the sidebar and 28 chats — and none of the dialog's; the model invented a
// ref, then guessed a point (user, 24.09: "asta e controlul browserului? mi
// se pare o glumă"). A read is what a person could use now, like an
// accessibility tree: the dialog on top, what is on screen first.
describe('what a read lists when a dialog is open, and in what order', () => {
  const settings = `
    <nav><a href="/projects" data-box="0,140,200,30">Projects</a><button data-box="0,180,200,30">New chat</button></nav>
    <div role="dialog" aria-modal="true" aria-label="Settings" data-box="300,100,600,500">
      <button aria-label="Close" data-box="310,110,30,30"></button>
      <button role="tab" data-box="310,200,200,30">General</button>
      <button role="tab" data-box="310,400,200,30">Billing</button>
      <p>Secure your account</p>
    </div>`;

  it('lists only the dialog’s controls and words, and says the page behind takes no clicks', () => {
    page(settings);
    const result = scan();
    expect(result.lines).toEqual([
      'e1 button "Close" @ (325, 125)',
      'e2 tab "General" @ (410, 215)',
      'e3 tab "Billing" @ (410, 415)',
    ]);
    expect(result.text).toMatch(/^\[A dialog "Settings" is open over the page\. Only it takes clicks now, and only its controls are listed\. Close it \(its close button, or browser_press Escape\) to reach the page behind\.\]/);
    expect(result.text).toContain('Secure your account');
    expect(result.text).not.toContain('Projects');
    expect(result.note).toBe('2 controls of the page behind the open dialog "Settings" are not listed: nothing behind it takes a click while it is open.');
    // By its words, the dialog's; behind it, said so — not clicked through the dialog.
    expect(run(locateScript({ label: 'Billing' }))).toMatchObject({ what: 'tab "Billing"', x: 410, y: 415 });
    expect(() => run(locateScript({ label: 'Projects' }))).toThrow(
      'link "Projects" is behind the open dialog "Settings", which takes every click now. Close the dialog first (its close button, or browser_press Escape), then click it.');
  });

  it('refuses a ref from before the dialog opened, and lets the words decide when a ref no longer holds', () => {
    page('<a href="/projects" data-box="0,140,200,30">Projects</a>');
    scan();
    document.body.insertAdjacentHTML('beforeend', '<div role="dialog" aria-modal="true" aria-label="Settings" data-box="300,100,600,500"><button role="tab" data-box="310,400,200,30">Billing</button></div>');
    expect(() => run(locateScript({ ref: 'e1' }))).toThrow('Ref e1 (link "Projects") is behind the open dialog "Settings", which takes every click now. Close the dialog first (its close button, or browser_press Escape).');
    // The model's invented ref, with the words it meant: the words decide.
    expect(run(locateScript({ ref: 'e121', label: 'Billing' }))).toMatchObject({ what: 'tab "Billing"' });
    // A ref that is another control than the words say: the words decide too.
    document.querySelector('[role="dialog"]')!.insertAdjacentHTML('afterbegin', '<button role="tab" data-box="310,200,200,30">General</button>');
    expect(scan().lines.map(line => line.split(' @')[0])).toEqual(['e1 tab "General"', 'e2 tab "Billing"']);
    expect(run(locateScript({ ref: 'e1', label: 'Billing' }))).toMatchObject({ what: 'tab "Billing"' });
    expect(run(locateScript({ ref: 'e1' }))).toMatchObject({ what: 'tab "General"' });
    expect(() => run(locateScript({ ref: 'e9' }))).toThrow(/not from the latest browser_read/);
  });

  it('leaves out a background hidden from use while a dialog is open, as Radix does it', () => {
    page(`<div aria-hidden="true"><a href="/projects" data-box="0,140,200,30">Projects</a></div>
      <div role="dialog" data-box="300,100,600,500"><button data-box="310,400,200,30">Billing</button></div>`);
    expect(scan().lines).toEqual(['e1 button "Billing" @ (410, 415)']);
    expect(() => run(locateScript({ label: 'Projects' }))).toThrow(/No visible element shows "Projects"/);
    // A page that hides everything, its controls too, has misused aria-hidden: they are listed.
    page('<main aria-hidden="true"><button data-box="0,0,50,20">Pay</button></main>');
    expect(scan().lines).toEqual(['e1 button "Pay" @ (25, 10)']);
  });

  it('lists what is on screen first, then what needs a scroll, then what shows on hover, and counts what did not fit', () => {
    page(`<button data-box="0,2000,50,20">Far</button>
      <div style="opacity:0"><button data-box="0,0,50,20">Pin</button></div>
      <button data-box="0,40,50,20">Near</button>`);
    expect(scan().lines).toEqual([
      'e1 button "Near" @ (25, 50)',
      'e2 button "Far" (off screen, below) @ (25, 2010)',
      'e3 button "Pin" (shows on hover) @ (25, 10)',
    ]);
    page(Array.from({ length: READ_CONTROLS + 5 }, (_, index) => `<button data-box="0,${index * 30},50,20">B${index}</button>`).join(''));
    const crowded = scan();
    expect(crowded.count).toBe(READ_CONTROLS);
    expect(crowded.note).toBe('5 more controls are not listed — the ones further off screen or covered. Name one by label, or scroll to it and read again.');
  });

  it('says what a point is on, and the ref of the control it belongs to', () => {
    page('<button data-box="0,0,40,40" aria-label="menu"></button><button id="billing" data-box="0,50,120,40"><span id="inside">Billing</span></button>');
    scan();
    const inside = document.getElementById('inside')!;
    (document as Document & { elementFromPoint(x: number, y: number): Element | null }).elementFromPoint = () => inside;
    try {
      expect(run(hitScript(60, 70))).toEqual({ what: 'button "Billing"', ref: 'e2', control: true });
      (document as Document & { elementFromPoint(x: number, y: number): Element | null }).elementFromPoint = () => document.body;
      expect(run(hitScript(500, 500))).toMatchObject({ control: false, ref: '' });
    } finally {
      delete (document as Partial<Document>).elementFromPoint;
    }
  });
});

describe('what a page script’s exception says', () => {
  it('keeps its words and drops the stack of Hello’s injected script', () => {
    const thrown = new Error('Error: No visible element shows "Decline All". browser_read lists the visible controls with their words.\n    at find (<anonymous>:147:28)\n    at <anonymous>:158:12\n    at <anonymous>:170:3');
    expect((pageScriptError(thrown) as Error).message).toBe('No visible element shows "Decline All". browser_read lists the visible controls with their words.');
    // As Electron hands it over — the stack as text, not an Error — it becomes one, with its words.
    const handed = pageScriptError('Error: No visible element shows "Apple iPad Air 11 M4". browser_read lists the visible controls with their words.\n    at find (<anonymous>:167:28)\n    at <anonymous>:3:12');
    expect(handed).toBeInstanceOf(Error);
    expect((handed as Error).message).toBe('No visible element shows "Apple iPad Air 11 M4". browser_read lists the visible controls with their words.');
    // Anything else is left exactly as it was.
    const navigation = new Error('ERR_ABORTED (-3) loading https://example.test/');
    expect(pageScriptError(navigation)).toBe(navigation);
    expect((pageScriptError('text') as Error).message).toBe('text');
    expect(pageScriptError(undefined)).toBeUndefined();
  });
});

describe('where a mark goes', () => {
  it('measures the element it names without touching it, and scrolls to it only when asked', async () => {
    page('<a id="cheap" href="/itm/1" data-box="40,1300,320,90">Apple Mac Studio M3 Ultra</a>');
    let scrolled = 0;
    document.getElementById('cheap')!.scrollIntoView = () => { scrolled += 1; };
    expect(await run(boxScript({ label: 'apple mac studio m3 ultra' }))).toEqual({
      what: 'link "Apple Mac Studio M3 Ultra"', left: 40, top: 1300, width: 320, height: 90, inView: false, path: '#cheap',
    });
    expect([scrolled, clicks]).toEqual([0, []]);
    await run(boxScript({ label: 'apple mac studio m3 ultra' }, true));
    expect(scrolled).toBe(1);
    expect(clicks).toEqual([]);
  });

  it('names the element itself by a path that finds it again, not a place on the screen', async () => {
    page(`<main><ul><li><a href="/itm/1" data-box="40,300,320,90">First listing</a></li>
      <li><a href="/itm/2" data-box="40,420,320,90">Second listing</a></li></ul></main>`);
    const { path } = await run(boxScript({ label: 'second listing' })) as unknown as { path: string };
    expect(path).toBe('body > main > ul > li:nth-of-type(2) > a');
    expect(document.querySelector(path)?.textContent).toBe('Second listing');
  });
});

// What Hello calls visible is what the person can see (user, 30.09: a nav for
// screen readers repeated the cards' names, the marks went on it, and the
// cards' own links — inline, no width of their own — counted as not there).
describe('visible as the person sees it', () => {
  it('leaves out what a screen-reader-only block or a closed menu clips away', async () => {
    page(`<nav style="position:absolute;overflow:hidden" data-box="0,0,1,1"><a id="hidden" href="/skills/emil" data-box="0,169,177,21">Emil Design Engineering</a></nav>
      <div style="overflow:hidden" data-box="0,40,300,0"><button id="menu" data-box="0,40,120,30">Emil Design Engineering</button></div>
      <a id="card" href="/skills/emil" data-box="40,2600,320,400">Featured Emil Design Engineering by Emil Kowalski</a>`);
    // The card is the one visible element with those words.
    const read = scan();
    expect(read.lines.some(line => line.includes('#hidden') || line.includes('"Emil Design Engineering"'))).toBe(false);
    expect(await run(boxScript({ label: 'emil design engineering' }))).toMatchObject({ what: expect.stringContaining('Featured Emil Design Engineering') });
  });

  it('measures a link around a whole card by its content', async () => {
    page('<a id="card" href="/skills/taste" data-box="33,2207,0,401"><div data-box="0,2207,167,550">Featured Taste Skill</div></a>');
    const range = Range.prototype as unknown as { getBoundingClientRect?: () => DOMRect };
    const had = range.getBoundingClientRect;
    range.getBoundingClientRect = function () { return { x: 0, y: 2207, left: 0, top: 2207, width: 167, height: 550, right: 167, bottom: 2757, toJSON: () => ({}) } as DOMRect; };
    try {
      expect(await run(boxScript({ label: 'featured taste skill' }))).toMatchObject({ left: 0, top: 2207, width: 167, height: 550 });
    } finally {
      if (had) range.getBoundingClientRect = had; else delete range.getBoundingClientRect;
    }
  });

  it('says when what it names moves by itself', async () => {
    page('<a id="ticker" href="/skills/emil" data-box="600,110,177,21">Emil Design Engineering</a>');
    const ticker = document.getElementById('ticker')!;
    let calls = 0;
    ticker.getBoundingClientRect = () => { const left = 600 - 40 * calls++; return { x: left, y: 110, left, top: 110, width: 177, height: 21, right: left + 177, bottom: 131, toJSON: () => ({}) } as DOMRect; };
    expect(await run(boxScript({ label: 'emil design engineering' }))).toMatchObject({ moving: true });
  });
});

