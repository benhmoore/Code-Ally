/**
 * AgentManager - Agent storage and retrieval
 *
 * Manages specialized agent definitions stored as markdown files.
 * Loads from both built-in agents (dist/agents/) and user agents (~/.ally/profiles/{profile}/agents/).
 * User agents can override built-in agents by using the same name.
 *
 * Profile-aware: Uses profile-specific agents directory via getAgentsDir()
 */

import { readFile, writeFile, readdir, unlink, access } from 'fs/promises';
import { join } from 'path';
import { constants } from 'fs';
import { logger } from './Logger.js';
import { formatError } from '../utils/errorUtils.js';
import { getAgentsDir, BUILTIN_AGENTS_DIR } from '../config/paths.js';
import { ServiceRegistry } from './ServiceRegistry.js';
import { AgentRequirements } from '../agent/RequirementTracker.js';
import { parseFrontmatterYAML, extractFrontmatter } from '../utils/yamlUtils.js';
import { validateAgentName } from '../utils/namingValidation.js';

export interface AgentData {
  name: string;
  description: string;
  system_prompt: string;
  model?: string;
  temperature?: number;
  reasoning_effort?: string; // Reasoning effort: "inherit", "low", "medium", "high". Defaults to "inherit"
  tools?: string[]; // Tool names this agent can use. Empty array = all tools, undefined = all tools
  usage_guidelines?: string; // Optional guidance on when/how to use this agent
  requirements?: AgentRequirements; // Tool call requirements for this agent
  created_at?: string;
  updated_at?: string;
  _pluginName?: string; // Plugin source identifier (only for plugin-provided agents)

  /**
   * List of agent names that can call this agent.
   * - If undefined: agent is visible to all agents (default)
   * - If empty array []: agent is visible to none (only main assistant can use it)
   * - If ["agent1", "agent2"]: only these agents can call this agent
   *
   * @example
   * visible_from_agents: ["explore", "plan"] // Only explore and plan agents can use this
   * visible_from_agents: [] // Only main assistant can use this
   * visible_from_agents: undefined // All agents can use this (default)
   */
  visible_from_agents?: string[];

  /**
   * Whether this agent can delegate to sub-agents.
   * - If undefined: defaults to true (can delegate)
   * - If false: agent cannot spawn sub-agents
   * - If true: agent can spawn sub-agents
   *
   * Useful for restricting delegation chains to prevent infinite recursion
   * or to enforce that certain agents work in isolation.
   *
   * @example
   * can_delegate_to_agents: false // Agent works alone, no delegation
   * can_delegate_to_agents: true // Agent can spawn sub-agents (default)
   */
  can_delegate_to_agents?: boolean;

  /**
   * Whether this agent can see other agents in its tool list.
   * - If undefined: defaults to true (can see agents)
   * - If false: agent cannot see agent/explore/plan tools
   * - If true: agent can see and use agent tools
   *
   * Controls visibility of agent-related tools in the agent's context.
   * When false, the agent operates in isolation without awareness of other agents.
   *
   * @example
   * can_see_agents: false // Agent doesn't see agent/explore/plan tools
   * can_see_agents: true // Agent can see and use agent tools (default)
   */
  can_see_agents?: boolean;
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
  private builtInAgents: Map<string, AgentData> = new Map();

