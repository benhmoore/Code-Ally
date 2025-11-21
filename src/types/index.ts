/**
 * Core type definitions for Code Ally
 */

// ===========================
// Message Types
// ===========================

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  id?: string; // Unique identifier for deduplication
  role: MessageRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  thinking?: string; // Native reasoning/thinking content from model
  thinkingStartTime?: number; // When thinking started (for duration calculation)
  thinkingEndTime?: number; // When thinking completed (for duration calculation)
  timestamp?: number; // For chronological ordering with tool calls
  metadata?: MessageMetadata; // Presentation hints and command metadata
}

/**
 * Optional metadata for messages
 */
export interface MessageMetadata {
  /** Whether this is a command response that should be styled in yellow */
  isCommandResponse?: boolean;
  /** Whether this is an error message that should be styled in red */
  isError?: boolean;
  /** Whether this message should be removed after the current turn */
  ephemeral?: boolean;
  /** Whether this is a user interjection mid-response */
  isInterjection?: boolean;
  /** Parent ID for nested interjections (tool call ID or 'root') */
  parentId?: string;
  /** Whether this is a partial assistant response (interrupted mid-stream) */
  partial?: boolean;
  /** Whether this is a conversation summary that should be displayed in UI */
  isConversationSummary?: boolean;
  /** File paths that were mentioned using '@' completion in this message */
  mentions?: {
    files?: string[];
  };
  /** Tool visibility state for each tool call (keyed by tool call ID) */
  tool_visibility?: Record<string, boolean>;
  /** Tool status for each tool call (keyed by tool call ID) */
  tool_status?: Record<string, 'success' | 'error'>;
  // Future: Add more presentation hints as needed
}

// ===========================
// Tool Types
// ===========================

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: Record<string, any>; // Object (Ollama format)
  };
}

export interface FunctionDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, ParameterSchema>;
      required?: string[];
    };
  };
}

export interface ParameterSchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  items?: ParameterSchema;
  properties?: Record<string, ParameterSchema>;
  required?: string[];
}

export type ErrorType =
  | 'validation_error'
  | 'system_error'
  | 'permission_error'
  | 'permission_denied'
  | 'security_error'
  | 'timeout_error'
  | 'command_failed'
  | 'interrupted'
  | 'interactive_command'
  | 'depth_limit_exceeded'
  | 'execution_error'
  | 'plugin_error'
  | 'user_error'
  | 'file_error'
  | 'agent_mismatch'
  | 'general';

export interface ToolResult {
  success: boolean;
  error: string;
  error_type?: ErrorType;
  suggestion?: string;
  system_reminder?: string;
  system_reminder_persist?: boolean;
  _non_truncatable?: boolean; // If true, this result should never be truncated - operation must fail if insufficient context
  [key: string]: any;
}

// ===========================
// Activity Stream Types
// ===========================

