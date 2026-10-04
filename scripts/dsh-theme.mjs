// Builds the Hello theme for dsh: assets/dsh/hello-dsh/lib/client.js.
//
// Hello's look is written once, in src/renderer/styles/tokens.css. This script
// reads it, resolves every dsh token (--dsw-*) from Hello tokens — light and
// dark — and writes a dsh client plugin, in dsh's own loader format, that
// hands the result to ctx.theme.overrideTokens('hello', …). The plugin also
// ships Hello's Inter and fills dsh's brand slots with Hello's mark and name.
//
//   node scripts/dsh-theme.mjs          write the plugin
//   node scripts/dsh-theme.mjs --check  fail when the written plugin is stale
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_DIR = join(root, 'assets', 'dsh', 'hello-dsh');

/**
 * Every dsh color token, as Hello tokens. `var(--x)` names a Hello token;
 * anything else is plain CSS the browser computes (color-mix, rgb()).
 */
export const COLOR_MAP = {
  // Surfaces: navigation < workspace < panel < raised, as in Hello.
  'dsw-alias-bg-base': 'var(--surface-workspace)',
  'dsw-alias-bg-layer-1': 'var(--surface-workspace)',
  'dsw-alias-bg-layer-2': 'var(--surface-panel)',
  'dsw-alias-bg-layer-3': 'var(--surface-raised)',
  'dsw-alias-bg-overlay': 'var(--menu-fill)',
  'dsw-alias-bg-document-preview': 'var(--surface-workspace)',
  'dsw-alias-bg-module-platform': 'var(--surface-sidebar)',
  'dsw-alias-bg-multi-select': 'var(--color-accent-subtle)',
  'dsw-alias-bg-skeleton': 'color-mix(in srgb, var(--ink-primary) 6%, transparent)',
  'dsw-alias-bg-mask-1': 'rgb(0 0 0 / 42%)',
  'dsw-alias-bg-mask-2': 'rgb(0 0 0 / 24%)',
  'dsw-alias-bg-mask-3': 'rgb(0 0 0 / 60%)',
  'dsw-alias-bg-mask-photo': 'rgb(0 0 0 / 88%)',
  'dsw-alias-bg-mask-drop': 'color-mix(in srgb, var(--surface-raised) 72%, transparent)',
  // Edges.
  'dsw-alias-border-l1': 'color-mix(in srgb, var(--surface-edge) 60%, transparent)',
  'dsw-alias-border-l2': 'var(--surface-edge)',
  'dsw-alias-border-l2-darkmode-thin': 'var(--surface-edge)',
  'dsw-alias-border-l3': 'var(--surface-edge-strong)',
  'dsw-alias-border-l4': 'var(--surface-edge-strong)',
  'dsw-alias-border-inverted': 'var(--surface-edge)',
  'dsw-alias-border-inverted2': 'var(--surface-edge)',
  // Ink.
  'dsw-alias-label-primary': 'var(--ink-primary)',
  'dsw-alias-label-secondary': 'var(--ink-secondary)',
  'dsw-alias-label-tertiary': 'var(--ink-tertiary)',
  'dsw-alias-label-caption': 'var(--ink-tertiary)',
  'dsw-alias-label-dimmed': 'var(--ink-disabled)',
  'dsw-alias-label-primary-dimmed': 'var(--ink-secondary)',
  'dsw-alias-label-primary-bluish': 'var(--color-accent)',
  'dsw-alias-label-primary-foreground': 'var(--surface-sidebar)',
  'dsw-alias-label-primary-inverted': 'var(--surface-raised)',
  'dsw-alias-label-document-preview': 'var(--ink-primary)',
  'dsw-alias-menu-icon': 'var(--ink-secondary)',
  'dsw-alias-link': 'var(--color-accent)',
  // Brand: Hello's primary is its ink, as its primary button is.
  'dsw-alias-brand-primary': 'var(--ink-primary)',
  'dsw-alias-brand-primary-invert': 'var(--surface-raised)',
  'dsw-alias-brand-text': 'var(--ink-primary)',
  'dsw-alias-brand-primary-new-colorprimary-new-color': 'var(--color-accent)',
  // Buttons.
  'dsw-alias-button-primary-fill': 'var(--ink-primary)',
  'dsw-alias-button-primary-hover': 'var(--ink-secondary)',
  'dsw-alias-button-primary-dimmed': 'var(--surface-active)',
  'dsw-alias-button-contrast-fill': 'var(--ink-secondary)',
  'dsw-alias-button-elevated-fill': 'var(--surface-raised)',
  'dsw-alias-button-floating-fill': 'var(--menu-fill)',
  'dsw-alias-button-floating-hover': 'var(--menu-hover)',
  'dsw-alias-button-ghost-active-border': 'var(--surface-edge-strong)',
  'dsw-alias-button-ghost-active-fill': 'var(--surface-active)',
  'dsw-alias-button-ghost-active-hover': 'var(--surface-active)',
  'dsw-alias-button-info-fill': 'var(--color-accent)',
  'dsw-alias-button-info-hover': 'var(--color-accent-hover)',
  'dsw-alias-button-tool-bar-fill': 'color-mix(in srgb, var(--ink-primary) 50%, transparent)',
  'dsw-alias-button-tool-bar-fill-invisible': 'color-mix(in srgb, var(--ink-primary) 36%, transparent)',
  'dsw-alias-button-tool-bar-hover': 'color-mix(in srgb, var(--ink-primary) 60%, transparent)',
  // Pointer states.
  'dsw-alias-interactive-bg-hover': 'var(--surface-hover)',
  'dsw-alias-interactive-bg-hover-solid': 'var(--surface-hover)',
  'dsw-alias-interactive-bg-active': 'var(--surface-active)',
  'dsw-alias-interactive-bg-hover-accent': 'var(--color-accent-subtle)',
  'dsw-alias-interactive-bg-hover-danger': 'var(--color-error-subtle)',
  // Markdown and code.
  'dsw-alias-markdown-citation': 'var(--surface-active)',
  'dsw-alias-markdown-code-block': 'var(--surface-sidebar)',
  'dsw-alias-markdown-code-block-banner': 'var(--surface-hover)',
  'dsw-alias-markdown-code-segment-selected': 'var(--surface-raised)',
  'dsw-alias-markdown-code-segment-unselected': 'var(--surface-hover)',
  'dsw-alias-markdown-inline-code': 'var(--surface-active)',
  'dsw-alias-markdown-placeholder': 'var(--surface-hover)',
  'dsw-alias-markdown-tag': 'var(--surface-active)',
  'dsw-alias-code-diff-added': 'var(--color-success-subtle)',
  'dsw-alias-code-diff-deleted': 'var(--color-error-subtle)',
  'dsw-alias-file-diff-added-bg': 'var(--color-success-subtle)',
  'dsw-alias-file-diff-added-gutter': 'color-mix(in srgb, var(--color-success-subtle) 70%, transparent)',
  'dsw-alias-file-diff-added-marker': 'var(--color-success)',
  'dsw-alias-file-diff-deleted-bg': 'var(--color-error-subtle)',
  'dsw-alias-file-diff-deleted-gutter': 'color-mix(in srgb, var(--color-error-subtle) 70%, transparent)',
  'dsw-alias-file-diff-deleted-marker': 'var(--color-error)',
  // Scrollbars.
  'dsw-alias-scrollbar-bg-l1': 'var(--surface-edge-strong)',
  'dsw-alias-scrollbar-bg-l2': 'var(--surface-edge-strong)',
  'dsw-alias-scrollbar-hover-l1': 'var(--ink-disabled)',
  'dsw-alias-scrollbar-hover-l2': 'var(--ink-disabled)',
  // States.
  'dsw-alias-state-business-primary': 'var(--color-accent)',
  'dsw-alias-state-business-tertiary': 'var(--color-accent-subtle)',
  'dsw-alias-state-error-primary': 'var(--color-error)',
  'dsw-alias-state-error-secondary': 'color-mix(in srgb, var(--color-error) 70%, var(--surface-raised))',
  'dsw-alias-state-idle-primary': 'var(--ink-disabled)',
  'dsw-alias-state-success-primary': 'var(--color-success)',
  'dsw-alias-state-success-secondary': 'color-mix(in srgb, var(--color-success) 70%, var(--surface-raised))',
  'dsw-alias-state-success-tertiary': 'var(--color-success-subtle)',
  'dsw-alias-state-warn-label': 'var(--color-warning)',
  'dsw-alias-state-warn-primary': 'var(--color-warning)',
  'dsw-alias-state-warn-secondary': 'color-mix(in srgb, var(--color-warning) 70%, var(--surface-raised))',
  'dsw-alias-state-warn-tertiary': 'var(--color-warning-subtle)',
  // Toasts and tooltips: dark on light, light on dark, like Hello's menus inverted.
  'dsw-alias-toast-bg': 'var(--ink-primary)',
  'dsw-alias-toast-label': 'var(--surface-raised)',
  'dsw-alias-tooltip-bg': 'var(--ink-primary)',
  'dsw-alias-tooltip-key-bg': 'color-mix(in srgb, var(--ink-primary) 82%, var(--surface-raised))',
  // Onboarding and settings cards.
  'dsw-alias-onboarding-accent': 'var(--color-accent)',
  'dsw-alias-onboarding-card-fill': 'var(--surface-raised)',
  'dsw-alias-onboarding-checkbox-border': 'var(--surface-edge-strong)',
  'dsw-alias-onboarding-secondary-fill': 'var(--surface-hover)',
  'dsw-alias-settings-card-fill': 'var(--surface-panel)',
  'dsw-alias-settings-card-stroke': 'var(--surface-edge)',
  // Specific seats.
  'dsw-specific-sidebar-fill': 'var(--surface-sidebar)',
  'dsw-specific-sidebar-nav-item-active': 'var(--sidebar-current-fill)',
  'dsw-specific-sidebar-nav-item-active-accent': 'var(--color-accent-subtle)',
  'dsw-specific-sidebar-nav-item-hover': 'var(--surface-hover)',
  'dsw-specific-input-major': 'var(--surface-raised)',
  'dsw-specific-login-input': 'var(--surface-raised)',
  'dsw-specific-bubble': 'var(--surface-raised)',
  'dsw-specific-bubble-highlight': 'var(--color-accent-subtle)',
  'dsw-specific-menu': 'var(--menu-fill)',
  'dsw-specific-selector': 'var(--surface-hover)',
  'dsw-specific-tip': 'var(--surface-hover)',
};

