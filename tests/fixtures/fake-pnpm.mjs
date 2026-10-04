// Stands in for pnpm in the DSH service tests: "installs" by creating the
// linked Hello bundle folder in the profile it runs in, then succeeds.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
mkdirSync(join(process.cwd(), 'node_modules', 'hello-dsh'), { recursive: true });
process.stdout.write('Progress: resolved 1, reused 1, downloaded 0, added 1, done\n');
