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
import { ServiceRegistry } from './ServiceRegistry.js';

export interface AgentData {
  name: string;
  description: string;
  system_prompt: string;
  model?: string;
  temperature?: number;
  reasoning_effort?: string; // Reasoning effort: "inherit", "low", "medium", "high". Defaults to "inherit"
  tools?: string[]; // Tool names this agent can use. Empty array = all tools, undefined = all tools
  usage_guidelines?: string; // Optional guidance on when/how to use this agent
  created_at?: string;
  updated_at?: string;
  _pluginName?: string; // Plugin source identifier (only for plugin-provided agents)
}

export interface AgentInfo {
  name: string;
  description: string;
  file_path: string;
  source?: 'user' | 'plugin' | 'builtin';
  pluginName?: string; // Plugin name for plugin-provided agents
}

export class AgentManager {
  private readonly userAgentsDir: string;
  private readonly builtinAgentsDir: string;
  private pluginAgents: Map<string, AgentData>;

  constructor() {
    this.userAgentsDir = AGENTS_DIR;
    this.builtinAgentsDir = BUILTIN_AGENTS_DIR;
    this.pluginAgents = new Map<string, AgentData>();
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
   * Check if a plugin agent is active
   *
   * @param pluginName - Plugin name (optional)
   * @returns True if plugin is active, or if not a plugin agent
   */
  private isPluginAgentActive(pluginName?: string): boolean {
    if (!pluginName) return true; // Non-plugin agents are always active

    try {
      const registry = ServiceRegistry.getInstance();
      const activationManager = registry.getPluginActivationManager();
      return activationManager.isActive(pluginName);
    } catch (error) {
      // If PluginActivationManager unavailable, allow all agents
      return true;
    }
  }

  /**
   * Check if an agent exists (in user, plugin, or built-in sources)
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
      // Check plugin agents (only if plugin is active)
      if (this.pluginAgents.has(agentName)) {
        const pluginAgent = this.pluginAgents.get(agentName)!;

        if (this.isPluginAgentActive(pluginAgent._pluginName)) {
          return true;
        }
        // Plugin is deactivated, continue to check built-in
      }

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
   * Priority: user agents (~/.ally/agents/) > plugin agents > built-in agents (dist/agents/)
   *
   * @param agentName - Agent name
   * @returns Agent data or null if not found
   */
  async loadAgent(agentName: string): Promise<AgentData | null> {
    // 1. Try user agents first (highest priority)
    const userPath = join(this.userAgentsDir, `${agentName}.md`);
    try {
      const content = await readFile(userPath, 'utf-8');
      logger.debug(`Loaded user agent '${agentName}' from user directory`);
      return this.parseAgentFile(content, agentName);
    } catch (error) {
      logger.debug(`Agent '${agentName}' not found in user directory`);
    }

    // 2. Try plugin agents (second priority)
    // Check if plugin agent exists and its plugin is active
    const pluginAgent = this.pluginAgents.get(agentName);
    if (pluginAgent) {
      if (this.isPluginAgentActive(pluginAgent._pluginName)) {
        logger.debug(`Loaded plugin agent '${agentName}' from plugin '${pluginAgent._pluginName}'`);
        return pluginAgent;
      } else {
        logger.debug(`Plugin agent '${agentName}' skipped - plugin '${pluginAgent._pluginName}' is not active`);
        // Fall through to check built-in agents
      }
    }

    // 3. Try built-in agents (lowest priority)
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
      logger.error(`Error saving agent ${agent.name}:`, error);
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
   * List all available agents (user + plugin + built-in)
   * Priority: user agents override plugin agents override built-ins with the same name
   * Filters plugin agents by activation state
   *
   * @returns Array of agent info
   */
  async listAgents(): Promise<AgentInfo[]> {
    const agentMap = new Map<string, AgentInfo>();

    // 1. Load built-in agents first (lowest priority)
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
              source: 'builtin',
            });
          }
        } catch {
          continue;
        }
      }
    } catch (error) {
      logger.debug('Could not load built-in agents:', formatError(error));
    }

    // 2. Load plugin agents (override built-in, second priority)
    // Filter by plugin activation state
    for (const [name, agentData] of this.pluginAgents.entries()) {
      // Skip agents from deactivated plugins
      if (!this.isPluginAgentActive(agentData._pluginName)) {
        logger.debug(`[AgentManager] Filtering out agent '${name}' - plugin '${agentData._pluginName}' is not active`);
        continue;
      }

      agentMap.set(name, {
        name: agentData.name,
        description: agentData.description,
        file_path: `<plugin:${agentData._pluginName}>`, // Virtual path for plugin agents
        source: 'plugin',
        pluginName: agentData._pluginName,
      });
    }

    // 3. Load user agents (override all, highest priority)
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
              source: 'user',
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
      const lines = frontmatter.split('\n');
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (!line) {
          i++;
          continue;
        }

        const match = line.match(/^(\w+):\s*(.*)$/);

        if (match) {
          const key = match[1];
          const value = match[2];

          if (key && value !== undefined) {
            // Handle multiline strings (usage_guidelines: |)
            if (value.trim() === '|') {
              const multilineContent: string[] = [];
              i++;
              // Collect indented lines following the |
              while (i < lines.length) {
                const nextLine = lines[i];
                if (!nextLine || (!nextLine.startsWith('  ') && nextLine.trim() !== '')) {
                  break;
                }
                // Remove the indentation (first 2 spaces)
                multilineContent.push(nextLine.replace(/^  /, ''));
                i++;
              }
              metadata[key] = multilineContent.join('\n').trim();
              continue; // Don't increment i again, already done
            }
            // Handle JSON arrays (for tools field)
            else if (value.trim().startsWith('[')) {
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
        i++;
      }

      return {
        name: metadata.name || agentName,
        description: metadata.description || '',
        system_prompt: body.trim(),
        model: metadata.model,
        temperature: metadata.temperature ? parseFloat(metadata.temperature) : undefined,
        reasoning_effort: metadata.reasoning_effort,
        tools: metadata.tools, // Array of tool names or undefined
        usage_guidelines: metadata.usage_guidelines,
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

    if (agent.usage_guidelines) {
      // Write usage_guidelines as multiline string
      lines.push(`usage_guidelines: |`);
      const guidelineLines = agent.usage_guidelines.split('\n');
      guidelineLines.forEach(line => {
        lines.push(`  ${line}`);
      });
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

  /**
   * Get all agent usage guidance strings for injection into system prompt
   *
   * @returns Array of guidance strings from agents that provide them
   */
  async getAgentUsageGuidance(): Promise<string[]> {
    const guidances: string[] = [];

    // Get all available agents (user + plugin + built-in)
    const agents = await this.listAgents();

    for (const agentInfo of agents) {
      // Load the full agent data to get usage_guidelines
      const agentData = await this.loadAgent(agentInfo.name);

      if (agentData && agentData.usage_guidelines) {
        // If agent has a plugin name, prepend it to the first line
        if (agentData._pluginName) {
          // Split guidance into lines to modify the first line
          const lines = agentData.usage_guidelines.split('\n');
          if (lines.length > 0 && lines[0]) {
            // Check if first line starts with "**When to use" pattern
            const firstLine = lines[0];
            const whenMatch = firstLine.match(/^(\*\*When to use [^:]+:\*\*)/);
            if (whenMatch) {
              // Insert plugin attribution after the bold header and add agent name
              lines[0] = `${whenMatch[1]} (agent: ${agentData.name}, plugin: ${agentData._pluginName})`;
            } else {
              // Fallback: just prepend plugin and agent info at the start
              lines[0] = `(agent: ${agentData.name}, plugin: ${agentData._pluginName}) ${firstLine}`;
            }
            guidances.push(lines.join('\n'));
          } else {
            guidances.push(agentData.usage_guidelines);
          }
        } else {
          // Built-in or user agent - prepend agent name for clarity
          const lines = agentData.usage_guidelines.split('\n');
          if (lines.length > 0 && lines[0]) {
            const firstLine = lines[0];
            const whenMatch = firstLine.match(/^(\*\*When to use [^:]+:\*\*)/);
            if (whenMatch) {
              // Insert agent name after the bold header
              lines[0] = `${whenMatch[1]} (agent: ${agentData.name})`;
            } else {
              // Fallback: just prepend agent name at the start
              lines[0] = `(agent: ${agentData.name}) ${firstLine}`;
            }
            guidances.push(lines.join('\n'));
          } else {
            guidances.push(agentData.usage_guidelines);
          }
        }
      }
    }

    return guidances;
  }

  /**
   * Register a single plugin-provided agent
   *
   * @param agentData - Agent data with _pluginName property
   * @throws Error if _pluginName is not present
   */
  public registerPluginAgent(agentData: AgentData): void {
    if (!agentData._pluginName) {
      throw new Error(`Cannot register plugin agent '${agentData.name}': _pluginName is required`);
    }

    this.pluginAgents.set(agentData.name, agentData);
    logger.debug(`Registered plugin agent '${agentData.name}' from plugin '${agentData._pluginName}'`);
  }

  /**
   * Register multiple plugin-provided agents in bulk
   *
   * @param agents - Array of agent data with _pluginName properties
   */
  public registerPluginAgents(agents: AgentData[]): void {
    let successCount = 0;
    let failCount = 0;

    for (const agent of agents) {
      try {
        this.registerPluginAgent(agent);
        successCount++;
      } catch (error) {
        failCount++;
        logger.error(`Failed to register plugin agent '${agent.name}':`, formatError(error));
      }
    }

    logger.debug(`Registered ${successCount} plugin agent(s)${failCount > 0 ? `, ${failCount} failed` : ''}`);
  }

  /**
   * Unregister a plugin-provided agent
   *
   * @param agentName - Name of the agent to unregister
   * @returns True if agent was found and removed
   */
  public unregisterPluginAgent(agentName: string): boolean {
    const agent = this.pluginAgents.get(agentName);

    if (!agent) {
      logger.debug(`Plugin agent '${agentName}' not found for unregistration`);
      return false;
    }

    this.pluginAgents.delete(agentName);
    logger.info(`Unregistered plugin agent '${agentName}' from plugin '${agent._pluginName}'`);
    return true;
  }
}
