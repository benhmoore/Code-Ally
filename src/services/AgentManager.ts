/**
 * AgentManager - Agent storage and retrieval
 *
 * Manages specialized agent definitions stored as markdown files in ~/.code_ally/agents/
 * This is a simplified version focusing on storage/retrieval - agent generation
 * will be added in a future iteration.
 */

import { readFile, writeFile, readdir, unlink, access } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { constants } from 'fs';
import { logger } from './Logger.js';
import { formatError } from '../utils/errorUtils.js';

export interface AgentData {
  name: string;
  description: string;
  system_prompt: string;
  model?: string;
  temperature?: number;
  created_at?: string;
  updated_at?: string;
}

export interface AgentInfo {
  name: string;
  description: string;
  file_path: string;
}

export class AgentManager {
  private readonly agentsDir: string;

  constructor() {
    this.agentsDir = join(homedir(), '.code_ally', 'agents');
  }

  /**
   * Get the agents directory path
   *
   * @returns Agents directory path
   */
  getAgentsDir(): string {
    return this.agentsDir;
  }

  /**
   * Check if an agent exists
   *
   * @param agentName - Agent name
   * @returns True if agent exists
   */
  async agentExists(agentName: string): Promise<boolean> {
    const filePath = join(this.agentsDir, `${agentName}.md`);
    try {
      await access(filePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Load an agent by name
   *
   * @param agentName - Agent name
   * @returns Agent data or null if not found
   */
  async loadAgent(agentName: string): Promise<AgentData | null> {
    const filePath = join(this.agentsDir, `${agentName}.md`);

    try {
      const content = await readFile(filePath, 'utf-8');
      return this.parseAgentFile(content, agentName);
    } catch (error) {
      logger.debug(`Failed to load agent '${agentName}':`, formatError(error));
      return null;
    }
  }

  /**
   * Save an agent to storage
   *
   * @param agent - Agent data
   * @returns True if saved successfully
   */
  async saveAgent(agent: AgentData): Promise<boolean> {
    try {
      // Ensure directory exists
      const { mkdir } = await import('fs/promises');
      await mkdir(this.agentsDir, { recursive: true });

      const filePath = join(this.agentsDir, `${agent.name}.md`);
      const content = this.formatAgentFile(agent);

      await writeFile(filePath, content, 'utf-8');
      return true;
    } catch (error) {
      console.error(`Error saving agent ${agent.name}:`, error);
      return false;
    }
  }

  /**
   * Delete an agent
   *
   * @param agentName - Agent name
   * @returns True if deleted successfully
   */
  async deleteAgent(agentName: string): Promise<boolean> {
    // Prevent deletion of default agent
    if (agentName === 'general') {
      return false;
    }

    const filePath = join(this.agentsDir, `${agentName}.md`);

    try {
      await unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all available agents
   *
   * @returns Array of agent info
   */
  async listAgents(): Promise<AgentInfo[]> {
    try {
      const files = await readdir(this.agentsDir);
      const agentFiles = files.filter(f => f.endsWith('.md'));

      const agents: AgentInfo[] = [];
      for (const file of agentFiles) {
        const agentName = file.replace('.md', '');
        const filePath = join(this.agentsDir, file);

        try {
          const content = await readFile(filePath, 'utf-8');
          const agent = this.parseAgentFile(content, agentName);

          if (agent) {
            agents.push({
              name: agent.name,
              description: agent.description,
              file_path: filePath,
            });
          }
        } catch {
          // Skip files that can't be parsed
          continue;
        }
      }

      return agents;
    } catch {
      return [];
    }
  }

  /**
   * Ensure the default general agent exists
   */
  async ensureDefaultAgent(): Promise<void> {
    if (!(await this.agentExists('general'))) {
      await this.saveAgent({
        name: 'general',
        description: 'General-purpose agent for complex multi-step tasks and codebase exploration',
        system_prompt: this.getDefaultAgentPrompt(),
        created_at: new Date().toISOString(),
      });
    }
  }

  /**
   * Get the default agent system prompt
   *
   * @returns Default system prompt
   */
  private getDefaultAgentPrompt(): string {
    return `You are a general-purpose AI assistant specialized in software development tasks. You excel at:

**Core Capabilities:**
- Complex multi-step analysis and implementation
- Codebase exploration and understanding
- Problem-solving across multiple domains
- Thorough research and investigation

**Working Style:**
- Use multiple tools systematically (aim for 5+ tools minimum per task)
- Be thorough and methodical in your analysis
- Provide detailed explanations of findings and approaches
- Always complete tasks fully rather than stopping prematurely

**Tool Usage:**
- Extensively use search tools (grep, glob) to understand codebases
- Read multiple files to build comprehensive understanding
- Execute tests and verify solutions when applicable
- Make necessary file changes and implementations

**Communication:**
- Summarize your findings and approach clearly
- Explain what was accomplished and any important discoveries
- Provide actionable next steps or recommendations

Continue working until you have thoroughly addressed the task through comprehensive analysis and implementation.`;
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
          // Remove quotes from values
          if (key && value) {
            metadata[key] = value.replace(/^["']|["']$/g, '');
          }
        }
      });

      return {
        name: metadata.name || agentName,
        description: metadata.description || '',
        system_prompt: body.trim(),
        model: metadata.model,
        temperature: metadata.temperature ? parseFloat(metadata.temperature) : undefined,
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
