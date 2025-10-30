/**
 * ToolManager - Registry and execution manager for all tools
 *
 * Handles tool registration, function definition generation, validation,
 * and execution orchestration with permission checks.
 */

import { BaseTool } from './BaseTool.js';
import { ToolValidator } from './ToolValidator.js';
import { FunctionDefinition, ToolResult } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { formatError } from '../utils/errorUtils.js';
import { DuplicateDetector } from '../services/DuplicateDetector.js';

export class ToolManager {
  private tools: Map<string, BaseTool>;
  private validator: ToolValidator;
  private duplicateDetector: DuplicateDetector;
  private readFiles: Map<string, number> = new Map();

  constructor(tools: BaseTool[], _activityStream: ActivityStream) {
    this.tools = new Map();
    this.validator = new ToolValidator();
    this.duplicateDetector = new DuplicateDetector();

    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * Get a tool by name
   */
  getTool(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tools
   */
  getAllTools(): BaseTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Register additional tools at runtime
   *
   * @param tools - Array of tools to register
   */
  registerTools(tools: BaseTool[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * Generate function definitions for all tools
   *
   * @param excludeTools - Optional list of tool names to exclude
   * @returns List of function definitions for LLM function calling
   */
  getFunctionDefinitions(excludeTools?: string[]): FunctionDefinition[] {
    const functionDefs: FunctionDefinition[] = [];
    const excludeSet = new Set(excludeTools || []);

    for (const tool of this.tools.values()) {
      // Skip excluded tools
      if (excludeSet.has(tool.name)) {
        continue;
      }

      const functionDef = this.generateFunctionDefinition(tool);
      functionDefs.push(functionDef);
    }

    return functionDefs;
  }

  /**
   * Generate function definition for a single tool
   */
  private generateFunctionDefinition(tool: BaseTool): FunctionDefinition {
    let functionDef: FunctionDefinition;

    // Check if tool provides custom definition
    if ('getFunctionDefinition' in tool && typeof (tool as any).getFunctionDefinition === 'function') {
      functionDef = (tool as any).getFunctionDefinition();
    } else {
      // Generate default definition by introspecting the tool
      functionDef = {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
      };
    }

    // Add todo_id parameter to all tools (unless it's TodoWriteTool itself)
    if (tool.name !== 'todo_write') {
      if (!functionDef.function.parameters.properties) {
        functionDef.function.parameters.properties = {};
      }

      functionDef.function.parameters.properties.todo_id = {
        type: 'string',
        description: 'Optional: ID of todo to mark as complete upon successful execution',
      };
    }

    return functionDef;
  }

  /**
   * Get all tool usage guidance strings for injection into system prompt
   *
   * @returns Array of guidance strings from tools that provide them
   */
  getToolUsageGuidance(): string[] {
    const guidances: string[] = [];

    for (const tool of this.tools.values()) {
      if (tool.usageGuidance) {
        guidances.push(tool.usageGuidance);
      }
    }

    return guidances;
  }

  /**
   * Execute a tool with the given arguments
   *
   * @param toolName - Name of the tool to execute
   * @param args - Tool arguments
   * @param callId - Tool call ID from orchestrator (for streaming output)
   * @param _preApproved - Whether permission has been pre-approved
   * @param abortSignal - Optional AbortSignal for interrupting tool execution
   * @returns Tool result
   */
  async executeTool(
    toolName: string,
    args: Record<string, any>,
    callId?: string,
    _preApproved: boolean = false,
    abortSignal?: AbortSignal
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        success: false,
        error: `Unknown tool: ${toolName}`,
        error_type: 'validation_error',
        suggestion: `Available tools: ${Array.from(this.tools.keys()).join(', ')}`,
      };
    }

    const argsWithoutTodoId = { ...args };
    delete argsWithoutTodoId.todo_id;

    const duplicateCheck = this.duplicateDetector.check(toolName, argsWithoutTodoId);
    if (duplicateCheck.shouldBlock) {
      return {
        success: false,
        error: duplicateCheck.message!,
        error_type: 'validation_error',
        suggestion: 'Avoid calling the same tool with identical arguments multiple times',
      };
    }

    const functionDef = this.generateFunctionDefinition(tool);
    const validation = this.validator.validateArguments(tool, functionDef, args);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error!,
        error_type: validation.error_type,
        suggestion: validation.suggestion,
      };
    }

    try {
      const result = await tool.execute(args, callId, abortSignal);

      this.trackFileOperation(toolName, args, result);

      if (result.success) {
        this.duplicateDetector.recordCall(toolName, argsWithoutTodoId);

        if (duplicateCheck.isDuplicate && duplicateCheck.message) {
          result.warning = duplicateCheck.message;
        }
      }

      return result;
    } catch (error) {
      // Propagate abort errors without wrapping
      if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('interrupted'))) {
        throw error;
      }
      return {
        success: false,
        error: formatError(error),
        error_type: 'system_error',
      };
    }
  }

  /**
   * Clear current turn state
   */
  clearCurrentTurn(): void {
    this.duplicateDetector.nextTurn();
  }

  /**
   * Track file operations for read-before-write validation
   */
  private trackFileOperation(
    toolName: string,
    args: Record<string, any>,
    result: ToolResult
  ): void {
    if (!result.success) {
      return;
    }

    if (toolName === 'read' && args.file_paths) {
      const filePaths = Array.isArray(args.file_paths)
        ? args.file_paths
        : [args.file_paths];

      const timestamp = Date.now();
      for (const filePath of filePaths) {
        this.readFiles.set(filePath, timestamp);
      }
    }

    if (['write', 'edit', 'line_edit'].includes(toolName) && args.file_path) {
      this.readFiles.set(args.file_path, Date.now());
    }
  }

  /**
   * Check if a file has been read
   */
  hasFileBeenRead(filePath: string): boolean {
    return this.readFiles.has(filePath);
  }

  /**
   * Get the timestamp when a file was last read
   */
  getFileReadTimestamp(filePath: string): number | undefined {
    return this.readFiles.get(filePath);
  }

  /**
   * Clear all tracked state
   */
  clearState(): void {
    this.readFiles.clear();
    this.duplicateDetector.clear();
  }
}