export enum ActivityEventType {
  TOOL_CALL_START = 'tool_call_start',
  TOOL_CALL_END = 'tool_call_end',
  TOOL_PERMISSION_REQUEST = 'tool_permission_request',
  TOOL_EXECUTION_START = 'tool_execution_start',
  TOOL_OUTPUT_CHUNK = 'tool_output_chunk',
  THOUGHT_CHUNK = 'thought_chunk',
  THOUGHT_COMPLETE = 'thought_complete',
  ASSISTANT_CHUNK = 'assistant_chunk',
  ASSISTANT_MESSAGE_COMPLETE = 'assistant_message_complete',
  SYSTEM_PROMPT_DISPLAY = 'system_prompt_display',
  AGENT_START = 'agent_start',
  AGENT_END = 'agent_end',
  ERROR = 'error',
  PERMISSION_REQUEST = 'permission_request',
  PERMISSION_RESPONSE = 'permission_response',
  MODEL_SELECT_REQUEST = 'model_select_request',
  MODEL_SELECT_RESPONSE = 'model_select_response',
  SESSION_SELECT_REQUEST = 'session_select_request',
  SESSION_SELECT_RESPONSE = 'session_select_response',
  CONFIG_VIEW_REQUEST = 'config_view_request',
  CONFIG_VIEW_RESPONSE = 'config_view_response',
  REWIND_REQUEST = 'rewind_request',
  REWIND_RESPONSE = 'rewind_response',
  TODO_UPDATE = 'todo-update',
  UNDO_FILE_LIST_REQUEST = 'undo_file_list_request',
  UNDO_FILE_SELECTED = 'undo_file_selected',
  UNDO_FILE_BACK = 'undo_file_back',
  UNDO_CONFIRM = 'undo_confirm',
  UNDO_CANCELLED = 'undo_cancelled',
  USER_INTERRUPT_INITIATED = 'user_interrupt_initiated',
  INTERRUPT_ALL = 'interrupt_all',
  DIFF_PREVIEW = 'diff_preview',
  SETUP_WIZARD_REQUEST = 'setup_wizard_request',
  SETUP_WIZARD_COMPLETE = 'setup_wizard_complete',
  SETUP_WIZARD_SKIP = 'setup_wizard_skip',
  PROJECT_WIZARD_REQUEST = 'project_wizard_request',
  PROJECT_WIZARD_COMPLETE = 'project_wizard_complete',
  PROJECT_WIZARD_SKIP = 'project_wizard_skip',
  AGENT_WIZARD_REQUEST = 'agent_wizard_request',
  AGENT_WIZARD_COMPLETE = 'agent_wizard_complete',
  AGENT_WIZARD_SKIP = 'agent_wizard_skip',
  AGENT_SELECT_REQUEST = 'agent_select_request',
  AGENT_SELECT_RESPONSE = 'agent_select_response',
  AGENT_USE_REQUEST = 'agent_use_request',
  AGENT_USE_COMPLETE = 'agent_use_complete',
  CONTEXT_USAGE_UPDATE = 'context_usage_update',
  COMPACTION_START = 'compaction_start',
  COMPACTION_COMPLETE = 'compaction_complete',
  PLUGIN_CONFIG_REQUEST = 'plugin_config_request',
  PLUGIN_CONFIG_COMPLETE = 'plugin_config_complete',
  PLUGIN_CONFIG_CANCEL = 'plugin_config_cancel',
  USER_INTERJECTION = 'user_interjection',
  INTERJECTION_ACKNOWLEDGMENT = 'interjection_acknowledgment',
  LIBRARY_SELECT_REQUEST = 'library_select_request',
  LIBRARY_SELECT_RESPONSE = 'library_select_response',
  PROMPT_MESSAGE_SELECT_REQUEST = 'prompt_message_select_request',
  PROMPT_MESSAGE_SELECT_RESPONSE = 'prompt_message_select_response',
  PROMPT_ADD_REQUEST = 'prompt_add_request',
  PROMPT_ADD_RESPONSE = 'prompt_add_response',
  LIBRARY_CLEAR_CONFIRM_REQUEST = 'library_clear_confirm_request',
  LIBRARY_CLEAR_CONFIRM_RESPONSE = 'library_clear_confirm_response',
}

export interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  timestamp: number;
  parentId?: string;
  data: any;
}

export type ActivityCallback = (event: ActivityEvent) => void;

// ===========================
// Tool Status Types
// ===========================

export type ToolStatus =
  | 'pending'
  | 'validating'
  | 'scheduled'
  | 'executing'
  | 'success'
  | 'error'
  | 'cancelled';

export interface ToolCallState {
  id: string;
  status: ToolStatus;
  toolName: string;
  arguments: any;
  output?: string;
  error?: string;
  error_type?: ErrorType; // Type of error for filtering display
  startTime: number;
  executionStartTime?: number; // When actual execution starts (after permission granted)
  endTime?: number;
  parentId?: string; // For nested tool calls (e.g., subagents)
  visibleInChat?: boolean; // Whether this tool should appear in conversation
  isTransparent?: boolean; // For wrapper tools that should not be displayed
  collapsed?: boolean; // For tools that should hide their children immediately
  shouldCollapse?: boolean; // For tools that should collapse after completion
  hideOutput?: boolean; // For tools that should never show output
  thinking?: string; // Thinking content for agent tools
  thinkingStartTime?: number; // When thinking started (for duration calculation)
  thinkingEndTime?: number; // When thinking completed (for duration calculation)
  agentId?: string; // Pool agent ID for agent delegations (used to look up agent type)
  diffPreview?: {
    oldContent: string;
    newContent: string;
    filePath: string;
    operationType: string;
  };
}

