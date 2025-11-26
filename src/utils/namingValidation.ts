/**
 * Naming validation utilities for strict kebab-case enforcement
 *
 * Enforces kebab-case naming convention for all tools and agents.
 * No normalization or fallbacks - validation failures are explicit and clear.
 */

/** Kebab-case pattern: lowercase letters/numbers with hyphens between segments */
export const KEBAB_CASE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate agent name follows kebab-case pattern
 *
 * @param name - Agent name to validate
 * @returns Validation result with error message if invalid
 */
export function validateAgentName(name: string): ValidationResult {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Agent name is required and must be a string' };
  }

  if (!KEBAB_CASE_PATTERN.test(name)) {
    return {
      valid: false,
      error: `Invalid agent name '${name}': must be lowercase letters, numbers, and hyphens only (kebab-case). Examples: 'math-expert', 'code-reviewer'`
    };
  }

  return { valid: true };
}

/**
 * Validate tool name follows kebab-case pattern
 *
 * @param name - Tool name to validate
 * @returns Validation result with error message if invalid
 */
export function validateToolName(name: string): ValidationResult {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Tool name is required and must be a string' };
  }

  if (!KEBAB_CASE_PATTERN.test(name)) {
    return {
      valid: false,
      error: `Invalid tool name '${name}': must be lowercase letters, numbers, and hyphens only (kebab-case). Examples: 'read-file', 'execute-command'`
    };
  }

  return { valid: true };
}
