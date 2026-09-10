import type { Endpoint } from '../../shared/types';

/**
 * How an endpoint identifies itself in a list, and what to add when that is not
 * enough to tell it from the row above it.
 *
 * Shared because the app has two endpoint lists and only one of them is the one
 * the user actually reaches: endpoint and model selection live in the composer
 * chip (DESIGNUIguide.md §Window chrome). Anything that helps someone pick the
 * right endpoint has to be here, not in one component.
 */

/** Prefer the human name; fall back to the base URL when it is empty. */
export function endpointLabel(endpoint: Endpoint): string {
  return endpoint.displayName.trim().length > 0 ? endpoint.displayName : endpoint.baseUrl;
}

/**
 * Ids of endpoints that another endpoint is indistinguishable from — same
 * label, same base URL, so the line a list prints for them is word-for-word
 * identical.
 *
 * Registering the same provider twice is easy to do and impossible to see
 * afterwards: every copy reads "OpenRouter", including one whose key never got
 * stored, which then fails on every send for no visible reason. Rows in such a
 * group carry the facts that actually differ (`endpointDistinguisher`); rows
 * that are already unique carry nothing extra, because there a "no key" tag
 * would only libel a local server that needs none.
 *
 * This distinguishes; it does not judge. Nothing here merges, reorders, or
 * removes an endpoint — which of the copies to keep is the user's call.
 */
export function ambiguousEndpointIds(endpoints: readonly Endpoint[]): ReadonlySet<string> {
  const byKey = new Map<string, string[]>();
  for (const endpoint of endpoints) {
    // NUL separates the halves so a label ending in the URL's first word
    // cannot collide with a shorter label and a longer URL.
    const key = `${endpointLabel(endpoint)}\u0000${endpoint.baseUrl}`;
    const ids = byKey.get(key);
    if (ids) ids.push(endpoint.id);
    else byKey.set(key, [endpoint.id]);
  }

  const ambiguous = new Set<string>();
  for (const ids of byKey.values()) {
    if (ids.length > 1) for (const id of ids) ambiguous.add(id);
  }
  return ambiguous;
}

/**
 * The trailing detail line for an endpoint whose name does not identify it.
 * Only facts already on the endpoint: whether a key is stored, and when it last
 * verified. The base URL is deliberately not among them — endpoints only reach
 * this function when theirs are identical.
 */
export function endpointDistinguisher(endpoint: Endpoint): string {
  const verified =
    endpoint.verifiedAt !== null
      ? `verified ${new Date(endpoint.verifiedAt).toLocaleString()}`
      : 'never verified';
  return `${endpoint.hasApiKey ? 'key stored' : 'no key stored'} · ${verified}`;
}
