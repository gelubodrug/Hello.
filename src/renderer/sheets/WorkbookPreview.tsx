import { useEffect, useRef, useState } from 'react';
import type { SheetPreview } from '../../shared/sheets';
import { api } from '../api';
import { ErrorNote, Truncated, errorText } from '../ui/primitives';
import { gridSheetId, gridWorkbook } from './univer-data';
import type { Grid } from './univer';
import './sheets.css';

const dark = () => document.documentElement.dataset.theme === 'dark';
/** Keys that only move around a grid. Anything else would start editing a cell. */
const MOVES = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown',
  'Home', 'End', 'Tab', 'Escape', 'Shift', 'Control', 'Alt', 'Meta']);

/**
 * A workbook file of the chat's folder, drawn by the same grid the Sheets pane
 * uses. It opens nothing: no workbook joins the chat, so the model is told
 * nothing and the next request carries what it carried before. Looking at a
 * file is not asking for that.
 *
 * Read-only, and it has to be: what is typed here reaches no one. The Sheets
 * pane is where a change is sent to main, computed and kept; a grid that took
 * typing and dropped it would be a trap. Typing and double-click are stopped
 * before the grid sees them; moving, selecting and copying are not.
 */
export function WorkbookPreview({ conversationId, path, visible }: { conversationId: string; path: string; visible: boolean }) {
  const preview = api.sheets?.preview;
  const host = useRef<HTMLDivElement>(null);
  const grid = useRef<Grid | null>(null);
  const loading = useRef<Promise<Grid | null> | null>(null);
  const unit = useRef<string | null>(null);
  const units = useRef(0);
  const gone = useRef(false);
  const [snapshot, setSnapshot] = useState<SheetPreview | null>(null);
  const [tabs, setTabs] = useState<{ names: string[]; active: number }>({ names: [], active: 0 });
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  useEffect(() => { gone.current = false; return () => { gone.current = true; }; }, []);
  // The grid is disposed with the component, not with the file: a new file reuses it.
  useEffect(() => () => {
    grid.current?.univer.dispose();
    grid.current = null;
    loading.current = null;
    unit.current = null;
  }, []);
  useEffect(() => {
    const watch = new MutationObserver(() => grid.current?.univerAPI.toggleDarkMode(dark()));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => watch.disconnect();
  }, []);

  useEffect(() => {
    if (!preview) return;
    let current = true;
    setError(null); setReading(true); setSnapshot(null); setTabs({ names: [], active: 0 });
    void preview(conversationId, path)
      .then(file => { if (current && !gone.current) setSnapshot(file); })
      .catch(reason => { if (current && !gone.current) setError(errorText(reason)); })
      .finally(() => { if (current && !gone.current) setReading(false); });
    return () => { current = false; };
  }, [conversationId, path, preview]);

  // A grid needs a box to draw in, so it is filled once the pane is on screen.
  useEffect(() => {
    if (!snapshot || !visible) return;
    let current = true;
    void (async () => {
      const made = await (grid.current ? Promise.resolve(grid.current) : (loading.current ??= (async () => {
        const { mountGrid } = await import('./univer');
        if (gone.current || !host.current) return null;
        grid.current = mountGrid(host.current, dark());
        return grid.current;
      })()));
      if (!made || !current || gone.current) return;
      if (unit.current) made.univerAPI.disposeUnit(unit.current);
      const next = `preview-${++units.current}`;
      made.univerAPI.createWorkbook(gridWorkbook(snapshot, next) as Parameters<typeof made.univerAPI.createWorkbook>[0]);
      unit.current = next;
      setTabs({ names: snapshot.grids.map(sheet => sheet.name), active: 0 });
    })().catch(reason => { if (current && !gone.current) setError(errorText(reason)); });
    return () => { current = false; };
  }, [snapshot, visible]);

  const pick = (index: number) => {
    const workbook = grid.current?.univerAPI.getActiveWorkbook();
    if (!workbook) return;
    workbook.setActiveSheet(gridSheetId(index));
    setTabs(now => ({ ...now, active: index }));
  };

  if (!preview) return <div className="sheets-empty"><h2>Workbook preview</h2>
    <p>Showing a workbook here needs the updated Hello. main process and preload. Reopen Hello. when ready.</p></div>;
  const held = snapshot?.lossy ?? [];
  const limited = snapshot?.grids.some(sheet => sheet.limited) ?? false;
  return <div className="files-workbook">
    <ErrorNote error={error} />
    {reading && <p className="sheets-notice" role="status">Reading the workbook…</p>}
    {snapshot && <p className="sheets-notice">{snapshot.openInChat
      ? 'The file as saved, read-only. This chat is working on it in Sheets, where any unsaved change is — go there to see and change it.'
      : 'The file as saved, read-only. Looking at it here opens nothing: it is not in this chat and the model has not been told about it.'}
      {held.length ? ` This workbook holds ${held.join(', ')}, which are in the file but not drawn here.` : ''}
      {limited ? ' A sheet is larger than the grid shows; the rest is in the file.' : ''}</p>}
    <div className="sheets-grid" ref={host} hidden={!snapshot}
      // Moving, selecting and copying pass; what would open a cell for editing does not.
      onKeyDownCapture={event => {
        if (MOVES.has(event.key) || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c')) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onDoubleClickCapture={event => { event.preventDefault(); event.stopPropagation(); }} />
    {tabs.names.length > 0 && <div className="sheets-tabs" role="tablist" aria-label="Sheets of this workbook">
      {tabs.names.map((name, index) => <button type="button" role="tab" key={`${index}-${name}`} aria-selected={index === tabs.active}
        className="sheets-tab" onClick={() => pick(index)}><Truncated>{name}</Truncated></button>)}
    </div>}
  </div>;
}
