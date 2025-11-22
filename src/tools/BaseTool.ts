/**
 * BaseTool - Abstract base class for all tools
 *
 * Provides common functionality for tool execution, error handling,
 * and event emission. All concrete tools must extend this class.
 */

import { ToolResult, ActivityEvent, ActivityEventType, ErrorType } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { formatError } from '../utils/errorUtils.js';
import { TOOL_OUTPUT_ESTIMATES } from '../config/toolDefaults.js';
import { TEXT_LIMITS } from '../config/constants.js';
import { logger } from '../services/Logger.js';

export abstract class BaseTool {
  /**
   * Unique tool identifier (must be set by subclass)
   */
  abstract readonly name: string;

  /**
   * LLM-facing description of what the tool does
   */
  abstract readonly description: string;

  /**
   * Whether this tool requires user confirmation before execution
   */
  abstract readonly requiresConfirmation: boolean;

  /**
   * Optional custom display name for UI presentation
   * If not set, the tool name will be auto-formatted (e.g., 'ls' -> 'Ls', 'read-file' -> 'Read File')
   */
  readonly displayName?: string;

  /**
   * Whether to suppress the standard execution animation
   * Set to true if tool manages its own display (e.g., AgentTool)
   */
  readonly suppressExecutionAnimation: boolean = false;

  /**
   * Whether this tool should appear in the conversation UI
   * Set to false for tools that should be hidden from chat
   * (e.g., batch, todo)
   */
  readonly visibleInChat: boolean = true;

  /**
   * Whether this tool is a transparent wrapper
   * Set to true for tools that should not appear in the conversation
   * (only their children should appear)
   */
  readonly isTransparentWrapper: boolean = false;

  /**
   * Whether this tool's agent should persist in the pool (if applicable)
   * Set to true for agent-based tools that should keep agents alive for follow-up questions
   * Set to false for tools that should fully cleanup agents after execution
   * Default: false (full cleanup)
   */
  readonly persistAgent: boolean = false;

  /**
   * Whether this tool should collapse its children when complete
   * Set to true for tools that should hide their output/children after completion
   * (e.g., subagents that should show only their summary line)
   */
  readonly shouldCollapse: boolean = false;

  /**
   * Optional usage guidance to inject into the agent's system prompt
   * Use this to provide examples and instructions about when/how to use this tool
   * Example: "When answering questions about current information, always verify by searching first."
   */
  readonly usageGuidance?: string;

  /**
   * Optional plugin name for plugin-provided tools
   * Set by ExecutableToolWrapper to identify the source plugin
   */
  readonly pluginName?: string;

  /**
   * Whether this is an internal tool restricted to specific agents
   * Set to true for specialized tools that shouldn't be available to all agents
   * (e.g., write-temp is only for explore agents)
   */
  readonly internalTool: boolean = false;

  /**
   * Whether this tool is exploratory in nature (reads/searches files without modifying them)
   *
   * Exploratory tools are used for investigating codebases through reading and searching.
   * Examples: read, grep, glob, ls, tree
   *
   * When set to true, the agent will be reminded to consider using explore() instead
   * if many exploratory tool calls are made in a single turn, as explore() delegates
   * to a specialized agent with its own context budget.
   *
   * Default: false
   */
  readonly isExploratoryTool: boolean = false;

  /**
   * Whether this tool breaks the exploratory tool streak
   *
   * Most tools break the streak when called (they represent productive work).
   * However, meta/housekeeping tools like cleanup-call should NOT break the streak
   * since they're part of the prescribed workflow (cleanup → explore).
   *
   * Setting this to false means the tool neither increments nor resets the streak.
   *
   * Default: true (most tools break the streak)
   */
  readonly breaksExploratoryStreak: boolean = true;

  /**
   * Optional array of agent names this tool is visible to (empty or missing = visible to all)
   * Set by plugin wrappers from manifest tool definition
   */
  readonly visibleTo?: string[];

  /**
   * Activity stream for emitting events
   */
  protected activityStream: ActivityStream;

  /**
   * Current parameters (for error context)
   */
  protected currentParams: Record<string, any> = {};

  constructor(activityStream: ActivityStream) {
    this.activityStream = activityStream;
  }

  /**
   * Current tool call ID (set by ToolOrchestrator for streaming output)
   */
  protected currentCallId?: string;

  /**
   * Current abort signal (set during execute for access in executeImpl)
   */
  protected currentAbortSignal?: AbortSignal;

