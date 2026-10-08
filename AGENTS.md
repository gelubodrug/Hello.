# Hello. — new application

This is a separate, greenfield Electron app. Never mutate the old repository at
`/Users/q/Documents/app chat local models first` or access its user database.

- The approved visual contract and complete executable reference are in
  `design/reference/`. Preserve the approved typography, native CSS materials,
  pill/menu geometry and reveal/fade motion. Do not import the old shell/store.
- Terminal renderer, PTY integration and CLI launch are authorized for reuse.
  The user also explicitly authorized the earlier `web-tools.ts` research flow and
  SessionChatThread research/source rendering. Record adaptations in `docs/PROVENANCE.md`.
- Use SQLite in this app's own user-data directory. No user credentials in Git,
  renderer bootstrap, logs or test fixtures. Native IPC only from the main UI.
- The browser pane hosts its page in a `<webview>` guest, in the document, so
  menus and dialogs stack above it by CSS alone. Never hide, detach or reload a
  page to make room for app chrome. The renderer sets only the `src` main minted
  for it; every other attribute and every navigation is main's decision. A page
  whose pane is closed stays mounted and parked, because a chat's tabs must
  remain readable while their pane is not on screen — and because Chromium
  creates no page at all for an element with no box.
- Hidden tools continue running; hiding UI is distinct from terminating a PTY.
- CLI sessions receive a small Hello connection guide, never an automatically
  assigned task or the full notebook contents. Read Tasks/Runbook on request
  through the session-bound notebook connection; empty notebooks must not block launch.
- A tab the person opens starts Agent control Off. Read access and mutations are
  gated in the main process, per tab. A tab the model opens with browser_open
  starts Full (user, 29.09: the model opens a page to work in it, read-write);
  that Full is not saved, comes back Off after a restart, and becomes the
  person's once they change it. Opening a requested page/dev URL or scoped HTML
  preview inside Hello does not require a grant. Off still blocks page reading
  and DOM interaction; Read allows reading; Full allows interaction.
- Generated HTML uses browser_show_html: bounded app-owned artifacts work without
  an attached folder. Such a tab opens at Full, like every tab the model opens: the model
  wrote every word in it, it is served from an isolated local session with
  nothing signed in, and a page it cannot look at is a page it never checked.
  The grant belongs to the document, not to the tab — navigating that tab
  anywhere else, or the page sending itself away, drops it back to Off. They are
  still not workspace write grants.
- A tab is saved by the handle that can produce its page again, never by a local
  address whose port dies with the app: `artifact:<id>` for a generated document,
  a folder-relative path for a previewed file. Both come back after a restart,
  served again the moment the tab is looked at. A dev server is the one thing
  that legitimately does not: tell the model so rather than restoring a dead URL.
  A previewed file is the person's, so it comes back Off.
  Opening a page is navigation success only, never proof its content is correct.
- In the active dev workflow, the user performs testing. Do not run builds,
  packaging, tests or restart the dev app unless requested. Non-emitting static
  type checks are separate. Never execute real CLI work, spend model credits,
  or change global app/OS settings during QA.
- Use apply_patch for source edits. Do not edit another agent's assigned files.
- `docs/archive/` is history: plans, reports and research that are no longer
  current. Never act on it or treat a decision recorded there as standing. What
  the app is: `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/PROVENANCE.md`
  and `design/reference/`; what is open: Spec Kit `specs/blaizzy-nativ-hello-monitor/tasks.md`
  (read it with spec_kit_status).
