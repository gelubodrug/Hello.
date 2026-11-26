import { execFile } from 'node:child_process';
import type { LocalServer, ModelChoice, VoiceServer } from '../../shared/types';
import { voiceServerName } from '../voice/servers';

/**
 * Model servers running on this Mac, found rather than typed. A llama-server
 * started with `--port 8081` is not where the llama.cpp preset looks, and a
 * person should not have to know that: every TCP port a process of this user
 * listens on is asked for an OpenAI-style model list, and whatever answers
 * with one is a server Hello can use.
 */

export interface ListeningPort { pid: number; command: string; port: number }

/** Ports worth asking even when lsof cannot say who listens. */
export const WELL_KNOWN_PORTS: readonly number[] = [8080, 1234, 11434, 8000, 5001, 1337];

/** Listeners that are known not to speak HTTP, or belong to macOS itself. */
const NOT_HTTP = /^(postgres|mysqld|mariadbd|mongod|redis-server|rapportd|ControlCenter|sharingd|identityservicesd)$/i;

/** More ports than this and the rest are not asked. */
export const PORT_LIMIT = 64;

/** Addresses a request to localhost reaches. */
const LOOPBACK = /^(\*|127\.0\.0\.1|\[::1\]|localhost|0\.0\.0\.0|\[::\])$/i;

/** `lsof -F pcn` output: `p<pid>` opens a process, `c<command>` names it, `n<address:port>` is one socket. */
export function parseListening(output: string, ownPid: number): ListeningPort[] {
  const found = new Map<number, ListeningPort>();
  let pid = 0;
  let command = '';
  for (const line of output.split('\n')) {
    const field = line[0];
    const value = line.slice(1);
    if (field === 'p') { pid = Number(value); command = ''; }
    else if (field === 'c') command = value;
    else if (field === 'n') {
      const split = value.lastIndexOf(':');
      const address = value.slice(0, split);
      const port = Number(value.slice(split + 1));
      if (split < 0 || !Number.isInteger(port) || port < 1 || port > 65_535) continue;
      if (pid === ownPid || !LOOPBACK.test(address) || NOT_HTTP.test(command) || found.has(port)) continue;
      found.set(port, { pid, command, port });
    }
  }
  return [...found.values()];
}

/** Who listens where, from lsof. Anything lsof cannot say leaves the well-known ports. */
export function listeningPorts(ownPid = process.pid): Promise<ListeningPort[]> {
  const fallback = WELL_KNOWN_PORTS.map(port => ({ pid: 0, command: '', port }));
  return new Promise(resolve => {
    execFile('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '+c', '0', '-F', 'pcn'],
      { timeout: 3_000, maxBuffer: 2 * 1024 * 1024 },
      (_error, stdout) => {
        // lsof exits 1 when it matched nothing, and may be missing or slow:
        // whatever it printed is the answer, and nothing printed leaves the
        // ports servers usually take.
        const ports = parseListening(String(stdout ?? ''), ownPid);
        resolve(ports.length ? ports : fallback);
      });
  });
}

const NAMES: ReadonlyArray<[RegExp, string]> = [
  [/llama-server|llama\.cpp|llamafile/i, 'llama.cpp'],
  [/ollama/i, 'Ollama'],
  [/lm ?studio|^lms$/i, 'LM Studio'],
  [/whisper/i, 'whisper.cpp'],
  [/kokoro/i, 'Kokoro'],
  [/omlx/i, 'oMLX'],
  [/mlx/i, 'MLX'],
  [/vllm/i, 'vLLM'],
  [/kobold/i, 'KoboldCpp'],
  [/^jan$|cortex/i, 'Jan'],
  [/local-?ai/i, 'LocalAI'],
];

/** What a person calls the server: its product, or failing that the process. */
export function serverLabel(command: string): { label: string; known: boolean } {
  const known = NAMES.find(([pattern]) => pattern.test(command));
  return known ? { label: known[1], known: true } : { label: command || 'Server', known: false };
}

/** The first port the system hands out on its own. A process that did not
 *  choose its port is not a server anyone configured. */
