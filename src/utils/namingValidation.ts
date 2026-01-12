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

/** Maximum skill name length (64 characters) */
export const SKILL_NAME_MAX_LENGTH = 64;

/** Maximum skill description length (1024 characters) */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/**
 * Validate skill name follows kebab-case pattern and length constraints
 *
 * @param name - Skill name to validate
 * @returns Validation result with error message if invalid
 */
export function validateSkillName(name: string): ValidationResult {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Skill name is required and must be a string' };
  }

  if (name.length > SKILL_NAME_MAX_LENGTH) {
    return {
      valid: false,
      error: `Invalid skill name '${name}': must be ${SKILL_NAME_MAX_LENGTH} characters or fewer (currently ${name.length})`
    };
  }

  if (!KEBAB_CASE_PATTERN.test(name)) {
    return {
      valid: false,
      error: `Invalid skill name '${name}': must be lowercase letters, numbers, and hyphens only (kebab-case). Examples: 'git-commit', 'code-review'`
    };
  }

  return { valid: true };
}
