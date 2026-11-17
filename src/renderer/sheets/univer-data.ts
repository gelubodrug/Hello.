import { cellName, parseRange, type SheetCell, type SheetCellEdit, type SheetSnapshot, type SheetValue } from '../../shared/sheets';

/** Univer's cell types. */
const STRING = 1, NUMBER = 2, BOOLEAN = 3;
const ALIGN = { left: 1, center: 2, right: 3 } as const;
/** A column width in characters, as the pixels the grid wants. */
const pixels = (characters: number) => Math.round(characters * 7 + 5);

export interface GridCell { v?: string | number | boolean | null; f?: string | null; t?: number | null; s?: unknown; si?: string | null }

export const gridSheetId = (index: number) => `sheet-${index}`;

function gridCell(cell: SheetCell): GridCell {
  const style: Record<string, unknown> = {};
  if (cell.bold) style.bl = 1;
  if (cell.italic) style.it = 1;
  if (cell.color) style.cl = { rgb: cell.color };
  if (cell.fill) style.bg = { rgb: cell.fill };
  if (cell.format) style.n = { pattern: cell.format };
  if (cell.align) style.ht = ALIGN[cell.align];
  const value = cell.v;
  return {
    ...(cell.f !== undefined ? { f: `=${cell.f}` } : {}),
    ...(typeof value === 'boolean' ? { v: value ? 1 : 0, t: BOOLEAN }
      : typeof value === 'number' ? { v: value, t: NUMBER }
      : typeof value === 'string' ? { v: value, t: STRING } : {}),
    ...(Object.keys(style).length ? { s: style } : {}),
  };
}

/**
 * A snapshot as the grid's own workbook. Sheets are named by their place, so
 * the pane can show one by index; rows and columns become 0-based. The grid is
 * given room past the used part, because a sheet a person cannot type below is
 * not a sheet.
 */
export function gridWorkbook(snapshot: SheetSnapshot, unitId: string) {
  const sheets: Record<string, unknown> = {};
  const sheetOrder: string[] = [];
  snapshot.grids.forEach((grid, index) => {
    const id = gridSheetId(index);
    const cellData: Record<number, Record<number, GridCell>> = {};
    for (const [row, column, cell] of grid.cells) (cellData[row - 1] ??= {})[column - 1] = gridCell(cell);
    const columnData: Record<number, { w: number }> = {};
    for (const [column, width] of Object.entries(grid.widths ?? {})) columnData[Number(column) - 1] = { w: pixels(width) };
    // A merged range is drawn as the one cell it is.
    const mergeData = (grid.merges ?? []).flatMap(name => {
      try { const range = parseRange(name); return [{ startRow: range.top - 1, endRow: range.bottom - 1, startColumn: range.left - 1, endColumn: range.right - 1 }]; }
      catch { return []; }
    });
    sheets[id] = {
      id, name: grid.name, cellData, columnData, ...(mergeData.length ? { mergeData } : {}),
      rowCount: Math.max(grid.rows + 200, 300), columnCount: Math.max(grid.columns + 20, 40),
      ...(grid.frozenRows || grid.frozenColumns ? { freeze: {
        xSplit: grid.frozenColumns ?? 0, ySplit: grid.frozenRows ?? 0,
        startRow: grid.frozenRows ?? -1, startColumn: grid.frozenColumns ?? -1,
      } } : {}),
    };
    sheetOrder.push(id);
  });
  return { id: unitId, name: snapshot.title, sheetOrder, sheets, styles: {} };
}

/** What a grid cell holds, as what would be typed into it: the formula when there is one. */
export function gridInput(formula: string | null | undefined, value: unknown): SheetValue {
  if (typeof formula === 'string' && formula.trim()) return formula.startsWith('=') ? formula : `=${formula}`;
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  // The grid keeps a typed number as text until it is formatted; a sheet computes on numbers.
  if (/^-?\d+(\.\d+)?$/.test(value.trim()) && !/^-?0\d/.test(value.trim())) return Number(value);
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  return value;
}

/** A changed block of the grid as edits for main: every cell of it, a cleared one as null. */
export function gridEdits(top: number, left: number, formulas: string[][], values: unknown[][]): SheetCellEdit[] {
  const edits: SheetCellEdit[] = [];
  const height = Math.max(formulas.length, values.length);
  for (let y = 0; y < height; y++) {
    const width = Math.max(formulas[y]?.length ?? 0, values[y]?.length ?? 0);
    for (let x = 0; x < width; x++)
      edits.push({ cell: cellName(top + y + 1, left + x + 1), input: gridInput(formulas[y]?.[x], values[y]?.[x]) });
  }
  return edits;
}

/** The grid's selection (0-based corners) as the range a person would say: D1:D20, or B4 for one cell. */
export function gridSelection(range: { startRow: number; startColumn: number; endRow: number; endColumn: number }): string {
  const first = cellName(Math.max(0, range.startRow) + 1, Math.max(0, range.startColumn) + 1);
  const last = cellName(Math.max(0, range.endRow) + 1, Math.max(0, range.endColumn) + 1);
  return first === last ? first : `${first}:${last}`;
}
