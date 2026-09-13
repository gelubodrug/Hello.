// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { PAGE_MODE_PROBE, fiberProbe, probeCall } from '../src/main/browser/page-mode-probe';
import { parseProbeBatch } from '../src/shared/page-mode-format';
import { dispatchTrusted } from './trusted-event';

interface Bridge {
  arm(kind: string, armId: string): boolean;
  disarm(armId?: string): boolean;
  release(armId: string): boolean;
  wait(armId: string, ms: number): Promise<unknown>;
  beforeShot(): Promise<{ viewport: { w: number; h: number } }>;
  afterShot(): boolean;
  kinds(): string[];
}
const run = (code: string): unknown => (0, eval)(code);
const bridge = () => (window as unknown as { __HELLO_PAGE_MODE__?: Bridge }).__HELLO_PAGE_MODE__!;

describe('page mode probe', () => {
  afterEach(() => {
    (window as unknown as { __HELLO_PAGE_MODE__?: Bridge }).__HELLO_PAGE_MODE__?.disarm();
    document.body.innerHTML = '';
  });

  it('installs once and knows only the kinds it implements', () => {
    expect(run(PAGE_MODE_PROBE)).toBe(true);
    expect(run(PAGE_MODE_PROBE)).toBe(true);
    expect(bridge().kinds()).toEqual(['design', 'annotate']);
    expect(bridge().arm('sketch', 'a1')).toBe(false);
    expect(run(probeCall('arm', ['design', 'a2'], 'false'))).toBe(true);
  });

  it('swallows the click, reports the pick, and ends it on a click away', async () => {
    run(PAGE_MODE_PROBE);
    document.body.innerHTML = '<main><section id="card"><button class="primary big">Save   changes</button><p>other</p></section></main>';
    const button = document.querySelector('button')!;
    let pageSawClick = false;
    button.addEventListener('click', () => { pageSawClick = true; });
    expect(bridge().arm('design', 'arm-1')).toBe(true);
    expect(document.querySelector('[data-hello-page-mode]')).not.toBeNull();

    dispatchTrusted(button, new MouseEvent('mousemove', { bubbles: true }));
    dispatchTrusted(button, new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 12, clientY: 9 }));
    expect(pageSawClick).toBe(false);

    const batch = parseProbeBatch(await bridge().wait('arm-1', 50));
    expect(batch?.events.map(event => event.type)).toEqual(['hover', 'pick']);
    const pick = batch!.events[1];
    expect(pick).toMatchObject({ type: 'pick', tag: 'button', selector: '#card > button', text: 'Save changes', dom: 'main > section#card > button.primary.big', point: { x: 12, y: 9 } });
    const token = (pick as { token: string }).token;
    expect(button.getAttribute('data-hello-pick')).toBe(token);

    // Another arming's wait gets nothing.
    expect(await bridge().wait('someone-else', 50)).toBeNull();

    dispatchTrusted(document.querySelector('p')!, new MouseEvent('click', { bubbles: true, cancelable: true }));
    const after = parseProbeBatch(await bridge().wait('arm-1', 50));
    expect(after?.events[0]).toEqual({ type: 'released' });
    expect(button.hasAttribute('data-hello-pick')).toBe(false);
  });

  it('answers a waiting main at once, and a late disarm cannot end a newer arming', async () => {
    run(PAGE_MODE_PROBE);
    document.body.innerHTML = '<a href="#x">link</a>';
    bridge().arm('design', 'old');
    bridge().arm('design', 'new');
    expect(bridge().disarm('old')).toBe(false);
    const waiting = bridge().wait('new', 5000);
    const started = Date.now();
    dispatchTrusted(document.querySelector('a')!, new MouseEvent('click', { bubbles: true, cancelable: true }));
    const batch = parseProbeBatch(await waiting);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(batch?.events.some(event => event.type === 'pick')).toBe(true);
    expect(bridge().disarm('new')).toBe(true);
    expect(document.querySelector('[data-hello-page-mode]')).toBeNull();
    expect(await bridge().wait('new', 50)).toBeNull();
  });

  it('leaves a script-made click, move and press to the page: no pick, no highlight, nothing swallowed', async () => {
    run(PAGE_MODE_PROBE);
    document.body.innerHTML = '<button>Save</button>';
    const button = document.querySelector('button')!;
    const seen: string[] = [];
    for (const type of ['mousedown', 'click']) button.addEventListener(type, () => seen.push(type));
    bridge().arm('design', 'scripted');
    button.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button.dispatchEvent(down);
    button.click();
    expect(seen).toEqual(['mousedown', 'click']);
    expect(down.defaultPrevented).toBe(false);
    expect(parseProbeBatch(await bridge().wait('scripted', 50))?.events).toEqual([]);
    expect(button.hasAttribute('data-hello-pick')).toBe(false);
  });

  it('hides its overlay for a picture and gives it back', async () => {
    run(PAGE_MODE_PROBE);
    bridge().arm('design', 'shot');
    const host = document.querySelector<HTMLElement>('[data-hello-page-mode]')!;
    const shot = await bridge().beforeShot();
    expect(shot.viewport.w).toBeGreaterThan(0);
    expect(host.style.getPropertyValue('visibility')).toBe('hidden');
    bridge().afterShot();
    expect(host.style.getPropertyValue('visibility')).toBe('');
  });

  it('reads the component trail and source line from the page world, once', () => {
    document.body.innerHTML = '<button data-hello-pick="tok123">Go</button>';
    const button = document.querySelector('button')! as unknown as Record<string, unknown>;
    function Button() {}
    function SidebarPanel() {}
    button['__reactFiber$xyz'] = {
      type: Button,
      _debugSource: { fileName: '/Users/me/app/src/ui/Button.tsx', lineNumber: 12, columnNumber: 3 },
      return: { type: 'div', return: { type: SidebarPanel } },
    };
    expect(run(fiberProbe('tok123'))).toEqual({ component: 'SidebarPanel › Button', file: 'src/ui/Button.tsx:12:3' });
    expect(document.querySelector('button')!.hasAttribute('data-hello-pick')).toBe(false);
    expect(run(fiberProbe('tok123'))).toBeNull();
    expect(() => fiberProbe('"); alert(1); ("')).toThrow();
    expect(() => probeCall('arm(1);x')).toThrow();
  });
});
