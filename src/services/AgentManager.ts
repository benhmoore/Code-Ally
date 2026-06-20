/**
 * AgentManager - Agent storage and retrieval
 *
 * Manages specialized agent definitions stored as markdown files.
 * Loads from both built-in agents (dist/agents/) and user agents (~/.ally/profiles/{profile}/agents/).
 * User agents can override built-in agents by using the same name.
 *
 * Profile-aware: Uses profile-specific agents directory via getAgentsDir()
 */

import { readFile, writeFile, readdir, unlink, access, mkdir } from 'fs/promises';
import { join } from 'path';
import { constants } from 'fs';
import { logger } from './Logger.js';
import { formatError } from '../utils/errorUtils.js';
import { getAgentsDir, BUILTIN_AGENTS_DIR } from '../config/paths.js';
import { ServiceRegistry } from './ServiceRegistry.js';
import { serializeAgent, parseAgentContent } from '../utils/agentContentUtils.js';
import { validateAgentName } from '../utils/namingValidation.js';
import { ToolManager } from '../tools/ToolManager.js';
import { BaseTool } from '../tools/BaseTool.js';
import { isAgentDelegationTool, applyLeafDelegationPolicy } from '../config/constants.js';
import type { AgentData, AgentInfo, BaseAgentConfig } from '../types/agents.js';

export class AgentManager {
  private readonly userAgentsDir: string;
  private readonly builtinAgentsDir: string;
  private pluginAgents: Map<string, AgentData>;

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

    // With the marketplace system, installed + enabled plugins are always active
    try {
      const registry = ServiceRegistry.getInstance();
      const pm = registry.get<any>('plugin_manager');
      if (pm) {
        return pm.isPluginEnabled(pluginName);
      }
    } catch {
      // If plugin manager unavailable, allow all agents
    }
    return true;
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
   * Compute the list of allowed tools for an agent based on its configuration
   *
   * This centralizes the tool filtering logic that was previously duplicated
   * between AgentSwitcher and AgentTool.
   *
   * @param agentData - Agent definition with tools, _pluginName, and can_see_agents fields
   * @param toolManager - ToolManager instance for accessing available tools
   * @param allToolNames - Complete list of available tool names (used for can_see_agents filtering
   *                       when agent is unrestricted but should not see agent delegation tools)
   * @returns Array of allowed tool names, or undefined for unrestricted access
   *          - undefined: All tools available (unrestricted)
   *          - []: No tools available (explicitly empty)
   *          - ['tool1', 'tool2']: Only these tools available
   *
   * @public Can be called by AgentSwitcher and AgentTool to centralize tool filtering
   */
  public computeAllowedTools(
    agentData: AgentData,
    toolManager: ToolManager,
    allToolNames: string[],
    agentDepth?: number
  ): string[] | undefined {
    let allowedTools: string[] | undefined;

    // Step 1: Determine base tool list
    if (agentData.tools !== undefined) {
      // Agent explicitly specifies allowed tools (including empty array = no tools)
      allowedTools = agentData.tools;
    } else if (agentData._pluginName) {
      // Plugin agent with no explicit tool list: compute plugin tools (core tools + plugin's tools)
      const allTools: BaseTool[] = toolManager.getAllTools();
      const coreTools = allTools.filter(tool => !tool.pluginName);
      const pluginTools = allTools.filter(tool => tool.pluginName === agentData._pluginName);
      const filteredTools = [...coreTools, ...pluginTools];
      allowedTools = filteredTools.map(t => t.name);
    } else {
      // User agent with no explicit tool list: unrestricted access
      allowedTools = undefined;
    }

    // Step 2: Apply can_see_agents filtering. Removing delegation tools from an
    // unrestricted agent first materializes the full tool list, then filters it.
    if (agentData.can_see_agents === false) {
      const base = allowedTools ?? allToolNames;
      allowedTools = base.filter(toolName => !isAgentDelegationTool(toolName));
    }

    // Step 3: Single-level delegation. A sub-agent (depth >= 1) is a leaf and cannot
    // delegate further, so strip delegation tools regardless of its declared tools.
    if (agentDepth !== undefined && agentDepth >= 1) {
      allowedTools = applyLeafDelegationPolicy(allowedTools ?? allToolNames, agentDepth);
    }

    return allowedTools;
  }

