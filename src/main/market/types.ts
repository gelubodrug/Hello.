export interface MarketSourceView {
  id: string;
  name: string;
  description: string;
  homepage: string;
  endpointHost: string;
  builtIn: boolean;
  partner: boolean;
  selected: boolean;
  /** False for a source Hello lists but cannot read yet. */
  available: boolean;
  /** In the person's list of sources; a built-in partner is listed to add until then. */
  added: boolean;
  attribution: { name: string; url: string; notice: string };
}

export interface MarketItemView {
  key: string;
  name: string;
  summary: string;
  publisher?: string;
  categories: string[];
  repository: string;
  installable: boolean;
  manualCommand?: string;
  sourceName: string;
  /** Opaque: pass to icon() for a data URL. */
  icon?: string;
  installs: number;
  stars: number;
  updatedAt?: string;
}

export interface MarketPageView {
  items: MarketItemView[];
  total: number;
  /** Every entry the source holds, when a filter narrows `total`. */
  unfiltered?: number;
  nextCursor?: string;
  categories: string[];
  generatedAt?: string;
}

export interface CatalogQuery {
  q?: string;
  /** One category, the only shape a source's own endpoint takes. */
  category?: string;
  /** Several categories supplied by a caller. */
  categories?: string[];
  sort?: 'downloads' | 'updated' | 'name' | 'stars';
  cursor?: string;
  limit?: number;
  locale?: string;
  /** Installable view: only entries with an npm target. */
  installable?: boolean;
}

