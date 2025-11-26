/**
 * UI Symbols Configuration
 *
 * Centralizes all unicode symbols used throughout the user interface.
 * This ensures consistency across components and makes it easy to change
 * symbols in one place if needed.
 *
 * Symbol Categories:
 * - Status & Progress: Tool execution states and progress indicators
 * - Navigation & Flow: Directional indicators and flow arrows
 * - Todo & Checkboxes: Task list status indicators
 * - Lists: Bullet points for lists
 * - Dividers & Borders: Table and box drawing characters
 * - Diff: Version control change indicators
 * - Spinner: Animation frames for loading indicators
 * - Selection: UI selection indicators
 * - Separators: Visual content separators
 */

export const UI_SYMBOLS = {
  // ========================================
  // Status & Progress
  // ========================================
  STATUS: {
    /** Success/completion checkmark */
    SUCCESS: '✓',
    /** Error/failure cross */
    ERROR: '✕',
    /** Cancelled/prohibited symbol */
    CANCELLED: '⊘',
    /** Pending/empty circle */
    PENDING: '○',
    /** Validating/quarter circle */
    VALIDATING: '◔',
    /** Scheduled/half circle */
    SCHEDULED: '◐',
    /** Executing/filled circle */
    EXECUTING: '●',
  },

  // ========================================
  // Navigation & Flow
  // ========================================
  NAVIGATION: {
    /** Right arrow - primary direction indicator */
    ARROW_RIGHT: '→',
    /** Left arrow - backward navigation */
    ARROW_LEFT: '←',
    /** Up arrow - upward navigation */
    ARROW_UP: '↑',
    /** Down arrow - downward navigation */
    ARROW_DOWN: '↓',
    /** Hook arrow - subtask/nested item indicator */
    ARROW_HOOK: '↳',
    /** Greater than - simple right indicator */
    CHEVRON_RIGHT: '>',
    /** Therefore symbol - reasoning/thinking indicator */
    THEREFORE: '∴',
  },

  // ========================================
  // Todo & Checkboxes
  // ========================================
  TODO: {
    /** Unchecked checkbox - pending task */
    UNCHECKED: '☐',
    /** Checked checkbox - completed task */
    CHECKED: '☑',
    /** Empty circle - proposed/draft task */
    PROPOSED: '◯',
  },

  // ========================================
  // Lists
  // ========================================
  LIST: {
    /** Bullet point - list item marker */
    BULLET: '•',
  },

  // ========================================
  // Dividers & Borders (Box Drawing)
  // ========================================
  BORDER: {
    /** Horizontal line */
    HORIZONTAL: '─',
    /** Vertical line */
    VERTICAL: '│',
    /** Top-left corner */
    TOP_LEFT: '┌',
    /** Top-right corner */
    TOP_RIGHT: '┐',
    /** Bottom-left corner */
    BOTTOM_LEFT: '└',
    /** Bottom-right corner */
    BOTTOM_RIGHT: '┘',
    /** T-junction down (header separator) */
    T_DOWN: '┬',
    /** T-junction up (footer separator) */
    T_UP: '┴',
    /** T-junction right (left border junction) */
    T_RIGHT: '├',
    /** T-junction left (right border junction) */
    T_LEFT: '┤',
    /** Cross junction (middle separator) */
    CROSS: '┼',
  },

  // ========================================
  // Diff (Version Control)
  // ========================================
  DIFF: {
    /** Addition/inserted line */
    ADDITION: '+',
    /** Deletion/removed line */
    DELETION: '-',
  },

  // ========================================
  // Spinner (Animation Frames)
  // ========================================
  SPINNER: {
    /** Default/Dots spinner - Braille patterns for smooth rotation */
    DEFAULT: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    /** Dots variant (same as default) */
    DOTS: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    /** Line spinner - rotating line */
    LINE: ['─', '\\', '|', '/'],
    /** Dots2 spinner - block Braille patterns */
    DOTS2: ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'],
    /** Arc spinner - curved segments */
    ARC: ['◜', '◠', '◝', '◞', '◡', '◟'],
    /** Bounce spinner - bouncing Braille */
    BOUNCE: ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'],
  },

  // ========================================
  // Separators
  // ========================================
  SEPARATOR: {
    /** Bullet separator - visual divider between elements */
    BULLET: '•',
    /** Middle dot - lighter visual divider */
    MIDDLE_DOT: '·',
  },
} as const;

/**
 * Type-safe access to UI symbols
 * Example usage:
 *   import { UI_SYMBOLS } from '@config/uiSymbols.js';
 *   const checkmark = UI_SYMBOLS.STATUS.SUCCESS; // '✓'
 *   const arrow = UI_SYMBOLS.NAVIGATION.ARROW_RIGHT; // '→'
 */
export type UISymbols = typeof UI_SYMBOLS;
