import { DIFF_LAYOUT_VALUES, MOUSE_SUPPORT_VALUES, type Config } from '../types/index.js';
import { MODEL_PROVIDERS } from './providers.js';
import { REASONING_EFFORT_API_VALUES } from './constants.js';
import { PERMISSION_MODES } from '../security/PermissionMode.js';

export const SECRET_CONFIG_KEYS = new Set<keyof Config>(['api_key', 'search_api_key', 'reviewer_api_key']);

export const CONFIG_SUGGESTIONS: Partial<Record<keyof Config, readonly unknown[]>> = {
  temperature: [null, 0, 0.3, 0.5, 0.7, 1],
  context_size: [32768, 65536, 131072, 262144],
  max_tokens: [2000, 4000, 7000, 10000, 16000],
  top_p: [null, 0.9, 0.95, 1],
  top_k: [null, 0, 20, 40],
  min_p: [null, 0, 0.05, 0.1],
  repeat_penalty: [null, 1, 1.1],
};

export const CONFIG_CHOICES: Partial<Record<keyof Config, readonly string[]>> = {
  permission_mode: PERMISSION_MODES,
  provider: MODEL_PROVIDERS.map(provider => provider.value),
  reasoning_effort: REASONING_EFFORT_API_VALUES,
  search_provider: ['none', 'brave', 'serper'],
  theme: ['default', 'dark', 'light', 'minimal'],
  diff_display_theme: ['auto', 'dark', 'light', 'minimal'],
  diff_display_layout: DIFF_LAYOUT_VALUES,
  mouse_support: MOUSE_SUPPORT_VALUES,
};

export interface ConfigNumberRule {
  minimum?: number;
  maximum?: number;
  integer?: boolean;
}

/** Valid numeric domains shared by setting validation and focused help. */
export const CONFIG_NUMBER_RULES: Partial<Record<keyof Config, ConfigNumberRule>> = {
  context_size: { minimum: 1, integer: true },
  max_tokens: { minimum: 1, integer: true },
  temperature: { minimum: 0, maximum: 2 },
  top_p: { minimum: 0, maximum: 1 },
  min_p: { minimum: 0, maximum: 1 },
  top_k: { minimum: 0, integer: true },
  repeat_penalty: { minimum: 0 },
  bash_timeout: { minimum: 1, integer: true },
  tool_call_activity_timeout: { minimum: 0, integer: true },
  tool_call_max_retries: { minimum: 0, integer: true },
  dir_tree_max_depth: { minimum: 0, integer: true },
  dir_tree_max_files: { minimum: 1, integer: true },
  diff_display_max_file_size: { minimum: 1, integer: true },
  diff_display_context_lines: { minimum: 0, integer: true },
  tool_result_max_context_percent: { minimum: 0, maximum: 1 },
  tool_result_min_tokens: { minimum: 0, integer: true },
  read_max_tokens: { minimum: 1, integer: true },
};

export const CONFIG_CATEGORIES: Record<string, (keyof Config)[]> = {
  'LLM Model Settings': [
    'provider',
    'endpoint',
    'api_key',
    'model',
    'service_model',
    'explore_model',
    'plan_model',
    'agent_creation_model',
    'context_size',
    'temperature',
    'max_tokens',
    'reasoning_effort',
    'top_p',
    'top_k',
    'min_p',
    'repeat_penalty',
    'stop',
  ],
  'Agent Settings': ['default_agent'],
  'Execution Settings': [
    'bash_timeout',
    'permission_mode',
    'parallel_tools',
    'stream_responses',
    'tool_call_activity_timeout',
  ],
  'File System Settings': ['temp_directory'],
  'UI Preferences': [
    'theme',
    'show_thinking_in_chat',
    'show_system_prompt_in_chat',
    'show_full_tool_output',
    'show_tool_parameters_in_chat',
    'enable_idle_messages',
    'enable_session_title_generation',
    'enable_terminal_hyperlinks',
    'mouse_support',
  ],
  'Tool Call Retry': [
    'tool_call_retry_enabled',
    'tool_call_max_retries',
    'tool_call_repair_attempts',
    'tool_call_verbose_errors',
  ],
  'Directory Tree': ['dir_tree_enable', 'dir_tree_max_depth', 'dir_tree_max_files'],
  'Diff Display': [
    'diff_display_enabled',
    'diff_display_max_file_size',
    'diff_display_context_lines',
    'diff_display_theme',
    'diff_display_layout',
    'diff_display_color_removed',
    'diff_display_color_added',
    'diff_display_color_modified',
  ],
  'Tool Result Truncation': ['tool_result_max_context_percent', 'tool_result_min_tokens'],
  'Read Tool': ['read_max_tokens'],
  Setup: ['setup_completed'],
  'Search Integration': ['search_provider', 'search_api_key'],
  'Permission Reviewer': ['reviewer_model', 'reviewer_endpoint', 'reviewer_api_key', 'reviewer_shadow'],
};

