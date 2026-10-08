import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpRight, ArrowUpCircle, Check, Database, Download, Globe, Library, Plus, Puzzle, RefreshCw, Search, Settings2, Trash2, X } from 'lucide-react';
import type { MarketInstalledPlugin, MarketItem, MarketKind, MarketPage, MarketPreview, MarketResult, MarketScan, MarketSource } from '../../shared/types';
import { api } from '../api';
import { errorText } from '../ui/primitives';
import { MARKETS, type MarketCopy } from './markets';
import { formatNumber, t } from '../i18n';
import './market.css';

/**
 * The Community Plugin Market, ported from dsh-community-market
 * (src/client/MarketSettingsTab.tsx, MarketOverlay.tsx; MIT, Anywhere Labs).
 * Same views, same words, same geometry and stylesheet; Hello supplies the
 * primitives, the colours, and a main process that does every fetch and
 * every install. Adaptations: installs go to the DSH surface's profile, a
 * restart restarts the DSH host (not the app), and the confirmation says
 * what the plugin brings to Hello.
 *
 * The same window shows the Pi package market (user, 29.09): `kind` picks the
 * market's handles and words (markets.ts); nothing else differs. An installed
 * package is updated or uninstalled from Installed, in either market.
 */
type View = 'discover' | 'installable' | 'installed' | 'sources';

const iconCache = new Map<string, Promise<string | null>>();
function useIcon(kind: MarketKind, ref?: string): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const market = MARKETS[kind].api();
    if (!ref || !market) { setSrc(null); return; }
    let alive = true;
    // Each market hands out its own icon references.
    const key = `${kind}:${ref}`;
    let pending = iconCache.get(key);
    if (!pending) { pending = market.icon(ref).catch(() => null); iconCache.set(key, pending); }
    void pending.then(value => { if (alive) setSrc(value); });
    return () => { alive = false; };
  }, [kind, ref]);
  return src;
}

function Pill({ children, pressed, onClick, className }: { children: ReactNode; pressed?: boolean; onClick?: () => void; className?: string }): JSX.Element {
  return onClick
    ? <button type="button" className={`p-pill${className ? ` ${className}` : ''}`} aria-pressed={pressed} onClick={onClick}>{children}</button>
    : <span className={`p-pill${className ? ` ${className}` : ''}`}>{children}</span>;
}

function Button({ variant = 'outline', size, icon, children, iconOnly, ...rest }: { variant?: 'primary' | 'outline' | 'ghost'; size?: 'sm'; icon?: ReactNode; iconOnly?: boolean; children?: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return <button type="button" className="p-btn" data-variant={variant} data-size={size} data-icon-only={iconOnly || undefined} {...rest}>{icon}{children}</button>;
}

function Dot({ state }: { state: 'warning' | 'done' | 'error' | 'ongoing' }): JSX.Element {
  return <i className="p-dot" data-state={state} aria-hidden />;
}

function Warning({ children }: { children: ReactNode }): JSX.Element {
  return <div className="dshMarketOperationWarning"><Dot state="warning" /><span>{children}</span></div>;
}

function PluginIcon({ item, kind, large = false }: { item: MarketItem; kind: MarketKind; large?: boolean }): JSX.Element {
  const src = useIcon(kind, item.icon);
  return (
    <div className={large ? 'dshMarketGlyph dshMarketGlyphLarge' : 'dshMarketGlyph'}>
      <Puzzle size={large ? 28 : 20} />
      {src && <img src={src} alt="" />}
    </div>
  );
}

function Modal({ title, description, className, children, footer, onClose }: { title: string; description?: string; className: string; children: ReactNode; footer: ReactNode; onClose(): void }): JSX.Element {
  return (
    <div className="dshMarketModalBackdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`p-modal dshMarketModal ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="p-modal-head">
          <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
          <Button variant="ghost" size="sm" iconOnly aria-label="Close" onClick={onClose} icon={<X size={16} />} />
        </header>
        <div className="p-modal-body dshMarketModalContent">{children}</div>
        <footer className="p-modal-foot"><div className="dshMarketModalActions">{footer}</div></footer>
      </div>
    </div>
  );
}

function SourceRow({ source, name }: { source?: MarketSource; name: string }): JSX.Element {
  const href = source?.homepage;
  return (
    <div className="dshMarketItemSourceRow">
      <span>Source:</span>
      {href
        ? <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`Source: ${name}`} onClick={event => { event.preventDefault(); void api.system.openExternal(href); }}>{name} <ArrowUpRight size={12} /></a>
        : <span>{name}</span>}
    </div>
  );
}

