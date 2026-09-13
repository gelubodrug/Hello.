// jsdom marks every dispatchEvent() untrusted, as a browser does for page
// scripts. The page-mode probe only listens to the person, so tests that play
// the person dispatch through jsdom's own internals with isTrusted set.
const implOf = (wrapper: object): Record<string, unknown> & { isTrusted?: boolean; _dispatch?: (event: unknown) => boolean } => {
  for (const symbol of Object.getOwnPropertySymbols(wrapper)) {
    const value = (wrapper as Record<symbol, unknown>)[symbol];
    if (value && typeof value === 'object') return value as never;
  }
  throw new Error('Not a jsdom wrapper.');
};

/** Dispatches `event` on `target` as the user agent would: isTrusted is true. */
export function dispatchTrusted(target: EventTarget, event: Event): boolean {
  const impl = implOf(event);
  const targetImpl = implOf(target);
  impl.isTrusted = true;
  return targetImpl._dispatch!(impl);
}