/** Shape: Hello's fonts and corners. dsh's radii scale 4 8 12 16 20 28; Hello's 6 8 10 12 18, panels 16. */
export const SHAPE_MAP = {
  'dsw-font-family': 'var(--font-ui)',
  'ds-font-family-code': 'var(--font-mono)',
  'dsw-radius-xs': 'var(--r-6)',
  'dsw-radius-sm': 'var(--r-8)',
  'dsw-radius-md': 'var(--r-10)',
  'dsw-radius-lg': 'var(--r-12)',
  'dsw-radius-xl': 'var(--r-18)',
  'dsw-radius-panel': 'var(--panel-radius)',
};

function declarations(block) {
  const tokens = {};
  for (const match of block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g))
    tokens[match[1]] = match[2].replace(/\s+/g, ' ').trim();
  return tokens;
}

/** Hello's light and dark token sets from tokens.css (the dark set is the light one with the dark block over it). */
export function parseHelloTokens(css) {
  const media = css.indexOf('@media (prefers-color-scheme: dark)');
  if (media < 0) throw new Error('tokens.css: no dark block');
  const light = declarations(css.slice(0, media));
  const open = css.indexOf('{', css.indexOf('{', media) + 1);
  let depth = 1;
  let index = open + 1;
  for (; index < css.length && depth > 0; index++) {
    if (css[index] === '{') depth++;
    else if (css[index] === '}') depth--;
  }
  const dark = { ...light, ...declarations(css.slice(open + 1, index - 1)) };
  return { light, dark };
}

