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
 * Profile color palette for user personalization
 *
 * This array defines 8 distinct terminal-safe colors that can be used for profile customization.
 * Each profile can select a color from this palette to personalize their UI experience.
 *
 * Index 0 (yellow) is the default color for the primary profile.
 */
export const PROFILE_COLOR_PALETTE = [
  'yellow',      // Index 0: Default profile color
  'cyan',        // Index 1
  '#50fa7b',     // Index 2: Green
  '#bd93f9',     // Index 3: Purple
  'magenta',     // Index 4
  '#8be9fd',     // Index 5: Light cyan
  '#f1fa8c',     // Index 6: Light yellow
  '#ff79c6',     // Index 7: Pink
] as const;

/**
 * Core UI color palette
 *
 * Use these constants instead of hardcoded color strings to ensure consistency
 * and make future theme changes easier.
 *
 * Note: PRIMARY is mutable to support profile color customization.
 * Use initializePrimaryColor() to set it during app initialization.
 */
export const UI_COLORS = {
  // ============================================================================
  // PRIMARY COLORS
  // ============================================================================

  /**
   * Yellow - Primary application color
   *
   * This color is mutable and can be changed via initializePrimaryColor()
   * to support profile color customization. Defaults to yellow.
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
  PRIMARY: 'yellow' as string,

  /**
   * Orange - Warning color (#ea800d)
   *
   * Usage:
   * - Warning messages
   * - Context usage 0-89%
   * - Caution states
   * - Attention-grabbing (non-critical)
   */
  WARNING: '#ea800d' as const,

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
  ERROR: 'red' as const,

  /**
   * Green - Success and positive states (#50fa7b)
   *
   * Usage:
   * - Success messages
   * - Completed operations
   * - Positive confirmations
   * - Diff additions
   */
  SUCCESS: '#50fa7b' as const,

  /**
   * Cyan - Memory and note-taking mode
   *
   * Usage:
   * - Memory input mode border (# prefix)
   * - ALLY.md memory storage indicator
   */
  MEMORY: 'cyan' as const,

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
  TEXT_DEFAULT: 'white' as const,

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
  TEXT_DIM: 'gray' as const,

  /**
   * Black - Contrast text on yellow backgrounds
   *
   * Usage:
   * - Text on yellow search highlights
   * - Text on yellow selection backgrounds
   * - High contrast scenarios
   */
  TEXT_CONTRAST: 'black' as const,
};

// Type for color values
export type UIColor = (typeof UI_COLORS)[keyof typeof UI_COLORS];

/**
 * ANSI escape codes for terminal string output
 *
 * Use these when building strings that need color outside of Ink components
 * (e.g., command responses that get rendered as markdown).
 */
export const ANSI_COLORS = {
  /** Orange/warning color (matches UI_COLORS.WARNING) */
  WARNING: '\x1b[38;5;208m',
  /** Red/error color */
  ERROR: '\x1b[31m',
  /** Green/success color */
  SUCCESS: '\x1b[32m',
  /** Yellow/primary color */
  PRIMARY: '\x1b[33m',
  /** Cyan/memory color */
  MEMORY: '\x1b[36m',
  /** Reset to default */
  RESET: '\x1b[0m',
} as const;

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
  SUCCESS: UI_COLORS.SUCCESS,
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

/**
 * Initialize the primary UI color
 *
 * This function sets UI_COLORS.PRIMARY to a custom color, enabling profile-specific
 * color customization. It should be called early during application initialization,
 * before any UI components are rendered.
 *
 * The color parameter should typically come from a profile's color preference,
 * using one of the colors from PROFILE_COLOR_PALETTE.
 *
 * @param color - The color to use as the primary UI color (e.g., 'yellow', 'cyan', '#50fa7b')
 *
 * @example
 * // During app initialization:
 * const profileColor = PROFILE_COLOR_PALETTE[profileColorIndex];
 * initializePrimaryColor(profileColor);
 *
 * @example
 * // Using default color:
 * initializePrimaryColor(PROFILE_COLOR_PALETTE[0]); // Yellow
 */
export function initializePrimaryColor(color: string): void {
  UI_COLORS.PRIMARY = color;
}