  /**
   * Preview changes before execution (e.g., show diff for file edits)
   *
   * Called by ToolOrchestrator BEFORE permission checks, allowing users
   * to see what will change before authorizing the operation.
   *
   * Override this in tools that modify files to emit diff previews.
   *
   * @param args - Tool-specific parameters
   * @param callId - Tool call ID for event emission
   */
  async previewChanges(_args: any, callId?: string): Promise<void> {
    this.currentCallId = callId;
    // Default: no preview
    // Override in subclasses that need to show previews
  }

  /**
   * Execute the tool with the given arguments
   *
   * Event emission for START/END/ERROR is handled by ToolOrchestrator.
   * Tools can emit OUTPUT_CHUNK events for real-time streaming using currentCallId.
   *
   * @param args - Tool-specific parameters
   * @param callId - Tool call ID from ToolOrchestrator (for streaming output)
   * @param abortSignal - Optional AbortSignal for interrupting tool execution
   * @param isUserInitiated - Internal flag indicating user-initiated execution (not visible to model)
   * @param isContextFile - Internal flag indicating context file read (not visible to model)
   * @returns Tool result dictionary
   */
  async execute(args: any, callId?: string, abortSignal?: AbortSignal, isUserInitiated: boolean = false, isContextFile: boolean = false): Promise<ToolResult> {
    this.currentCallId = callId;
    this.currentAbortSignal = abortSignal;

    try {
      // Check if already aborted before starting
      if (abortSignal?.aborted) {
        throw new Error('AbortError: Tool execution was interrupted');
      }

      const result = await this.executeImpl(args, callId, isUserInitiated, isContextFile);

      return result;
    } catch (error) {
      // Detect abort errors
      if (error instanceof Error &&
          (error.message?.includes('AbortError') || abortSignal?.aborted)) {
        return this.formatErrorResponse(
          'Tool execution interrupted by user',
          'interrupted'
        );
      }

      const errorResult = this.formatErrorResponse(
        formatError(error),
        'system_error'
      );
      return errorResult;
    } finally {
      this.currentCallId = undefined;
      this.currentAbortSignal = undefined;
    }
  }

  /**
   * Optional validation before permission request
   *
   * Called BEFORE permission is requested for tools that require confirmation.
   * This allows tools to fail fast on invalid states (e.g., stale content, no changes)
   * without prompting the user for permission first.
   *
   * @param _args - Tool-specific parameters
   * @returns ToolResult with success=false if validation fails, or null if validation passes
   */
  async validateBeforePermission(_args: any): Promise<ToolResult | null> {
    // Default: no pre-permission validation
    return null;
  }

  /**
   * Abstract implementation method - subclasses must implement this
   * @param args - Tool-specific parameters
   * @param toolCallId - Tool call ID (optional)
   * @param isUserInitiated - Internal flag for user-initiated execution (optional, defaults to false)
   * @param isContextFile - Internal flag for context file read (optional, defaults to false)
   */
  protected abstract executeImpl(args: any, toolCallId?: string, isUserInitiated?: boolean, isContextFile?: boolean): Promise<ToolResult>;

  /**
   * Emit an event to the activity stream
   */
  protected emitEvent(event: ActivityEvent): void {
    this.activityStream.emit(event);
  }

  /**
   * Emit a chunk of output (for streaming tools like bash)
   * Uses currentCallId set by ToolOrchestrator
   */
  protected emitOutputChunk(chunk: string): void {
    if (!this.currentCallId) {
      logger.warn(`[${this.name}] Cannot emit output chunk: no currentCallId set`);
      return;
    }

    this.emitEvent({
      id: this.currentCallId,
      type: ActivityEventType.TOOL_OUTPUT_CHUNK,
      timestamp: Date.now(),
      data: {
        toolName: this.name,
        chunk,
      },
    });
  }

  /**
   * Emit a diff preview for file changes
   * Shows user what will change before applying modifications
   */
  protected emitDiffPreview(oldContent: string, newContent: string, filePath: string, operationType: 'edit' | 'write' | 'line-edit' = 'edit'): void {
    if (!this.currentCallId) {
      logger.warn(`[${this.name}] Cannot emit diff preview: no currentCallId set`);
      return;
    }

    this.emitEvent({
      id: this.currentCallId,
      type: ActivityEventType.DIFF_PREVIEW,
      timestamp: Date.now(),
      data: {
        toolName: this.name,
        oldContent,
        newContent,
        filePath,
        operationType,
      },
    });
  }