function Facts({ preview, copy, extra }: { preview: MarketPreview; copy: MarketCopy; extra?: ReactNode }): JSX.Element {
  return (
    <dl className="dshMarketOperationFacts">
      <div><dt>{copy.item}</dt><dd>{preview.displayName}</dd></div>
      <div><dt>{preview.folder ? 'Package' : 'npm package'}</dt><dd>{preview.packageName}</dd></div>
      {preview.folder && <div className="hello-add"><dt>Folder</dt><dd>{preview.folder} (linked: edits apply on the next restart)</dd></div>}
      {preview.from && <div className="hello-add"><dt>Installed version</dt><dd>{preview.from}</dd></div>}
      {preview.version && <div><dt>{preview.action === 'update' ? 'New exact version' : 'Exact version'}</dt><dd>{preview.version}</dd></div>}
      <div><dt>{copy.target.label}</dt><dd>{copy.target.value(preview)}</dd></div>
      {extra}
    </dl>
  );
}

/** Downloads a month the way pi.dev writes them: 1,740/mo, 1.2M/mo — the
 *  shape is pi.dev's, the digits and the words are the active locale's. */
export function monthlyDownloads(count: number): string {
  const shown = count >= 1_000_000
    ? t('millions', { n: formatNumber(+(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)) })
    : formatNumber(Math.max(0, Math.round(count)));
  return t('perMonth', { n: shown });
}

/** How long ago, the way pi.dev writes it: 44m ago, 19h ago, 3d ago. */
export function publishedAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'just now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  if (days < 30) return `${Math.floor(days)}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function PluginCard({ item, kind, action, meta = false, onOpen }: { item: MarketItem; kind: MarketKind; action?: string; meta?: boolean; onOpen(): void }): JSX.Element {
  return (
    <button type="button" className="dshMarketCard" aria-haspopup="dialog" aria-label={action ? `${action}: ${item.name}` : undefined} onClick={onOpen}>
      <div className="dshMarketCardTop">
        <PluginIcon item={item} kind={kind} />
        <div className="dshMarketCardName"><strong>{item.name}</strong><span>{item.publisher ?? item.sourceName}</span></div>
      </div>
      <p className="dshMarketSummary">{item.summary}</p>
      {meta && (
        <div className="dshMarketCardMeta">
          {item.publisher && <span>{item.publisher}</span>}
          <span>{monthlyDownloads(item.installs)}</span>
          {item.updatedAt && <span title={new Date(item.updatedAt).toLocaleString()}>{publishedAgo(item.updatedAt)}</span>}
        </div>
      )}
      <div className="dshMarketTags">
        <Pill>Source: {item.sourceName}</Pill>
        {action && <Pill>{action}</Pill>}
        {item.categories.slice(0, 2).map(category => <Pill key={category}>{category}</Pill>)}
      </div>
    </button>
  );
}

interface Operation {
  item?: MarketItem;
  preview?: MarketPreview;
  phase: 'checking' | 'details' | 'confirm' | 'running' | 'done' | 'failed';
  error?: string;
  result?: MarketResult;
}

