// @vitest-environment jsdom
// Invariant probes for page modes against the existing agent flows (manager.read / manager.agentAction).
import { afterEach, describe, expect, it } from 'vitest';
import { PAGE_MODE_PROBE } from '../src/main/browser/page-mode-probe';
import { parseProbeBatch } from '../src/shared/page-mode-format';

interface Bridge { arm(kind: string, armId: string): boolean; disarm(armId?: string): boolean; wait(armId: string, ms: number): Promise<unknown>; }
const bridge = () => (window as unknown as { __HELLO_PAGE_MODE__: Bridge }).__HELLO_PAGE_MODE__;
(0, eval)(PAGE_MODE_PROBE);

afterEach(() => {
  bridge().disarm();
  document.body.innerHTML = '';
});

describe('browser invariant: an armed page mode and the agent', () => {
  it('keeps its own UI out of document.body, which is what "Add page to chat" and the agent read', () => {
    document.body.innerHTML = '<p>Page words</p>';
    for (const kind of ['design', 'annotate']) {
      expect(bridge().arm(kind, `arm-${kind}`)).toBe(true);
      const ui = document.querySelector('[data-hello-page-mode]');
      expect(ui).not.toBeNull();
      expect(document.body.contains(ui)).toBe(false);
      expect(document.body.textContent).toBe('Page words');
      bridge().disarm();
    }
  });

  it('gives the page its clicks back once disarmed', () => {
    document.body.innerHTML = '<button id="save">Save</button>';
    const button = document.querySelector('button')!;
    let clicks = 0;
    button.addEventListener('click', () => { clicks += 1; });
    bridge().arm('design', 'arm-1');
    bridge().disarm('arm-1');
    button.click();
    expect(clicks).toBe(1);
  });

  // Fixed: the probe only takes the person's own (trusted) input. An agent with
  // Full runs `el.click()` (manager.agentAction): the page gets that click, and
  // it is never reported to the human as their own pick.
  it("lets a Full-control agent's scripted el.click() reach the page while Design is armed", async () => {
    document.body.innerHTML = '<button id="save">Save</button>';
    const button = document.querySelector('button')!;
    let clicks = 0;
    button.addEventListener('click', () => { clicks += 1; });
    bridge().arm('design', 'arm-2');
    // Exactly what agentAction runs in the page's main world.
    button.click();
    const batch = parseProbeBatch(await bridge().wait('arm-2', 30));
    expect(clicks).toBe(1);
    expect(batch?.events.some(event => event.type === 'pick')).toBe(false);
  });
});
