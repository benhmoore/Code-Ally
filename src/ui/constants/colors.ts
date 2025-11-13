/**
 * Centralized UI Color Palette
 *
 * Code Ally uses a minimal, focused color scheme with yellow as the primary color.
 * This ensures visual consistency and reduces color noise across the interface.
 *
 * Design Principles:
 * - Yellow is the primary application color (mascot, selections, active states, user messages)
 * - Orange is used for warnings and attention
 * - Red is reserved for errors and critical states
 * - White is the default text color
 * - Gray (dim) is used for secondary/inactive elements
 * - Black provides contrast on yellow backgrounds
 */

/**
 * Core UI color palette
 *
 * Use these constants instead of hardcoded color strings to ensure consistency
 * and make future theme changes easier.
 */
export const UI_COLORS = {
  // ============================================================================
  // PRIMARY COLORS
  // ============================================================================

  /**
   * Yellow - Primary application color
   *
   * Usage:
   * - Mascot (chick/duck)
   * - Cursor
   * - User messages
   * - Selection indicators (carets, highlights)
   * - Active/in-progress states
   * - Permission titles (all sensitivities)
   * - File/plugin mentions
   * - Primary actions
   */
  PRIMARY: 'yellow',

  /**
   * Orange - Warning color (#ea800d)
   *
   * Usage:
   * - Warning messages
   * - Context usage 0-89%
   * - Caution states
   * - Attention-grabbing (non-critical)
   */
  WARNING: '#ea800d',

  /**
   * Red - Error and critical states
   *
   * Usage:
   * - Error messages
   * - Failed operations
   * - Cancellations
   * - Context usage 90-100%
   * - Destructive actions
   * - Diff deletions
   */
  ERROR: 'red',

  // ============================================================================
  // SECONDARY COLORS
  // ============================================================================

  /**
   * White - Default text color
   *
   * Usage:
   * - Normal content
   * - Assistant messages
   * - Completed tool calls
   * - Success states (non-highlighted)
   * - Body text
   * - Markdown content
   */
  TEXT_DEFAULT: 'white',

  /**
   * Gray - Secondary/dim elements
   *
   * Usage:
   * - Borders
   * - Inactive items
   * - Metadata
   * - Timestamps
   * - Placeholders
   * - Section dividers
   * - Disabled states
   * - Unselected items
   * - Pending/validating/scheduled statuses
   */
  TEXT_DIM: 'gray',

  /**
   * Black - Contrast text on yellow backgrounds
   *
   * Usage:
   * - Text on yellow search highlights
   * - Text on yellow selection backgrounds
   * - High contrast scenarios
   */
  TEXT_CONTRAST: 'black',
} as const;

// Type for color values
export type UIColor = (typeof UI_COLORS)[keyof typeof UI_COLORS];

/**
 * Semantic color mappings for common UI patterns
 *
 * These provide higher-level abstractions for specific use cases.
 */
export const SEMANTIC_COLORS = {
  // Interactive states
  SELECTED: UI_COLORS.PRIMARY,
  ACTIVE: UI_COLORS.PRIMARY,
  IN_PROGRESS: UI_COLORS.PRIMARY,
  INACTIVE: UI_COLORS.TEXT_DIM,
  DISABLED: UI_COLORS.TEXT_DIM,

  // Messages
  USER_MESSAGE: UI_COLORS.PRIMARY,
  ASSISTANT_MESSAGE: UI_COLORS.TEXT_DEFAULT,
  SYSTEM_MESSAGE: UI_COLORS.TEXT_DIM,
  TOOL_MESSAGE: UI_COLORS.TEXT_DIM,
  ERROR_MESSAGE: UI_COLORS.ERROR,

  // Status
  SUCCESS: UI_COLORS.TEXT_DEFAULT,
  WARNING: UI_COLORS.WARNING,
  ERROR: UI_COLORS.ERROR,
  PENDING: UI_COLORS.TEXT_DIM,

  // Borders
  BORDER_DEFAULT: UI_COLORS.TEXT_DIM,
  BORDER_WARNING: UI_COLORS.WARNING,
  BORDER_ERROR: UI_COLORS.ERROR,

  // UI Elements
  HEADER: UI_COLORS.TEXT_DEFAULT,
  CURSOR: UI_COLORS.PRIMARY,
  PLACEHOLDER: UI_COLORS.TEXT_DIM,
  METADATA: UI_COLORS.TEXT_DIM,

  // Highlighting
  HIGHLIGHT_BG: UI_COLORS.PRIMARY,
  HIGHLIGHT_FG: UI_COLORS.TEXT_CONTRAST,
  MENTION: UI_COLORS.PRIMARY,
} as const;

/**
 * Helper function to get context usage color based on percentage
 *
 * @param percent - Context usage percentage (0-100)
 * @returns Color for the given usage level
 */
export function getContextUsageColor(percent: number): UIColor {
  if (percent >= 90) {
    return UI_COLORS.ERROR; // Red for 90-100%
  }
  return UI_COLORS.WARNING; // Orange for 0-89%
}

/**
 * Helper function to get todo color based on status
 *
 * @param status - Todo status
 * @returns Color for the given status
 */
export function getTodoColorNew(
  status: 'in_progress' | 'completed' | 'proposed' | 'pending'
): UIColor {
  switch (status) {
    case 'in_progress':
      return UI_COLORS.PRIMARY; // Yellow for active
    case 'completed':
      return UI_COLORS.TEXT_DEFAULT; // White for done
    case 'proposed':
    case 'pending':
      return UI_COLORS.TEXT_DIM; // Gray for waiting
    default:
      return UI_COLORS.TEXT_DIM;
  }
}
