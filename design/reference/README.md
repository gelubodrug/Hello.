# Hello. — runnable design checkpoint

This folder contains the actual mockup source, not only screenshots or a style
guide. It is a one-way snapshot of the live renderer specimen and every local
source dependency it imports, including shared tokens, motion, chat, menus,
notebooks, tool fixtures and required types. The copied files are byte-for-byte
identical to their originals; see `manifest.json` for SHA-256 hashes.

## Run independently

Requires Node.js 20+ and pnpm 9.15.0. Copy this entire directory anywhere, then:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm dev
```

Open http://127.0.0.1:4318/. This port is separate from the live study on 4317.
`pnpm typecheck` checks the copied TypeScript; `pnpm build` makes a static
`dist/` export; `pnpm preview` serves it on http://127.0.0.1:4319/.
Serve `dist/` over HTTP; opening its HTML through `file://` is not supported.
Font assets are bundled by Vite from the package dependencies, not a web CDN.

## What is—and is not—inside

- [Approved look](design/LOOK.md), [implementation decision](design/IMPLEMENTATION.md),
  and the [design index](design/README.md) accompany the complete source.
- The live entry is `src/renderer/design/ChatPanelPreview.tsx`. `index.html`
  is a second entry pointing to that exact copied component.
- Browser, terminal and CLI panels are local simulations. They do not launch
  sessions, contact a model, access a repository or render an external website.
- No Electron main/preload implementation, native dependencies, credentials,
  user databases or application data are included. The shared renderer stores
  and IPC *types* remain because the real UI imports them; this page has no
  preload bridge. Closing/reloading the page is not a persistence guarantee.
- `App.css` remains because the live preview explicitly imports it. No old
  app shell or Sidebar implementation is copied unless a future specimen
  genuinely imports it. This is a checkpoint, not a second app architecture.
- Third-party libraries/fonts are installed from the package manifest and lock;
  they are not vendored. The initial install therefore needs registry access.
- `dist/` and `node_modules/` are generated, not part of the source checkpoint.

## Update without design drift

The canonical editable sources stay in the parent repository's `src/` and
`design/`. Do not edit these copied files in parallel or reinterpret the look
inside the export. From the parent repository, after the specimen is approved:

```sh
node design/export-mockup.mjs
cd design/mockup
pnpm install --lockfile-only --ignore-scripts
pnpm typecheck
pnpm build
```

`node design/export-mockup.mjs --check` (from the parent repo) detects both
source drift and accidental edits to generated/copied files. Export refuses to
overwrite changed generated files; resolve those edits explicitly first. It
never recursively deletes the folder. New local dependencies are discovered
from TypeScript imports and CSS imports/URLs. The manifest has no machine paths,
timestamps or user data. Original documentation links to the broader repository
may not resolve inside this intentionally bounded standalone snapshot.
