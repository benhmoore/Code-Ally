/**
 * BaseTool - Abstract base class for all tools
 *
 * Provides common functionality for tool execution, error handling,
 * and event emission. All concrete tools must extend this class.
 */

import { ToolResult, ActivityEvent, ActivityEventType } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { generateId } from '../utils/id.js';

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
   * Whether to suppress the standard execution animation
   * Set to true if tool manages its own display (e.g., AgentTool)
   */
  readonly suppressExecutionAnimation: boolean = false;

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
   * Execute the tool with the given arguments
   *
   * This method wraps the actual implementation with event emission
   * and error handling. Subclasses should implement executeImpl instead.
   *
   * @param args - Tool-specific parameters
   * @returns Tool result dictionary
   */
  async execute(args: any): Promise<ToolResult> {
    const callId = generateId();

    this.emitEvent({
      id: callId,
      type: ActivityEventType.TOOL_CALL_START,
      timestamp: Date.now(),
      data: {
        toolName: this.name,
        arguments: args,
      },
    });

    try {
      const result = await this.executeImpl(args);

      this.emitEvent({
        id: callId,
        type: ActivityEventType.TOOL_CALL_END,
        timestamp: Date.now(),
        data: {
          toolName: this.name,
          result,
          success: result.success,
        },
      });

      return result;
    } catch (error) {
      const errorResult = this.formatErrorResponse(
        error instanceof Error ? error.message : String(error),
        'system_error'
      );

      this.emitEvent({
        id: callId,
        type: ActivityEventType.ERROR,
        timestamp: Date.now(),
        data: {
          toolName: this.name,
          error: errorResult.error,
        },
      });

      return errorResult;
    }
  }

  /**
   * Abstract implementation method - subclasses must implement this
   */
  protected abstract executeImpl(args: any): Promise<ToolResult>;

  /**
   * Emit an event to the activity stream
   */
  protected emitEvent(event: ActivityEvent): void {
    this.activityStream.emit(event);
  }

  /**
   * Emit a chunk of output (for streaming tools like bash)
   */
  protected emitOutputChunk(callId: string, chunk: string): void {
    this.emitEvent({
      id: generateId(),
      type: ActivityEventType.TOOL_OUTPUT_CHUNK,
      timestamp: Date.now(),
      parentId: callId,
      data: {
        toolName: this.name,
        chunk,
      },
    });
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
    errorType: string = 'general',
    suggestion?: string,
    additionalFields?: Record<string, any>
  ): ToolResult {
    // Build parameter context for error message
    let paramContext = '';
    if (Object.keys(this.currentParams).length > 0) {
      const paramPairs = Object.entries(this.currentParams)
        .map(([key, value]) => {
          const valueStr =
            typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
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
          ? value.length > 50
            ? value.substring(0, 47) + '...'
            : value
          : JSON.stringify(value);
      return `${key}: ${valueStr}`;
    });
  }
}
