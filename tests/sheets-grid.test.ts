import { describe, expect, it } from 'vitest';
import { gridEdits, gridInput, gridSelection, gridSheetId, gridWorkbook } from '../src/renderer/sheets/univer-data';
import type { SheetSnapshot } from '../src/shared/sheets';

const snapshot: SheetSnapshot = {
  id: 'w', conversationId: 'c', title: 'Buget', source: 'hello', dirty: false, revision: 3, sheets: ['Costuri', 'Note'],
  grids: [
    { name: 'Costuri', rows: 4, columns: 2, widths: { 1: 20 }, frozenRows: 1, cells: [
      [1, 1, { v: 'Item', bold: true, fill: '#EEEEEE' }], [2, 2, { v: 10, format: '0.00' }],
      [4, 2, { f: 'SUM(B2:B3)', v: 42.5, align: 'right' }], [3, 1, { v: true }],
    ] },
    { name: 'Note', rows: 0, columns: 0, cells: [] },
  ],
};

describe('the grid’s picture of a workbook', () => {
  it('places cells 0-based, with formulas, types and looks', () => {
    const data = gridWorkbook(snapshot, 'unit-1') as any;
    expect(data).toMatchObject({ id: 'unit-1', name: 'Buget', sheetOrder: [gridSheetId(0), gridSheetId(1)] });
    const sheet = data.sheets[gridSheetId(0)];
    expect(sheet.name).toBe('Costuri');
    expect(sheet.cellData[0][0]).toEqual({ v: 'Item', t: 1, s: { bl: 1, bg: { rgb: '#EEEEEE' } } });
    expect(sheet.cellData[1][1]).toEqual({ v: 10, t: 2, s: { n: { pattern: '0.00' } } });
    expect(sheet.cellData[3][1]).toEqual({ f: '=SUM(B2:B3)', v: 42.5, t: 2, s: { ht: 3 } });
    expect(sheet.cellData[2][0]).toEqual({ v: 1, t: 3 });
    expect(sheet.columnData).toEqual({ 0: { w: 145 } });
    expect(sheet.freeze).toEqual({ xSplit: 0, ySplit: 1, startRow: 1, startColumn: -1 });
    // Room to type past what is used.
    expect(sheet.rowCount).toBeGreaterThanOrEqual(300);
    expect(data.sheets[gridSheetId(1)].cellData).toEqual({});
  });

  it('reads what a cell holds as what would be typed', () => {
    expect(gridInput('=A1+1', 5)).toBe('=A1+1');
    expect(gridInput('A1+1', 5)).toBe('=A1+1');
    expect(gridInput('', '12.5')).toBe(12.5);
    expect(gridInput(null, '007')).toBe('007');
    expect(gridInput(undefined, 'TRUE')).toBe(true);
    expect(gridInput(undefined, 'text')).toBe('text');
    expect(gridInput(undefined, '')).toBeNull();
    expect(gridInput(undefined, null)).toBeNull();
  });

  it('names the selection as a person would say it', () => {
    expect(gridSelection({ startRow: 0, startColumn: 3, endRow: 19, endColumn: 3 })).toBe('D1:D20');
    expect(gridSelection({ startRow: 3, startColumn: 1, endRow: 3, endColumn: 1 })).toBe('B4');
    expect(gridSelection({ startRow: 0, startColumn: 0, endRow: 1048575, endColumn: 0 })).toBe('A1:A1048576');
  });

  it('reports a changed block cell by cell, a cleared one as null', () => {
    expect(gridEdits(1, 1, [['', '=B2*2'], ['', '']], [[3, 6], [null, 'x']])).toEqual([
      { cell: 'B2', input: 3 }, { cell: 'C2', input: '=B2*2' }, { cell: 'B3', input: null }, { cell: 'C3', input: 'x' },
    ]);
  });
});