  /**
   * Helper for safely generating and emitting a diff preview
   * Catches errors silently to avoid disrupting the preview flow
   *
   * @param filePath - Path to the file being modified
   * @param generatePreview - Async function that reads file and generates preview content
   * @param operationType - Type of operation being performed
   */
  protected async safelyEmitDiffPreview(
    filePath: string,
    generatePreview: () => Promise<{ oldContent: string; newContent: string }>,
    operationType: 'edit' | 'write' | 'line-edit' = 'edit'
  ): Promise<void> {
    try {
      const { oldContent, newContent } = await generatePreview();
      this.emitDiffPreview(oldContent, newContent, filePath, operationType);
    } catch {
      // Silently fail preview - let actual execute handle errors
    }
  }

  /**
   * Capture parameters for error context
   *
   * Should be called at the beginning of executeImpl to capture
   * the parameters for enhanced error reporting.
   *
   * @param params - Parameters to capture
   */
  protected captureParams(params: Record<string, any>): void {
    // Filter out None/undefined values and empty objects/arrays
    const filtered: Record<string, any> = {};
    for (const [key, value] of Object.entries(params)) {
      if (
        value !== undefined &&
        value !== null &&
        !(Array.isArray(value) && value.length === 0) &&
        !(typeof value === 'object' && Object.keys(value).length === 0)
      ) {
        filtered[key] = value;
      }
    }
    this.currentParams = filtered;
  }

  /**
   * Format a standard error response with tool name and parameter context
   *
   * @param errorMessage - The error message
   * @param errorType - Type of error (user_error, system_error, permission_error, validation_error, security_error)
   * @param suggestion - Optional suggestion for resolving the error
   * @param additionalFields - Additional custom fields to include in the response
   * @returns Formatted error response
   */
  protected formatErrorResponse(
    errorMessage: string,
    errorType: ErrorType = 'general',
    suggestion?: string,
    additionalFields?: Record<string, any>
  ): ToolResult {
    // Build parameter context for error message (with truncation for clarity)
    let paramContext = '';
    if (Object.keys(this.currentParams).length > 0) {
      const paramPairs = Object.entries(this.currentParams)
        .map(([key, value]) => {
          let valueStr: string;

          // Truncate long strings
          if (typeof value === 'string') {
            valueStr = value.length > TEXT_LIMITS.TOOL_PARAM_VALUE_MAX
              ? `"${value.substring(0, TEXT_LIMITS.TOOL_PARAM_VALUE_MAX - TEXT_LIMITS.ELLIPSIS_LENGTH)}..."`
              : `"${value}"`;
          }
          // Summarize long arrays
          else if (Array.isArray(value)) {
            valueStr = value.length > TEXT_LIMITS.TOOL_PARAM_ARRAY_DISPLAY
              ? `[${value.length} items]`
              : JSON.stringify(value);
          }
          // Normal JSON for other types
          else {
            valueStr = JSON.stringify(value);
          }

          return `${key}=${valueStr}`;
        })
        .join(', ');
      paramContext = `${this.name}(${paramPairs}): `;
    } else {
      paramContext = `${this.name}(): `;
    }

    const result: ToolResult = {
      success: false,
      error: `${paramContext}${errorMessage}`,
      error_type: errorType,

      // Structured error details for clean error extraction
      error_details: {
        message: errorMessage,
        tool_name: this.name,
        parameters: Object.keys(this.currentParams).length > 0
          ? { ...this.currentParams }
          : undefined,
        suggestion: suggestion,
      },

      ...additionalFields,
    };

    if (suggestion) {
      result.suggestion = suggestion;
    }

    return result;
  }

  /**
   * Format a standard success response
   *
   * @param fields - Fields to include in the response
   * @returns Formatted success response
   */
  protected formatSuccessResponse(fields: Record<string, any>): ToolResult {
    return {
      success: true,
      error: '',
      ...fields,
    };
  }

  /**
   * Format an internal response (available to LLM but not displayed to user)
   *
   * Used by tools that handle their own user display (like agent tool).
   *
   * @param fields - Fields to include in the response
   * @returns Formatted internal response
   */
  protected formatInternalResponse(fields: Record<string, any>): ToolResult {
    return {
      success: true,
      error: '',
      _internal_only: true,
      ...fields,
    };
  }

  /**
   * Get truncation guidance for this tool
   *
   * Provides tool-specific instructions to the LLM on how to narrow down
   * output when results are truncated due to length or context limits.
   *
   * Override this in subclasses to provide specific guidance.
   *
   * @returns Guidance string for handling truncated output
   */
  getTruncationGuidance(): string {
    return 'Consider narrowing the scope of your query or using filters';
  }

