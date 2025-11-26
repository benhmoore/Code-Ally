/**
 * UI utilities for todo display
 *
 * Centralizes todo-related display logic including checkbox symbols
 * and color mapping for different todo statuses.
 */

import { UI_SYMBOLS } from '@config/uiSymbols.js';
import { UI_COLORS } from '../constants/colors.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'proposed';

/**
 * Get the checkbox symbol for a todo status
 *
 * Returns the appropriate checkbox character based on the todo's current status:
 * - completed: Checked checkbox (☑)
 * - in_progress: Unchecked checkbox (☐)
 * - proposed: Empty circle (◯) for draft/proposed tasks
 * - pending: Unchecked checkbox (☐)
 *
 * @param status - The todo status
 * @returns Checkbox symbol for the status
 */
export function getCheckboxSymbol(status: string): string {
  switch (status) {
    case 'completed':
      return UI_SYMBOLS.TODO.CHECKED;
    case 'in_progress':
      return UI_SYMBOLS.TODO.UNCHECKED;
    case 'proposed':
      return UI_SYMBOLS.TODO.PROPOSED;
    case 'pending':
      return UI_SYMBOLS.TODO.UNCHECKED;
    default:
      return UI_SYMBOLS.TODO.UNCHECKED;
  }
}

/**
 * Get the color for a todo status
 *
 * Returns the appropriate color name for displaying a todo based on its status:
 * - in_progress: Yellow (active task)
 * - completed: White (finished task)
 * - proposed: Gray (draft/proposed task)
 * - pending: Gray (waiting task)
 *
 * @param status - The todo status
 * @returns Color name for the status
 */
export function getTodoColor(status: string): string {
  switch (status) {
    case 'in_progress':
      return UI_COLORS.PRIMARY;
    case 'completed':
      return UI_COLORS.TEXT_DEFAULT;
    case 'proposed':
      return UI_COLORS.TEXT_DIM;
    case 'pending':
      return UI_COLORS.TEXT_DIM;
    default:
      return UI_COLORS.TEXT_DIM;
  }
}