// ===========================
// Configuration Types
// ===========================

export interface Config {
  // LLM Settings
  model: string | null;
  service_model?: string | null; // Model for background services (titles, idle messages). Defaults to main model.
  explore_model?: string | null; // Model for Explore agent. Defaults to global model.
  plan_model?: string | null; // Model for Plan agent. Defaults to global model.
  endpoint: string;
  context_size: number;
  temperature: number;
  max_tokens: number;
  reasoning_effort?: string; // Reasoning level for models that support it (e.g., "low", "medium", "high")

  // Execution Settings
  bash_timeout: number;
  auto_confirm: boolean;
  parallel_tools: boolean;
  tool_call_activity_timeout: number; // Timeout in seconds for agents without tool call activity

  // UI Preferences
  theme: string;
  compact_threshold: number;
  show_context_in_prompt: boolean;
  show_thinking_in_chat: boolean;
  show_system_prompt_in_chat: boolean;
  show_full_tool_output: boolean;
  show_tool_parameters_in_chat: boolean; // Show tool parameter lists in chat UI
  enable_idle_messages: boolean; // Enable auto-generated idle status messages
  enable_session_title_generation: boolean; // Enable auto-generated session titles

  // Tool Call Retry Settings
  tool_call_retry_enabled: boolean;
  tool_call_max_retries: number;
  tool_call_repair_attempts: boolean;
  tool_call_verbose_errors: boolean;

  // Filesystem Settings
  temp_directory: string;

  // Directory Tree Settings
  dir_tree_max_depth: number;
  dir_tree_max_files: number;
  dir_tree_enable: boolean;

  // Diff Display
  diff_display_enabled: boolean;
  diff_display_max_file_size: number;
  diff_display_context_lines: number;
  diff_display_theme: string;
  diff_display_color_removed: string;
  diff_display_color_added: string;
  diff_display_color_modified: string;

  // Tool Result Truncation (Context-Aware)
  tool_result_max_context_percent: number;
  tool_result_min_tokens: number;

  // Read Tool Settings
  read_max_tokens: number;

  // Setup
  setup_completed: boolean;
}

// ===========================
// Service Types
// ===========================

export enum ServiceLifecycle {
  SINGLETON = 'singleton',
  TRANSIENT = 'transient',
  SCOPED = 'scoped',
}

export interface IService {
  initialize(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface BackgroundTask {
  readonly isActive: boolean;
}

// ===========================
// Session Types
// ===========================

export interface SessionMetadata {
  title?: string;
  tags?: string[];
  model?: string;
  lastTitleGeneratedAt?: number; // Timestamp of last title generation
  pendingToolCleanups?: string[]; // Tool call IDs identified as irrelevant, pending cleanup
  lastCleanupAnalysisAt?: number; // Timestamp of last cleanup analysis
}

export interface Session {
  id: string;
  name: string;
  title?: string;
  created_at: string;
  updated_at: string;
  working_dir: string;
  messages: Message[];
  todos?: Array<{
    id: string;
    task: string;
    status: 'proposed' | 'pending' | 'in_progress' | 'completed';
    activeForm: string;
    created_at: string;
    dependencies?: string[];
    subtasks?: Array<{
      id: string;
      task: string;
      status: 'proposed' | 'pending' | 'in_progress' | 'completed';
      activeForm: string;
      created_at: string;
    }>;
  }>;
  idle_messages?: string[]; // Queue of generated idle messages
  project_context?: {
    languages: string[];
    frameworks: string[];
    projectName?: string;
    projectType?: string;
    hasGit: boolean;
    packageManager?: string;
    scale: 'small' | 'medium' | 'large';
    hasDocker?: boolean;
    cicd?: string[];
    detectedAt: string;
  };
  metadata?: SessionMetadata;
  active_plugins?: string[]; // List of active plugin names for this session
}

export interface SessionInfo {
  session_id: string;
  display_name: string;
  last_modified_timestamp: number;
  message_count: number;
  working_dir: string;
  lastUserMessage?: string;
}

// ===========================
// Prompt Library Types
// ===========================

export type { PromptInfo } from '../services/PromptLibraryManager.js';
