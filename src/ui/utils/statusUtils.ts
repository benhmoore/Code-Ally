/**
 * UI utilities for tool status display
 */

import { UI_SYMBOLS } from '@config/uiSymbols.js';
import { UI_COLORS } from '../constants/colors.js';

export type ToolStatus =
  | 'pending'
  | 'validating'
  | 'scheduled'
  | 'executing'
  | 'success'
  | 'error'
  | 'cancelled';

/**
 * Get the color for a tool status
 *
 * @param status - The tool status
 * @returns Color name for the status
 */
export function getStatusColor(status: ToolStatus): string {
  switch (status) {
    case 'executing':
    case 'pending':
    case 'validating':
    case 'scheduled':
      return UI_COLORS.PRIMARY;
    case 'success':
      return UI_COLORS.TEXT_DEFAULT;
    case 'error':
    case 'cancelled':
      return UI_COLORS.ERROR;
    default:
      return UI_COLORS.TEXT_DEFAULT;
  }
}

/**
 * Get the icon for a tool status
 *
 * Uses centralized UI_SYMBOLS as single source of truth for status icons.
 *
 * @param status - The tool status
 * @returns Icon character for the status
 */
export function getStatusIcon(status: ToolStatus): string {
  switch (status) {
    case 'pending':
      return UI_SYMBOLS.STATUS.PENDING;
    case 'validating':
      return UI_SYMBOLS.STATUS.VALIDATING;
    case 'scheduled':
      return UI_SYMBOLS.STATUS.SCHEDULED;
    case 'executing':
      return UI_SYMBOLS.STATUS.EXECUTING;
    case 'success':
      return UI_SYMBOLS.STATUS.SUCCESS;
    case 'error':
      return UI_SYMBOLS.STATUS.ERROR;
    case 'cancelled':
      return UI_SYMBOLS.STATUS.CANCELLED;
    default:
      return '?';
  }
}
