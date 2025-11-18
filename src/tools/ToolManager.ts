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
import { validateToolName } from '../utils/namingValidation.js';
import { DelegationContextManager } from '../services/DelegationContextManager.js';
import { isInjectableTool } from './InjectableTool.js';
import { AGENT_DELEGATION_TOOLS } from '../config/constants.js';
import { ConversationManager } from '../agent/ConversationManager.js';

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
  private functionDefinitionsCache: Map<string, FunctionDefinition[]> = new Map();
  private delegationContextManager: DelegationContextManager;
  private conversationManager?: ConversationManager;

  constructor(tools: BaseTool[], _activityStream: ActivityStream) {
    this.tools = new Map();
    this.validator = new ToolValidator();
    this.duplicateDetector = new DuplicateDetector();
    this.delegationContextManager = new DelegationContextManager();

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
   * Finds the deepest 'executing' delegation for interjection routing.
   * Only routes to actively executing agents, NOT completing/dying agents.
   *
   * NOTE: agent-ask is intentionally excluded - interjections should route
   * to the main agent, not the queried subagent, since agent-ask is just
   * querying for information while the main conversation continues.
   *
   * @returns {tool: BaseTool, name: string, callId: string} if found, undefined otherwise
   */
  getActiveInjectableTool(): { tool: BaseTool; name: string; callId: string } | undefined {
    const activeDelegation = this.delegationContextManager.getActiveDelegation();

    if (!activeDelegation) {
      return undefined;
    }

    const tool = this.tools.get(activeDelegation.toolName);
    if (!tool) {
      logger.warn(`[TOOL_MANAGER] Active delegation references unknown tool: ${activeDelegation.toolName}`);
      return undefined;
    }

    // Validate that the tool implements InjectableTool interface
    // This ensures type safety - only tools with injectUserMessage() can be returned
    if (!isInjectableTool(tool)) {
      logger.warn(`[TOOL_MANAGER] Active delegation tool '${activeDelegation.toolName}' does not implement InjectableTool interface`);
      return undefined;
    }

    return {
      tool,
      name: activeDelegation.toolName,
      callId: activeDelegation.callId
    };
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
   * @throws Error if tool name is invalid
   */
  registerTool(tool: BaseTool): void {
    // Validate tool name format (kebab-case)
    const validation = validateToolName(tool.name);
    if (!validation.valid) {
      throw new Error(`Failed to register tool: ${validation.error}`);
    }

    if (this.tools.has(tool.name)) {
      logger.debug(`[TOOL_MANAGER] Tool '${tool.name}' already registered, skipping duplicate`);
      return;
    }
    this.tools.set(tool.name, tool);
    // Invalidate cache when tool is registered
    this.functionDefinitionsCache.clear();
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
    // Invalidate cache when tool is unregistered
    this.functionDefinitionsCache.clear();
    logger.debug(`[TOOL_MANAGER] Unregistered contextual tool: ${toolName}`);
  }

  /**
   * Generate function definitions for all tools
   *
   * @param excludeTools - Optional list of tool names to exclude
   * @param currentAgentName - Optional current agent name for visible_to filtering
   * @returns List of function definitions for LLM function calling
   */
  getFunctionDefinitions(excludeTools?: string[], currentAgentName?: string): FunctionDefinition[] {
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

    // Generate cache key based on plugin activation state and agent name
    // This ensures cached results match the current activation state and agent context
    const cacheKey = this.generateCacheKey(activePlugins, excludeTools, currentAgentName);

    // Check cache with activation-aware key
    if (this.functionDefinitionsCache.has(cacheKey)) {
      return this.functionDefinitionsCache.get(cacheKey)!;
    }

    const functionDefs: FunctionDefinition[] = [];
    const excludeSet = new Set(excludeTools || []);
    const visibleTools: string[] = [];
    const filteredByAgent: string[] = [];

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

      // Filter tools by visible_to array (if specified)
      // Empty or missing array = visible to all agents
      if (tool.visibleTo && tool.visibleTo.length > 0) {
        // Non-empty array = only visible to specified agents
        if (!currentAgentName || !tool.visibleTo.includes(currentAgentName)) {
          filteredByAgent.push(tool.name);
          continue;
        }
      }

      const functionDef = this.generateFunctionDefinition(tool);
      functionDefs.push(functionDef);
      visibleTools.push(tool.name);
    }

    // Log consolidated tool visibility summary (only if agent filtering occurred)
    if (filteredByAgent.length > 0) {
      logger.debug(
        `[ToolManager] Agent '${currentAgentName || 'none'}' - Visible tools: [${visibleTools.join(', ')}] (${filteredByAgent.length} agent-specific tools filtered)`
      );
    }

    // Cache the result with the activation-aware key
    this.functionDefinitionsCache.set(cacheKey, functionDefs);

    return functionDefs;
  }

  /**
   * Generate a cache key based on active plugins, excluded tools, and agent name
   *
   * The cache key includes the sorted list of active plugins to ensure that
   * cached function definitions match the current plugin activation state.
   * This prevents returning cached definitions that include deactivated plugins.
   * Also includes agent name to ensure tools are filtered based on visible_to.
   *
   * @param activePlugins - Set of active plugin names (null if no plugin system)
   * @param excludeTools - Optional list of tool names to exclude
   * @param currentAgentName - Optional current agent name for visible_to filtering
   * @returns Cache key string
   */
  private generateCacheKey(activePlugins: Set<string> | null, excludeTools?: string[], currentAgentName?: string): string {
    const parts: string[] = [];

    // Include active plugins in key (sorted for consistency)
    if (activePlugins === null) {
      parts.push('no-plugin-manager');
    } else if (activePlugins.size === 0) {
      parts.push('no-active-plugins');
    } else {
      parts.push(`plugins:${Array.from(activePlugins).sort().join(',')}`);
    }

    // Include exclusions in key if present
    if (excludeTools && excludeTools.length > 0) {
      parts.push(`exclude:${excludeTools.sort().join(',')}`);
    }

    // Include agent name in key if present
    if (currentAgentName) {
      parts.push(`agent:${currentAgentName}`);
    }

    return parts.join('|');
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

    // Dynamically inject description parameter for UI subtext
    // Only inject if tool doesn't already define it
    if (functionDef.function.parameters?.properties && !functionDef.function.parameters.properties.description) {
      functionDef.function.parameters.properties.description = {
        type: 'string',
        description: 'Brief description of what this operation does (5-10 words, shown in UI)',
      };

      // Add to required array if it exists
      // Exception: agent delegation tools have description as optional
      const isAgentDelegationTool = AGENT_DELEGATION_TOOLS.includes(tool.name as any);

      if (!isAgentDelegationTool && functionDef.function.parameters.required && Array.isArray(functionDef.function.parameters.required)) {
        functionDef.function.parameters.required.push('description');
      }
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
   * @param currentAgentName - Current agent name for tool-agent binding validation
   * @returns Tool result
   */
  async executeTool(
    toolName: string,
    args: Record<string, any>,
    callId?: string,
    _preApproved: boolean = false,
    abortSignal?: AbortSignal,
    isUserInitiated: boolean = false,
    isContextFile: boolean = false,
    currentAgentName?: string
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

    // Check visible_to constraint (if specified and non-empty)
    if (tool.visibleTo && tool.visibleTo.length > 0) {
      if (!currentAgentName || !tool.visibleTo.includes(currentAgentName)) {
        return {
          success: false,
          error: `Tool '${toolName}' is only visible to agents: [${tool.visibleTo.join(', ')}]. Current agent is '${currentAgentName || 'unknown'}'`,
          error_type: 'agent_mismatch',
        };
      }
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
   * Check if a file has been successfully read in the conversation.
   *
   * Delegates to ConversationManager to check if the file has been read
   * with a successful outcome in the current conversation state.
   *
   * @param filePath - Absolute path to the file to check
   * @returns true if file has been successfully read, false if not or if conversationManager not set
   */
  hasFileBeenRead(filePath: string): boolean {
    return this.conversationManager?.hasSuccessfulReadFor(filePath) ?? false;
  }

  /**
   * Clear all tracked state
   */
  clearState(): void {
    this.duplicateDetector.clear();
  }

  /**
   * Get delegation context manager for delegation state tracking
   */
  getDelegationContextManager(): DelegationContextManager {
    return this.delegationContextManager;
  }

  /**
   * Set the conversation manager
   * Called by Agent during initialization to provide access to conversation state
   */
  setConversationManager(manager: ConversationManager): void {
    this.conversationManager = manager;
  }
}
