// What a kept connection is called wherever it is listed: Settings' saved
// connections and the chat's model picker.

const THIS_MAC = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/i;

/** An address that reaches this Mac itself, as a URL's hostname spells it. */
export const onThisMac = (hostname: string): boolean => THIS_MAC.test(hostname);

/**
 * A server on this Mac is whatever answers at its port now. kapitsa took port
 * 8000 from oMLX, and the name kept from oMLX went on calling it
 * "oMLX · Qwen3-Coder-Next-6bit", over a model oMLX never had (user, 12.11).
 * So an address on this Mac is named by the server running there, or by the
 * address itself while none is; a provider elsewhere keeps its kept name.
 */
export function connectionName(
  kept: { name: string; endpointUrl: string },
  running: ReadonlyArray<{ name: string; endpointUrl: string }>,
): string {
  let url: URL;
  try { url = new URL(kept.endpointUrl.trim()); } catch { return kept.name; }
  if (!THIS_MAC.test(url.hostname)) return kept.name;
  const samePort = (endpointUrl: string) => {
    try {
      const other = new URL(endpointUrl);
      return THIS_MAC.test(other.hostname) && other.port === url.port;
    } catch { return false; }
  };
  return running.find(server => samePort(server.endpointUrl))?.name ?? url.host;
}
