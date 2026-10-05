# Hello. — runnable design checkpoint

This folder contains the actual mockup source, not only screenshots or a style
guide. It is a one-way snapshot of the live renderer specimen and every local
source dependency it imports, including shared tokens, motion, chat, menus,
notebooks, tool fixtures and required types. It was copied byte for byte from
the old repository on 2026-09-10, and `manifest.json` records those hashes;
`design/LOOK.md` has been edited here since, as the living contract, so its
hash no longer matches.

## Run independently

Requires Node.js 20+ and pnpm 9.15.0. Copy this entire directory anywhere, then:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm dev
```

Open http://127.0.0.1:4318/ — or, from the Hello. repository, run `pnpm preview:design`.
`pnpm typecheck` checks the copied TypeScript; `pnpm build` makes a static
`dist/` export; `pnpm preview` serves it on http://127.0.0.1:4319/.
Serve `dist/` over HTTP; opening its HTML through `file://` is not supported.
Font assets are bundled by Vite from the package dependencies, not a web CDN.

## What is—and is not—inside

- The [approved look](design/LOOK.md) and the [design index](design/README.md)
  accompany the complete source. The 09-09 implementation decision is archived
  in `docs/archive/design/reference-IMPLEMENTATION-2026-09-09.md`.
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

## Updating

The snapshot came from the old repository's `design/mockup/` export, which is not
part of Hello. Here, `design/LOOK.md` is edited directly as the contract; the
copied source is the specimen and is not edited.
