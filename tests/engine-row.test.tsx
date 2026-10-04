// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Cpu } from 'lucide-react';

vi.mock('../src/renderer/api', () => ({ api: {} }));
import { EngineRow } from '../src/renderer/EngineRow';

// User, 01.10: "DSH v.xxx (update) jos în bară … update dacă există versiune
// nouă, dacă nu, nu … la fel și pentru Pi".
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const onUpdate = vi.fn();
const onBack = vi.fn();
const render = (props: Partial<Parameters<typeof EngineRow>[0]>) =>
  act(() => root.render(createElement(EngineRow, { icon: Cpu, name: 'Pi', version: '0.99.1', bundled: '0.99.1', onUpdate, onBack, ...props })));
const update = () => host.querySelector<HTMLButtonElement>('.engine-update');
const back = () => host.querySelector<HTMLButtonElement>('[aria-label^="Back to Pi"]');

describe('an engine in the footer', () => {
  it('shows the version running, and update only when npm has a newer one', () => {
    render({});
    expect(host.textContent).toContain('Pi');
    expect(host.querySelector('.engine-version')?.textContent).toBe('v0.99.1');
    expect(update()).toBeNull();
    render({ latest: '0.99.2' });
    expect(update()?.textContent).toBe('update');
    expect(update()?.title).toBe('Update Pi to v0.99.2');
    act(() => update()!.click());
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('offers the way back to the version Hello came with while an update runs', () => {
    render({});
    expect(back()).toBeNull();
    render({ version: '0.99.2' });
    expect(back()?.title).toBe('Back to v0.99.1, the Pi Hello came with');
    act(() => back()!.click());
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('spins while updating, and says why an update failed', () => {
    render({ latest: '0.99.2', updating: true });
    expect(host.querySelector('[aria-label="Updating Pi"]')).not.toBeNull();
    expect(update()).toBeNull();
    render({ latest: '0.99.2', error: 'Installing Pi 0.99.2 failed.' });
    expect(host.querySelector('.engine-version')?.getAttribute('title')).toBe('Installing Pi 0.99.2 failed.');
    expect(update()).not.toBeNull();
  });
});
