import { describe, expect, it } from 'vitest';
import { absoluteLayout, hitTest, layoutRoot, liveRegionTop, type LayoutNode } from '../pointer.js';

const node = (box: { left: number; top: number; width: number; height: number }, parentNode?: LayoutNode): LayoutNode => ({
  yogaNode: { getComputedLayout: () => box },
  parentNode,
});

describe('absoluteLayout', () => {
  it('accumulates offsets up to the root', () => {
    const root = node({ left: 0, top: 0, width: 80, height: 20 });
    const panel = node({ left: 2, top: 5, width: 40, height: 10 }, root);
    const row = node({ left: 1, top: 3, width: 20, height: 1 }, panel);

    expect(absoluteLayout(row)).toEqual({ left: 3, top: 8, width: 20, height: 1 });
    expect(layoutRoot(row)).toBe(root);
  });

  it('is null for nodes without layout', () => {
    expect(absoluteLayout({ parentNode: undefined })).toBeNull();
  });
});

describe('liveRegionTop', () => {
  it('places the region above the cursor line', () => {
    expect(liveRegionTop(30, 10, 40)).toBe(20);
  });

  it('accounts for a region that fills the screen', () => {
    expect(liveRegionTop(40, 40, 40)).toBe(1);
  });
});

describe('hitTest', () => {
  const root = node({ left: 0, top: 0, width: 80, height: 20 });
  const panel = node({ left: 0, top: 4, width: 80, height: 6 }, root);
  const first = node({ left: 2, top: 1, width: 30, height: 1 }, panel);
  const second = node({ left: 2, top: 2, width: 30, height: 1 }, panel);
  const targets = [
    { node: panel, value: 'panel' },
    { node: first, value: 'first' },
    { node: second, value: 'second' },
  ];

  it('picks the innermost target under the point', () => {
    expect(hitTest(targets, 5, 10)).toBe('first');
    expect(hitTest(targets, 6, 10)).toBe('second');
    expect(hitTest(targets, 8, 10)).toBe('panel');
  });

  it('misses outside every target', () => {
    expect(hitTest(targets, 0, 0)).toBeUndefined();
    expect(hitTest(targets, 5, 40)).toBe('panel');
  });
});
