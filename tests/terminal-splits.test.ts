import { describe, expect, it } from 'vitest';
import {
  closeInSplits, leadOf, leaves, liveSplits, parseSplits, removeLeaves, setRatio, splitChildren, splitLeaf, type SplitNode,
} from '../src/renderer/workspace/terminal-splits';

describe('terminal splits', () => {
  it('splits a pane beside or below itself, as deep as asked', () => {
    let tree: SplitNode = splitLeaf('t1', 't1', 't2', 'row');
    expect(tree).toEqual({ dir: 'row', ratio: 0.5, a: 't1', b: 't2' });
    tree = splitLeaf(tree, 't2', 't3', 'column');
    expect(tree).toEqual({ dir: 'row', ratio: 0.5, a: 't1', b: { dir: 'column', ratio: 0.5, a: 't2', b: 't3' } });
    expect(leaves(tree)).toEqual(['t1', 't2', 't3']);
    expect(leadOf({ t1: tree }, 't3')).toBe('t1');
    expect([...splitChildren({ t1: tree })]).toEqual(['t2', 't3']);
  });

  it('closes a pane into its sibling, and a ratio stays within reach', () => {
    const tree: SplitNode = { dir: 'row', ratio: 0.5, a: 't1', b: { dir: 'column', ratio: 0.5, a: 't2', b: 't3' } };
    expect(removeLeaves(tree, new Set(['t2']))).toEqual({ dir: 'row', ratio: 0.5, a: 't1', b: 't3' });
    expect(removeLeaves(tree, new Set(['t1', 't2', 't3']))).toBeNull();
    expect(setRatio(tree, 'b', 0.99)).toEqual({ ...tree, b: { dir: 'column', ratio: 0.85, a: 't2', b: 't3' } });
  });

  it('hands a closed lead’s tab to the first terminal left in it', () => {
    const splits = { t1: { dir: 'row', ratio: 0.5, a: 't1', b: { dir: 'column', ratio: 0.5, a: 't2', b: 't3' } } as SplitNode };
    expect(closeInSplits(splits, new Set(['t1']))).toEqual({
      splits: { t2: { dir: 'column', ratio: 0.5, a: 't2', b: 't3' } }, renamed: { t1: 't2' },
    });
    expect(closeInSplits(splits, new Set(['t1', 't3']))).toEqual({ splits: {}, renamed: { t1: 't2' } });
    expect(closeInSplits(splits, new Set(['t3'])).splits).toEqual({ t1: { dir: 'row', ratio: 0.5, a: 't1', b: 't2' } });
  });

  it('keeps only what is alive, and drops a tab whose own terminal did not come back', () => {
    const splits = { t1: { dir: 'row', ratio: 0.5, a: 't1', b: 't2' } as SplitNode };
    expect(liveSplits(splits, new Set(['t1', 't2']))).toEqual(splits);
    expect(liveSplits(splits, new Set(['t1']))).toEqual({});
    expect(liveSplits(splits, new Set(['t2']))).toEqual({});
  });

  it('reads saved trees back, dropping damaged ones', () => {
    expect(parseSplits({ t1: { dir: 'row', ratio: 7, a: 't1', b: 't2' } })).toEqual({ t1: { dir: 'row', ratio: 0.85, a: 't1', b: 't2' } });
    expect(parseSplits({ t1: { dir: 'diagonal', a: 't1', b: 't2' } })).toEqual({});
    expect(parseSplits({ t1: { dir: 'row', a: 't3', b: 't2' } })).toEqual({});
    expect(parseSplits({ t1: { dir: 'row', a: 't1', b: 't1' } })).toEqual({});
    expect(parseSplits('nope')).toEqual({});
  });
});
