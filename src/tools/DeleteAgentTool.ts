/**
 * DeleteAgentTool - Specialized tool for deleting agent definition files
 *
 * This tool is only visible to the 'manage-agents' agent and handles
 * removing agent files permanently. No confirmation required (manage-agents is trusted).
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { formatError } from '../utils/errorUtils.js';
import { getAgentsDir } from '../config/paths.js';
import { validateAgentName } from '../utils/agentContentUtils.js';
import * as fs from 'fs/promises';
import * as path from 'path';

export class DeleteAgentTool extends BaseTool {
  readonly name = 'delete-agent';
  readonly description = 'Delete an agent from the profile. Removes the agent file permanently.';
  readonly requiresConfirmation = false; // Trust the manage-agents agent
  readonly hideOutput = false; // Show deletion confirmation
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
          },
          required: ['name'],
        },
      },
    };
  }

  async previewChanges(args: any, callId?: string): Promise<void> {
    await super.previewChanges(args, callId);
    // No diff preview for deletion
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
          'Example: delete-agent(name="code-reviewer")'
        );
      }

      // Construct filename and path
      const filename = `${name}.md`;
      const agentsDir = getAgentsDir();
      const absolutePath = path.join(agentsDir, filename);

      // Check if file exists and read content
      let originalContent = '';
      try {
        originalContent = await fs.readFile(absolutePath, 'utf-8');
      } catch (error) {
        // File doesn't exist
        return this.formatErrorResponse(
          `Agent does not exist: ${name}`,
          'file_error',
          `Agent '${name}' not found at ${absolutePath}. Use list-agents to see available agents.`
        );
      }

      // Delete the file
      await fs.unlink(absolutePath);

      // Capture operation patch for potential undo
      const patchNumber = await this.captureOperationPatch(
        'delete-agent',
        absolutePath,
        originalContent,
        undefined // No new content (file deleted)
      );

      const successMessage = `Deleted agent '${name}' from ${absolutePath}`;

      const response = this.formatSuccessResponse({
        content: successMessage,
        file_path: absolutePath,
        agent_name: name,
      });

      if (patchNumber !== null) {
        response.patch_number = patchNumber;
      }

      return response;
    } catch (error) {
      return this.formatErrorResponse(
        `Failed to delete agent file: ${formatError(error)}`,
        'system_error'
      );
    }
  }

  /**
   * Format subtext for display in UI
   * Shows the agent name being deleted
   */
  formatSubtext(args: Record<string, any>): string | null {
    const name = args.name as string;
    if (name) {
      return `Deleting agent: ${name}`;
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
   * Custom result preview for delete-agent tool
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const lines: string[] = [];
    const agentName = result.agent_name ?? 'unknown';

    lines.push(`Deleted agent '${agentName}'`);

    return lines;
  }
}
