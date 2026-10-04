# hello-dsh — the Hello. theme for DeepSeek Harness

Hello.'s look on dsh's web client: every dsh colour token (`--dsw-alias-*`,
`--dsw-specific-*`), light and dark, plus radii and fonts, taken from Hello.'s own
design tokens. It also bundles Inter (Latin and Latin Extended) and puts Hello.'s
mark and name in dsh's brand slots.

It is an ordinary dsh plugin:

- `lib/client.js` — the browser half, in dsh's loader format. It calls
  `ctx.theme.overrideTokens('hello', …)` and registers `sidebar.brand.mark` and
  `sidebar.brand.name`.
- `cordis.patch.yml` — inserts the row and turns off `ui-brand-official`, so
  Hello.'s brand holds the slots. It also starts the appearance dark, as Hello.'s
  window is: a bundle default, beneath the profile's own layer, so Settings ›
  Appearance changes it.
- `lib/index.js` — an empty host half.

## Install

- **In Hello.** Nothing to do: Hello.'s DSH surface links this package into its
  profile on every start.
- **In DSH Desktop or dsh**, once published:
  `dsh plugin --profile web add hello-dsh`, then restart.

## Build

`lib/client.js` is generated; do not edit it. From the Hello. repository run
`node scripts/dsh-theme.mjs`. A test fails when the pinned dsh has a token without
a Hello. value, or when the file is stale.

## Limits

A dsh theme changes variables only. The layout (sidebar, conversation, right
panel) stays dsh's, and per-element elevation shadows keep dsh's values.
