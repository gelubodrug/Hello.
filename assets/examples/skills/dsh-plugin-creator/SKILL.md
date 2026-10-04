---
name: dsh-plugin-creator
description: Make a DeepSeek Harness (dsh) plugin — tools, skills, a theme or other interface parts — in the format dsh itself loads, so it runs in Hello's DSH surface and in DSH Desktop alike. Use when the user asks for a dsh plugin, a plugin for the DSH surface or the Plugin Market, or to package a tool or skill for DeepSeek Harness. Coder mode, with a chat folder.
version: 1.0.0
---

# DSH plugin creator

A dsh plugin is an npm package that dsh composes into its plugin tree. Hello
installs it into its DSH surface; the same package installs into DSH Desktop
(`dsh plugin --profile web add <name>`). Build it in the chat's folder, test it
through Hello, then publish it if the user wants.

## The shape — nothing else is needed

1. **`package.json`** — a package name, an exact version, `"type": "module"`, and
   `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`. Peer ranges on
   `@deepseek-ai/dsh-*` must include `0.1.7-rc.2`, the dsh Hello runs
   (`"^0.1.7-rc.2 || >=0.2.0-rc.1 <0.3.0-0"`); Hello refuses a plugin whose peers
   exclude it, because it would stop the surface from booting.
2. **`cordis.patch.yml`** — a YAML list of loader patches. `- insert:` adds rows,
   each `{ id, name, config? }`, where `name` is a package (this one, or a dsh
   package such as `@deepseek-ai/dsh-skill-filesystem`). `- id: <row>` with
   `config:` or `disabled: true` changes an existing row.
3. **One module per row** — `export const inject = [...]` (the services it needs)
   and `export function apply(ctx, config)`.

Start from `template/` in this skill: copy it into the chat folder, rename the
package in all three places (`package.json` name, the row `name`, and the
`resolve('<name>/package.json')` in the patch), then replace the example.

## Tools

Register with `defineTool` from `@deepseek-ai/dsh-tools`, inside `apply`, with
`inject = ['tools']`:

- `name` (snake_case, what the model calls), `description` (when to use it),
  `parameters` (`{ key: { type, required, description } }`);
- `output` is **mandatory**: a `schema` for the value `execute` returns and a
  `render(args, value)` returning content blocks (`[{ type: 'text', text }]`);
- `execute(args, exec)` returns that value and must honour `exec.signal`.

See `template/lib/index.js`. Keep tools deterministic and local unless the user
asks for network access; say plainly in the README what a tool reads or sends.

## Skills

Put each skill in `skills/<name>/SKILL.md`, with front matter `name` and a
`description` that says when to use it. Offer the folder with a row of
`@deepseek-ai/dsh-skill-filesystem` (`bundledSkillDir`), as the template does.
Hello also lists these skills under "Found on this Mac" in its Extensions menu.

## Interface parts and themes

A browser half is a second export (`"./client"`) and a `"dsh": { "client": {
"platform": "web" } }` field. Its file is **not** a normal module: dsh's page
loads it as `window.__ModuleLoader__.load({ id: '<package>', factory: (require) =>
{ … return module.exports } })`, and `require` answers only dsh's shared modules
(`react`, `react/jsx-runtime`, `react-dom`, `@deepseek-ai/cordis`,
`@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, …).
Its `apply(ctx)` uses `ctx.slots.inject(name, () => ctx.slots.register({ name, … },
Component))` for slots, and `ctx.theme.overrideTokens('<source>', { '--dsw-…': {
light, dark } })` for a theme. Hello's own theme plugin, `hello-dsh`, is a worked
example of both. Colours come only from `--dsw-*` variables: never hard-code them.

## Test it in Hello

1. Write the files in the chat folder, then check `package.json` is valid JSON
   and the patch is valid YAML.
2. Ask the user to open Settings › Extensions › DSH surface › **Add from
   folder…** and pick the plugin's folder. Hello shows what it found; the user
   confirms. The folder is linked, so later edits apply after a restart.
3. Restart the DSH surface (its header, or the confirmation's Restart now). A
   plugin that does not activate is named in the surface's banner, with Restore.
4. Try the tool in a DSH session. Fix, restart, repeat.

Never install packages into the user's `~/.dsh`, and never run `npm publish`
yourself: publishing is the user's decision and needs their npm login. When they
want it, tell them the one command, and that the 1024Store lists packages with the
`dsh-plugin` keyword.