export function MarketDialog({ kind = 'dsh', open, onClose, initialView = 'installable', addByName, addFromFolder }: { /** Which market this window shows. */ kind?: MarketKind; open: boolean; onClose(): void; initialView?: View; /** A package the person typed in Settings: previewed at once. */ addByName?: string; /** Asks main for a plugin folder, then previews it. */ addFromFolder?: boolean }): JSX.Element | null {
  const definition = MARKETS[kind];
  const market = definition.api();
  const copy = definition.copy;
  const [view, setView] = useState<View>(initialView);
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [category, setCategory] = useState<string | undefined>();
  // The DSH market's pills pick several at once (an item in any of them); the
  // Pi market's one <select> keeps using `category`.
  const [picked, setPicked] = useState<string[]>([]);
  const [scan, setScan] = useState<MarketScan | undefined>();
  const [scanning, setScanning] = useState(false);
  const [sort, setSort] = useState<'downloads' | 'updated' | 'name'>('downloads');
  const [pages, setPages] = useState<Record<'discover' | 'installable', MarketPage | undefined>>({ discover: undefined, installable: undefined });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [loadMoreError, setLoadMoreError] = useState<string | undefined>();
  const [installed, setInstalled] = useState<MarketInstalledPlugin[] | undefined>();
  const [sources, setSources] = useState<MarketSource[]>([]);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [sourcePending, setSourcePending] = useState(false);
  const [sourceError, setSourceError] = useState<string | undefined>();
  const [addOpen, setAddOpen] = useState(false);
  const [manifestUrl, setManifestUrl] = useState('');
  const request = useRef(0);

  const load = useCallback(async (which: 'discover' | 'installable', options: { more?: boolean; reload?: boolean } = {}) => {
    if (!market) return;
    const id = ++request.current;
    const current = pages[which];
    setLoading(true);
    if (!options.more) setError(undefined);
    setLoadMoreError(undefined);
    try {
      const page = await market.query({
        ...(submitted ? { q: submitted } : {}),
        ...(category ? { category } : {}),
        ...(picked.length ? { categories: picked } : {}),
        ...(copy.filters && sort !== 'downloads' ? { sort } : {}),
        ...(which === 'installable' ? { installable: true } : { limit: 50 }),
        ...(options.more && current?.nextCursor ? { cursor: current.nextCursor } : {}),
        ...(options.reload ? { reload: true } : {}),
      });
      if (id !== request.current) return;
      setPages(previous => ({ ...previous, [which]: options.more && current ? { ...page, items: [...current.items, ...page.items] } : page }));
    } catch (reason) {
      if (id !== request.current) return;
      if (options.more) setLoadMoreError('More results could not be loaded. Results already shown are unaffected.');
      else setError(errorText(reason));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [market, submitted, category, picked, sort, pages, copy.filters]);

  /** A change to the source list: the lists shown so far belonged to the old source. */
  const mutateSources = async (change: () => Promise<MarketSource[]> | undefined): Promise<boolean> => {
    setSourcePending(true);
    setSourceError(undefined);
    try {
      const next = await change();
      if (!next) return false;
      const before = sources.find(source => source.selected)?.id;
      setSources(next);
      if (next.find(source => source.selected)?.id !== before) {
        setPages({ discover: undefined, installable: undefined });
        setCategory(undefined);
        setPicked([]);
        // A catalogue is read per source; the one held is not this one's.
        setScan(undefined);
        void market?.scanState?.().then(setScan).catch(() => {});
      }
      return true;
    } catch (reason) {
      setSourceError(errorText(reason));
      return false;
    } finally {
      setSourcePending(false);
    }
  };

  const refreshInstalled = useCallback(() => {
    void market?.installed().then(setInstalled).catch(reason => setError(errorText(reason)));
  }, [market]);

  useEffect(() => { if (open) void market?.sources().then(setSources).catch(() => {}); }, [open, market]);
  useEffect(() => { if (open) void market?.scanState?.().then(setScan).catch(() => {}); }, [open, market]);
  useEffect(() => {
    if (!open || !addByName || !market) return;
    let alive = true;
    setOperation({ phase: 'checking' });
    void market.previewByName(addByName)
      .then(preview => { if (alive) setOperation({ preview, phase: 'confirm' }); })
      .catch(reason => { if (alive) { setOperation(null); setError(errorText(reason)); setView('installed'); } });
    return () => { alive = false; };
  }, [open, addByName, market]);
  useEffect(() => {
    if (!open || !addFromFolder || !market?.previewFolder) return;
    let alive = true;
    setView('installed');
    void market.previewFolder()
      .then(preview => { if (alive) setOperation(preview ? { preview, phase: 'confirm' } : null); if (!preview && alive) onClose(); })
      .catch(reason => { if (alive) setError(errorText(reason)); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, addFromFolder, market]);
  useEffect(() => {
    if (!open) return;
    if (view === 'discover' || view === 'installable') void load(view);
    if (view === 'installed') refreshInstalled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view, submitted, category, picked, sort]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (operation) { if (operation.phase !== 'running') setOperation(null); }
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, operation, onClose]);

  const openItem = async (item: MarketItem) => {
    if (!market) return;
    if (!item.installable) { setOperation({ item, phase: 'details' }); return; }
    setOperation({ item, phase: 'checking' });
    try {
      const preview = await market.preview(item.key);
      setOperation(current => current?.item === item ? { item, preview, phase: 'confirm' } : current);
    } catch (reason) {
      setOperation(current => current?.item === item ? { item, phase: 'details', error: errorText(reason) } : current);
    }
  };
  const uninstall = async (packageName: string) => {
    if (!market) return;
    try { setOperation({ preview: await market.previewUninstall(packageName), phase: 'confirm' }); }
    catch (reason) { setError(errorText(reason)); }
  };
  const update = async (packageName: string) => {
    if (!market?.previewUpdate) return;
    setError(undefined);
    setOperation({ phase: 'checking' });
    try { setOperation({ preview: await market.previewUpdate(packageName), phase: 'confirm' }); }
    catch (reason) { setOperation(null); setError(errorText(reason)); }
  };
  const confirm = async () => {
    if (!market || !operation?.preview) return;
    const current = operation;
    setOperation({ ...current, phase: 'running', error: undefined });
    try {
      const result = await market.confirm(current.preview!.token);
      setOperation({ ...current, phase: 'done', result });
      refreshInstalled();
    } catch (reason) {
      setOperation({ ...current, phase: 'failed', error: errorText(reason) });
    }
  };
  const restart = async () => {
    if (!definition.restart) { setOperation(null); return; }
    setRestarting(true);
    try {
      await definition.restart();
      setOperation(null);
    } catch (reason) {
      setOperation(current => current ? { ...current, error: errorText(reason) } : current);
    } finally {
      setRestarting(false);
    }
  };

  const page = view === 'discover' || view === 'installable' ? pages[view] : undefined;
  const current = sources.find(source => source.selected);
  const categories = useMemo(() => pages.discover?.categories ?? pages.installable?.categories ?? [], [pages]);
  if (!open || !market) return null;

  const filters = copy.filters;
  const reset = () => { setQuery(''); setSubmitted(''); setCategory(undefined); setPicked([]); setSort('downloads'); };
  const readCatalogue = async () => {
    if (!market?.scan) return;
    setScanning(true);
    setError(undefined);
    try {
      setScan(await market.scan());
      setPages({ discover: undefined, installable: undefined });
      await load(view === 'installable' ? 'installable' : 'discover');
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setScanning(false);
    }
  };
  // "1–50 / 305 (of 5548)", as the gallery counts.
  const counted = page ? `${page.items.length ? 1 : 0}–${page.items.length} / ${page.total.toLocaleString('en-US')}${page.unfiltered !== undefined && page.unfiltered !== page.total ? ` (of ${page.unfiltered.toLocaleString('en-US')})` : ''}` : '';
  const toolbar = (
    <form className="dshMarketToolbar" onSubmit={event => { event.preventDefault(); setSubmitted(query.trim()); }}>
      <label className="p-input dshMarketSearch"><Search size={14} /><input value={query} placeholder={copy.searchPlaceholder} aria-label={copy.searchPlaceholder} onChange={event => setQuery(event.currentTarget.value)} /></label>
      {filters && (
        <>
          <label className="p-input dshMarketSelect">
            <select aria-label="Type" value={category ?? ''} onChange={event => setCategory(event.currentTarget.value || undefined)}>
              {filters.types.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="p-input dshMarketSelect">
            <select aria-label="Order" value={sort} onChange={event => setSort(event.currentTarget.value as typeof sort)}>
              {filters.sorts.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        </>
      )}
      <Button type="submit" variant="primary" icon={<Search size={14} />}>Search</Button>
      {filters && <Button variant="ghost" onClick={reset}>Reset</Button>}
      <Button variant="ghost" size="sm" iconOnly aria-label="Refresh" title="Refresh" disabled={loading} onClick={() => void load(view as 'discover', { reload: true })} icon={<RefreshCw size={14} />} />
      {filters ? <span className="dshMarketCount" role="status">{counted}</span> : <Pill>{page?.items.length ?? 0}</Pill>}
    </form>
  );
  const categoryPills = !filters && (categories.length > 0 || market.scan) && (
    <div className="dshMarketCategories" role="group" aria-label="Categories">
      <span>Categories</span>
      {categories.map(name => (
        <Pill key={name} pressed={picked.includes(name)} onClick={() => setPicked(value => value.includes(name) ? value.filter(item => item !== name) : [...value, name])}>{name}</Pill>
      ))}
      {picked.length > 1 && <Pill onClick={() => setPicked([])}>Clear {picked.length}</Pill>}
      {/* Several categories and an exact count need the whole catalogue: a
          source's own search is one page and one category at a time. */}
      {market.scan && (
        <Button
          variant="ghost"
          size="sm"
          disabled={scanning || loading}
          icon={<Library size={14} />}
          title={scan?.scanned
            ? `${scan.items.toLocaleString('en-US')} entries read from ${scan.pages} page(s)${scan.complete ? '' : ', stopped before the end'}. Searches are answered from these.`
            : 'Read every page of this source once, so searches are counted exactly and several categories can be picked at a time'}
          onClick={() => void readCatalogue()}
        >
          {scanning ? 'Reading the catalogue…' : scan?.scanned ? `Catalogue: ${scan.items.toLocaleString('en-US')}` : 'Read the whole catalogue'}
        </Button>
      )}
    </div>
  );
  const grid = (items: MarketItem[], action?: string) => (
    <>
      {error && <div className="dshMarketEmpty" role="alert"><Dot state="error" /><h2>{copy.unavailable}</h2><p>{error}</p><Button icon={<RefreshCw size={14} />} onClick={() => void load(view as 'discover', { reload: true })}>Retry</Button></div>}
      {!error && loading && !items.length && <div className="dshMarketEmpty"><Dot state="ongoing" /><p>{copy.loading}</p></div>}
      {!error && !loading && !items.length && <div className="dshMarketEmpty"><h2>{view === 'installable' ? copy.noInstallable : copy.noMatch}</h2>{view === 'installable' && copy.noInstallableHint && <p>{copy.noInstallableHint}</p>}</div>}
      <div className="dshMarketGrid">{items.map(item => <PluginCard key={item.key} item={item} kind={kind} meta={Boolean(copy.cardMeta)} {...(action ? { action } : {})} onOpen={() => void openItem(item)} />)}</div>
      {(page?.nextCursor || loadMoreError) && (
        <div className="dshMarketPagination">
          {loadMoreError && <div className="dshMarketPaginationError" role="status">{loadMoreError}</div>}
          {page?.nextCursor && <Button disabled={loading} onClick={() => void load(view as 'discover', { more: true })}>{loading ? 'Loading more...' : 'Load more'}</Button>}
        </div>
      )}
    </>
  );

  return (
    <div className="dshMarketOverlay dshMarketScope" role="dialog" aria-modal="true" aria-label={copy.title} data-market={kind}>
      <button className="dshMarketOverlayMask" type="button" aria-label="Close Plugin Market" onClick={onClose} />
      <section className="dshMarketOverlayPanel">
        <header className="dshMarketOverlayHeader">
          <div><h1>{copy.title}</h1><p>{copy.subtitle}</p></div>
          <Button variant="ghost" size="sm" iconOnly aria-label="Close Plugin Market" title="Close Plugin Market" onClick={onClose} icon={<X size={16} />} />
        </header>
        <div className="dshMarketOverlayBody">
          <section className="dshMarketRoot" aria-label={copy.title} aria-busy={loading}>
            <div className="dshMarketViewBar">
              <div className="dshMarketViewSwitch" role="group" aria-label={copy.title}>
                <Pill pressed={view === 'discover'} onClick={() => setView('discover')}><Database size={14} /><span>Discover</span></Pill>
                <Pill pressed={view === 'installable'} onClick={() => setView('installable')}><Download size={14} /><span>Installable</span></Pill>
                <Pill pressed={view === 'installed'} onClick={() => setView('installed')}><Check size={14} /><span>Installed</span></Pill>
                <Pill pressed={view === 'sources'} onClick={() => setView('sources')}><Settings2 size={14} /><span>Sources</span></Pill>
              </div>
              <Pill className="dshMarketCurrentSource">{current
                ? <a href={current.homepage} onClick={event => { event.preventDefault(); void api.system.openExternal(current.homepage); }}>Current source: {current.name} <ArrowUpRight size={12} /></a>
                : <span>No source selected</span>}</Pill>
            </div>
            <main className="dshMarketMain">
              {view === 'discover' && <div>{toolbar}{categoryPills}{grid(page?.items ?? [])}</div>}
              {view === 'installable' && (
                <div className="dshMarketContent">
                  <div className="dshMarketSectionHead">
                    <div><h2>Installable</h2><p>{copy.installableBlurb}</p></div>
                    <Button size="sm" disabled={loading} icon={<RefreshCw size={14} />} onClick={() => void load('installable', { reload: true })}>Check again</Button>
                  </div>
                  {page?.generatedAt && <div className="dshMarketIndexMeta" role="status"><span>Catalog updated: {new Date(page.generatedAt).toLocaleString()}</span></div>}
                  {toolbar}{categoryPills}{grid(page?.items ?? [], 'Install')}
                </div>
              )}
              {view === 'installed' && (
                <div className="dshMarketContent">
                  <div className="dshMarketSectionHead">
                    <div><h2>Installed</h2><p>{copy.installedBlurb}</p></div>
                    <Button size="sm" icon={<RefreshCw size={14} />} onClick={refreshInstalled}>Refresh</Button>
                  </div>
                  {error && <div className="dshMarketBanner" role="alert"><Dot state="error" />{error}</div>}
                  {installed === undefined && !error && <div className="dshMarketEmpty"><Dot state="ongoing" /><p>{copy.installedLoading}</p></div>}
                  {installed?.length === 0 && <div className="dshMarketEmpty"><h2>{copy.installedEmptyTitle}</h2><p>{copy.installedEmptyText}</p></div>}
                  {!!installed?.length && (
                    <div className="dshMarketReceipts">
                      {installed.map(row => (
                        <article className="dshMarketReceipt" key={row.packageName}>
                          <div className="dshMarketReceiptMain">
                            <div className="dshMarketReceiptTitle">
                              <Dot state="done" />
                              <h3>{row.packageName}</h3>
                              <Pill>{copy.kindLabel(row.kind)}</Pill>
                            </div>
                            <div className="dshMarketReceiptMeta"><span>{row.version}</span>{row.latest && <span>{row.latest} available</span>}{row.bundle && <span>Bundle</span>}</div>
                          </div>
                          <div className="dshMarketReceiptActions">
                            {row.kind === 'plugin' && row.latest && market.previewUpdate && <Button size="sm" variant="primary" aria-label={`Update ${row.packageName} to ${row.latest}`} icon={<ArrowUpCircle size={14} />} onClick={() => void update(row.packageName)}>Update to {row.latest}</Button>}
                            {row.kind === 'plugin' && <Button size="sm" aria-label={`Uninstall: ${row.packageName}`} icon={<Trash2 size={14} />} onClick={() => void uninstall(row.packageName)}>Uninstall</Button>}
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {view === 'sources' && (
                <div className="dshMarketContent">
                  <div className="dshMarketSectionHead">
                    <div><h2>Sources</h2><p>{copy.sourcesBlurb}</p></div>
                    <Button disabled={sourcePending || !market.addStandardSource} icon={<Plus size={14} />} onClick={() => { setSourceError(undefined); setAddOpen(true); }}>Add standard source</Button>
                  </div>
                  <div className="dshMarketBanner dshMarketSourceGuide"><Globe size={14} /><span>{copy.sourcesGuide}</span></div>
                  {sourceError && !addOpen && <div className="dshMarketBanner" role="alert"><Dot state="error" />{sourceError}</div>}
                  <div className="dshMarketSources" role="radiogroup" aria-label="Choose plugin source">
                    {sources.filter(source => source.added !== false).map((source, at, added) => (
                      <div className="dshMarketSource" key={source.id}>
                        <div>
                          <h3>{source.name}{source.partner && <Pill>Partner provider</Pill>}</h3>
                          <p>{source.description}</p>
                          <div className="dshMarketSourceAttribution"><a href={source.attribution.url} onClick={event => { event.preventDefault(); void api.system.openExternal(source.attribution.url); }}>{source.attribution.name}</a>{source.attribution.notice && <span>{source.attribution.notice}</span>}</div>
                          <div className="dshMarketSourceMeta"><span>{source.endpointHost}</span><span>{source.builtIn ? 'Built-in adapter' : 'Standard protocol'}</span>{source.selected && <span><Dot state={error ? 'error' : 'done'} />{error ? 'Unavailable on last check' : 'Available on last check'}</span>}</div>
                        </div>
                        <div className="dshMarketSourceActions">
                          <Button size="sm" role="radio" aria-checked={source.selected} disabled={sourcePending || !market.selectSource} icon={source.selected ? <Check size={14} /> : undefined} onClick={() => { if (!source.selected) void mutateSources(() => market.selectSource?.(source.id)); }}>{source.selected ? 'Current source' : 'Select this source'}</Button>
                          {/* The person's own order for the list. Which source
                              is used is still the selected one, not the first. */}
                          {market.moveSource && added.length > 1 && (
                            <>
                              <Button variant="ghost" size="sm" iconOnly aria-label={`Move ${source.name} up`} title="Move up" disabled={sourcePending || at === 0} icon={<ArrowUp size={14} />} onClick={() => void mutateSources(() => market.moveSource?.(source.id, 'up'))} />
                              <Button variant="ghost" size="sm" iconOnly aria-label={`Move ${source.name} down`} title="Move down" disabled={sourcePending || at === added.length - 1} icon={<ArrowDown size={14} />} onClick={() => void mutateSources(() => market.moveSource?.(source.id, 'down'))} />
                            </>
                          )}
                          <Button variant="ghost" size="sm" iconOnly aria-label="Remove source" title="Remove source" disabled={sourcePending || !market.removeSource} icon={<Trash2 size={14} />} onClick={() => void mutateSources(() => market.removeSource?.(source.id))} />
                        </div>
                      </div>
                    ))}
                  </div>
                  {sources.some(source => source.added === false) && (
                    <div className="dshMarketSources dshMarketAvailableSources">
                      {sources.filter(source => source.added === false).map(source => (
                        <div className="dshMarketSource" key={source.id}>
                          <div>
                            <h3>{source.name}{source.partner && <Pill>Partner provider</Pill>}</h3>
                            <p>{source.description}</p>
                            <div className="dshMarketSourceAttribution"><a href={source.attribution.url} onClick={event => { event.preventDefault(); void api.system.openExternal(source.attribution.url); }}>{source.attribution.name}</a>{source.attribution.notice && <span>{source.attribution.notice}</span>}</div>
                          </div>
                          <Button size="sm" disabled={sourcePending || !market.addSource} icon={<Plus size={14} />} onClick={() => void mutateSources(() => market.addSource?.(source.id))}>Add</Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </main>
          </section>
        </div>
      </section>
      {operation && <OperationModal kind={kind} copy={copy} canRestart={Boolean(definition.restart)} operation={operation} source={sources.find(source => source.name === operation.item?.sourceName)} restarting={restarting} onClose={() => setOperation(null)} onConfirm={() => void confirm()} onRestart={() => void restart()} />}
      {addOpen && (
        <Modal title="Add standard source" description="You can add multiple sources, but only one is used at a time. Use only plugin sources you trust." className="dshMarketSourceModal" onClose={() => { if (!sourcePending) setAddOpen(false); }}
          footer={<>
            <Button variant="ghost" disabled={sourcePending} onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button variant="primary" icon={<Plus size={14} />} disabled={sourcePending || !manifestUrl.trim()} onClick={() => { void mutateSources(() => market.addStandardSource?.(manifestUrl.trim())).then(added => { if (added) { setManifestUrl(''); setAddOpen(false); } }); }}>Add source</Button>
          </>}>
          <div className="dshMarketModalField">
            <label htmlFor={`${kind}-market-manifest`}>Source manifest URL</label>
            <div className="p-input"><input id={`${kind}-market-manifest`} value={manifestUrl} disabled={sourcePending} placeholder="https://example.com/catalog-source.json" onChange={event => setManifestUrl(event.currentTarget.value)} style={{ paddingLeft: 12 }} /></div>
            {sourceError && <div className="dshMarketError" role="alert">{sourceError}</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}

function OperationModal({ kind, copy, canRestart, operation, source, restarting, onClose, onConfirm, onRestart }: { kind: MarketKind; copy: MarketCopy; canRestart: boolean; operation: Operation; source?: MarketSource; restarting: boolean; onClose(): void; onConfirm(): void; onRestart(): void }): JSX.Element {
  const { item, preview, phase } = operation;
  const openRepository = () => { if (item) void api.system.openExternal(item.repository); };
  const noun = copy.item;
  if (phase === 'done' && preview) {
    const title = preview.action === 'install' ? `${noun} installed` : preview.action === 'update' ? `${noun} updated` : `${noun} uninstalled`;
    return (
      <Modal title={title} className="dshMarketStatusModal" onClose={onClose}
        footer={canRestart
          ? <><Button variant="ghost" disabled={restarting} onClick={onClose}>Restart later</Button><Button variant="primary" disabled={restarting} onClick={onRestart} icon={<RefreshCw size={14} />}>{restarting ? 'Restarting...' : 'Restart now'}</Button></>
          : <Button variant="primary" onClick={onClose}>Close</Button>}>
        <div className="dshMarketOperationReview">
          <Facts preview={preview} copy={copy} extra={operation.result && <div><dt>{preview.action === 'uninstall' ? 'Removed at' : 'Installed at'}</dt><dd>{new Date(operation.result.installedAt).toLocaleTimeString()}</dd></div>} />
          <div className="dshMarketOperationSuccess"><Dot state="done" /><span>{copy.done(preview)}</span></div>
          {copy.afterNote && <Warning>{copy.afterNote}</Warning>}
          {copy.doneNote && preview.action !== 'uninstall' && <div className="dshMarketBanner"><span>{copy.doneNote}</span></div>}
          {operation.error && <div className="dshMarketError" role="alert">{operation.error}</div>}
        </div>
      </Modal>
    );
  }
  if ((phase === 'confirm' || phase === 'running' || phase === 'failed') && preview) {
    const action = preview.action;
    const adding = action !== 'uninstall';
    const running = phase === 'running';
    const title = phase === 'failed'
      ? (action === 'install' ? `${noun} installation failed` : action === 'update' ? `${noun} update failed` : `${noun} removal failed`)
      : action === 'install' ? `Confirm ${noun.toLowerCase()} installation` : action === 'update' ? `Confirm ${noun.toLowerCase()} update` : `Confirm ${noun.toLowerCase()} removal`;
    const doing = action === 'install' ? 'Installing...' : action === 'update' ? 'Updating...' : 'Uninstalling...';
    return (
      <Modal title={title}
        description={phase === 'failed' ? copy.failed : copy.describeConfirm(action)}
        className={adding ? 'dshMarketWideModal' : 'dshMarketConfirmModal'} onClose={() => { if (!running) onClose(); }}
        footer={phase === 'failed'
          ? <Button variant="ghost" onClick={onClose}>Close</Button>
          : <><Button variant="ghost" disabled={running} onClick={onClose}>Cancel</Button><Button variant="primary" disabled={running || !preview.compatibility.ok} onClick={onConfirm} icon={action === 'uninstall' ? <Trash2 size={14} /> : action === 'update' ? <ArrowUpCircle size={14} /> : <Download size={14} />}>{running ? doing : action === 'install' ? 'Confirm install' : action === 'update' ? 'Confirm update' : 'Confirm uninstall'}</Button></>}>
        {action === 'install' && item && <SourceRow source={source} name={item.sourceName} />}
        <div className="dshMarketOperationReview">
          <Facts preview={preview} copy={copy} extra={adding && preview.hello && (
            <>
              <div className="hello-add"><dt>In Hello</dt><dd>{preview.hello.lines.join(' ')}</dd></div>
              <div><dt>Confirmation expires</dt><dd>{new Date(preview.expiresAt).toLocaleTimeString()}</dd></div>
            </>
          )} />
          {!preview.compatibility.ok && <div className="dshMarketFailureSummary" role="alert"><Dot state="error" /><span>{preview.compatibility.reason}</span></div>}
          {(adding ? copy.installWarnings : copy.afterNote ? [copy.installWarnings.at(-1)!] : []).map(text => <Warning key={text}>{text}</Warning>)}
          {running && <div className="dshMarketOperationProgress" role="status"><Dot state="ongoing" />{doing}</div>}
          {phase === 'failed' && operation.error && <div className="dshMarketFailureOutput"><span>Detailed output</span><pre>{operation.error}</pre></div>}
        </div>
      </Modal>
    );
  }
  // details: checking, a manual entry, or a failed preview
  return (
    <Modal title={item?.name ?? `${noun} details`} className="dshMarketWideModal" onClose={onClose}
      footer={<>{item && <Button icon={<ArrowUpRight size={12} />} onClick={openRepository}>Open source repository</Button>}<Button variant="ghost" onClick={onClose}>Close</Button></>}>
      {item && <SourceRow source={source} name={item.sourceName} />}
      {!item && <div className="dshMarketOperationProgress" role="status"><Dot state="ongoing" />Checking the package with npm...</div>}
      {item && (
        <div className="dshMarketDetails">
          <div className="dshMarketDetailsIntro"><PluginIcon item={item} kind={kind} large /><p>{item.summary}</p></div>
          {phase === 'checking' && <div className="dshMarketOperationProgress" role="status"><Dot state="ongoing" />Checking available installation methods...</div>}
          {operation.error && <div className="dshMarketBanner" role="alert"><Dot state="warning" /><span>{operation.error}</span></div>}
          {phase === 'details' && !item.installable && item.manualCommand ? (
            <div className="dshMarketManualInstall">
              <div><h3>Manual installation</h3><p>This catalog entry names a GitHub repository, not an npm package. Hello. installs only an exact npm version, so this entry cannot be installed from here. If the plugin is on npm, use Settings › Extensions › DSH surface › Add by npm name.</p></div>
              <div className="dshMarketCommand"><span>Install command (for DSH)</span><code>{item.manualCommand}</code></div>
              <Warning>This display-only command has not passed the complete package verification required for managed installation. Verify the source, contents, and compatibility yourself.</Warning>
              <Warning>This GitHub target follows the repository’s current HEAD. Its contents can change and are not pinned to the code shown now.</Warning>
              <Warning>Plugins run as local code with your user permissions. Install only plugins you trust.</Warning>
            </div>
          ) : phase === 'details' && !operation.error ? <div>This {noun.toLowerCase()} cannot currently be installed automatically in Hello. You can still review its details and source repository.</div> : null}
        </div>
      )}
    </Modal>
  );
}
