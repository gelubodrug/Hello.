// Stands in for pnpm in the market tests: `add <name>@<version> --save-exact`
// and `remove <name>` edit the profile's package.json and node_modules the
// way pnpm would, so the installer's own steps can be checked around it.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.env.FAKE_PNPM_FAIL) {
  process.stdout.write(`${process.env.FAKE_PNPM_FAIL}\n`);
  process.exit(1);
}
const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const manifestPath = join(process.cwd(), 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.dependencies ??= {};
if (args[0] === 'add') {
  const spec = args[1];
  const at = spec.lastIndexOf('@');
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  manifest.dependencies[name] = version;
  mkdirSync(join(process.cwd(), 'node_modules', name), { recursive: true });
  writeFileSync(join(process.cwd(), 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
} else if (args[0] === 'remove') {
  delete manifest.dependencies[args[1]];
  rmSync(join(process.cwd(), 'node_modules', args[1]), { recursive: true, force: true });
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write('Progress: resolved 1, reused 1, downloaded 0, added 1, done\n');
