import { describe, expect, it } from 'vitest';
import {
  PAGE_REF_MARK, composeAnnotations, composeDesignNote, composeDesignNotes, composeRefBlock, cropBox,
  parseAnnotationShot, parseDesignNotes, parseFiberInfo, parseProbeBatch, parseRect,
} from '../src/shared/page-mode-format';

describe('page mode notes', () => {
  it('builds a reference block that degrades off React', () => {
    expect(composeRefBlock({ component: 'Sidebar › Row', file: 'src/Row.tsx:12:3', tag: 'button', text: 'Save', styles: 'font 13px/500', dom: 'div.row > button', url: 'http://localhost:5173/' }))
      .toBe([`${PAGE_REF_MARK} Sidebar › Row <button>`, 'file: src/Row.tsx:12:3', 'text: "Save"', 'style: font 13px/500', 'dom:  div.row > button', 'page: http://localhost:5173/'].join('\n'));
    expect(composeRefBlock({ tag: 'div' })).toBe(`${PAGE_REF_MARK} element <div>\nfile: (unknown — not a React development build)`);
  });

  it('puts the ask under the reference, labelled', () => {
    const note = { text: '  make it bolder ', ref: `${PAGE_REF_MARK} Card <h2>`, selector: 'h2', tag: 'h2' };
    expect(composeDesignNote(note)).toBe(`${PAGE_REF_MARK} Card <h2>\nchange: make it bolder`);
    expect(composeDesignNote({ text: 'x', selector: '#a', tag: 'a', url: 'https://e.test/', shot: '/tmp/s.png' }))
      .toBe(`${PAGE_REF_MARK} element <a>\ndom:  #a\npage: https://e.test/\nshot: /tmp/s.png\nchange: x`);
  });

  it('numbers several notes and separates them', () => {
    expect(composeDesignNotes([])).toBe('');
    const joined = composeDesignNotes([{ text: 'one', selector: 'a', tag: 'a' }, { text: 'two', selector: 'b', tag: 'b' }]);
    expect(joined.startsWith('1. ')).toBe(true);
    expect(joined).toContain('\n\n---\n\n2. ');
  });

  it('drops anything that is not a note, and accepts one layer of extra encoding', () => {
    const notes = [{ text: 'ok', selector: 'a', tag: 'a' }, { text: '  ', selector: 'b', tag: 'b' }, { text: 'no selector' }, null];
    expect(parseDesignNotes(JSON.stringify(notes))).toHaveLength(1);
    expect(parseDesignNotes(JSON.stringify(JSON.stringify(notes)))).toHaveLength(1);
    expect(parseDesignNotes('{nope')).toEqual([]);
    expect(parseDesignNotes('{}')).toEqual([]);
  });

  it('formats annotations by number and colour', () => {
    const shot = parseAnnotationShot(JSON.stringify({ url: 'https://e.test/', marks: [{ n: 2, color: 'blue', text: 'gap', inView: false }, { n: 1, color: 'yellow', text: 'typo', at: 'p.lead' }, { n: 3, text: '' }] }));
    expect(shot?.marks).toHaveLength(2);
    expect(composeAnnotations(shot!, '/tmp/a.png')).toBe([
      '⟦Hello-annotations⟧ 2 markers on https://e.test/', 'shot: /tmp/a.png',
      '#1 yellow — typo · at p.lead', '#2 blue — gap · outside the picture',
    ].join('\n'));
    expect(parseAnnotationShot('[]')).toBeNull();
  });
});

describe('what the page hands back', () => {
  const pick = {
    type: 'pick', token: 'abc123', tag: 'BUTTON', selector: '#save', text: 'Save', styles: 's', dom: 'd', url: 'u',
    rect: { x: 1.4, y: 2, w: 30, h: 20 }, point: { x: 5, y: 6 }, viewport: { w: 800, h: 600 },
  };

  it('keeps well-formed events, bounded', () => {
    const batch = parseProbeBatch({ armId: 'arm-1', events: [{ type: 'hover', rect: { x: 0, y: 0, w: 1, h: 1 } }, { type: 'hover', rect: null }, pick, { type: 'released' }] });
    expect(batch?.armId).toBe('arm-1');
    expect(batch?.events.map(event => event.type)).toEqual(['hover', 'hover', 'pick', 'released']);
    expect(batch!.events[2]).toMatchObject({ type: 'pick', tag: 'button', text: 'Save', rect: { x: 1, y: 2, w: 30, h: 20 } });
    const long = parseProbeBatch({ armId: 'a', events: [{ ...pick, text: 'x'.repeat(5000), selector: 'y'.repeat(5000) }] });
    expect((long!.events[0] as { text: string }).text.length).toBe(200);
    expect((long!.events[0] as { selector: string }).selector.length).toBe(1000);
    const controls = parseProbeBatch({ armId: 'a', events: [{ ...pick, text: 'a\u0000b\u001bc' }] });
    expect((controls!.events[0] as { text: string }).text).toBe('a b c');
  });

  it('drops malformed picks and batches', () => {
    expect(parseProbeBatch(null)).toBeNull();
    expect(parseProbeBatch({ armId: '', events: [] })).toBeNull();
    expect(parseProbeBatch({ armId: 'a', events: 'no' })).toBeNull();
    const events = parseProbeBatch({ armId: 'a', events: [
      { ...pick, token: 'bad token"' }, { ...pick, rect: { x: 'no' } }, { ...pick, viewport: { w: 0, h: 1 } }, { type: 'other' },
    ] })!.events;
    expect(events).toEqual([]);
    expect(parseRect({ x: 1, y: 1, w: -1, h: 1 })).toBeNull();
    expect(parseRect({ x: Infinity, y: 1, w: 1, h: 1 })).toBeNull();
  });

  it('reads fiber info as plain bounded strings', () => {
    expect(parseFiberInfo({ component: 'Card › Button', file: 'src/Button.tsx:4' })).toEqual({ component: 'Card › Button', file: 'src/Button.tsx:4' });
    expect(parseFiberInfo({ component: 42, file: '' })).toEqual({ component: null, file: null });
    expect(parseFiberInfo('nope')).toEqual({ component: null, file: null });
  });

  it('crops against the picture, whatever the zoom or density', () => {
    // A 2x display: a 400×300 viewport comes back as 800×600 pixels.
    expect(cropBox({ x: 10, y: 20, w: 100, h: 50 }, { w: 400, h: 300 }, { width: 800, height: 600 })).toEqual({ x: 20, y: 40, width: 200, height: 100 });
    // Partly off screen: clipped to what is visible.
    expect(cropBox({ x: -10, y: 280, w: 50, h: 100 }, { w: 400, h: 300 }, { width: 400, height: 300 })).toEqual({ x: 0, y: 280, width: 40, height: 20 });
    // Entirely off screen.
    expect(cropBox({ x: 0, y: 400, w: 10, h: 10 }, { w: 400, h: 300 }, { width: 400, height: 300 })).toBeNull();
    expect(cropBox({ x: 0, y: 0, w: 10, h: 10 }, { w: 0, h: 300 }, { width: 400, height: 300 })).toBeNull();
  });
});
