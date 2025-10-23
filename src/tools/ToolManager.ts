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

export class ToolManager {
  private tools: Map<string, BaseTool>;
  private validator: ToolValidator;

  // Track recent tool calls to avoid redundancy
  private recentToolCalls: Array<[string, string]> = [];
  private currentTurnToolCalls: Array<[string, string]> = [];
  private maxRecentCalls: number = 5;

  // Track files that have been read in this session
  private readFiles: Map<string, number> = new Map(); // file_path -> timestamp

  constructor(tools: BaseTool[], _activityStream: ActivityStream) {
    this.tools = new Map();
    this.validator = new ToolValidator();

    // Register all tools
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
   * Execute a tool with the given arguments
   *
   * Pipeline:
   * 1. Validate tool existence
   * 2. Check for redundant calls
   * 3. Validate arguments
   * 4. Execute tool
   * 5. Track operations
   *
   * @param toolName - Name of the tool to execute
   * @param args - Tool arguments
   * @param callId - Tool call ID from orchestrator (for streaming output)
   * @param _preApproved - Whether permission has been pre-approved
   * @returns Tool result
   */
  async executeTool(
    toolName: string,
    args: Record<string, any>,
    callId?: string,
    _preApproved: boolean = false
  ): Promise<ToolResult> {
    // 1. Validate tool existence
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        success: false,
        error: `Unknown tool: ${toolName}`,
        error_type: 'validation_error',
        suggestion: `Available tools: ${Array.from(this.tools.keys()).join(', ')}`,
      };
    }

    // 2. Check for redundant calls
    if (this.isRedundantCall(toolName, args)) {
      return {
        success: false,
        error: `Redundant tool call detected: ${toolName} was already called with the same arguments in this turn`,
        error_type: 'validation_error',
        suggestion: 'Avoid calling the same tool with identical arguments multiple times',
      };
    }

    // 3. Validate arguments
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

    // 4. Track this call
    this.trackToolCall(toolName, args);

    // 5. Execute tool (pass callId for streaming output)
    try {
      const result = await tool.execute(args, callId);

      // 6. Track file operations
      this.trackFileOperation(toolName, args, result);

      return result;
    } catch (error) {
      return {
        success: false,
        error: formatError(error),
        error_type: 'system_error',
      };
    }
  }

  /**
   * Check if a tool call is redundant
   *
   * Only considers calls made in the current conversation turn as redundant.
   */
  private isRedundantCall(toolName: string, args: Record<string, any>): boolean {
    const callSignature = this.createCallSignature(toolName, args);

    return this.currentTurnToolCalls.some(
      ([existingToolName, existingSignature]) =>
        existingToolName === toolName && existingSignature === callSignature
    );
  }

  /**
   * Track a tool call
   */
  private trackToolCall(toolName: string, args: Record<string, any>): void {
    const callSignature = this.createCallSignature(toolName, args);

    // Add to current turn
    this.currentTurnToolCalls.push([toolName, callSignature]);

    // Add to recent calls
    this.recentToolCalls.push([toolName, callSignature]);
    if (this.recentToolCalls.length > this.maxRecentCalls) {
      this.recentToolCalls.shift();
    }
  }

  /**
   * Create a signature for a tool call
   */
  private createCallSignature(_toolName: string, args: Record<string, any>): string {
    // Sort keys for consistent signature
    const sortedArgs = Object.keys(args)
      .sort()
      .map((key) => `${key}=${JSON.stringify(args[key])}`)
      .join(',');
    return sortedArgs;
  }

  /**
   * Clear current turn tool calls (call this at the start of each turn)
   */
  clearCurrentTurn(): void {
    this.currentTurnToolCalls = [];
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

    // Track read operations
    if (toolName === 'read' && args.file_paths) {
      const filePaths = Array.isArray(args.file_paths)
        ? args.file_paths
        : [args.file_paths];

      const timestamp = Date.now();
      for (const filePath of filePaths) {
        this.readFiles.set(filePath, timestamp);
      }
    }

    // Track write/edit operations (model now has current version)
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
   * Clear all tracked state (useful for new conversations)
   */
  clearState(): void {
    this.recentToolCalls = [];
    this.currentTurnToolCalls = [];
    this.readFiles.clear();
  }
}
