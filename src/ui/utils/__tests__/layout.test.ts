import { describe, expect, test } from 'vitest';
import { centeredWindow, liveRegionBudget, visibleItemBudget } from '../layout.js';

describe('terminal-relative layout budgets', () => {
  test('list budgets grow with the terminal but remain bounded', () => {
    expect(visibleItemBudget(16)).toBe(6);
    expect(visibleItemBudget(24)).toBe(10);
    expect(visibleItemBudget(80)).toBe(10);
  });

  test('multi-row items consume the same finite viewport budget', () => {
    expect(visibleItemBudget(24, { chromeRows: 9, rowsPerItem: 3, maximum: 10 })).toBe(5);
  });

  test('live output is capped without reserving rows', () => {
    expect(liveRegionBudget(8)).toBe(3);
    expect(liveRegionBudget(24)).toBe(8);
    expect(liveRegionBudget(80)).toBe(12);
  });
});

describe('centeredWindow', () => {
  const items = Array.from({ length: 12 }, (_, index) => index);

  test('centers the selection away from list edges', () => {
    expect(centeredWindow(items, 6, 5)).toEqual({
      items: [4, 5, 6, 7, 8],
      start: 4,
      end: 9,
      above: 4,
      below: 3,
    });
  });

  test('pins the window at both edges', () => {
    expect(centeredWindow(items, 0, 5).items).toEqual([0, 1, 2, 3, 4]);
    expect(centeredWindow(items, 11, 5).items).toEqual([7, 8, 9, 10, 11]);
  });

  test('clamps stale selection indexes', () => {
    expect(centeredWindow(items, 99, 3).items).toEqual([9, 10, 11]);
    expect(centeredWindow([], 0, 3)).toEqual({ items: [], start: 0, end: 0, above: 0, below: 0 });
  });
});
