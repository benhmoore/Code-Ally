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
import { formatError } from '../utils/errorUtils.js';
import { getAgentsDir } from '../config/paths.js';
import * as fs from 'fs/promises';
import * as path from 'path';

export class WriteAgentTool extends BaseTool {
  readonly name = 'write-agent';
  readonly description = 'Create a new agent definition file. Takes filename (e.g., "my-agent.md") and content. File is automatically created in the correct profile agents directory.';
  readonly requiresConfirmation = true; // Destructive operation
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
    const filename = args.filename as string;

    if (!filename) {
      return this.formatErrorResponse(
        'filename parameter is required',
        'validation_error',
        'Example: write-agent(filename="my-agent.md", content="...")'
      );
    }

    // Validate filename format (must be .md and kebab-case)
    if (!filename.endsWith('.md')) {
      return this.formatErrorResponse(
        'Agent filename must end with .md',
        'validation_error',
        'Example: "my-agent.md"'
      );
    }

    // Extract agent name (without .md extension)
    const agentName = filename.slice(0, -3);

    // Validate kebab-case format
    const kebabRegex = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
    if (!kebabRegex.test(agentName)) {
      return this.formatErrorResponse(
        `Agent name must be kebab-case: ${agentName}`,
        'validation_error',
        'Valid examples: "code-reviewer", "python-tester". Invalid: "CodeReviewer", "code_reviewer"'
      );
    }

    const agentsDir = getAgentsDir();
    const absolutePath = path.join(agentsDir, filename);

    try {
      // Check if file exists
      await fs.access(absolutePath);
      // File exists - fail without requesting permission
      return this.formatErrorResponse(
        `Agent already exists: ${absolutePath}`,
        'file_error',
        `An agent named '${agentName}' already exists. Choose a different name or manually delete the existing agent first.`
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
            filename: {
              type: 'string',
              description: 'Agent filename (e.g., "my-agent.md"). Must be kebab-case with .md extension.',
            },
            content: {
              type: 'string',
              description: 'Complete agent file content with YAML frontmatter and system prompt.',
            },
          },
          required: ['filename', 'content'],
        },
      },
    };
  }

  async previewChanges(args: any, callId?: string): Promise<void> {
    await super.previewChanges(args, callId);

    const filename = args.filename as string;
    const content = args.content as string;

    if (!filename || content === undefined) {
      return; // Skip preview if invalid args
    }

    const agentsDir = getAgentsDir();
    const absolutePath = path.join(agentsDir, filename);

    await this.safelyEmitDiffPreview(
      absolutePath,
      async () => {
        // Always a new file for agents (we validate no overwrite in validateBeforePermission)
        return { oldContent: '', newContent: content };
      },
      'write'
    );
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    // Capture parameters
    this.captureParams(args);

    // Extract and validate parameters
    const filename = args.filename as string;
    const content = args.content as string;

    if (!filename) {
      return this.formatErrorResponse(
        'filename parameter is required',
        'validation_error',
        'Example: write-agent(filename="my-agent.md", content="...")'
      );
    }

    if (content === undefined || content === null) {
      return this.formatErrorResponse(
        'content parameter is required',
        'validation_error',
        'Example: write-agent(filename="my-agent.md", content="---\\nname: ...\\n---\\n...")'
      );
    }

    // Construct absolute path using agents directory
    const agentsDir = getAgentsDir();
    const absolutePath = path.join(agentsDir, filename);

    try {
      // Check if file exists
      try {
        await fs.access(absolutePath);
        // File exists - fail
        return this.formatErrorResponse(
          `Agent already exists: ${absolutePath}`,
          'file_error',
          'Choose a different name or manually delete the existing agent first.'
        );
      } catch {
        // File doesn't exist - proceed
      }

      // Create agents directory if it doesn't exist
      await fs.mkdir(agentsDir, { recursive: true });

      // Write the agent file
      await fs.writeFile(absolutePath, content, 'utf-8');

      // Track the written content as read (model knows what it wrote)
      const registry = ServiceRegistry.getInstance();
      const readStateManager = registry.get<ReadStateManager>('read_state_manager');
      if (readStateManager && content.length > 0) {
        const lines = content.split('\n');
        readStateManager.trackRead(absolutePath, 1, lines.length);
      }

      // Capture the operation as a patch for undo functionality
      const patchNumber = await this.captureOperationPatch(
        'write-agent',
        absolutePath,
        '', // New file, no existing content
        content
      );

      const stats = await fs.stat(absolutePath);
      const agentName = filename.slice(0, -3); // Remove .md extension

      const successMessage = `Created agent '${agentName}' at ${absolutePath} (${stats.size} bytes)`;

      const response = this.formatSuccessResponse({
        content: successMessage,
        file_path: absolutePath,
        agent_name: agentName,
        bytes_written: stats.size,
      });

      // Add patch information to result if patch was captured
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
    const filename = args.filename as string;
    if (filename) {
      const agentName = filename.endsWith('.md') ? filename.slice(0, -3) : filename;
      return `Creating agent: ${agentName}`;
    }
    return null;
  }

  /**
   * Get parameters shown in subtext
   */
  getSubtextParameters(): string[] {
    return ['filename'];
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
