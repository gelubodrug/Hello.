/**
 * The DSH host: one dsh profile, booted the way dsh's own desktop host boots
 * it (apps/desktop-host, MIT), in a process of its own.
 *
 * Main starts this file as an Electron utility process, with
 * `--expose-internals` (see runtime.ts) and an environment it chose. dsh is
 * never imported at build time: it is loaded from the runtime folder the
 * person installed, so the app bundle carries none of it.
 *
 * Messages to main: `ready {port, url}` once the web server
 * listens — `url` carries the one-time token and never leaves main;
 * `fatal {message}` when the boot fails, `shutdown-complete` after a
 * requested stop.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { pathToFileURL } from 'node:url';

type HostMessage =
  | { type: 'ready'; port: number; url: string }
  | { type: 'fatal'; message: string; diagnostic: string }
  | { type: 'shutdown-complete' };

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

function send(message: HostMessage): void {
  if (parentPort) parentPort.postMessage(message);
  else process.send?.(message);
}

function onMessage(listener: (message: unknown) => void): void {
  if (parentPort) parentPort.on('message', event => listener(event.data));
  else process.on('message', listener);
}

const MAX_DIAGNOSTIC = 64 * 1024;

interface RunningApplication {
  ctx: { webServer: { port: number }; connection: { authenticatedUrl(origin: string): string } };
  shutdown: { shutdown(code: number): Promise<void> };
}

async function main(): Promise<void> {
  const [runtimeDir, profile, template] = process.argv.slice(2);
  const home = process.env.DSH_HOME;
  if (!runtimeDir || !profile || !home) throw new Error('DSH host: runtime folder, profile and DSH_HOME are required.');
  const require = createRequire(join(runtimeDir, 'package.json'));
  const load = <T>(specifier: string) => import(pathToFileURL(require.resolve(specifier)).href) as Promise<T>;
  const appBoot = await load<{ loadLayeredEnv(bin: string): unknown }>('@deepseek-ai/dsh-app-boot');
  const { runProfile } = await load<{ runProfile(options: Record<string, unknown>): Promise<RunningApplication> }>('@deepseek-ai/dsh/profile-boot');
  const exists = existsSync(join(home, 'profiles', profile, 'package.json'));
  const patch = process.env.HELLO_DSH_PATCH;
  const application = runProfile({
    environment: appBoot.loadLayeredEnv('dsh'),
    profile,
    ...(exists || !template ? {} : { fromDefaultProfile: template }),
    patchFiles: patch ? [patch] : [],
    args: ['--no-open', '--port', '0'],
    ...(process.env.HELLO_DSH_PNPM ? {
      packageManager: {
        command: process.execPath,
        args: [process.env.HELLO_DSH_PNPM],
        env: { ELECTRON_RUN_AS_NODE: '1', npm_config_manage_package_manager_versions: 'false' },
      },
    } : {}),
  });
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    const running = await application.catch(() => undefined);
    await running?.shutdown.shutdown(0);
    send({ type: 'shutdown-complete' });
    process.exit(0);
  })();
  onMessage(message => {
    if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'shutdown') void stop();
  });
  const { ctx } = await application;
  const port = ctx.webServer.port;
  send({
    type: 'ready',
    port,
    url: ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(port)}`),
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  send({ type: 'fatal', message, diagnostic: inspect(error, { depth: 4, maxArrayLength: 50 }).slice(0, MAX_DIAGNOSTIC) });
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 200).unref();
});
