/**
 * AgentManager - Agent storage and retrieval
 *
 * Manages specialized agent definitions stored as markdown files.
 * Loads from both built-in agents (dist/agents/) and user agents (~/.ally/agents/).
 * User agents can override built-in agents by using the same name.
 */

import { readFile, writeFile, readdir, unlink, access } from 'fs/promises';
import { join } from 'path';
import { constants } from 'fs';
import { logger } from './Logger.js';
import { formatError } from '../utils/errorUtils.js';
import { AGENTS_DIR, BUILTIN_AGENTS_DIR } from '../config/paths.js';

export interface AgentData {
  name: string;
  description: string;
  system_prompt: string;
  model?: string;
  temperature?: number;
  reasoning_effort?: string; // Reasoning effort: "inherit", "low", "medium", "high". Defaults to "inherit"
  tools?: string[]; // Tool names this agent can use. Empty array = all tools, undefined = all tools
  created_at?: string;
  updated_at?: string;
}

export interface AgentInfo {
  name: string;
  description: string;
  file_path: string;
}

export class AgentManager {
  private readonly userAgentsDir: string;
  private readonly builtinAgentsDir: string;

  constructor() {
    this.userAgentsDir = AGENTS_DIR;
    this.builtinAgentsDir = BUILTIN_AGENTS_DIR;
  }

  /**
   * Get the user agents directory path
   *
   * @returns User agents directory path
   */
  getAgentsDir(): string {
    return this.userAgentsDir;
  }