  constructor() {
    // Profile-aware: getAgentsDir() returns profile-specific agents directory
    // This is captured at construction time (launch-time), so profile switching
    // requires application restart
    this.userAgentsDir = getAgentsDir();
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
   * Check if an agent is visible to the calling agent
   *
   * @param agentData - Agent to check visibility for
   * @param callingAgentName - Name of agent requesting access (undefined = main Ally)
   * @returns True if agent is visible to caller, false otherwise
   */
  private isAgentVisibleTo(agentData: AgentData, callingAgentName?: string): boolean {
    // If visible_from_agents is undefined, agent is visible to all
    if (agentData.visible_from_agents === undefined) {
      return true;
    }

    // Empty array means only main assistant can use it
    if (agentData.visible_from_agents.length === 0) {
      if (callingAgentName !== undefined) {
        logger.debug(
          `Agent '${agentData.name}' is only visible to main assistant, not '${callingAgentName}'`
        );
        return false;
      }
      return true;
    }

    // Non-empty array: check if caller is in the list
    if (callingAgentName === undefined || !agentData.visible_from_agents.includes(callingAgentName)) {
      logger.debug(
        `Agent '${agentData.name}' is not visible to '${callingAgentName || 'main'}'`
      );
      return false;
    }

    return true;
  }

  /**
   * Validate agent data fields
   *
   * @param agentData - Agent data to validate
   * @throws Error if validation fails
   */
  private validateAgentData(agentData: AgentData): void {
    // Validate visible_from_agents
    if (agentData.visible_from_agents !== undefined) {
      if (!Array.isArray(agentData.visible_from_agents)) {
        throw new Error(`Agent '${agentData.name}': visible_from_agents must be an array`);
      }
      if (agentData.visible_from_agents.some(name => !name || typeof name !== 'string')) {
        throw new Error(
          `Agent '${agentData.name}': visible_from_agents must contain valid agent names (non-empty strings)`
        );
      }
    }

    // Validate can_delegate_to_agents
    if (
      agentData.can_delegate_to_agents !== undefined &&
      typeof agentData.can_delegate_to_agents !== 'boolean'
    ) {
      throw new Error(`Agent '${agentData.name}': can_delegate_to_agents must be a boolean`);
    }

    // Validate can_see_agents
    if (agentData.can_see_agents !== undefined && typeof agentData.can_see_agents !== 'boolean') {
      throw new Error(`Agent '${agentData.name}': can_see_agents must be a boolean`);
    }
  }

  /**
   * Register a built-in tool-based agent (explore, plan, sessions)
   * These agents are created by tools but should be discoverable like file-based agents
   *
   * @param agentData - Complete agent metadata
   */
  registerBuiltInAgent(agentData: AgentData): void {
    // Validate required fields
    if (!agentData.name || typeof agentData.name !== 'string') {
      throw new Error('Built-in agent must have a valid name');
    }
    if (!agentData.description || typeof agentData.description !== 'string') {
      throw new Error(`Built-in agent '${agentData.name}' must have a valid description`);
    }
    if (!agentData.system_prompt || typeof agentData.system_prompt !== 'string') {
      throw new Error(`Built-in agent '${agentData.name}' must have a valid system_prompt`);
    }

    // Validate visibility fields using existing method
    this.validateAgentData(agentData);

    // Warn if agent name already registered
    if (this.builtInAgents.has(agentData.name)) {
      logger.warn(`Built-in agent '${agentData.name}' is already registered, overwriting`);
    }

    // Store in builtInAgents Map
    this.builtInAgents.set(agentData.name, agentData);
    logger.debug(`Registered built-in tool-agent '${agentData.name}'`);
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

      // Check built-in tool-agents
      if (this.builtInAgents.has(agentName)) {
        return true;
      }

      // Fall back to built-in files
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
   * Priority: user agents (~/.ally/profiles/{profile}/agents/) > plugin agents > built-in agents (dist/agents/)
   *
   * @param agentName - Agent name
   * @param callingAgentName - Optional name of agent requesting to load this agent (undefined = main Ally)
   * @returns Agent data or null if not found or not visible to calling agent
   */
  async loadAgent(agentName: string, callingAgentName?: string): Promise<AgentData | null> {
    // 1. Try user agents first (highest priority)
    const userPath = join(this.userAgentsDir, `${agentName}.md`);
    try {
      const content = await readFile(userPath, 'utf-8');
      logger.debug(`Loaded user agent '${agentName}' from user directory`);
      const agentData = this.parseAgentFile(content, agentName);

      // Check visibility before returning
      if (agentData && !this.isAgentVisibleTo(agentData, callingAgentName)) {
        return null;
      }

      return agentData;
    } catch (error) {
      logger.debug(`Agent '${agentName}' not found in user directory`);
    }

    // 2. Try plugin agents (second priority)
    // Check if plugin agent exists and its plugin is active
    const pluginAgent = this.pluginAgents.get(agentName);
    if (pluginAgent) {
      if (this.isPluginAgentActive(pluginAgent._pluginName)) {
        logger.debug(`Loaded plugin agent '${agentName}' from plugin '${pluginAgent._pluginName}'`);

        // Check visibility before returning
        if (!this.isAgentVisibleTo(pluginAgent, callingAgentName)) {
          return null;
        }

        return pluginAgent;
      } else {
        logger.debug(`Plugin agent '${agentName}' skipped - plugin '${pluginAgent._pluginName}' is not active`);
        // Fall through to check built-in agents
      }
    }

    // 3. Try built-in tool-agents (third priority)
    const builtInAgent = this.builtInAgents.get(agentName);
    if (builtInAgent) {
      // Check visibility before returning
      if (!this.isAgentVisibleTo(builtInAgent, callingAgentName)) {
        return null;
      }
      logger.debug(`Loaded built-in tool-agent '${agentName}'`);
      return builtInAgent;
    }

    // 4. Try built-in agent files (lowest priority)
    const builtinPath = join(this.builtinAgentsDir, `${agentName}.md`);
    try {
      const content = await readFile(builtinPath, 'utf-8');
      logger.debug(`Loaded built-in agent '${agentName}'`);
      const agentData = this.parseAgentFile(content, agentName);

      // Check visibility before returning
      if (agentData && !this.isAgentVisibleTo(agentData, callingAgentName)) {
        return null;
      }

      return agentData;
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
   * @throws Error if agent name is invalid
   */
  async saveAgent(agent: AgentData): Promise<boolean> {
    try {
      // Validate agent name format (kebab-case)
      const nameValidation = validateAgentName(agent.name);
      if (!nameValidation.valid) {
        throw new Error(`Failed to save agent: ${nameValidation.error}`);
      }

      // Validate agent data before saving
      this.validateAgentData(agent);

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
   * Filters plugin agents by activation state and visibility
   *
   * @param callingAgentName - Optional name of agent requesting the list (undefined = main Ally)
   * @returns Array of agent info visible to the caller
   */
  async listAgents(callingAgentName?: string): Promise<AgentInfo[]> {
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

          // Check visibility
          if (agent && this.isAgentVisibleTo(agent, callingAgentName)) {
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
    // Filter by plugin activation state and visibility
    for (const [name, agentData] of this.pluginAgents.entries()) {
      // Skip agents from deactivated plugins
      if (!this.isPluginAgentActive(agentData._pluginName)) {
        logger.debug(`[AgentManager] Filtering out agent '${name}' - plugin '${agentData._pluginName}' is not active`);
        continue;
      }

      // Check visibility
      if (!this.isAgentVisibleTo(agentData, callingAgentName)) {
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

    // 2.5. Load built-in tool-agents (override file-based built-ins, third priority)
    for (const [name, agentData] of this.builtInAgents.entries()) {
      if (!agentMap.has(name)) {
        // Check visibility before adding
        if (this.isAgentVisibleTo(agentData, callingAgentName)) {
          agentMap.set(name, {
            name: agentData.name,
            description: agentData.description,
            file_path: '<built-in-tool>', // Virtual path for tool-based agents
            source: 'builtin',
          });
        }
      }
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

          // Check visibility
          if (agent && this.isAgentVisibleTo(agent, callingAgentName)) {
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
      const extracted = extractFrontmatter(content);
      if (!extracted) {
        return null;
      }

      const { frontmatter, body } = extracted;
      const metadata = parseFrontmatterYAML(frontmatter);

      return {
        name: metadata.name || agentName,
        description: metadata.description || '',
        system_prompt: body.trim(),
        model: metadata.model,
        temperature: metadata.temperature ? parseFloat(metadata.temperature) : undefined,
        reasoning_effort: metadata.reasoning_effort,
        tools: metadata.tools, // Array of tool names or undefined
        usage_guidelines: metadata.usage_guidelines,
        requirements: metadata.requirements, // Agent requirements object
        created_at: metadata.created_at,
        updated_at: metadata.updated_at,
        visible_from_agents: metadata.visible_from_agents, // Array of agent names or undefined
        can_delegate_to_agents: metadata.can_delegate_to_agents, // Boolean or undefined
        can_see_agents: metadata.can_see_agents, // Boolean or undefined
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

    if (agent.requirements) {
      // Write requirements as nested object
      lines.push(`requirements:`);
      const reqs = agent.requirements;
      if (reqs.required_tools_one_of) {
        lines.push(`  required_tools_one_of: ${JSON.stringify(reqs.required_tools_one_of)}`);
      }
      if (reqs.required_tools_all) {
        lines.push(`  required_tools_all: ${JSON.stringify(reqs.required_tools_all)}`);
      }
      if (reqs.minimum_tool_calls !== undefined) {
        lines.push(`  minimum_tool_calls: ${reqs.minimum_tool_calls}`);
      }
      if (reqs.require_tool_use !== undefined) {
        lines.push(`  require_tool_use: ${reqs.require_tool_use}`);
      }
      if (reqs.max_retries !== undefined) {
        lines.push(`  max_retries: ${reqs.max_retries}`);
      }
      if (reqs.reminder_message) {
        lines.push(`  reminder_message: "${reqs.reminder_message}"`);
      }
    }

    if (agent.visible_from_agents !== undefined) {
      // Write visible_from_agents as JSON array
      lines.push(`visible_from_agents: ${JSON.stringify(agent.visible_from_agents)}`);
    }

    if (agent.can_delegate_to_agents !== undefined) {
      lines.push(`can_delegate_to_agents: ${agent.can_delegate_to_agents}`);
    }

    if (agent.can_see_agents !== undefined) {
      lines.push(`can_see_agents: ${agent.can_see_agents}`);
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
   * @param callingAgentName - Optional name of agent requesting the list (for visibility filtering)
   * @returns Formatted string describing available agents
   */
  async getAgentsForSystemPrompt(callingAgentName?: string): Promise<string> {
    const agents = await this.listAgents(callingAgentName);

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
   * @throws Error if _pluginName is not present or if agent name is invalid
   */
  public registerPluginAgent(agentData: AgentData): void {
    // Validate agent name format (kebab-case)
    const nameValidation = validateAgentName(agentData.name);
    if (!nameValidation.valid) {
      throw new Error(`Failed to register plugin agent: ${nameValidation.error}`);
    }

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
