/**
 * Core type definitions for Code Ally
 */

// ===========================
// Message Types
// ===========================

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: MessageRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  timestamp?: number; // For chronological ordering with tool calls
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

export interface ToolResult {
  success: boolean;
  error: string;
  error_type?: string;
  suggestion?: string;
  [key: string]: any;
}

// ===========================
// Activity Stream Types
// ===========================

export enum ActivityEventType {
  TOOL_CALL_START = 'tool_call_start',
  TOOL_CALL_END = 'tool_call_end',
  TOOL_OUTPUT_CHUNK = 'tool_output_chunk',
  THOUGHT_CHUNK = 'thought_chunk',
  ASSISTANT_CHUNK = 'assistant_chunk',
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
  USER_INTERRUPT_INITIATED = 'user_interrupt_initiated',
  INTERRUPT_ALL = 'interrupt_all',
  DIFF_PREVIEW = 'diff_preview',
  SETUP_WIZARD_REQUEST = 'setup_wizard_request',
  SETUP_WIZARD_COMPLETE = 'setup_wizard_complete',
  SETUP_WIZARD_SKIP = 'setup_wizard_skip',
  PROJECT_WIZARD_REQUEST = 'project_wizard_request',
  PROJECT_WIZARD_COMPLETE = 'project_wizard_complete',
  PROJECT_WIZARD_SKIP = 'project_wizard_skip',
  CONTEXT_USAGE_UPDATE = 'context_usage_update',
  AUTO_COMPACTION_START = 'auto_compaction_start',
  AUTO_COMPACTION_COMPLETE = 'auto_compaction_complete',
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
  startTime: number;
  endTime?: number;
  parentId?: string; // For nested tool calls (e.g., subagents)
  visibleInChat?: boolean; // Whether this tool should appear in conversation
  isTransparent?: boolean; // For wrapper tools that should not be displayed
  collapsed?: boolean; // For tools that should hide their children immediately
  shouldCollapse?: boolean; // For tools that should collapse after completion
  hideOutput?: boolean; // For tools that should never show output
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
  endpoint: string;
  context_size: number;
  temperature: number;
  max_tokens: number;

  // Execution Settings
  bash_timeout: number;
  auto_confirm: boolean;
  check_context_msg: boolean;
  parallel_tools: boolean;
  tool_call_activity_timeout: number; // Timeout in seconds for agents without tool call activity

  // UI Preferences
  theme: string;
  compact_threshold: number;
  show_token_usage: boolean;
  show_context_in_prompt: boolean;

  // Tool Result Settings
  tool_result_preview_lines: number;
  tool_result_preview_enabled: boolean;

  // Tool Call Retry Settings
  tool_call_retry_enabled: boolean;
  tool_call_max_retries: number;
  tool_call_repair_attempts: boolean;
  tool_call_verbose_errors: boolean;

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
  tool_result_max_tokens_normal: number;
  tool_result_max_tokens_moderate: number;
  tool_result_max_tokens_aggressive: number;
  tool_result_max_tokens_critical: number;

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

// ===========================
// Session Types
// ===========================

export interface SessionMetadata {
  title?: string;
  tags?: string[];
  model?: string;
}

export interface Session {
  id: string;
  name: string;
  title?: string;
  created_at: string;
  updated_at: string;
  messages: Message[];
  todos?: Array<{
    id: string;
    task: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm: string;
    created_at: string;
  }>;
  metadata?: SessionMetadata;
}

export interface SessionInfo {
  session_id: string;
  display_name: string;
  last_modified: string;
  message_count: number;
}