  /**
   * Check if an agent exists (in either user or built-in directories)
   *
   * @param agentName - Agent name
   * @returns True if agent exists
   */
  async agentExists(agentName: string): Promise<boolean> {
    // Check user directory first
    const userPath = join(this.userAgentsDir, `${agentName}.md`);
    try {
      await access(userPath, constants.F_OK);
      return true;
    } catch {
      // Fall back to built-in
      const builtinPath = join(this.builtinAgentsDir, `${agentName}.md`);
      try {
        await access(builtinPath, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Load an agent by name
   * Priority: user agents (~/.ally/agents/) > built-in agents (dist/agents/)
   *
   * @param agentName - Agent name
   * @returns Agent data or null if not found
   */
  async loadAgent(agentName: string): Promise<AgentData | null> {
    // Try user directory first
    const userPath = join(this.userAgentsDir, `${agentName}.md`);
    try {
      const content = await readFile(userPath, 'utf-8');
      logger.debug(`Loaded user agent '${agentName}'`);
      return this.parseAgentFile(content, agentName);
    } catch (error) {
      logger.debug(`Agent '${agentName}' not found in user directory`);
    }

    // Fall back to built-in agents
    const builtinPath = join(this.builtinAgentsDir, `${agentName}.md`);
    try {
      const content = await readFile(builtinPath, 'utf-8');
      logger.debug(`Loaded built-in agent '${agentName}'`);
      return this.parseAgentFile(content, agentName);
    } catch (error) {
      logger.debug(`Failed to load agent '${agentName}':`, formatError(error));
      return null;
    }
  }

  /**
   * Save an agent to user storage
   *
   * @param agent - Agent data
   * @returns True if saved successfully
   */
  async saveAgent(agent: AgentData): Promise<boolean> {
    try {
      // Ensure directory exists
      const { mkdir } = await import('fs/promises');
      await mkdir(this.userAgentsDir, { recursive: true });

      const filePath = join(this.userAgentsDir, `${agent.name}.md`);
      const content = this.formatAgentFile(agent);

      await writeFile(filePath, content, 'utf-8');
      return true;
    } catch (error) {
      console.error(`Error saving agent ${agent.name}:`, error);
      return false;
    }
  }

  /**
   * Delete a user agent (cannot delete built-in agents)
   *
   * @param agentName - Agent name
   * @returns True if deleted successfully
   */
  async deleteAgent(agentName: string): Promise<boolean> {
    // Only delete from user directory (built-ins cannot be deleted)
    const filePath = join(this.userAgentsDir, `${agentName}.md`);

    try {
      await unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all available agents (user + built-in)
   * User agents override built-ins with the same name
   *
   * @returns Array of agent info
   */
  async listAgents(): Promise<AgentInfo[]> {
    const agentMap = new Map<string, AgentInfo>();

    // Load built-in agents first
    try {
      const builtinFiles = await readdir(this.builtinAgentsDir);
      for (const file of builtinFiles.filter(f => f.endsWith('.md'))) {
        const agentName = file.replace('.md', '');
        const filePath = join(this.builtinAgentsDir, file);

        try {
          const content = await readFile(filePath, 'utf-8');
          const agent = this.parseAgentFile(content, agentName);

          if (agent) {
            agentMap.set(agentName, {
              name: agent.name,
              description: agent.description,
              file_path: filePath,
            });
          }
        } catch {
          continue;
        }
      }
    } catch (error) {
      logger.debug('Could not load built-in agents:', formatError(error));
    }

    // Load user agents (override built-ins)
    try {
      const userFiles = await readdir(this.userAgentsDir);
      for (const file of userFiles.filter(f => f.endsWith('.md'))) {
        const agentName = file.replace('.md', '');
        const filePath = join(this.userAgentsDir, file);

        try {
          const content = await readFile(filePath, 'utf-8');
          const agent = this.parseAgentFile(content, agentName);

          if (agent) {
            agentMap.set(agentName, {
              name: agent.name,
              description: agent.description,
              file_path: filePath,
            });
          }
        } catch {
          continue;
        }
      }
    } catch (error) {
      logger.debug('Could not load user agents:', formatError(error));
    }

    return Array.from(agentMap.values());
  }


  /**
   * Parse agent markdown file
   *
   * @param content - File content
   * @param agentName - Agent name
   * @returns Parsed agent data
   */
  private parseAgentFile(content: string, agentName: string): AgentData | null {
    try {
      // Simple frontmatter parser
      const frontmatterMatch = content.match(/^---\n([\s\S]+?)\n---\n([\s\S]+)$/);

      if (!frontmatterMatch) {
        return null;
      }

      const frontmatter = frontmatterMatch[1];
      const body = frontmatterMatch[2];

      if (!frontmatter || !body) {
        return null;
      }

      const metadata: Record<string, any> = {};

      // Parse YAML-style frontmatter
      frontmatter.split('\n').forEach(line => {
        const match = line.match(/^(\w+):\s*(.+)$/);
        if (match) {
          const key = match[1];
          const value = match[2];
          if (key && value) {
            // Handle JSON arrays (for tools field)
            if (value.trim().startsWith('[')) {
              try {
                metadata[key] = JSON.parse(value);
              } catch {
                // If JSON parse fails, treat as string
                metadata[key] = value.replace(/^["']|["']$/g, '');
              }
            } else {
              // Remove quotes from simple values
              metadata[key] = value.replace(/^["']|["']$/g, '');
            }
          }
        }
      });

      return {
        name: metadata.name || agentName,
        description: metadata.description || '',
        system_prompt: body.trim(),
        model: metadata.model,
        temperature: metadata.temperature ? parseFloat(metadata.temperature) : undefined,
        reasoning_effort: metadata.reasoning_effort,
        tools: metadata.tools, // Array of tool names or undefined
        created_at: metadata.created_at,
        updated_at: metadata.updated_at,
      };
    } catch {
      return null;
    }
  }

  /**
   * Format agent data as markdown file
   *
   * @param agent - Agent data
   * @returns Formatted markdown content
   */
  private formatAgentFile(agent: AgentData): string {
    const lines: string[] = ['---'];

    lines.push(`name: "${agent.name}"`);
    lines.push(`description: "${agent.description}"`);

    if (agent.model) {
      lines.push(`model: "${agent.model}"`);
    }

    if (agent.temperature !== undefined) {
      lines.push(`temperature: ${agent.temperature}`);
    }

    if (agent.reasoning_effort) {
      lines.push(`reasoning_effort: "${agent.reasoning_effort}"`);
    }

    if (agent.tools !== undefined) {
      // Write tools as JSON array
      lines.push(`tools: ${JSON.stringify(agent.tools)}`);
    }

    lines.push(`created_at: "${agent.created_at || new Date().toISOString()}"`);
    lines.push(`updated_at: "${new Date().toISOString()}"`);

    lines.push('---');
    lines.push('');
    lines.push(agent.system_prompt);

    return lines.join('\n');
  }

  /**
   * Get agent information formatted for system prompt
   *
   * @returns Formatted string describing available agents
   */
  async getAgentsForSystemPrompt(): Promise<string> {
    const agents = await this.listAgents();

    if (agents.length === 0) {
      return 'No specialized agents available.';
    }

    const descriptions = agents.map(agent => `- **${agent.name}**: ${agent.description}`);

    return `**Available Agents:**
${descriptions.join('\n')}

Use the 'agent' tool to delegate tasks to specialized agents when their expertise matches the task requirements.`;
  }
}
