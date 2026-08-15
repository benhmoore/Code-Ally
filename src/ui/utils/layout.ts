/** Minimum useful number of rows in a selectable viewport. */
const MIN_VISIBLE_ITEMS = 3;

/**
 * Derive a list window from terminal height.
 *
 * `chromeRows` includes the app shell, surface title, description, hints, and
 * any workflow-specific content outside the list. The function intentionally
 * rounds down and clamps: interactive content may scroll, but must never force
 * the controls below the viewport.
 */
export function visibleItemBudget(
  terminalRows: number,
  options: {
    chromeRows?: number;
    rowsPerItem?: number;
    maximum?: number;
    minimum?: number;
  } = {}
): number {
  const {
    chromeRows = 10,
    rowsPerItem = 1,
    maximum = 10,
    minimum = MIN_VISIBLE_ITEMS,
  } = options;
  const available = Math.max(1, terminalRows - chromeRows);
  return Math.max(minimum, Math.min(maximum, Math.floor(available / Math.max(1, rowsPerItem))));
}

/** Cap live output without pre-allocating any of the returned rows. */
export function liveRegionBudget(terminalRows: number): number {
  return Math.max(3, Math.min(12, Math.floor(terminalRows * 0.35)));
}

export interface CenteredWindow<T> {
  items: T[];
  start: number;
  end: number;
  above: number;
  below: number;
}

/** Return a stable, centered slice for every keyboard-driven list. */
export function centeredWindow<T>(
  items: T[],
  selectedIndex: number,
  visibleCount: number
): CenteredWindow<T> {
  const count = Math.max(1, Math.floor(visibleCount));
  const selected = Math.max(0, Math.min(items.length - 1, selectedIndex));
  const start = Math.max(0, Math.min(items.length - count, selected - Math.floor(count / 2)));
  const end = Math.min(items.length, start + count);

  return {
    items: items.slice(start, end),
    start,
    end,
    above: start,
    below: items.length - end,
  };
}
