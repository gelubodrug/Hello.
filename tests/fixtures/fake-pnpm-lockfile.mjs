// Stands in for pnpm installing the DSH runtime the way pnpm does in CI: a
// lockfile made for another dsh version is refused unless the install may
// update it. Lays out the runtime at the version package.json asks for.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const cwd = process.cwd();
const version = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).dependencies['@deepseek-ai/dsh'];
const lockfile = join(cwd, 'pnpm-lock.yaml');
if (existsSync(lockfile) && !readFileSync(lockfile, 'utf8').includes(version) && !process.argv.includes('--no-frozen-lockfile')) {
  process.stderr.write('[ERR_PNPM_OUTDATED_LOCKFILE] Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date\n');
  process.exit(1);
}
writeFileSync(lockfile, `dsh: ${version}\n`);
mkdirSync(join(cwd, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
writeFileSync(join(cwd, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ version }));
mkdirSync(join(cwd, 'node_modules', 'node-addon-require-builtin'), { recursive: true });
writeFileSync(join(cwd, 'node_modules', 'node-addon-require-builtin', 'package.json'), '{}');
