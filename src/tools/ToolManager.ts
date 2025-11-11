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
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { logger } from '../services/Logger.js';

/**
 * Tool with custom function definition
 */
interface ToolWithCustomDefinition extends BaseTool {
  getFunctionDefinition(): FunctionDefinition;
}

/**
 * Type guard to check if a tool has a custom getFunctionDefinition method
 */
function hasCustomFunctionDefinition(tool: BaseTool): tool is ToolWithCustomDefinition {
  return (
    typeof tool === 'object' &&
    tool !== null &&
    'getFunctionDefinition' in tool &&
    typeof (tool as any).getFunctionDefinition === 'function'
  );
}

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
   * Find the currently active tool that supports message injection
   *
   * Checks explore, plan, and agent tools for an active pooled agent.
   * Returns the tool instance, name, and call ID if found.
   *
   * @returns {tool: BaseTool, name: string, callId: string} if found, undefined otherwise
   */
  getActiveInjectableTool(): { tool: BaseTool; name: string; callId: string } | undefined {
    const injectableToolNames = ['explore', 'plan', 'agent', 'agent_ask'];

    for (const toolName of injectableToolNames) {
      const tool = this.tools.get(toolName);
      if (tool && typeof (tool as any).injectUserMessage === 'function') {
        // Check if this tool has an active pooled agent and current call ID
        if ((tool as any).currentPooledAgent && (tool as any).currentCallId) {
          return {
            tool,
            name: toolName,
            callId: (tool as any).currentCallId
          };
        }
      }
    }

    return undefined;
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
   * Register a single contextual tool at runtime
   *
   * Contextual tools are dynamically added based on the current context
   * (e.g., plugin-provided tools). This method checks for duplicates
   * to prevent overwriting existing tools.
   *
   * @param tool - Tool to register
   */
  registerTool(tool: BaseTool): void {
    if (this.tools.has(tool.name)) {
      logger.debug(`[TOOL_MANAGER] Tool '${tool.name}' already registered, skipping duplicate`);
      return;
    }
    this.tools.set(tool.name, tool);
    logger.debug(`[TOOL_MANAGER] Registered contextual tool: ${tool.name}`);
  }

  /**
   * Unregister a contextual tool by name
   *
   * Removes a dynamically added tool from the registry. Only removes
   * if the tool exists; silently handles non-existent tools.
   *
   * @param toolName - Name of the tool to unregister
   */
  unregisterTool(toolName: string): void {
    if (!this.tools.has(toolName)) {
      logger.debug(`[TOOL_MANAGER] Tool '${toolName}' not found, skipping unregister`);
      return;
    }
    this.tools.delete(toolName);
    logger.debug(`[TOOL_MANAGER] Unregistered contextual tool: ${toolName}`);
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

    // Get active plugins from PluginActivationManager
    let activePlugins: Set<string> | null = null;
    try {
      const registry = ServiceRegistry.getInstance();
      const activationManager = registry.getPluginActivationManager();
      activePlugins = new Set(activationManager.getActivePlugins());
    } catch (error) {
      // If PluginActivationManager is not registered, include all tools
      // This ensures backward compatibility
      activePlugins = null;
    }

    for (const tool of this.tools.values()) {
      // Skip excluded tools
      if (excludeSet.has(tool.name)) {
        continue;
      }

      // Filter by plugin activation state
      if (activePlugins !== null && tool.pluginName) {
        // Plugin tool: only include if plugin is active
        if (!activePlugins.has(tool.pluginName)) {
          continue;
        }
      }
      // Core tools (no pluginName) are always included

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
    if (hasCustomFunctionDefinition(tool)) {
      functionDef = tool.getFunctionDefinition();
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
        // If tool has a plugin name, prepend it to the first line
        if (tool.pluginName) {
          // Split guidance into lines to modify the first line
          const lines = tool.usageGuidance.split('\n');
          if (lines.length > 0 && lines[0]) {
            // Check if first line starts with "**When to use" pattern
            const firstLine = lines[0];
            const whenMatch = firstLine.match(/^(\*\*When to use [^:]+:\*\*)/);
            if (whenMatch) {
              // Insert plugin attribution after the bold header
              lines[0] = `${whenMatch[1]} (from plugin: ${tool.pluginName})`;
            } else {
              // Fallback: just prepend plugin info at the start
              lines[0] = `(from plugin: ${tool.pluginName}) ${firstLine}`;
            }
            guidances.push(lines.join('\n'));
          } else {
            guidances.push(tool.usageGuidance);
          }
        } else {
          // Built-in tool - use guidance as-is
          guidances.push(tool.usageGuidance);
        }
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
   * @param isUserInitiated - Internal flag for user-initiated execution (not visible to model)
   * @param isContextFile - Internal flag for context file read (not visible to model)
   * @returns Tool result
   */
  async executeTool(
    toolName: string,
    args: Record<string, any>,
    callId?: string,
    _preApproved: boolean = false,
    abortSignal?: AbortSignal,
    isUserInitiated: boolean = false,
    isContextFile: boolean = false
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

    const duplicateCheck = this.duplicateDetector.check(toolName, args);
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
      const result = await tool.execute(args, callId, abortSignal, isUserInitiated, isContextFile);

      this.trackFileOperation(toolName, args, result);

      if (result.success) {
        this.duplicateDetector.recordCall(toolName, args);

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
