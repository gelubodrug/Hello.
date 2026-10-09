import type { MarketApi, MarketInstalledPlugin, MarketKind, MarketPreview } from '../../shared/types';
import { api } from '../api';

export interface MarketCopy {
  title: string;
  subtitle: string;
  /** What one entry is called: Plugin, Package. */
  item: string;
  searchPlaceholder: string;
  unavailable: string;
  loading: string;
  noInstallable: string;
  noInstallableHint?: string;
  noMatch: string;
  installableBlurb: string;
  installedBlurb: string;
  installedLoading: string;
  installedEmptyTitle: string;
  installedEmptyText: string;
  kindLabel(kind: MarketInstalledPlugin['kind']): string;
  sourcesBlurb: string;
  sourcesGuide: string;
  /** Where an operation lands, in the confirmation's facts. */
  target: { label: string; value(preview: MarketPreview): string };
  done(preview: MarketPreview): string;
  /** What to do after an operation, or nothing when nothing has to happen. */
  afterNote?: string;
  /** Said after an operation when there is no restart to offer. */
  doneNote?: string;
  describeConfirm(action: MarketPreview['action']): string;
  failed: string;
  installWarnings: string[];
  /**
   * The gallery's own filters in the toolbar — a type, an order, Reset and a
   * "1–50 / N" count — instead of category pills (Pi, user 29.09: "pune
   * filtrele de la pagina oficială pi").
   */
  filters?: {
    types: Array<{ value: string; label: string }>;
    sorts: Array<{ value: 'downloads' | 'updated' | 'name'; label: string }>;
  };
  /** Each card says who made it, its downloads a month and when it was last published. */
  cardMeta?: boolean;
}

const PI_COPY: MarketCopy = {
  title: 'Pi Package Market',
  subtitle: 'Discover Pi packages — extensions, skills and prompt templates — from pi.dev/packages',
  item: 'Package',
  searchPlaceholder: 'Filter packages…',
  unavailable: 'The package catalog is temporarily unavailable',
  loading: 'Loading package catalog...',
  noInstallable: 'No packages in the current source',
  noMatch: 'No matching packages',
  installableBlurb: 'Every Pi package installs from npm. Before installation, Hello. resolves npm latest and checks that it is a Pi package the Pi in Hello. can run.',
  installedBlurb: 'Packages installed from this market appear here, with an update when npm has a newer version, and plugins imported into Hello. another way. An installed package is off in every chat until you turn it on there.',
  installedLoading: 'Reading Hello.’s library...',
  installedEmptyTitle: 'No Pi packages installed yet',
  installedEmptyText: 'Install packages from Discover or Installable; they appear here to update or uninstall.',
  kindLabel: kind => kind === 'plugin' ? 'Installed from the market' : 'Imported into Hello.',
  sourcesBlurb: 'The Pi market reads the official gallery, pi.dev/packages, where every Pi package published on npm is listed. Use only packages you trust.',
  sourcesGuide: 'The list, its filters and its counts are pi.dev/packages’ own; when pi.dev does not answer, Hello. reads npm’s search instead. Every install comes from npm.',
  target: { label: 'Installed to', value: () => 'Hello.’s library — off in every chat until you turn it on there' },
  done: preview => preview.action === 'uninstall' ? `${preview.packageName} is removed from Hello.’s library and from every chat.`
    : preview.action === 'update' ? `${preview.packageName} is updated to ${preview.version}.`
      : `${preview.packageName}@${preview.version} is in Hello.’s library.`,
  doneNote: 'Turn it on in a chat from the Extensions menu beside the composer. A chat’s Pi loads the change with its next message; nothing else restarts.',
  describeConfirm: action => action === 'uninstall' ? 'The package leaves Hello.’s library and every chat that had it on.'
    : action === 'update' ? 'npm’s newest version replaces the installed one. Chats that have it on use it from their next message.'
      : 'Review the npm package, its version and what it brings to Hello.',
  failed: 'Hello. could not complete the operation. Nothing in the library changed.',
  installWarnings: [
    'Extensions run as local code with your user permissions, inside the Pi process of each chat you turn them on for. Install only packages you trust.',
    'Hello. installs without install scripts; a package that needs one may not work.',
  ],
  // pi.dev/packages' own two menus, in its words.
  filters: {
    types: [
      { value: '', label: 'All types' },
      { value: 'extension', label: 'extension' },
      { value: 'skill', label: 'skill' },
      { value: 'theme', label: 'theme' },
      { value: 'prompt', label: 'prompt' },
    ],
    sorts: [
      { value: 'downloads', label: 'Most downloads' },
      { value: 'updated', label: 'Recently published' },
      { value: 'name', label: 'A-Z' },
    ],
  },
  cardMeta: true,
};

export const MARKETS: Record<MarketKind, { api(): MarketApi | undefined; copy: MarketCopy }> = {
  // Optional while a renderer hot update runs against an older preload.
  pi: { api: () => (api as Partial<typeof api>).piMarket, copy: PI_COPY },
};
