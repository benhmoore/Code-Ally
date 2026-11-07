/**
 * UI Helper Functions
 *
 * Common UI patterns and utilities for consistent rendering across components.
 */

import { isAgentDelegationTool } from '@config/constants.js';
import { UI_SYMBOLS } from '@config/uiSymbols.js';

/** Fill the caller's available content width; padding belongs to the layout. */
export function createDivider(availableWidth: number): string {
  return UI_SYMBOLS.BORDER.HORIZONTAL.repeat(Math.max(1, Math.floor(availableWidth)));
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
  return isAgentDelegationTool(toolName);
}

/**
 * Formats a name for display by converting kebab/snake case to Title Case
 *
 * Transforms names from their internal format (lowercase with hyphens/underscores)
 * to a human-readable format with proper capitalization. Works for both agent
 * names and tool names.
 *
 * @param name - The internal name (e.g., "math-expert", "explore", "web-fetch")
 * @returns The formatted display name (e.g., "Math Expert", "Explore", "Web Fetch")
 *
 * @example
 * ```typescript
 * formatDisplayName('math-expert');      // Returns: 'Math Expert'
 * formatDisplayName('explore');          // Returns: 'Explore'
 * formatDisplayName('web-fetch');        // Returns: 'Web Fetch'
 * formatDisplayName('my_custom_agent');  // Returns: 'My Custom Agent'
 * ```
 */
export function formatDisplayName(name: string): string {
  return name
    .split(/[-_]/)  // Split by hyphens or underscores
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())  // Capitalize each word
    .join(' ');  // Join with spaces
}
