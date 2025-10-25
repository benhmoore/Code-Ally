/**
 * Default configuration values for Code Ally
 *
 * This file defines all default settings with their types and default values.
 * Configuration can be overridden via config file or runtime modifications.
 */

import type { Config } from '../types/index.js';
import { formatError } from '../utils/errorUtils.js';

/**
 * Default configuration object
 *
 * This represents the complete set of configuration options available in Code Ally.
 * All values here serve as defaults when no custom configuration is provided.
 */
export const DEFAULT_CONFIG: Config = {
  // ==========================================
  // LLM MODEL SETTINGS
  // ==========================================
  model: null, // Auto-selected from available models
  service_model: null, // Model for background services (defaults to main model)
  endpoint: 'http://localhost:11434', // Ollama API endpoint
  context_size: 16384, // Context window size in tokens
  temperature: 0.3, // Generation temperature (0.0-1.0)
  max_tokens: 7000, // Max tokens to generate per response
  reasoning_effort: 'low', // Reasoning level for gpt-oss and reasoning models: "low", "medium", "high"

  // ==========================================
  // EXECUTION SETTINGS
  // ==========================================
  bash_timeout: 30, // Bash command timeout in seconds
  auto_confirm: false, // Skip permission prompts (dangerous)
  parallel_tools: true, // Enable parallel tool execution
  tool_call_activity_timeout: 120, // Timeout for agents without tool call activity (seconds)

  // ==========================================
  // UI PREFERENCES
  // ==========================================
  theme: 'default', // UI theme name
  compact_threshold: 95, // Context % threshold for auto-compact
  show_context_in_prompt: false, // Show context % in input prompt

  // ==========================================
  // TOOL RESULT PREVIEW SETTINGS
  // ==========================================
  tool_result_preview_lines: 3, // Lines to show in tool result preview
  tool_result_preview_enabled: true, // Enable tool result previews

  // ==========================================
  // TOOL CALL RETRY SETTINGS
  // ==========================================
  tool_call_retry_enabled: true, // Enable tool call retry on failure
  tool_call_max_retries: 2, // Maximum retry attempts
  tool_call_repair_attempts: true, // Attempt to repair malformed tool calls
  tool_call_verbose_errors: false, // Show verbose error messages

  // ==========================================
  // DIRECTORY TREE SETTINGS
  // ==========================================
  dir_tree_max_depth: 3, // Maximum depth for directory tree
  dir_tree_max_files: 20, // Maximum files to show in tree
  dir_tree_enable: false, // Enable directory tree generation

  // ==========================================
  // DIFF DISPLAY SETTINGS
  // ==========================================
  diff_display_enabled: true, // Show file change previews
  diff_display_max_file_size: 102400, // Max file size for diffs (bytes)
  diff_display_context_lines: 3, // Context lines around changes
  diff_display_theme: 'auto', // Theme: auto, dark, light, minimal
  diff_display_color_removed: 'on rgb(50,20,20)', // Removed line color
  diff_display_color_added: 'on rgb(20,50,20)', // Added line color
  diff_display_color_modified: 'on rgb(50,50,20)', // Modified line color

  // ==========================================
  // TOOL RESULT TRUNCATION (CONTEXT-AWARE)
  // ==========================================
  tool_result_max_tokens_normal: 1000, // 0-70% context usage
  tool_result_max_tokens_moderate: 750, // 70-85% context usage
  tool_result_max_tokens_aggressive: 500, // 85-95% context usage
  tool_result_max_tokens_critical: 200, // 95%+ context usage

  // ==========================================
  // READ TOOL SETTINGS
  // ==========================================
  read_max_tokens: 3000, // Maximum tokens for a single read operation

  // ==========================================
  // SETUP TRACKING
  // ==========================================
  setup_completed: false, // Whether initial setup ran
};

/**
 * Type validation mapping for configuration keys
 *
 * This ensures that configuration values loaded from files or set at runtime
 * match the expected types. Used during validation and type coercion.
 */