export function resolve(expression, tokens, seen = new Set()) {
  return expression.replace(/var\(--([a-z0-9-]+)(?:\s*,\s*([^)]+))?\)/g, (_whole, name, fallback) => {
    if (seen.has(name)) throw new Error(`tokens.css: --${name} refers to itself`);
    const value = tokens[name] ?? fallback;
    if (value === undefined) throw new Error(`tokens.css: --${name} is not defined`);
    return resolve(value, tokens, new Set([...seen, name]));
  });
}

/** Every dsh token with its Hello value, light and dark, ready for overrideTokens. */
export function helloTheme(css) {
  const { light, dark } = parseHelloTokens(css);
  const theme = {};
  for (const [name, expression] of Object.entries({ ...COLOR_MAP, ...SHAPE_MAP }))
    theme[`--${name}`] = { light: resolve(expression, light), dark: resolve(expression, dark) };
  return theme;
}

function fontFaces() {
  const files = join(root, 'node_modules', '@fontsource-variable', 'inter', 'files');
  const face = (file, range) => `@font-face{font-family:'Inter Variable';font-style:normal;font-display:swap;font-weight:100 900;src:url(data:font/woff2;base64,${readFileSync(join(files, file)).toString('base64')}) format('woff2-variations');unicode-range:${range};}`;
  return [
    face('inter-latin-ext-wght-normal.woff2', 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'),
    face('inter-latin-wght-normal.woff2', 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'),
  ].join('');
}

function markDataUri() {
  return `data:image/svg+xml;base64,${readFileSync(join(root, 'assets', 'icon.svg')).toString('base64')}`;
}

/** The plugin's browser half, in dsh's loader format (window.__ModuleLoader__). */
export function buildClient(css) {
  const theme = helloTheme(css);
  return `// Generated by scripts/dsh-theme.mjs from src/renderer/styles/tokens.css. Do not edit.
window.__ModuleLoader__.load({
\tid: "hello-dsh",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tconst jsx = require("react/jsx-runtime").jsx;
\t\tconst jsxs = require("react/jsx-runtime").jsxs;
\t\tconst TOKENS = ${JSON.stringify(theme, null, 2).replace(/\n/g, '\n\t\t')};
\t\tconst FONTS = ${JSON.stringify(fontFaces())};
\t\tconst MARK = ${JSON.stringify(markDataUri())};
\t\tfunction HelloMark({ size = 24 }) {
\t\t\treturn jsx("img", { src: MARK, width: size, height: size, alt: "", draggable: false, style: { display: "block", borderRadius: Math.round(size * 0.22) } });
\t\t}
\t\tfunction HelloName() {
\t\t\treturn jsx("span", { style: { font: "500 15px/1 var(--dsw-font-family)", letterSpacing: "-0.01em", color: "var(--dsw-alias-label-primary)" }, children: "Hello." });
\t\t}
\t\tfunction installFonts() {
\t\t\tconst style = document.createElement("style");
\t\t\tstyle.dataset.plugin = "hello-dsh/fonts";
\t\t\tstyle.textContent = FONTS;
\t\t\tdocument.head.append(style);
\t\t\treturn () => style.remove();
\t\t}
\t\texports.name = "hello-dsh";
\t\texports.inject = ["theme", "slots"];
\t\texports.apply = (ctx) => {
\t\t\tctx.effect(() => installFonts(), "hello-dsh: Inter");
\t\t\tctx.effect(() => ctx.theme.overrideTokens("hello", TOKENS), "hello-dsh: Hello tokens");
\t\t\tctx.slots.inject("sidebar.brand.mark", () => ctx.slots.inject("sidebar.brand.name", function* () {
\t\t\t\tyield ctx.slots.register({ name: "sidebar.brand.mark" }, HelloMark);
\t\t\t\tyield ctx.slots.register({ name: "sidebar.brand.name" }, HelloName);
\t\t\t}));
\t\t};
\t\treturn module.exports;
\t}
});
`;
}

export function tokensCss() {
  return readFileSync(join(root, 'src', 'renderer', 'styles', 'tokens.css'), 'utf8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const output = join(PLUGIN_DIR, 'lib', 'client.js');
  const built = buildClient(tokensCss());
  if (process.argv.includes('--check')) {
    const current = readFileSync(output, 'utf8');
    if (current !== built) { console.error('assets/dsh/hello-dsh/lib/client.js is stale: run node scripts/dsh-theme.mjs'); process.exit(1); }
    console.log('hello-dsh theme is up to date.');
  } else {
    writeFileSync(output, built);
    console.log(`Wrote ${output} (${Object.keys(helloTheme(tokensCss())).length} tokens, ${Math.round(built.length / 1024)} KB).`);
  }
}
