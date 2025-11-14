/**
 * UI Helper Functions
 *
 * Common UI patterns and utilities for consistent rendering across components.
 */

import { TEXT_LIMITS, AGENT_DELEGATION_TOOLS } from '@config/constants.js';
import { UI_SYMBOLS } from '@config/uiSymbols.js';

/**
 * Creates a horizontal divider line for visual separation
 *
 * The divider respects minimum width and padding constraints to ensure
 * consistent appearance across different terminal sizes.
 *
 * @param terminalWidth - Current terminal width in columns
 * @returns A string of repeated horizontal line characters
 *
 * @example
 * ```typescript
 * const divider = createDivider(80);
 * // Returns: '────────────────────────────────────────────────────────'
 * ```
 */
export function createDivider(terminalWidth: number): string {
  // Calculate effective width by subtracting padding and ensuring minimum
  const effectiveWidth = Math.max(
    TEXT_LIMITS.DIVIDER_MIN_WIDTH,
    terminalWidth - TEXT_LIMITS.DIVIDER_PADDING
  );

  return UI_SYMBOLS.BORDER.HORIZONTAL.repeat(effectiveWidth);
}

/**
 * Creates an indentation string based on nesting level
 *
 * Used for threaded displays like nested tool calls, where each level
 * is indented by 4 spaces. This matches the indentation pattern used
 * in ToolCallDisplay component.
 *
 * @param level - Nesting level (0 = no indentation)
 * @returns A string of spaces for the specified indentation level
 *
 * @example
 * ```typescript
 * indentByLevel(0);  // Returns: ''
 * indentByLevel(1);  // Returns: '    ' (4 spaces)
 * indentByLevel(2);  // Returns: '        ' (8 spaces)
 * ```
 */
export function indentByLevel(level: number): string {
  return '    '.repeat(level);
}

/**
 * Checks if a tool name represents an agent delegation tool
 *
 * Agent delegation tools (like 'agent', 'explore', 'plan') are special
 * tools that delegate work to sub-agents and require different UI treatment,
 * such as nested display and specialized status indicators.
 *
 * @param toolName - The name of the tool to check
 * @returns True if the tool is an agent delegation tool, false otherwise
 *
 * @example
 * ```typescript
 * isAgentDelegation('agent');    // Returns: true
 * isAgentDelegation('explore');  // Returns: true
 * isAgentDelegation('Read');     // Returns: false
 * ```
 */
export function isAgentDelegation(toolName: string): boolean {
  return (AGENT_DELEGATION_TOOLS as readonly string[]).includes(toolName);
}

/**
 * Formats an agent name for display by converting kebab/snake case to Title Case
 *
 * Transforms agent names from their internal format (lowercase with hyphens/underscores)
 * to a human-readable format with proper capitalization.
 *
 * @param agentName - The internal agent name (e.g., "math-expert", "explore")
 * @returns The formatted display name (e.g., "Math Expert", "Explore")
 *
 * @example
 * ```typescript
 * formatAgentName('math-expert');      // Returns: 'Math Expert'
 * formatAgentName('explore');          // Returns: 'Explore'
 * formatAgentName('my_custom_agent');  // Returns: 'My Custom Agent'
 * ```
 */
export function formatAgentName(agentName: string): string {
  return agentName
    .split(/[-_]/)  // Split by hyphens or underscores
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())  // Capitalize each word
    .join(' ');  // Join with spaces
}
