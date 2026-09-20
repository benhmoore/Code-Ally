/**
 * Pointer hit-testing for Ink's live region.
 *
 * Ink lays the live region out with Yoga, so every element knows its box
 * relative to its parent. A click arrives as a terminal row and column, and
 * the live region's first row on screen is derived from the cursor position
 * the terminal reports after Ink's last write. These helpers turn one into
 * the other without touching Ink internals beyond the layout tree.
 */

export interface LayoutBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The subset of Ink's DOMElement the hit test relies on. */
export interface LayoutNode {
  yogaNode?: { getComputedLayout(): LayoutBox };
  parentNode?: LayoutNode;
}

/** A node's box in live-region coordinates (0-based rows and columns). */
export function absoluteLayout(node: LayoutNode): LayoutBox | null {
  const own = node.yogaNode?.getComputedLayout();
  if (!own) {
    return null;
  }
  let left = own.left;
  let top = own.top;
  for (let parent = node.parentNode; parent; parent = parent.parentNode) {
    const box = parent.yogaNode?.getComputedLayout();
    if (!box) {
      return null;
    }
    left += box.left;
    top += box.top;
  }
  return { left, top, width: own.width, height: own.height };
}

/** The root of the layout tree a node belongs to. */
export function layoutRoot(node: LayoutNode): LayoutNode {
  let root = node;
  while (root.parentNode) {
    root = root.parentNode;
  }
  return root;
}

/**
 * The 1-based terminal row where the live region starts.
 *
 * After a frame Ink leaves the cursor on the line below the region, unless
 * the region fills the screen, in which case there is no line below it and
 * the cursor rests on the region's last line.
 */
export function liveRegionTop(cursorRow: number, regionHeight: number, terminalRows: number): number {
  const fillsScreen = regionHeight >= terminalRows;
  return cursorRow - regionHeight + (fillsScreen ? 1 : 0);
}

export interface PointerTarget<T> {
  node: LayoutNode;
  value: T;
}

/**
 * The target under a live-region coordinate. Nested targets overlap, and the
 * innermost one (smallest area) wins, as a button inside a panel would.
 */
export function hitTest<T>(targets: Iterable<PointerTarget<T>>, row: number, column: number): T | undefined {
  let best: { value: T; area: number } | undefined;
  for (const target of targets) {
    const box = absoluteLayout(target.node);
    if (!box) continue;
    const inside = row >= box.top && row < box.top + box.height && column >= box.left && column < box.left + box.width;
    if (!inside) continue;
    const area = box.width * box.height;
    if (!best || area < best.area) {
      best = { value: target.value, area };
    }
  }
  return best?.value;
}
