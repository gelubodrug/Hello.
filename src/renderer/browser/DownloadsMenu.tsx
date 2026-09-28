import { useState } from 'react';
import { Copy, Download, File, FileArchive, FileCode, FileSpreadsheet, FileText, FolderOpen, Image, SquareArrowOutUpRight, Trash2, X } from 'lucide-react';
import type { BrowserDownload } from '../../shared/types';
import { api } from '../api';
import { MenuButton, type MenuItem } from '../ui/primitives';
import { useDownloads } from './useDownloads';

interface Props { conversationId: string; onError(message: string): void; }

/** "16.4 KB", "1.2 MB" — the way a browser's list says it. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value < 100 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
/** "just now", "5 min ago", "6 hours ago", "yesterday", "3 days ago". */
export function timeAgo(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(at).toLocaleDateString();
}
/** What the row says under the name: size, state, and when. */
export function downloadDetail(download: BrowserDownload, now = Date.now()): string {
  const size = formatBytes(download.bytes);
  if (download.state === 'saving')
    return `${download.total ? `${size || '0 B'} of ${formatBytes(download.total)}` : size || 'Starting'} · Saving…`;
  const state = download.state === 'saved' ? 'Done'
    : download.state === 'cancelled' ? 'Cancelled'
      : download.state === 'refused' ? `Refused${download.reason ? `: ${download.reason}` : ''}`
        : `Failed${download.reason ? `: ${download.reason}` : ''}`;
  return [size, state, timeAgo(download.finishedAt ?? download.startedAt, now)].filter(Boolean).join(' · ');
}
function iconFor(download: BrowserDownload) {
  const name = download.name.toLowerCase();
  const type = (download.mimeType ?? '').toLowerCase();
  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|heic|avif)$/.test(name)) return Image;
  if (/\.(xlsx?|csv|numbers|ods)$/.test(name) || type.includes('spreadsheet') || type.includes('excel')) return FileSpreadsheet;
  if (/\.(zip|tar|gz|tgz|rar|7z|dmg|pkg)$/.test(name) || type.includes('zip') || type.includes('compressed')) return FileArchive;
  if (/\.(html?|css|js|ts|json|xml|md|py|rs|sh)$/.test(name) || type.includes('json') || type.includes('html') || type.includes('javascript')) return FileCode;
  if (/\.(pdf|docx?|txt|rtf|pages)$/.test(name) || type === 'application/pdf' || type.startsWith('text/')) return FileText;
  return File;
}
/** How far the files still saving have got, 0–1, for the ring on the button. */
export function savingProgress(downloads: BrowserDownload[]): number | null {
  const saving = downloads.filter(download => download.state === 'saving');
  if (!saving.length) return null;
  const known = saving.filter(download => download.total);
  if (!known.length) return 0;
  return known.reduce((sum, download) => sum + Math.min(1, (download.bytes ?? 0) / download.total!), 0) / known.length;
}

/**
 * The chat's downloads, on the toolbar as a browser puts them: a button that
 * fills its ring while a file saves, and a list of what was saved — each row
 * opens into Open, Show in Finder, Copy path, Remove — with the folder they
 * land in and Clear at the bottom. Nothing is ever deleted from disk here.
 */
export function DownloadsMenu({ conversationId, onError }: Props): JSX.Element {
  const downloads = useDownloads(conversationId);
  const [folder, setFolder] = useState('');
  const progress = savingProgress(downloads);
  const run = (task: () => Promise<unknown>) => { void task().catch((error: Error) => onError(error.message)); };
  const rows: MenuItem[] = downloads.length ? downloads.map(download => {
    const Icon = iconFor(download);
    const saved = download.state === 'saved';
    const children: MenuItem[] = [
      ...(download.state === 'saving' ? [{ id: `${download.id}-cancel`, label: 'Cancel', icon: X, action: () => run(() => api.browser.downloads.cancel(download.id)) }] : []),
      ...(saved ? [
        { id: `${download.id}-open`, label: 'Open', icon: SquareArrowOutUpRight, action: () => run(() => api.browser.downloads.open(download.id)) },
        { id: `${download.id}-reveal`, label: 'Show in Finder', icon: FolderOpen, action: () => run(() => api.browser.downloads.reveal(download.id)) },
        { id: `${download.id}-copy`, label: 'Copy path', icon: Copy, detail: download.path, action: () => run(() => api.system.copy({ text: download.path ?? '' })) },
      ] : []),
      { id: `${download.id}-remove`, label: 'Remove from list', icon: Trash2, detail: 'The file stays where it is', action: () => run(() => api.browser.downloads.remove(download.id)) },
    ];
    return { id: download.id, label: download.name, leading: <Icon size={16} aria-hidden="true" />, detail: downloadDetail(download), children };
  }) : [{ id: 'empty', label: 'No downloads yet', detail: 'Files a page offers, and files the model saves, land here', disabled: true }];
  const items: MenuItem[] = [
    ...rows,
    { id: 'folder', label: 'Open downloads folder', icon: FolderOpen, detail: folder || undefined, separator: true,
      action: () => run(async () => { await api.system.revealPath(folder || await api.browser.downloads.folder(conversationId)); }) },
    { id: 'clear', label: 'Clear list', icon: Trash2, disabled: !downloads.some(download => download.state !== 'saving'),
      action: () => run(() => api.browser.downloads.clear(conversationId)) },
  ];
  const active = downloads.filter(download => download.state === 'saving').length;
  return <div className="browser-downloads-anchor" data-saving={progress === null ? undefined : 'true'}
    style={progress === null ? undefined : { '--download-progress': String(progress) } as React.CSSProperties}>
    <MenuButton className="browser-downloads" label={active ? `Downloads — ${active} saving` : 'Downloads'} menuLabel="Downloads" heading="Downloads"
      menuClassName="downloads-menu" items={items}
      onOpen={() => { void api.browser.downloads.folder(conversationId).then(setFolder).catch(() => setFolder('')); }}>
      <Download size={16} aria-hidden="true" />
    </MenuButton>
  </div>;
}
