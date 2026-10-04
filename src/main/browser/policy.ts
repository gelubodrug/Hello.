import type { AgentControl, BrowserTab, ViewBounds } from '../../shared/types';

const SCHEME = /^[a-z][a-z\d+.-]*:/i;
/** An address typed without its scheme: a name with a dot, a port, a path. */
const bareAddress = (value: string) => /^[\w.-]+(?::\d+)?(?:\/[^\s]*)?$/.test(value) && value.includes('.');
/** Names of the person's own network rather than of the web. */
const OWN_NETWORK = /(?:^|\.)(?:localhost|local|lan|home|corp|internal|intranet|test|example|invalid|arpa)$/;

/** The web search for words typed in the address bar. */
function searchURL(words: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(words)}`;
}

export function browserURL(input: string): string {
  const value = input.trim();
  if (value === 'about:blank' || value === '') return 'about:blank';
  const candidate = SCHEME.test(value) ? value : bareAddress(value) ? `https://${value}` : searchURL(value);
  const url = new URL(candidate);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use a web address beginning with https:// or http://.');
  }
  if (url.href.length > 8192) throw new Error('This address is too long.');
  return url.href;
}

/**
 * The search a typed address becomes when no site answers to its name, as in
 * any browser (user, 30.09: "smarbill.ro", a letter short of the site, ended
 * in an error). Only a bare name: an address typed with its scheme asks for
 * exactly that address. And only a name on the web: a port, an IP or a name
 * of the person's own network points at a machine of theirs, which a search
 * engine could not find and has no business hearing of.
 */
export function searchInstead(input: string): string | null {
  const value = input.trim();
  if (SCHEME.test(value) || !bareAddress(value)) return null;
  const host = value.split('/')[0].toLowerCase().replace(/\.$/, '');
  if (host.includes(':') || /^[\d.]+$/.test(host) || OWN_NETWORK.test(host)) return null;
  return searchURL(value);
}

export function checkAgentOwnership(tab: BrowserTab, conversationId: string): void {
  if (tab.conversationId !== conversationId) throw new Error('This tab belongs to a different chat.');
}

export function checkAgentAccess(tab: BrowserTab, conversationId: string, mutation = false): void {
  checkAgentOwnership(tab, conversationId);
  if (tab.control === 'off') throw new Error('Agent control is Off for this tab. Ask the user to enable it.');
  if (mutation && tab.control !== 'full') throw new Error('This tab is read only. Full control must be enabled by the user.');
}

export function isAgentControl(mode: unknown): mode is AgentControl {
  return mode === 'off' || mode === 'read' || mode === 'full';
}

export function safeBounds(bounds: ViewBounds, windowWidth: number, windowHeight: number): ViewBounds {
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
    throw new Error('Invalid browser viewport.');
  }
  const x = Math.min(windowWidth, Math.max(0, Math.round(bounds.x)));
  // The native browser never owns app title/header chrome, even with bad renderer geometry.
  const y = Math.min(windowHeight, Math.max(48, Math.round(bounds.y)));
  return { x, y, width: Math.max(0, Math.min(windowWidth - x, Math.round(bounds.width))), height: Math.max(0, Math.min(windowHeight - y, Math.round(bounds.height))) };
}
