/**
 * WriteAgentTool - Specialized tool for creating agent definition files
 *
 * This tool is only visible to the 'manage-agents' agent and handles
 * writing agent files to the correct profile directory automatically.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import type { AgentData } from '../types/agents.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { ReadStateManager } from '../services/ReadStateManager.js';
import { AgentManager } from '../services/AgentManager.js';
import { formatError } from '../utils/errorUtils.js';
import { validateAgentName } from '../utils/namingValidation.js';
import { validateAgentConfig } from '../utils/agentValidationUtils.js';
import { stat } from 'fs/promises';

export class WriteAgentTool extends BaseTool {
  readonly name = 'write-agent';
  readonly description = 'Create a new agent definition file with structured parameters (name, description, system_prompt, and optional configuration). File is automatically created in the correct profile agents directory.';
  readonly requiresConfirmation = false; // No permission needed (validated before creation)
  readonly hideOutput = true; // Hide output from result preview
  readonly visibleTo = ['manage-agents']; // Only visible to manage-agents agent

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Resolve the AgentManager from the service registry.
   */
  private getAgentManager(): AgentManager | null {
    return ServiceRegistry.getInstance().get<AgentManager>('agent_manager') ?? null;
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

    const agentManager = this.getAgentManager();
    if (agentManager && (await agentManager.readUserAgentFile(name)) !== null) {
      // File exists - fail without requesting permission
      return this.formatErrorResponse(
        `Agent already exists: ${agentManager.getAgentFilePath(name)}`,
        'file_error',
        `An agent named '${name}' already exists. Choose a different name or manually delete the existing agent first.`
      );
    }

    return null;
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

      // Validate all optional configuration in one pass
      const configValidation = await validateAgentConfig({
        model,
        temperature,
        reasoning_effort,
        tools,
        visible_from_agents,
        can_delegate_to_agents,
        can_see_agents,
      });
      if (!configValidation.valid) {
        return this.formatErrorResponse(configValidation.error!, 'validation_error');
      }

      const agentManager = this.getAgentManager();
      if (!agentManager) {
        return this.formatErrorResponse(
          'Internal error: AgentManager not available. Please restart the application.',
          'system_error'
        );
      }

      // Refuse to overwrite an existing user agent
      if ((await agentManager.readUserAgentFile(name)) !== null) {
        return this.formatErrorResponse(
          `Agent already exists: ${agentManager.getAgentFilePath(name)}`,
          'file_error',
          'Choose a different name or manually delete the existing agent first.'
        );
      }

      const agentData: AgentData = {
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
      };

      // Serialize and write through the single agent writer
      const { filePath: absolutePath, content } = await agentManager.writeAgentFile(agentData);

      // Track read state
      const readStateManager = ServiceRegistry.getInstance().get<ReadStateManager>('read_state_manager');
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

      const stats = await stat(absolutePath);

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
