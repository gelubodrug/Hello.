# dsh-plugin-word-count

A DeepSeek Harness (dsh) plugin in the shape dsh loads: an npm package whose
`package.json` names a bundle patch (`dsh.bundle.patch`), a patch that inserts
Cordis rows, and a module per row with `apply(ctx)` and `inject`.

- `lib/index.js` — the `word_count` tool, registered with `defineTool`.
- `skills/word-count/SKILL.md` — a skill, offered through
  `@deepseek-ai/dsh-skill-filesystem`.
- `cordis.patch.yml` — the two rows.

## Try it in Hello.

Copy this folder somewhere of your own (the chat's folder), then Settings ›
Extensions › DSH surface › **Add from folder…**, pick it, confirm, and restart
the DSH surface. The tool is offered to dsh sessions in the
surface; the skill also appears in Hello's own Extensions menu under
"Found on this Mac".

## Publish it

Rename the package (`name` in `package.json`, the row name and the
`resolve('…/package.json')` in `cordis.patch.yml`), then `npm publish`. Anyone can
install it: in Hello with **Add by npm name**, in dsh with
`dsh plugin --profile web add <name>`. The 1024Store lists packages with the
`dsh-plugin` keyword.