  /**
   * Build base agent configuration from agent data
   *
   * Extracts the common configuration fields needed by all agent instantiation
   * contexts. Callers should spread this into their full AgentConfig and add
   * context-specific fields.
   *
   * @param agentData - Loaded agent definition
   * @param agentType - Agent type identifier (e.g., 'explore', 'my-custom-agent')
   * @param toolManager - Tool manager for computing allowed tools
   * @returns Base configuration ready to be extended
   *
   * @example
   * ```typescript
   * const base = agentManager.buildBaseConfig(agentData, 'my-agent', toolManager);
   * const fullConfig: AgentConfig = {
   *   ...base,
   *   config: appConfig,
   *   isSpecializedAgent: false,
   *   allowTodoManagement: true,
   *   agentDepth: 0,
   *   agentCallStack: [],
   * };
   * ```
   */
  public buildBaseConfig(
    agentData: AgentData,
    agentType: string,
    toolManager: ToolManager,
    agentDepth?: number
  ): BaseAgentConfig {
    const allToolNames = toolManager.getAllTools().map(t => t.name);
    const allowedTools = this.computeAllowedTools(agentData, toolManager, allToolNames, agentDepth);

    return {
      baseAgentPrompt: agentData.system_prompt,
      taskPrompt: agentData.description,
      allowedTools,
      agentType,
      requirements: agentData.requirements,
    };
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

    // 3. Try built-in agent files (lowest priority)
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
   * Resolve the on-disk path of a user agent file.
   *
   * @param agentName - Agent name (without extension)
   * @returns Absolute path to the user agent markdown file
   */
  getAgentFilePath(agentName: string): string {
    return join(this.userAgentsDir, `${agentName}.md`);
  }

  /**
   * Read the raw markdown content of a user agent file.
   *
   * Returns the unparsed file contents so callers (e.g. the agent CRUD tools)
   * can capture undo patches and read state. Only the user directory is
   * consulted — built-in and plugin agents are not editable.
   *
   * @param agentName - Agent name
   * @returns Raw file content, or null if the user agent does not exist
   */
  async readUserAgentFile(agentName: string): Promise<string | null> {
    try {
      return await readFile(this.getAgentFilePath(agentName), 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Serialize and write an agent definition to user storage.
   *
   * This is the single writer for agent files; {@link saveAgent} and the agent
   * CRUD tools all funnel through it. Returns the path and serialized content so
   * callers can record undo patches and read state.
   *
   * @param agent - Agent data to persist
   * @returns The file path written and the serialized content
   * @throws Error if the agent name or data is invalid
   */
  async writeAgentFile(agent: AgentData): Promise<{ filePath: string; content: string }> {
    const nameValidation = validateAgentName(agent.name);
    if (!nameValidation.valid) {
      throw new Error(`Failed to save agent: ${nameValidation.error}`);
    }
    this.validateAgentData(agent);

    await mkdir(this.userAgentsDir, { recursive: true });

    const filePath = this.getAgentFilePath(agent.name);
    const content = serializeAgent(agent);
    await writeFile(filePath, content, 'utf-8');

    return { filePath, content };
  }

  /**
   * Save an agent to user storage.
   *
   * @param agent - Agent data
   * @returns True if saved successfully
   */
  async saveAgent(agent: AgentData): Promise<boolean> {
    try {
      await this.writeAgentFile(agent);
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
    try {
      await unlink(this.getAgentFilePath(agentName));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all user agents with their full parsed definitions.
   *
   * Unlike {@link listAgents} (which returns lightweight summaries across all
   * sources), this returns the complete {@link AgentData} for every editable
   * user agent — the set the manage-agents tooling operates on. Files that fail
   * to parse are skipped with a warning.
   *
   * @returns Array of user agent definitions, sorted by name
   */
  async listUserAgents(): Promise<AgentData[]> {
    let files: string[];
    try {
      files = await readdir(this.userAgentsDir);
    } catch {
      return [];
    }

    const agents: AgentData[] = [];
    for (const file of files.filter(f => f.endsWith('.md'))) {
      const agentName = file.replace(/\.md$/, '');
      const content = await this.readUserAgentFile(agentName);
      if (content === null) continue;
      try {
        agents.push(parseAgentContent(content, agentName));
      } catch (error) {
        logger.warn(`Failed to parse user agent '${agentName}': ${formatError(error)}`);
      }
    }

    agents.sort((a, b) => a.name.localeCompare(b.name));
    return agents;
  }

  /**
   * List all available agents (user + plugin + built-in)
   * Priority: user agents override plugin agents override built-ins with the same name
   * Filters plugin agents by activation state and visibility
   *
   * @param callingAgentName - Optional name of agent requesting the list (undefined = main Ally)
   * @param options - Optional settings for listing behavior
   * @param options.includeInactivePlugins - If true, include agents from inactive plugins (default: false)
   * @returns Array of agent info visible to the caller
   */
  async listAgents(callingAgentName?: string, options?: { includeInactivePlugins?: boolean }): Promise<AgentInfo[]> {
    const includeInactive = options?.includeInactivePlugins ?? false;
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
    // Filter by plugin activation state (unless includeInactive) and visibility
    for (const [name, agentData] of this.pluginAgents.entries()) {
      // Skip agents from deactivated plugins (unless includeInactive is true)
      const isActive = this.isPluginAgentActive(agentData._pluginName);
      if (!isActive && !includeInactive) {
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
        isInactive: !isActive, // Mark inactive plugin agents
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
   * Parse agent markdown file.
   *
   * Thin lenient wrapper over the shared {@link parseAgentContent} serializer:
   * returns null instead of throwing so a single malformed agent file never
   * breaks discovery/loading of the rest.
   *
   * @param content - File content
   * @param agentName - Fallback name when frontmatter omits `name`
   * @returns Parsed agent data, or null if the file is malformed
   */
  private parseAgentFile(content: string, agentName: string): AgentData | null {
    try {
      return parseAgentContent(content, agentName);
    } catch (error) {
      logger.debug(`Failed to parse agent '${agentName}':`, formatError(error));
      return null;
    }
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
   * Discover and register all agents shipped by a plugin.
   *
   * Mirrors {@link SkillManager.loadPluginSkills}: scans `<installPath>/agents/`
   * for `*.md` definitions, parses each, tags it with the plugin name, and
   * registers it. Plugins without an `agents/` directory are silently ignored;
   * individual files that fail to parse are skipped with a warning so one bad
   * file never blocks the rest.
   *
   * @param installPath - Plugin installation directory
   * @param pluginName - Owning plugin name (used for provenance and activation)
   */
  public async loadPluginAgents(installPath: string, pluginName: string): Promise<void> {
    const agentsDir = join(installPath, 'agents');

    let files: string[];
    try {
      files = await readdir(agentsDir);
    } catch {
      return; // Plugin ships no agents
    }

    for (const file of files.filter(f => f.endsWith('.md'))) {
      const agentName = file.replace(/\.md$/, '');
      try {
        const content = await readFile(join(agentsDir, file), 'utf-8');
        const agent = parseAgentContent(content, agentName);
        agent._pluginName = pluginName;
        this.registerPluginAgent(agent);
        logger.debug(`[AgentManager] Loaded plugin agent '${agent.name}' from '${pluginName}'`);
      } catch (error) {
        logger.warn(`[AgentManager] Failed to load plugin agent '${agentName}' from '${pluginName}': ${formatError(error)}`);
      }
    }
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
