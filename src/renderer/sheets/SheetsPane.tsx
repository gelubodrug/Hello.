import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FilePlus2, FolderOpen, Save, Sheet, TriangleAlert, X } from 'lucide-react';
import type { Conversation } from '../../shared/types';
import type { SheetCellEdit, SheetFormulaError, SheetWorkbookInfo } from '../../shared/sheets';
import { api } from '../api';
import { ErrorNote, IconButton, Truncated, errorText } from '../ui/primitives';
import { gridEdits, gridSelection, gridSheetId, gridWorkbook } from './univer-data';
import type { Grid } from './univer';
import './sheets.css';

/** Cells one change of the grid may report; past it the block is not sent and the pane says so. */
const MAX_EDIT_BLOCK = 20_000;
const dark = () => document.documentElement.dataset.theme === 'dark';

/**
 * A chat's workbooks, one shown at a time. The grid is a picture of what main
 * holds: it is rebuilt when the model changes the workbook, and what the
 * person types is sent to main cell by cell — main computes it, keeps it and
 * decides when a file of the folder is written. Sheets, formats and rows are
 * the model's to change; this pane reads them.
 */
export function SheetsPane({ conversation, visible }: { conversation: Conversation; visible: boolean }) {
  const sheets = api.sheets;
  const host = useRef<HTMLDivElement>(null);
  const grid = useRef<Grid | null>(null);
  const loading = useRef<Promise<Grid | null> | null>(null);
  const shown = useRef<{ id: string; unit: string } | null>(null);
  const units = useRef(0);
  /** The grid is being filled by this pane, not typed into. */
  const filling = useRef(false);
  const gone = useRef(false);
  const queued = useRef(new Map<string, Map<string, SheetCellEdit>>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSheet = useRef('');
  const looking = useRef<{ sheet: string; range?: string } | null>(null);
  const reporting = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onScreen = useRef(visible);
  const selectedRef = useRef<string | null>(null);
  const [books, setBooks] = useState<SheetWorkbookInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tabs, setTabs] = useState<{ names: string[]; active: number; limited: boolean }>({ names: [], active: 0, limited: false });
  const [errors, setErrors] = useState<SheetFormulaError[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** What goes with the next message, as the person reads it: Magazine!D1:D20. */
  const [seen, setSeen] = useState('');
  /** Grows when the model changed the shown workbook: its picture is old. */
  const [stale, setStale] = useState(0);
  const drawn = useRef(-1);
  selectedRef.current = selected;
  const current = books.find(book => book.id === selected);
  const held = [...new Set([...(current?.lossy ?? []), ...(current?.scripted ?? [])])];
  /** What the file came with that a save from here would lose: charts are carried through every change, so they are not among it once they are. */
  const lost = (current?.lossy ?? []).filter(part => !(current?.scripted ?? []).includes(part) && !(part === 'charts' && !current?.dirty));

  const refresh = useCallback(async () => {
    if (!sheets) return;
    try {
      const list = await sheets.list(conversation.id);
      if (gone.current) return;
      setBooks(list);
      setSelected(now => now && list.some(book => book.id === now) ? now : list.at(-1)?.id ?? null);
    } catch (reason) { setError(errorText(reason)); }
  }, [conversation.id, sheets]);

  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const target = shown.current?.id;
    const batches = [...queued.current];
    queued.current = new Map();
    if (!sheets || !target) return;
    for (const [sheet, edits] of batches) {
      try {
        const result = await sheets.edit(conversation.id, target, sheet, [...edits.values()]);
        if (gone.current) return;
        setErrors(result.errors);
        setBooks(list => list.map(book => book.id === result.info.id ? result.info : book));
      } catch (reason) { setError(errorText(reason)); }
    }
  }, [conversation.id, sheets]);

  /** Tell main what the pane shows, a moment after it settles: a drag passes through many ranges. */
  const report = useCallback(() => {
    if (reporting.current) clearTimeout(reporting.current);
    reporting.current = setTimeout(() => {
      const view = onScreen.current && shown.current && looking.current
        ? { workbook: shown.current.id, sheet: looking.current.sheet, ...(looking.current.range ? { range: looking.current.range } : {}) } : null;
      setSeen(view ? `${view.sheet}${view.range ? `!${view.range}` : ''}` : '');
      void sheets?.select?.(conversation.id, view).catch(() => {});
    }, 150);
  }, [conversation.id, sheets]);

  const ensureGrid = useCallback((): Promise<Grid | null> => {
    if (grid.current) return Promise.resolve(grid.current);
    return loading.current ??= (async () => {
      const { mountGrid } = await import('./univer');
      if (gone.current || !host.current) return null;
      const made = mountGrid(host.current, dark());
      // Where the person is: the sheet and the cells selected. It goes with their next message.
      made.univerAPI.addEvent(made.univerAPI.Event.SelectionChanged, params => {
        if (filling.current || !shown.current) return;
        const range = params.selections[0];
        looking.current = { sheet: params.worksheet.getSheetName(), ...(range ? { range: gridSelection(range) } : {}) };
        report();
      });
      made.univerAPI.addEvent(made.univerAPI.Event.SheetValueChanged, params => {
        if (filling.current || !shown.current) return;
        for (const range of params.effectedRanges) {
          const area = range.getRange();
          if ((area.endRow - area.startRow + 1) * (area.endColumn - area.startColumn + 1) > MAX_EDIT_BLOCK) {
            setError('That change covers more cells than this pane sends at once, so it was not kept. Make it in smaller blocks, or ask the model to.');
            continue;
          }
          const name = range.getSheetName();
          const batch = queued.current.get(name) ?? new Map<string, SheetCellEdit>();
          for (const edit of gridEdits(area.startRow, area.startColumn, range.getFormulas(), range.getValues())) batch.set(edit.cell, edit);
          queued.current.set(name, batch);
        }
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => { void flush(); }, 250);
      });
      grid.current = made;
      return made;
    })();
  }, [flush, report]);

  const show = useCallback(async (id: string, keepSheet: boolean) => {
    if (!sheets) return;
    try {
      await flush();
      const snapshot = await sheets.snapshot(conversation.id, id);
      const target = await ensureGrid();
      if (!target || gone.current || selectedRef.current !== id) return;
      filling.current = true;
      try {
        if (shown.current) target.univerAPI.disposeUnit(shown.current.unit);
        const unit = `workbook-${++units.current}`;
        const workbook = target.univerAPI.createWorkbook(gridWorkbook(snapshot, unit) as Parameters<typeof target.univerAPI.createWorkbook>[0]);
        const index = keepSheet ? Math.max(0, snapshot.grids.findIndex(sheet => sheet.name === activeSheet.current)) : 0;
        if (index > 0) workbook.setActiveSheet(gridSheetId(index));
        activeSheet.current = snapshot.grids[index]?.name ?? '';
        shown.current = { id, unit };
        looking.current = { sheet: activeSheet.current };
        report();
        setTabs({ names: snapshot.grids.map(sheet => sheet.name), active: index, limited: snapshot.grids.some(sheet => sheet.limited) });
      } finally {
        // The grid computes what it was given after it is made; that is not typing either.
        setTimeout(() => { filling.current = false; }, 300);
      }
      const { grids: _grids, ...info } = snapshot;
      setBooks(list => list.map(book => book.id === info.id ? info : book));
      setError(null);
    } catch (reason) { setError(errorText(reason)); }
  }, [conversation.id, ensureGrid, flush, report, sheets]);

  useEffect(() => { gone.current = false; void refresh(); return () => { gone.current = true; }; }, [refresh]);
  useEffect(() => sheets?.onChange(event => {
    if (event.conversationId !== conversation.id) return;
    void refresh();
    if (event.list && event.revision > 0) setSelected(event.id);
    if (event.by === 'model' && event.id === selectedRef.current) setStale(count => count + 1);
  }), [conversation.id, refresh, sheets]);
  // Out of sight, the pane shows the person nothing: its selection is not their "here".
  useEffect(() => { onScreen.current = visible; report(); }, [visible, report]);
  useEffect(() => () => { if (reporting.current) clearTimeout(reporting.current); void sheets?.select?.(conversation.id, null).catch(() => {}); }, [conversation.id, sheets]);
  // A grid needs a box to draw in, so a workbook is drawn when the pane is on screen.
  useEffect(() => {
    if (!visible || !selected) return;
    const same = shown.current?.id === selected;
    if (same && drawn.current === stale) return;
    drawn.current = stale;
    if (!same) setErrors([]);
    void show(selected, same);
  }, [visible, selected, stale, show]);
  useEffect(() => {
    const watch = new MutationObserver(() => grid.current?.univerAPI.toggleDarkMode(dark()));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      watch.disconnect();
      if (timer.current) clearTimeout(timer.current);
      grid.current?.univer.dispose();
      grid.current = null;
    };
  }, []);

  const act = (work: () => Promise<unknown>) => () => { setError(null); void work().catch(reason => setError(errorText(reason))); };
  const create = act(async () => { await sheets!.create(conversation.id, `Workbook ${books.filter(book => book.source === 'hello').length + 1}`); });
  const open = act(async () => { await sheets!.open(conversation.id); });
  const save = act(async () => { await flush(); await sheets!.save(conversation.id, selected!); await refresh(); });
  const exportCopy = act(async () => { await flush(); await sheets!.export(conversation.id, selected!); });
  /** Main asks first: a file is only closed, a workbook kept in Hello is deleted. */
  const remove = (id: string) => act(async () => {
    if (shown.current?.id === id) await flush();
    if (await sheets!.remove(conversation.id, id)) {
      if (shown.current?.id === id) { grid.current?.univerAPI.disposeUnit(shown.current.unit); shown.current = null; setTabs({ names: [], active: 0, limited: false }); }
      await refresh();
    }
  })();
  const pick = (index: number) => {
    const workbook = grid.current?.univerAPI.getActiveWorkbook();
    if (!workbook) return;
    workbook.setActiveSheet(gridSheetId(index));
    activeSheet.current = tabs.names[index] ?? '';
    looking.current = { sheet: activeSheet.current };
    report();
    setTabs(now => ({ ...now, active: index }));
  };

  if (!sheets) return <div className="sheets-pane"><div className="sheets-empty"><h2>Sheets</h2>
    <p>Sheets needs the updated Hello. main process and preload. Reopen Hello. when ready.</p></div></div>;
  return <div className="sheets-pane">
    <div className="sheets-toolbar">
      {/* One pill per workbook, each closed by itself, as the tool tabs above are. */}
      <div className="pills sheets-books" role="tablist" aria-label="Workbooks of this chat">
        {books.map(book => {
          const state = book.source === 'file' ? (book.dirty ? 'File of the folder, unsaved changes' : 'File of the folder') : 'Kept in Hello';
          const closing = book.source === 'file' ? 'Close' : 'Delete';
          return <div className="tab-pill" key={book.id} data-active={book.id === selected} title={`${book.title} — ${state}`}>
            <button type="button" role="tab" aria-selected={book.id === selected} onClick={() => setSelected(book.id)}>
              <Sheet size={14} aria-hidden /><Truncated className="tool-tab-label">{book.title}</Truncated>
              {book.source === 'file' && book.dirty && <span className="sheets-unsaved" aria-label="Unsaved changes" />}
            </button>
            <button type="button" className="pill-close" aria-label={`${closing} ${book.title}`} title={`${closing} ${book.title}`}
              onClick={() => remove(book.id)}><X size={13} /></button>
          </div>;
        })}
      </div>
      {current?.source === 'file' && current.dirty && <span className="sheets-state">Unsaved changes</span>}
      {errors.length > 0 && <span className="sheets-state sheets-problem"
        title={errors.slice(0, 20).map(item => `${item.sheet}!${item.cell} ${item.formula} → ${item.error}`).join('\n')}>
        <TriangleAlert size={13} aria-hidden /> {errors.length} formula {errors.length === 1 ? 'error' : 'errors'}
      </span>}
      {seen && <span className="sheets-state" title="The sheet and cells you have selected go with your next message, so “here” means them. Only the address is sent, not the contents.">With your message: {seen}</span>}
      <span className="sheets-spacer" />
      {current?.source === 'file' && <IconButton label={lost.length ? `Cannot save over a file with ${lost.join(', ')}; export a copy` : 'Save to the file'}
        disabled={!current.dirty || lost.length > 0} onClick={save}><Save size={16} /></IconButton>}
      {current && <IconButton label="Export a copy…" onClick={exportCopy}><Download size={16} /></IconButton>}
      <IconButton label="New workbook" onClick={create}><FilePlus2 size={16} /></IconButton>
      <IconButton label="Open an .xlsx…" onClick={open}><FolderOpen size={16} /></IconButton>
    </div>
    <ErrorNote error={error} />
    {/* One notice, and a true one: what is in the file and not drawn here, and — only where it is so — what a save from here would leave out. */}
    {held.length > 0 && <p className="sheets-notice">This workbook holds {held.join(', ')}. They are in the file but not shown here: open it in Excel to see them.{lost.length ? ` A copy saved from here would not carry ${lost.join(', ')}.` : ''}</p>}
    {tabs.limited && <p className="sheets-notice">This sheet is larger than the pane shows; the rest is in the file and the model can read it.</p>}
    {!books.length && <div className="sheets-empty">
      <h2>No workbook yet</h2>
      <p>Ask the model for a spreadsheet, start an empty one, or open an .xlsx. What the model writes appears here as it writes it, and you can type into it too.</p>
      <div className="sheets-empty-actions">
        <button type="button" className="text-button" onClick={create}><FilePlus2 size={15} aria-hidden /> New workbook</button>
        <button type="button" className="text-button" onClick={open}><FolderOpen size={15} aria-hidden /> Open an .xlsx…</button>
      </div>
    </div>}
    <div className="sheets-grid" ref={host} hidden={!books.length} />
    {tabs.names.length > 0 && books.length > 0 && <div className="sheets-tabs" role="tablist" aria-label="Sheets of this workbook">
      {tabs.names.map((name, index) => <button type="button" role="tab" key={`${index}-${name}`} aria-selected={index === tabs.active}
        className="sheets-tab" onClick={() => pick(index)}><Truncated>{name}</Truncated></button>)}
    </div>}
  </div>;
}
