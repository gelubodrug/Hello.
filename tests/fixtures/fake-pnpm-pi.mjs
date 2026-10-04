// Stands in for pnpm in the Pi market tests: `add <name>@<version> …` copies
// the package template into node_modules/<name>, adds one dependency beside
// it, and writes the lockfile pnpm would, with the integrity the test chose.
// It records its arguments and the settings it was run with.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
writeFileSync(process.env.FAKE_PI_RECORD, JSON.stringify({
  args,
  userconfig: process.env.npm_config_userconfig ?? null,
  workspace: readFileSync(join(process.cwd(), 'pnpm-workspace.yaml'), 'utf8'),
}));
if (process.env.FAKE_PI_EXIT) {
  process.stdout.write(`${process.env.FAKE_PI_OUTPUT ?? 'ERR_PNPM_FAKE failed'}\n`);
  process.exit(Number(process.env.FAKE_PI_EXIT));
}
const spec = args[args.indexOf('add') + 1];
const at = spec.lastIndexOf('@');
const name = spec.slice(0, at);
const version = spec.slice(at + 1);
const target = join(process.cwd(), 'node_modules', ...name.split('/'));
mkdirSync(target, { recursive: true });
cpSync(process.env.FAKE_PI_TEMPLATE, target, { recursive: true });
const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
writeFileSync(join(target, 'package.json'), JSON.stringify({ ...manifest, name, version }));
mkdirSync(join(process.cwd(), 'node_modules', 'left-pad'), { recursive: true });
writeFileSync(join(process.cwd(), 'node_modules', 'left-pad', 'package.json'), JSON.stringify({ name: 'left-pad', version: '1.3.0', main: 'index.js' }));
writeFileSync(join(process.cwd(), 'node_modules', 'left-pad', 'index.js'), "module.exports = (text, size) => String(text).padStart(size);\n");
writeFileSync(join(process.cwd(), 'pnpm-lock.yaml'), [
  "lockfileVersion: '9.0'",
  'importers:',
  '  .:',
  '    dependencies:',
  `      '${name}':`,
  `        specifier: ${version}`,
  `        version: ${version}`,
  'packages:',
  `  '${name}@${version}':`,
  `    resolution: {integrity: ${process.env.FAKE_PI_INTEGRITY}}`,
  "  'left-pad@1.3.0':",
  '    resolution: {integrity: sha512-bGVmdHBhZA==}',
  '',
].join('\n'));
process.stdout.write('Progress: resolved 2, reused 0, downloaded 2, added 2, done\n');
