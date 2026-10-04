import { gt, valid } from 'semver';

/**
 * Whether the engines Hello runs — Pi, and dsh behind the DSH surface — have
 * a newer release (user, 01.10: "v.xxx (update) dacă există versiune nouă,
 * dacă nu, nu"). npm's `latest` tag is the release; asking costs one small
 * request to the public registry, with nothing of the person's in it.
 */
export const NPM_REGISTRY = 'https://registry.npmjs.org';

/** The version npm tags `latest` for a package, or undefined when npm cannot say. */
export async function npmLatest(name: string, fetcher: typeof fetch = fetch, timeoutMs = 10_000): Promise<string | undefined> {
  try {
    const response = await fetcher(`${NPM_REGISTRY}/${encodeURIComponent(name).replace('%40', '@')}/latest`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) return undefined;
    const version = ((await response.json()) as { version?: unknown }).version;
    return typeof version === 'string' && valid(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/** `latest`, when it is newer than what runs; otherwise nothing to offer. */
export function newer(latest: string | undefined, current: string): string | undefined {
  return latest && valid(latest) && valid(current) && gt(latest, current) ? latest : undefined;
}