export const CONFIG_DESCRIPTIONS: Partial<Record<keyof Config, string>> = {
  // LLM Model Settings
  model: 'LLM model name',
  service_model: 'Model for background services (titles, idle messages)',
  explore_model: 'Model for Explore agent',
  plan_model: 'Model for Plan agent',
  agent_creation_model: 'Model for ManageAgents agent',
  provider: 'Model provider',
  endpoint: 'Provider base URL',
  api_key: 'Provider API key (stored encrypted)',
  context_size:
    'Context window in tokens. Use at least 32768 for everyday coding; smaller windows are for stress testing.',
  temperature: 'Generation temperature override (unset uses model default)',
  max_tokens: 'Maximum response tokens. The request budget also reserves space for conversation and tools.',
  reasoning_effort: 'Reasoning effort for providers that support it: low, medium or high.',
  top_p: 'Sampling probability cutoff (unset uses the model default)',
  top_k: 'Sampling candidate count (unset uses the model default)',
  min_p: 'Minimum token probability (unset uses the model default)',
  repeat_penalty: 'Repetition penalty override (unset uses the model default)',
  stop: 'JSON array of sequences that end generation',
  stream_responses: 'Stream model output as it arrives',

  // Agent Settings
  default_agent: 'Default agent at startup',

  // Execution Settings
  bash_timeout: 'Bash command timeout (seconds)',
  permission_mode: 'manual asks for approval; auto selectively reviews actions and falls back to manual until a reviewer is ready; allow-all skips interactive approval.',
  reviewer_model: 'SystemOne decision model. Unset auto-detects a local model advertising decision capability; remote-hosted models are excluded.',
  reviewer_endpoint: 'Reviewer server base URL supporting /v1/systemone, not a chat-completions endpoint. Unset inherits the main endpoint.',
  reviewer_api_key: 'Reviewer API key (encrypted). Unset inherits the main key only when reviewer and main endpoints match.',
  reviewer_shadow: 'Observe reviewer recommendations while keeping manual approval. Useful when evaluating a reviewer before enabling selective Auto.',
  parallel_tools: 'Enable parallel tool execution',
  tool_call_activity_timeout: 'Agent no-tool activity timeout (seconds)',

  // UI Preferences
  theme: 'UI theme name',
  show_thinking_in_chat: 'Show model thinking in chat',
  show_system_prompt_in_chat: 'Show system prompts in chat',
  show_full_tool_output: 'Show full tool output without truncation',
  show_tool_parameters_in_chat: 'Show tool parameters in chat',
  enable_idle_messages: 'Enable generated idle status messages',
  enable_session_title_generation: 'Enable generated session titles',
  enable_terminal_hyperlinks: 'Make file names and links clickable in supporting terminals',
  mouse_support: 'Mouse clicks: off, dialogs (default) or always',

  // Tool Call Retry
  tool_call_retry_enabled: 'Enable automatic tool-call retry',
  tool_call_max_retries: 'Maximum tool-call retries',
  tool_call_repair_attempts: 'Ask model to repair invalid tool calls',
  tool_call_verbose_errors: 'Show verbose tool-call errors',

  // File System Settings
  temp_directory: 'Temporary file directory',

  // Directory Tree
  dir_tree_enable: 'Enable directory tree generation',
  dir_tree_max_depth: 'Directory tree max depth',
  dir_tree_max_files: 'Directory tree max files',

  // Diff Display
  diff_display_enabled: 'Show file diffs',
  diff_display_max_file_size: 'Max diff file size (bytes)',
  diff_display_context_lines: 'Diff context lines',
  diff_display_theme: 'Diff theme',
  diff_display_layout: 'Diff layout: auto, unified or side-by-side',
  diff_display_color_removed: 'Removed line color',
  diff_display_color_added: 'Added line color',
  diff_display_color_modified: 'Modified line color',

  // Tool Result Truncation
  tool_result_max_context_percent: 'Max context % per tool result',
  tool_result_min_tokens: 'Minimum tokens per result',
  read_max_tokens: 'Maximum tokens for read operations',
  setup_completed: 'Whether setup wizard has completed',
};

export function formatConfigValue(key: keyof Config, value: unknown): string {
  if (SECRET_CONFIG_KEYS.has(key) && value) return '[REDACTED]';
  if (value === undefined) return '(model default)';
  return typeof value === 'string' ? value : JSON.stringify(value);
}
