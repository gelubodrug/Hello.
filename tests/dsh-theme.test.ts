import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs script, typed by use here
import { COLOR_MAP, PLUGIN_DIR, SHAPE_MAP, buildClient, helloTheme, parseHelloTokens, tokensCss } from '../scripts/dsh-theme.mjs';

const official = JSON.parse(readFileSync(join(PLUGIN_DIR, 'official-tokens.json'), 'utf8')) as { colors: string[]; shape: string[] };
type Theme = Record<string, { light: string; dark: string }>;

describe('the Hello theme for dsh', () => {
  it('gives every token of the pinned dsh a Hello value', () => {
    const missing = official.colors.filter(name => !(name in COLOR_MAP));
    const missingShape = official.shape.filter(name => !(name in SHAPE_MAP));
    expect(missing).toEqual([]);
    expect(missingShape).toEqual([]);
  });

  it('maps no token dsh does not have', () => {
    const known = new Set([...official.colors, ...official.shape]);
    expect(Object.keys({ ...COLOR_MAP, ...SHAPE_MAP }).filter(name => !known.has(name))).toEqual([]);
  });

  it('resolves every value to plain CSS, light and dark', () => {
    const theme = helloTheme(tokensCss()) as Theme;
    for (const [name, value] of Object.entries(theme)) {
      expect(value.light, name).not.toMatch(/var\(/);
      expect(value.dark, name).not.toMatch(/var\(/);
    }
    expect(theme['--dsw-alias-bg-layer-3']).toEqual({ light: '#ffffff', dark: '#222222' });
    expect(theme['--dsw-specific-sidebar-fill']).toEqual({ light: '#f1f1f1', dark: '#111111' });
    expect(theme['--dsw-alias-label-primary']).toEqual({ light: '#262626', dark: '#e6e6e6' });
    expect(theme['--dsw-font-family'].light).toContain('Inter Variable');
    expect(theme['--dsw-radius-panel']).toEqual({ light: '16px', dark: '16px' });
  });

  it('reads the dark block over the light one', () => {
    const { light, dark } = parseHelloTokens(tokensCss());
    expect(light['surface-panel']).toBe('#fafafa');
    expect(dark['surface-panel']).toBe('#181818');
    expect(dark['sp-8']).toBe(light['sp-8']);
  });

  it('is written from the current tokens.css', () => {
    expect(readFileSync(join(PLUGIN_DIR, 'lib', 'client.js'), 'utf8')).toBe(buildClient(tokensCss()));
  });

  it('registers in dsh’s loader, overrides the tokens and fills the brand slots', () => {
    const source = readFileSync(join(PLUGIN_DIR, 'lib', 'client.js'), 'utf8');
    let loaded: { id: string; factory: (require: (name: string) => unknown) => any } | undefined;
    const appended: Array<{ textContent: string; dataset: Record<string, string> }> = [];
    const fakeWindow = { __ModuleLoader__: { load: (entry: typeof loaded) => { loaded = entry; } } };
    const fakeDocument = {
      createElement: () => ({ dataset: {} as Record<string, string>, textContent: '', remove() {} }),
      head: { append: (node: { textContent: string; dataset: Record<string, string> }) => appended.push(node) },
    };
    new Function('window', 'document', source)(fakeWindow, fakeDocument);
    expect(loaded?.id).toBe('hello-dsh');
    const plugin = loaded!.factory(name => {
      if (name === 'react/jsx-runtime') return { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: () => null };
      throw new Error(`unexpected require ${name}`);
    });
    expect(plugin.inject).toEqual(['theme', 'slots']);
    const overrides: Array<[string, Theme]> = [];
    const registered: string[] = [];
    const ctx = {
      effect: (run: () => unknown) => { run(); },
      theme: { overrideTokens: (source: string, tokens: Theme) => { overrides.push([source, tokens]); return () => {}; } },
      slots: {
        inject: (_name: string, callback: () => unknown) => {
          const result = callback();
          if (result && typeof (result as Iterator<unknown>).next === 'function') for (const _ of result as Iterable<unknown>) { /* drain */ }
        },
        register: (options: { name: string }) => { registered.push(options.name); return () => {}; },
      },
    };
    plugin.apply(ctx);
    expect(overrides[0][0]).toBe('hello');
    expect(Object.keys(overrides[0][1])).toHaveLength(official.colors.length + official.shape.length);
    expect(registered).toEqual(['sidebar.brand.mark', 'sidebar.brand.name']);
    expect(appended[0].dataset.plugin).toBe('hello-dsh/fonts');
    expect(appended[0].textContent).toContain("font-family:'Inter Variable'");
  });

  it('turns the official brand row off in its bundle patch', () => {
    const patch = readFileSync(join(PLUGIN_DIR, 'cordis.patch.yml'), 'utf8');
    expect(patch).toContain('id: ui-brand-official');
    expect(patch).toContain('disabled: true');
    expect(patch).toContain('name: hello-dsh');
  });
});