  /**
   * Get estimated typical output size in tokens
   *
   * Provides an estimate of how many tokens this tool typically produces.
   * Used for context planning and capacity estimation.
   *
   * Override this in subclasses to provide accurate estimates.
   *
   * @returns Estimated output size in tokens
   */
  getEstimatedOutputSize(): number {
    return TOOL_OUTPUT_ESTIMATES.DEFAULT;
  }

  /**
   * Format subtext for display in the UI
   *
   * This method can be overridden by individual tools to provide
   * custom subtext formatting based on their arguments. The subtext
   * appears dimmed after the tool name in the UI.
   *
   * Default implementation: returns the description parameter if present.
   *
   * @param args - Tool arguments passed to execute()
   * @param _result - Optional tool result for post-execution data (e.g., actual line counts)
   * @returns Formatted subtext string or null if no subtext should be shown
   */
  formatSubtext(args: Record<string, any>, _result?: any): string | null {
    return args.description || null;
  }

  /**
   * Get list of parameter names that are shown in subtext
   *
   * These parameters will be filtered from the args preview in the UI
   * to avoid showing the same information twice (once in subtext, once in args).
   *
   * Default implementation: returns ['description'] since that's the default subtext parameter.
   *
   * Override this in tools that show additional parameters in their subtext
   * (e.g., BashTool shows 'command', ReadTool shows 'file_path').
   *
   * @returns Array of parameter names that are displayed in subtext
   */
  getSubtextParameters(): string[] {
    return ['description'];
  }

  /**
   * Get a preview of the tool result for display
   *
   * This method can be overridden by individual tools to provide
   * custom preview formatting for their specific result structure.
   *
   * @param result - The tool execution result
   * @param maxLines - Maximum number of lines to return
   * @returns List of preview lines to display (without indentation)
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    // Skip internal-only results
    if (result._internal_only) {
      return [];
    }

    // Handle error results
    if (!result.success) {
      const lines = [`Error: ${result.error}`];
      if (result.suggestion) {
        lines.push(`Suggestion: ${result.suggestion}`);
      }
      return lines;
    }

    // Try common content fields
    const contentFields = ['content', 'output', 'result', 'data'];
    for (const field of contentFields) {
      if (result[field]) {
        const content = String(result[field]);
        const lines = content.split('\n').slice(0, maxLines);
        if (content.split('\n').length > maxLines) {
          lines.push('...');
        }
        return lines;
      }
    }

    // Default: show first few fields
    const entries = Object.entries(result)
      .filter(([key]) => !['success', 'error'].includes(key))
      .slice(0, maxLines);

    if (entries.length === 0) {
      return ['Success'];
    }

    return entries.map(([key, value]) => {
      const valueStr =
        typeof value === 'string'
          ? value.length > TEXT_LIMITS.TOOL_PARAM_VALUE_MAX
            ? value.substring(0, TEXT_LIMITS.TOOL_PARAM_VALUE_MAX - TEXT_LIMITS.ELLIPSIS_LENGTH) + '...'
            : value
          : JSON.stringify(value);
      return `${key}: ${valueStr}`;
    });
  }

  /**
   * Capture a file operation as a patch for undo functionality
   *
   * Call this after successfully performing a file modification to enable undo.
   *
   * @param operationType - Type of operation (write, edit, line-edit, delete)
   * @param filePath - Path to the file being modified
   * @param originalContent - Original content before modification
   * @param newContent - New content after modification (undefined for delete)
   * @returns Patch number if successful, null otherwise
   */
  protected async captureOperationPatch(
    operationType: string,
    filePath: string,
    originalContent: string,
    newContent?: string
  ): Promise<number | null> {
    try {
      const registry = ServiceRegistry.getInstance();
      const patchManager = registry.get<any>('patch_manager');

      if (!patchManager) {
        // PatchManager not registered - this is fine, just means undo is disabled
        return null;
      }

      const patchNumber = await patchManager.captureOperation(
        operationType,
        filePath,
        originalContent,
        newContent
      );

      if (patchNumber !== null) {
        logger.debug(`[${this.name}] Captured ${operationType} operation as patch ${patchNumber}`);
      }

      return patchNumber;
    } catch (error) {
      // Silently handle errors - patch capture should never break the tool
      logger.error(`[${this.name}] Failed to capture patch:`, error);
      return null;
    }
  }
}
