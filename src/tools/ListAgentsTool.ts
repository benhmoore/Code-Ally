/**
 * ListAgentsTool - List all agents in the current profile
 *
 * This tool is only visible to the 'manage-agents' agent and provides
 * a comprehensive list of all available agents with their configurations.
 * It's a read-only operation that helps agents understand what other
 * agents exist and their capabilities.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { parseAgentFile } from '../utils/agentContentUtils.js';
import { getAgentsDir } from '../config/paths.js';
import { formatError } from '../utils/errorUtils.js';
import { logger } from '../services/Logger.js';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Agent summary information returned by list-agents
 */
interface AgentSummary {
  name: string;
  description: string;
  tools?: string[];
  visible_from_agents?: string[];
  can_delegate_to_agents?: boolean;
  can_see_agents?: boolean;
  file_path: string;
}

export class ListAgentsTool extends BaseTool {
  readonly name = 'list-agents';
  readonly description = 'List all agents in current profile. Returns agent summaries with name, description, and configuration.';
  readonly requiresConfirmation = false; // Read-only operation
  readonly hideOutput = false; // Show agent list to user
  readonly visibleTo = ['manage-agents']; // Only manage-agents agent can use

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
          properties: {},
          required: [],
        },
      },
    };
  }

  /**
   * Format agent summary for display
   *
   * Creates a nicely formatted text representation of an agent's key information.
   *
   * @param agent - Agent summary to format
   * @returns Formatted string representation
   */
  private formatAgentSummary(agent: AgentSummary): string {
    const lines: string[] = [];

    // Main info line with bullet point
    lines.push(`• ${agent.name} - ${agent.description}`);

    // Tools (if any)
    if (agent.tools && agent.tools.length > 0) {
      const toolsList = agent.tools.join(', ');
      lines.push(`  Tools: ${toolsList}`);
    }

    // Visibility settings
    const visibilityParts: string[] = [];

    if (agent.visible_from_agents && agent.visible_from_agents.length > 0) {
      visibilityParts.push(`Visible to: ${agent.visible_from_agents.join(', ')}`);
    } else {
      visibilityParts.push('Visibility: main only');
    }

    if (agent.can_delegate_to_agents !== undefined || agent.can_see_agents !== undefined) {
      const delegateInfo = agent.can_delegate_to_agents ? 'can delegate' : 'no delegation';
      const seeInfo = agent.can_see_agents ? 'can see agents' : 'no visibility';
      visibilityParts.push(`(${delegateInfo}, ${seeInfo})`);
    }

    lines.push(`  ${visibilityParts.join(' ')}`);

    return lines.join('\n');
  }

  /**
   * Read and parse a single agent file
   *
   * @param filePath - Absolute path to the agent file
   * @returns Agent summary or null if parsing fails
   */
  private async readAgentFile(filePath: string): Promise<AgentSummary | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const { frontmatter } = parseAgentFile(content);

      return {
        name: frontmatter.name,
        description: frontmatter.description,
        tools: frontmatter.tools,
        visible_from_agents: frontmatter.visible_from_agents,
        can_delegate_to_agents: frontmatter.can_delegate_to_agents,
        can_see_agents: frontmatter.can_see_agents,
        file_path: filePath,
      };
    } catch (error) {
      // Log parse error but don't fail entire operation
      logger.warn(`[${this.name}] Failed to parse agent file ${filePath}: ${formatError(error)}`);
      return null;
    }
  }

  protected async executeImpl(_args: any): Promise<ToolResult> {
    try {
      this.captureParams(_args);

      const agentsDir = getAgentsDir();

      // Check if agents directory exists
      try {
        await fs.access(agentsDir);
      } catch {
        return this.formatSuccessResponse({
          content: 'No agents found. The agents directory does not exist yet.',
          agents: [],
          count: 0,
        });
      }

      // Read all files in agents directory
      let files: string[];
      try {
        files = await fs.readdir(agentsDir);
      } catch (error) {
        return this.formatErrorResponse(
          `Failed to read agents directory: ${formatError(error)}`,
          'file_error',
          'Ensure the agents directory is accessible and has proper permissions.'
        );
      }

      // Filter to only .md files
      const agentFiles = files.filter(file => file.endsWith('.md'));

      if (agentFiles.length === 0) {
        return this.formatSuccessResponse({
          content: 'No agents found. The agents directory is empty.',
          agents: [],
          count: 0,
        });
      }

      // Read and parse all agent files
      const agentSummaries: AgentSummary[] = [];
      for (const file of agentFiles) {
        const filePath = path.join(agentsDir, file);
        const summary = await this.readAgentFile(filePath);
        if (summary) {
          agentSummaries.push(summary);
        }
      }

      // Sort alphabetically by name
      agentSummaries.sort((a, b) => a.name.localeCompare(b.name));

      // Format output
      const formattedAgents = agentSummaries.map(agent => this.formatAgentSummary(agent));
      const content = `Found ${agentSummaries.length} agent${agentSummaries.length === 1 ? '' : 's'}:\n\n${formattedAgents.join('\n\n')}`;

      return this.formatSuccessResponse({
        content,
        agents: agentSummaries,
        count: agentSummaries.length,
      });
    } catch (error) {
      return this.formatErrorResponse(
        `Failed to list agents: ${formatError(error)}`,
        'system_error'
      );
    }
  }

  /**
   * Format subtext for display in UI
   * Shows count of agents found
   */
  formatSubtext(_args: Record<string, any>, result?: any): string | null {
    if (result && result.count !== undefined) {
      return `Found ${result.count} agent${result.count === 1 ? '' : 's'}`;
    }
    return 'Listing agents';
  }

  /**
   * Get parameters shown in subtext
   */
  getSubtextParameters(): string[] {
    return [];
  }

  /**
   * Custom result preview for list-agents tool
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const lines: string[] = [];
    const count = result.count ?? 0;
    const agents = result.agents as AgentSummary[] | undefined;

    if (count === 0) {
      lines.push('No agents found');
      return lines;
    }

    lines.push(`Found ${count} agent${count === 1 ? '' : 's'}:`);

    // Show first few agents
    if (agents && agents.length > 0) {
      const agentsToShow = agents.slice(0, Math.min(maxLines - 1, agents.length));
      agentsToShow.forEach(agent => {
        lines.push(`  • ${agent.name} - ${agent.description}`);
      });

      if (agents.length > agentsToShow.length) {
        lines.push(`  ... and ${agents.length - agentsToShow.length} more`);
      }
    }

    return lines;
  }
}
