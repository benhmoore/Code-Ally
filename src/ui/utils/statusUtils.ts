/**
 * UI utilities for tool status display
 */

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
      return 'cyan';
    case 'success':
      return 'green';
    case 'error':
    case 'cancelled':
      return 'red';
    default:
      return 'white';
  }
}

/**
 * Get the icon for a tool status
 *
 * @param status - The tool status
 * @returns Icon character for the status
 */
export function getStatusIcon(status: ToolStatus): string {
  switch (status) {
    case 'pending':
      return '○';
    case 'validating':
      return '◔';
    case 'scheduled':
      return '◐';
    case 'executing':
      return '●';
    case 'success':
      return '✓';
    case 'error':
      return '✕';
    case 'cancelled':
      return '⊘';
    default:
      return '?';
  }
}
