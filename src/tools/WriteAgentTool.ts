/**
 * WriteAgentTool - Specialized tool for creating agent definition files
 *
 * This tool is only visible to the 'manage-agents' agent and handles
 * writing agent files to the correct profile directory automatically.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { ReadStateManager } from '../services/ReadStateManager.js';
import { formatError } from '../utils/errorUtils.js';
import { getAgentsDir } from '../config/paths.js';
import { constructAgentContent, validateAgentName } from '../utils/agentContentUtils.js';
import {
  validateTemperature,
  validateReasoningEffort,
  validateTools,
  validateModel,
  validateVisibilitySettings,
  validateModelToolCapability,
  VisibilitySettings
} from '../utils/agentValidationUtils.js';
import * as fs from 'fs/promises';
import * as path from 'path';

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
        const result = validateTemperature(temperature);
        if (!result.valid) {
          return this.formatErrorResponse(result.error!, 'validation_error');
        }
      }

      if (reasoning_effort !== undefined) {
        const result = validateReasoningEffort(reasoning_effort);
        if (!result.valid) {
          return this.formatErrorResponse(result.error!, 'validation_error');
        }
      }

      if (tools !== undefined) {
        const result = await validateTools(tools);
        if (!result.valid) {
          return this.formatErrorResponse(result.error!, 'validation_error');
        }
      }

      if (model !== undefined) {
        const result = await validateModel(model);
        if (!result.valid) {
          return this.formatErrorResponse(result.error!, 'validation_error');
        }
      }

      // Validate model supports tools if tools are configured
      const toolCapabilityResult = await validateModelToolCapability(model, tools);
      if (!toolCapabilityResult.valid) {
        return this.formatErrorResponse(toolCapabilityResult.error!, 'validation_error');
      }

      const visibilitySettings: VisibilitySettings = {
        visibleFromAgents: visible_from_agents,
        canDelegateToAgents: can_delegate_to_agents,
        canSeeAgents: can_see_agents,
      };
      const visibilityValidation = await validateVisibilitySettings(visibilitySettings);
      if (!visibilityValidation.valid) {
        return this.formatErrorResponse(visibilityValidation.error!, 'validation_error');
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