const EPHEMERAL = 49_152;

/**
 * Which listeners to ask, best first, at most PORT_LIMIT. A developer's Mac
 * listens on hundreds of ports — 276 on the one this was written on, most of
 * them editor and tool helpers on ports the system picked — and taking them in
 * lsof's order left a llama-server on 8081 unasked. So: processes that are
 * model servers by name, then the ports servers usually take, then the ports
 * someone chose; a system-picked port of an unknown process is not asked.
 */
export function candidates(ports: ListeningPort[]): ListeningPort[] {
  const rank = ({ command, port }: ListeningPort) =>
    serverLabel(command).known ? 0 : WELL_KNOWN_PORTS.includes(port) ? 1 : port < EPHEMERAL ? 2 : 3;
  return ports
    .filter(entry => rank(entry) < 3)
    .sort((left, right) => rank(left) - rank(right) || left.port - right.port)
    .slice(0, PORT_LIMIT);
}

export interface FoundServers { chat: LocalServer[]; voice: VoiceServer[] }

/**
 * A model list the server refused for want of a key. oMLX started with an API
 * key answers 401 `{"error":{"type":"authentication_error"}}` and was left out
 * of "On this Mac" as if nothing listened (user, 26.11). Only a refusal in the
 * OpenAI error shape counts: a web app's login wall is not a model server.
 */
export class ModelListingAuthError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'ModelListingAuthError'; }
}

/**
 * One look at every candidate port. A port that lists voices is a voice server
 * and stays out of the chat's list even when it also publishes /v1/models (its
 * Kokoro ids are not chat models); one with a chat model list is a chat server;
 * only a port that is neither is asked whether it is whisper.cpp.
 */
export async function detectServers(options: {
  ports: () => Promise<ListeningPort[]>;
  /** The model list at an endpoint; throws when it has none. */
  list: (endpointUrl: string) => Promise<ModelChoice[]>;
  /** Whether the server at this base URL lists voices (GET /v1/audio/voices). */
  speech?: (baseUrl: string) => Promise<boolean>;
  /** Whether the server at this base URL is whisper.cpp's. */
  whisper?: (baseUrl: string, command: string) => Promise<boolean>;
}): Promise<FoundServers> {
  const ports = candidates(await options.ports());
  const answered = await Promise.all(ports.map(async ({ command, port }) => {
    const baseUrl = `http://localhost:${port}`;
    const endpointUrl = `${baseUrl}/v1`;
    let needsKey = false;
    const [speaks, models] = await Promise.all([
      options.speech?.(baseUrl).catch(() => false) ?? false,
      options.list(endpointUrl).catch((error: unknown) => {
        needsKey = error instanceof ModelListingAuthError;
        return [] as ModelChoice[];
      }),
    ]);
    const { label, known } = serverLabel(command);
    if (speaks) return { voice: { name: voiceServerName('speech', command, port), baseUrl, kind: 'speech' as const }, known, port };
    if (models.length) return { server: { name: `${label} · ${port}`, endpointUrl, models }, known, port };
    if (needsKey) return { server: { name: `${label} · ${port}`, endpointUrl, models: [], needsKey: true }, known, port };
    if (await options.whisper?.(baseUrl, command).catch(() => false))
      return { voice: { name: voiceServerName('whisper.cpp', command, port), baseUrl, kind: 'whisper.cpp' as const }, known, port };
    return null;
  }));
  const found = answered
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((left, right) => Number(right.known) - Number(left.known) || left.port - right.port);
  return {
    chat: found.flatMap(entry => 'server' in entry && entry.server ? [entry.server] : []),
    voice: found.flatMap(entry => 'voice' in entry && entry.voice ? [entry.voice] : []),
  };
}

export async function detectLocalServers(options: {
  ports: () => Promise<ListeningPort[]>;
  /** The model list at an endpoint; throws when it has none. */
  list: (endpointUrl: string) => Promise<ModelChoice[]>;
}): Promise<LocalServer[]> {
  return (await detectServers(options)).chat;
}
