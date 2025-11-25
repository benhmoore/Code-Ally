/**
 * EditAgentTool - Specialized tool for editing existing agent definition files
 *
 * This tool is only visible to the 'manage-agents' agent and handles
 * updating agent files with partial modifications. Only provided fields
 * are updated, preserving all other existing configuration.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { ReadStateManager } from '../services/ReadStateManager.js';
import { formatError } from '../utils/errorUtils.js';
import { getAgentsDir } from '../config/paths.js';
import { parseAgentFile, constructAgentContent, AgentContentParams, validateAgentName } from '../utils/agentContentUtils.js';
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

export class EditAgentTool extends BaseTool {
  readonly name = 'edit-agent';
  readonly description = 'Modify existing agent configuration. Supports partial updates - only provided fields are updated.';
  readonly requiresConfirmation = false; // Validated before execution
  readonly hideOutput = true; // Hide output from result preview
  readonly visibleTo = ['manage-agents']; // Only visible to manage-agents agent

  constructor(activityStream: ActivityStream) {
    super(activityStream);
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
              description: 'Brief description of what the agent does. Optional - only updates if provided.',
            },
            system_prompt: {
              type: 'string',
              description: 'Agent system instructions that define its behavior and capabilities. Optional - only updates if provided.',
            },
            model: {
              type: 'string',
              description: 'Model name to use (e.g., "qwen2.5-coder:32b"). Optional - only updates if provided.',
            },
            temperature: {
              type: 'number',
              description: 'Temperature setting (0-2). Controls response randomness. Optional - only updates if provided.',
            },
            reasoning_effort: {
              type: 'string',
              description: 'Reasoning effort level: "low", "medium", or "high". Optional - only updates if provided.',
              enum: ['low', 'medium', 'high'],
            },
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of tool names the agent can use (e.g., ["read", "write", "grep"]). Optional - only updates if provided.',
            },
            usage_guidelines: {
              type: 'string',
              description: 'Guidelines for when and how to use this agent. Optional - only updates if provided.',
            },
            visible_from_agents: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of agent names that can see and use this agent. Optional - only updates if provided.',
            },
            can_delegate_to_agents: {
              type: 'boolean',
              description: 'Whether this agent can delegate tasks to other agents. Optional - only updates if provided.',
            },
            can_see_agents: {
              type: 'boolean',
              description: 'Whether this agent can see other agents. Optional - only updates if provided.',
            },
          },
          required: ['name'],
        },
      },
    };
  }

  async previewChanges(args: any, callId?: string): Promise<void> {
    await super.previewChanges(args, callId);
    // No diff preview for agent edits (would require complex merge logic)
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    try {
      this.captureParams(args);

      // Extract required parameter
      const name = args.name as string;

      // Validate agent name format
      const nameValidation = validateAgentName(name);
      if (!nameValidation.valid) {
        return this.formatErrorResponse(
          nameValidation.error!,
          'validation_error',
          'Example: edit-agent(name="code-reviewer", description="Updated description")'
        );
      }

      // Construct filename and path
      const filename = `${name}.md`;
      const agentsDir = getAgentsDir();
      const absolutePath = path.join(agentsDir, filename);

      // Read current agent file
      let currentContent: string;
      try {
        currentContent = await fs.readFile(absolutePath, 'utf-8');
      } catch {
        return this.formatErrorResponse(
          `Agent does not exist: ${name}`,
          'file_error',
          `Agent '${name}' not found at ${absolutePath}. Use write-agent to create new agents.`
        );
      }

      // Parse current agent file
      let currentFrontmatter;
      let currentSystemPrompt;
      try {
        const parsed = parseAgentFile(currentContent);
        currentFrontmatter = parsed.frontmatter;
        currentSystemPrompt = parsed.systemPrompt;
      } catch (error) {
        return this.formatErrorResponse(
          `Failed to parse agent file: ${formatError(error)}`,
          'validation_error',
          'The agent file may be corrupted or improperly formatted.'
        );
      }

      // Extract optional update parameters
      const description = args.description as string | undefined;
      const system_prompt = args.system_prompt as string | undefined;
      const model = args.model as string | undefined;
      const temperature = args.temperature as number | undefined;
      const reasoning_effort = args.reasoning_effort as string | undefined;
      const tools = args.tools as string[] | undefined;
      const usage_guidelines = args.usage_guidelines as string | undefined;
      const visible_from_agents = args.visible_from_agents as string[] | undefined;
      const can_delegate_to_agents = args.can_delegate_to_agents as boolean | undefined;
      const can_see_agents = args.can_see_agents as boolean | undefined;

      // Validate updated fields (non-visibility fields)
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

      // Merge updates with current values (only update provided fields)
      const mergedParams: AgentContentParams = {
        name: currentFrontmatter.name, // Name cannot be changed
        description: description !== undefined ? description : currentFrontmatter.description,
        system_prompt: system_prompt !== undefined ? system_prompt : currentSystemPrompt,
        model: model !== undefined ? model : currentFrontmatter.model,
        temperature: temperature !== undefined ? temperature : currentFrontmatter.temperature,
        reasoning_effort: reasoning_effort !== undefined ? reasoning_effort : currentFrontmatter.reasoning_effort,
        tools: tools !== undefined ? tools : currentFrontmatter.tools,
        usage_guidelines: usage_guidelines !== undefined ? usage_guidelines : currentFrontmatter.usage_guidelines,
        visible_from_agents: visible_from_agents !== undefined ? visible_from_agents : currentFrontmatter.visible_from_agents,
        can_delegate_to_agents: can_delegate_to_agents !== undefined ? can_delegate_to_agents : currentFrontmatter.can_delegate_to_agents,
        can_see_agents: can_see_agents !== undefined ? can_see_agents : currentFrontmatter.can_see_agents,
        preserveCreatedAt: currentFrontmatter.created_at, // Preserve original created_at timestamp
      };

      // Validate visibility settings on MERGED values (not just new values)
      // This ensures the final configuration is logically consistent
      const visibilitySettings: VisibilitySettings = {
        visibleFromAgents: mergedParams.visible_from_agents,
        canDelegateToAgents: mergedParams.can_delegate_to_agents,
        canSeeAgents: mergedParams.can_see_agents,
      };
      const visResult = await validateVisibilitySettings(visibilitySettings);
      if (!visResult.valid) {
        return this.formatErrorResponse(visResult.error!, 'validation_error');
      }

      // Validate model supports tools on MERGED values
      // This catches cases where model is changed to one that doesn't support existing tools
      const toolCapResult = await validateModelToolCapability(mergedParams.model, mergedParams.tools);
      if (!toolCapResult.valid) {
        return this.formatErrorResponse(toolCapResult.error!, 'validation_error');
      }

      // Construct updated content with preserved created_at and updated updated_at
      const updatedContent = constructAgentContent(mergedParams);

      // Write updated file
      await fs.writeFile(absolutePath, updatedContent, 'utf-8');

      // Track read state
      const registry = ServiceRegistry.getInstance();
      const readStateManager = registry.get<ReadStateManager>('read_state_manager');
      if (readStateManager && updatedContent.length > 0) {
        const lines = updatedContent.split('\n');
        readStateManager.trackRead(absolutePath, 1, lines.length);
      }

      // Capture operation patch
      const patchNumber = await this.captureOperationPatch(
        'edit-agent',
        absolutePath,
        currentContent,
        updatedContent
      );

      const stats = await fs.stat(absolutePath);

      // Build list of updated fields for success message
      const updatedFields: string[] = [];
      if (description !== undefined) updatedFields.push('description');
      if (system_prompt !== undefined) updatedFields.push('system_prompt');
      if (model !== undefined) updatedFields.push('model');
      if (temperature !== undefined) updatedFields.push('temperature');
      if (reasoning_effort !== undefined) updatedFields.push('reasoning_effort');
      if (tools !== undefined) updatedFields.push('tools');
      if (usage_guidelines !== undefined) updatedFields.push('usage_guidelines');
      if (visible_from_agents !== undefined) updatedFields.push('visible_from_agents');
      if (can_delegate_to_agents !== undefined) updatedFields.push('can_delegate_to_agents');
      if (can_see_agents !== undefined) updatedFields.push('can_see_agents');

      const fieldsMessage = updatedFields.length > 0
        ? ` (updated: ${updatedFields.join(', ')})`
        : ' (no changes)';

      const successMessage = `Updated agent '${name}' at ${absolutePath}${fieldsMessage} (${stats.size} bytes)`;

      const response = this.formatSuccessResponse({
        content: successMessage,
        file_path: absolutePath,
        agent_name: name,
        bytes_written: stats.size,
        updated_fields: updatedFields,
      });

      if (patchNumber !== null) {
        response.patch_number = patchNumber;
      }

      return response;
    } catch (error) {
      return this.formatErrorResponse(
        `Failed to edit agent file: ${formatError(error)}`,
        'system_error'
      );
    }
  }

  /**
   * Format subtext for display in UI
   * Shows the agent name being edited
   */
  formatSubtext(args: Record<string, any>): string | null {
    const name = args.name as string;
    if (name) {
      return `Editing agent: ${name}`;
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
   * Custom result preview for edit-agent tool
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const lines: string[] = [];
    const agentName = result.agent_name ?? 'unknown';
    const updatedFields = result.updated_fields ?? [];

    if (updatedFields.length > 0) {
      lines.push(`Updated agent '${agentName}': ${updatedFields.join(', ')}`);
    } else {
      lines.push(`Updated agent '${agentName}' (no changes)`);
    }

    return lines;
  }
}
