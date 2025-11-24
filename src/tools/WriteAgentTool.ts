/**
 * WriteAgentTool - Specialized tool for creating agent definition files
 *
 * This tool is only visible to the 'create-agent' agent and handles
 * writing agent files to the correct profile directory automatically.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { ReadStateManager } from '../services/ReadStateManager.js';
import { ToolManager } from './ToolManager.js';
import { AgentManager } from '../services/AgentManager.js';
import { ConfigManager } from '../services/ConfigManager.js';
import { formatError } from '../utils/errorUtils.js';
import { getAgentsDir } from '../config/paths.js';
import { API_TIMEOUTS } from '../config/constants.js';
import { constructAgentContent, validateAgentName } from '../utils/agentContentUtils.js';
import * as fs from 'fs/promises';
import * as path from 'path';

export class WriteAgentTool extends BaseTool {
  readonly name = 'write-agent';
  readonly description = 'Create a new agent definition file with structured parameters (name, description, system_prompt, and optional configuration). File is automatically created in the correct profile agents directory.';
  readonly requiresConfirmation = false; // No permission needed (validated before creation)
  readonly hideOutput = true; // Hide output from result preview
  readonly visibleTo = ['create-agent']; // Only visible to create-agent agent

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Validate before permission request
   * Checks if agent file already exists
   */
  async validateBeforePermission(args: any): Promise<ToolResult | null> {
    const name = args.name as string;

    // Validate agent name format
    const nameValidation = validateAgentName(name);
    if (!nameValidation.valid) {
      return this.formatErrorResponse(
        nameValidation.error!,
        'validation_error',
        'Example: write-agent(name="my-agent", description="...", system_prompt="...")'
      );
    }

    // Construct filename
    const filename = `${name}.md`;
    const agentsDir = getAgentsDir();
    const absolutePath = path.join(agentsDir, filename);

    try {
      // Check if file exists
      await fs.access(absolutePath);
      // File exists - fail without requesting permission
      return this.formatErrorResponse(
        `Agent already exists: ${absolutePath}`,
        'file_error',
        `An agent named '${name}' already exists. Choose a different name or manually delete the existing agent first.`
      );
    } catch {
      // File doesn't exist - validation passed
      return null;
    }
  }

  /**
   * Provide custom function definition
   */
  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Agent name in kebab-case (e.g., "code-reviewer", "python-tester")',
            },
            description: {
              type: 'string',
              description: 'Brief description of what the agent does',
            },
            system_prompt: {
              type: 'string',
              description: 'Agent system instructions that define its behavior and capabilities',
            },
            model: {
              type: 'string',
              description: 'Model name to use (e.g., "qwen2.5-coder:32b"). Optional.',
            },
            temperature: {
              type: 'number',
              description: 'Temperature setting (0-2). Controls response randomness. Optional.',
            },
            reasoning_effort: {
              type: 'string',
              description: 'Reasoning effort level: "low", "medium", or "high". Optional.',
              enum: ['low', 'medium', 'high'],
            },
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of tool names the agent can use (e.g., ["read", "write", "grep"]). Optional.',
            },
            usage_guidelines: {
              type: 'string',
              description: 'Guidelines for when and how to use this agent. Optional.',
            },
            visible_from_agents: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of agent names that can see and use this agent. Optional.',
            },
            can_delegate_to_agents: {
              type: 'boolean',
              description: 'Whether this agent can delegate tasks to other agents. Optional.',
            },
            can_see_agents: {
              type: 'boolean',
              description: 'Whether this agent can see other agents. Optional.',
            },
          },
          required: ['name', 'description', 'system_prompt'],
        },
      },
    };
  }

  async previewChanges(args: any, callId?: string): Promise<void> {
    await super.previewChanges(args, callId);
    // No diff preview for agent creation
  }

  /**
   * Validate temperature parameter
   *
   * @param temp - Temperature value to validate
   * @returns Validation result with error message if invalid
   *
   * @example
   * const result = this.validateTemperature(0.7);
   * if (!result.valid) console.error(result.error);
   */
  public validateTemperature(temp: number): { valid: boolean; error?: string } {
    // Type validation
    if (typeof temp !== 'number' || isNaN(temp)) {
      return {
        valid: false,
        error: 'Temperature must be a number. Example: temperature: 0.7'
      };
    }

    // Range validation
    if (temp < 0 || temp > 2) {
      return {
        valid: false,
        error: `Temperature must be between 0 and 2 (got ${temp}). Example: temperature: 0.7`
      };
    }
    return { valid: true };
  }

  /**
   * Validate reasoning effort parameter
   *
   * @param effort - Reasoning effort level to validate
   * @returns Validation result with error message if invalid
   *
   * @example
   * const result = this.validateReasoningEffort("medium");
   * if (!result.valid) console.error(result.error);
   */
  public validateReasoningEffort(effort: string): { valid: boolean; error?: string } {
    // Type validation
    if (!effort || typeof effort !== 'string') {
      return {
        valid: false,
        error: 'Reasoning effort must be a non-empty string. Example: reasoning_effort: "medium"'
      };
    }

    // Enum validation
    const validEfforts = ['low', 'medium', 'high'];
    if (!validEfforts.includes(effort.toLowerCase())) {
      return {
        valid: false,
        error: `Reasoning effort must be one of: ${validEfforts.join(', ')} (got "${effort}"). Example: reasoning_effort: "medium"`
      };
    }
    return { valid: true };
  }

  /**
   * Validate tools array
   *
   * Checks that all tool names exist in the ToolManager.
   *
   * @param tools - Array of tool names to validate
   * @returns Validation result with invalid tools and suggestions
   *
   * @example
   * const result = await this.validateTools(["read", "write", "invalid-tool"]);
   * if (!result.valid) {
   *   console.error(result.error);
   *   console.log("Invalid tools:", result.invalidTools);
   * }
   */
  public async validateTools(tools: string[]): Promise<{
    valid: boolean;
    error?: string;
    invalidTools?: string[]
  }> {
    try {
      // Type validation
      if (!tools || !Array.isArray(tools)) {
        return {
          valid: false,
          error: 'Tools must be an array. Example: tools: ["read", "write"]'
        };
      }

      // Empty array is valid (means no tools)
      if (tools.length === 0) {
        return { valid: true };
      }

      // Validate array elements are strings
      if (tools.some(tool => typeof tool !== 'string' || !tool)) {
        return {
          valid: false,
          error: 'All tool names must be non-empty strings. Example: tools: ["read", "write"]'
        };
      }

      const registry = ServiceRegistry.getInstance();
      const toolManager = registry.get<ToolManager>('tool_manager');

      if (!toolManager) {
        return {
          valid: false,
          error: 'Internal error: ToolManager not available. Please restart the application.'
        };
      }

      const allTools = toolManager.getAllTools();
      const availableToolNames = allTools.map(tool => tool.name);
      const invalidTools = tools.filter(toolName => !availableToolNames.includes(toolName));

      if (invalidTools.length > 0) {
        return {
          valid: false,
          error: `Invalid tool names: ${invalidTools.join(', ')}. Available tools: ${availableToolNames.slice(0, 10).join(', ')}${availableToolNames.length > 10 ? '...' : ''}`,
          invalidTools
        };
      }

      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: `Failed to validate tools: ${formatError(error)}`
      };
    }
  }

  /**
   * Validate model name
   *
   * Checks if the model exists in Ollama by querying the /api/tags endpoint.
   *
   * @param model - Model name to validate
   * @returns Validation result with available models if invalid
   *
   * @example
   * const result = await this.validateModel("qwen2.5-coder:32b");
   * if (!result.valid) {
   *   console.error(result.error);
   *   console.log("Available models:", result.availableModels);
   * }
   */
  public async validateModel(model: string): Promise<{
    valid: boolean;
    error?: string;
    availableModels?: string[]
  }> {
    try {
      // Type validation
      if (!model || typeof model !== 'string' || model.trim() === '') {
        return {
          valid: false,
          error: 'Model name must be a non-empty string. Example: model: "qwen2.5-coder:32b"'
        };
      }

      const registry = ServiceRegistry.getInstance();
      const configManager = registry.get<ConfigManager>('config_manager');

      if (!configManager) {
        return {
          valid: false,
          error: 'Internal error: ConfigManager not available. Please restart the application.'
        };
      }

      const config = configManager.getConfig();
      const endpoint = config.endpoint;

      // Fetch available models from Ollama
      const url = `${endpoint}/api/tags`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), API_TIMEOUTS.OLLAMA_MODEL_LIST_TIMEOUT);

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          return {
            valid: false,
            error: `Failed to fetch models from Ollama: ${response.status} ${response.statusText}`
          };
        }

        interface OllamaListResponse {
          models: Array<{ name: string }>;
        }

        const data = await response.json() as OllamaListResponse;
        const availableModels = data.models.map(m => m.name);

        if (!availableModels.includes(model)) {
          return {
            valid: false,
            error: `Model "${model}" not found. Available models: ${availableModels.slice(0, 5).join(', ')}${availableModels.length > 5 ? '...' : ''}. Run "ollama list" to see all models, or "ollama pull ${model}" to download it.`,
            availableModels
          };
        }

        return { valid: true };
      } catch (error) {
        clearTimeout(timeout);
        return {
          valid: false,
          error: `Failed to connect to Ollama at ${endpoint}: ${formatError(error)}. Make sure Ollama is running.`
        };
      }
    } catch (error) {
      return {
        valid: false,
        error: `Failed to validate model: ${formatError(error)}`
      };
    }
  }

  /**
   * Validate visibility settings
   *
   * Checks logical consistency of visibility parameters and validates that
   * agent names in visibleFrom exist.
   *
   * @param visibleFrom - Array of agent names that can see this agent
   * @param canDelegate - Whether the agent can delegate to other agents
   * @param canSee - Whether the agent can see other agents
   * @returns Validation result with error message if invalid
   *
   * @example
   * const result = await this.validateVisibilitySettings(
   *   ["explore", "plan"],
   *   true,
   *   true
   * );
   * if (!result.valid) console.error(result.error);
   */
  public async validateVisibilitySettings(
    visibleFrom?: string[],
    canDelegate?: boolean,
    canSee?: boolean
  ): Promise<{ valid: boolean; error?: string }> {
    try {
      // Type validation
      if (visibleFrom !== undefined && !Array.isArray(visibleFrom)) {
        return {
          valid: false,
          error: 'visible_from_agents must be an array. Example: visible_from_agents: ["explore", "plan"]'
        };
      }
      if (canDelegate !== undefined && typeof canDelegate !== 'boolean') {
        return {
          valid: false,
          error: 'can_delegate_to_agents must be a boolean. Example: can_delegate_to_agents: true'
        };
      }
      if (canSee !== undefined && typeof canSee !== 'boolean') {
        return {
          valid: false,
          error: 'can_see_agents must be a boolean. Example: can_see_agents: true'
        };
      }

      // Validate visibleFrom array elements are strings
      if (visibleFrom && visibleFrom.some(agent => typeof agent !== 'string' || !agent)) {
        return {
          valid: false,
          error: 'All agent names in visible_from_agents must be non-empty strings. Example: visible_from_agents: ["explore", "plan"]'
        };
      }

      // Note: We don't enforce logical consistency (can_delegate=true + can_see=false)
      // because the user may have specific reasons for this configuration

      // Validate agent names in visibleFrom
      if (visibleFrom && visibleFrom.length > 0) {
        const registry = ServiceRegistry.getInstance();
        const agentManager = registry.get<AgentManager>('agent_manager');

        if (!agentManager) {
          return {
            valid: false,
            error: 'Internal error: AgentManager not available. Please restart the application.'
          };
        }

        const allAgents = await agentManager.listAgents();
        const availableAgentNames = allAgents.map(agent => agent.name);
        const invalidAgents = visibleFrom.filter(agentName => !availableAgentNames.includes(agentName));

        if (invalidAgents.length > 0) {
          return {
            valid: false,
            error: `Invalid agent names in visible_from_agents: ${invalidAgents.join(', ')}. Available agents: ${availableAgentNames.slice(0, 10).join(', ')}${availableAgentNames.length > 10 ? '...' : ''}`
          };
        }
      }

      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: `Failed to validate visibility settings: ${formatError(error)}`
      };
    }
  }


  protected async executeImpl(args: any): Promise<ToolResult> {
    try {
      this.captureParams(args);

      // Extract required parameters
      const name = args.name as string;
      const description = args.description as string;
      const system_prompt = args.system_prompt as string;

      // Validate required parameters
      if (!name) {
        return this.formatErrorResponse(
          'name parameter is required',
          'validation_error',
          'Example: write-agent(name="code-reviewer", description="...", system_prompt="...")'
        );
      }

      if (!description) {
        return this.formatErrorResponse(
          'description parameter is required',
          'validation_error'
        );
      }

      if (!system_prompt) {
        return this.formatErrorResponse(
          'system_prompt parameter is required',
          'validation_error'
        );
      }

      // Extract optional parameters
      const model = args.model as string | undefined;
      const temperature = args.temperature as number | undefined;
      const reasoning_effort = args.reasoning_effort as string | undefined;
      const tools = args.tools as string[] | undefined;
      const usage_guidelines = args.usage_guidelines as string | undefined;
      const visible_from_agents = args.visible_from_agents as string[] | undefined;
      const can_delegate_to_agents = args.can_delegate_to_agents as boolean | undefined;
      const can_see_agents = args.can_see_agents as boolean | undefined;

      // Run validations on optional parameters
      if (temperature !== undefined) {
        const result = this.validateTemperature(temperature);
        if (!result.valid) {
          return this.formatErrorResponse(result.error!, 'validation_error');
        }
      }

      if (reasoning_effort !== undefined) {
        const result = this.validateReasoningEffort(reasoning_effort);
        if (!result.valid) {
          return this.formatErrorResponse(result.error!, 'validation_error');
        }
      }

      if (tools !== undefined) {
        const result = await this.validateTools(tools);
        if (!result.valid) {
          return this.formatErrorResponse(result.error!, 'validation_error');
        }
      }

      if (model !== undefined) {
        const result = await this.validateModel(model);
        if (!result.valid) {
          return this.formatErrorResponse(result.error!, 'validation_error');
        }
      }

      const visResult = await this.validateVisibilitySettings(
        visible_from_agents,
        can_delegate_to_agents,
        can_see_agents
      );
      if (!visResult.valid) {
        return this.formatErrorResponse(visResult.error!, 'validation_error');
      }

      // Construct filename
      const filename = `${name}.md`;
      const agentsDir = getAgentsDir();
      const absolutePath = path.join(agentsDir, filename);

      // Check if file exists
      try {
        await fs.access(absolutePath);
        return this.formatErrorResponse(
          `Agent already exists: ${absolutePath}`,
          'file_error',
          'Choose a different name or manually delete the existing agent first.'
        );
      } catch {
        // File doesn't exist - proceed
      }

      // Construct agent content
      const content = constructAgentContent({
        name,
        description,
        system_prompt,
        model,
        temperature,
        reasoning_effort,
        tools,
        usage_guidelines,
        visible_from_agents,
        can_delegate_to_agents,
        can_see_agents,
      });

      // Create agents directory if it doesn't exist
      await fs.mkdir(agentsDir, { recursive: true });

      // Write the agent file
      await fs.writeFile(absolutePath, content, 'utf-8');

      // Track read state
      const registry = ServiceRegistry.getInstance();
      const readStateManager = registry.get<ReadStateManager>('read_state_manager');
      if (readStateManager && content.length > 0) {
        const lines = content.split('\n');
        readStateManager.trackRead(absolutePath, 1, lines.length);
      }

      // Capture operation patch
      const patchNumber = await this.captureOperationPatch(
        'write-agent',
        absolutePath,
        '', // New file
        content
      );

      const stats = await fs.stat(absolutePath);

      const successMessage = `Created agent '${name}' at ${absolutePath} (${stats.size} bytes)`;

      const response = this.formatSuccessResponse({
        content: successMessage,
        file_path: absolutePath,
        agent_name: name,
        bytes_written: stats.size,
      });

      if (patchNumber !== null) {
        response.patch_number = patchNumber;
      }

      return response;
    } catch (error) {
      return this.formatErrorResponse(
        `Failed to create agent file: ${formatError(error)}`,
        'system_error'
      );
    }
  }

  /**
   * Format subtext for display in UI
   * Shows the agent name being created
   */
  formatSubtext(args: Record<string, any>): string | null {
    const name = args.name as string;
    if (name) {
      return `Creating agent: ${name}`;
    }
    return null;
  }

  /**
   * Get parameters shown in subtext
   */
  getSubtextParameters(): string[] {
    return ['name'];
  }

  /**
   * Custom result preview for write-agent tool
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const lines: string[] = [];
    const agentName = result.agent_name ?? 'unknown';
    const bytesWritten = result.bytes_written ?? 0;

    lines.push(`Created agent '${agentName}' (${bytesWritten} bytes)`);

    return lines;
  }
}