export const CONFIG_TYPES: Record<keyof Config, string> = {
  // LLM Settings
  model: 'string',
  service_model: 'string',
  endpoint: 'string',
  context_size: 'number',
  temperature: 'number',
  max_tokens: 'number',
  reasoning_effort: 'string',

  // Execution Settings
  bash_timeout: 'number',
  auto_confirm: 'boolean',
  parallel_tools: 'boolean',
  tool_call_activity_timeout: 'number',

  // UI Preferences
  theme: 'string',
  compact_threshold: 'number',
  show_context_in_prompt: 'boolean',

  // Tool Result Preview
  tool_result_preview_lines: 'number',
  tool_result_preview_enabled: 'boolean',

  // Tool Call Retry
  tool_call_retry_enabled: 'boolean',
  tool_call_max_retries: 'number',
  tool_call_repair_attempts: 'boolean',
  tool_call_verbose_errors: 'boolean',

  // Directory Tree
  dir_tree_max_depth: 'number',
  dir_tree_max_files: 'number',
  dir_tree_enable: 'boolean',

  // Diff Display
  diff_display_enabled: 'boolean',
  diff_display_max_file_size: 'number',
  diff_display_context_lines: 'number',
  diff_display_theme: 'string',
  diff_display_color_removed: 'string',
  diff_display_color_added: 'string',
  diff_display_color_modified: 'string',

  // Tool Result Truncation
  tool_result_max_tokens_normal: 'number',
  tool_result_max_tokens_moderate: 'number',
  tool_result_max_tokens_aggressive: 'number',
  tool_result_max_tokens_critical: 'number',

  // Read Tool
  read_max_tokens: 'number',

  // Setup
  setup_completed: 'boolean',
};

/**
 * Get the expected type for a configuration key
 */
export function getConfigType(key: keyof Config): string {
  return CONFIG_TYPES[key];
}

/**
 * Validate a configuration value against its expected type
 */
export function validateConfigValue(
  key: keyof Config,
  value: any
): { valid: boolean; coercedValue?: any; error?: string } {
  const expectedType = getConfigType(key);

  // Handle null model
  if (key === 'model' && value === null) {
    return { valid: true, coercedValue: null };
  }

  // Handle null/undefined service_model (defaults to main model)
  if (key === 'service_model' && (value === null || value === undefined)) {
    return { valid: true, coercedValue: value };
  }

  // Handle undefined reasoning_effort
  if (key === 'reasoning_effort' && (value === undefined || value === null)) {
    return { valid: true, coercedValue: undefined };
  }

  // Validate reasoning_effort values
  if (key === 'reasoning_effort' && typeof value === 'string') {
    const validValues = ['low', 'medium', 'high'];
    if (validValues.includes(value.toLowerCase())) {
      return { valid: true, coercedValue: value.toLowerCase() };
    }
    return { valid: false, error: `reasoning_effort must be one of: ${validValues.join(', ')}` };
  }

  try {
    switch (expectedType) {
      case 'string':
        if (typeof value === 'string') {
          return { valid: true, coercedValue: value };
        }
        return { valid: false, error: `Expected string, got ${typeof value}` };

      case 'number':
        if (typeof value === 'number') {
          return { valid: true, coercedValue: value };
        }
        if (typeof value === 'string') {
          const parsed = parseFloat(value);
          if (!isNaN(parsed)) {
            return { valid: true, coercedValue: parsed };
          }
        }
        return { valid: false, error: `Expected number, got ${typeof value}` };

      case 'boolean':
        if (typeof value === 'boolean') {
          return { valid: true, coercedValue: value };
        }
        // Coerce string to boolean
        if (typeof value === 'string') {
          const lower = value.toLowerCase();
          if (['true', 'yes', 'y', '1'].includes(lower)) {
            return { valid: true, coercedValue: true };
          }
          if (['false', 'no', 'n', '0'].includes(lower)) {
            return { valid: true, coercedValue: false };
          }
        }
        return { valid: false, error: `Expected boolean, got ${typeof value}` };

      default:
        return { valid: false, error: `Unknown type: ${expectedType}` };
    }
  } catch (error) {
    return {
      valid: false,
      error: `Validation error: ${formatError(error)}`,
    };
  }
}
