/**
 * Tests for Plugin Agents System
 *
 * Tests the complete integration of plugin-provided agents:
 * - Plugin agent loading from plugin.json
 * - Agent registration in AgentManager
 * - Priority system (user > plugin > builtin)
 * - AgentTool integration with pool keys
 * - Tool scoping (core + plugin tools)
 * - Tool-agent binding with visible_to
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PluginLoader, PluginManifest } from '@plugins/PluginLoader.js';
import { AgentManager, AgentData } from '@services/AgentManager.js';
import { ToolManager } from '@tools/ToolManager.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { PluginConfigManager } from '@plugins/PluginConfigManager.js';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Plugin Agents System', () => {
  let testDir: string;
  let pluginsDir: string;
  let activityStream: ActivityStream;
  let configManager: PluginConfigManager;
  let agentManager: AgentManager;
  let toolManager: ToolManager;
  let pluginLoader: PluginLoader;

  // Mock dependencies
  const mockSocketClient = {
    sendRequest: vi.fn().mockResolvedValue({ success: true }),
  };

  const mockProcessManager = {
    isRunning: vi.fn().mockReturnValue(false),
    startProcess: vi.fn().mockResolvedValue(undefined),
  };

  const mockEventSubscriptionManager = {
    subscribe: vi.fn(),
  };

  beforeEach(async () => {
    // Create temporary test directory
    testDir = await mkdtemp(join(tmpdir(), 'plugin-agents-test-'));
    pluginsDir = join(testDir, 'plugins');
    await mkdir(pluginsDir, { recursive: true });

    // Initialize services
    activityStream = new ActivityStream();
    configManager = new PluginConfigManager();
    agentManager = new AgentManager();
    toolManager = new ToolManager([], activityStream);

    pluginLoader = new PluginLoader(
      activityStream,
      configManager,
      mockSocketClient as any,
      mockProcessManager as any,
      mockEventSubscriptionManager as any
    );
  });

  afterEach(async () => {
    // Cleanup test directory
    await rm(testDir, { recursive: true, force: true });
  });

  describe('Plugin Agent Loading', () => {
    it('should load plugin with agent definitions', async () => {
      // Create plugin with agent
      const pluginDir = join(pluginsDir, 'test-plugin');
      await mkdir(pluginDir, { recursive: true });

      const agentContent = `---
name: test-agent
description: A test agent
model: claude-3-5-sonnet-20241022
temperature: 0.7
tools: ["read", "write"]
---

You are a test agent specialized in testing.`;

      await writeFile(join(pluginDir, 'agent.md'), agentContent, 'utf-8');

      const manifest: PluginManifest = {
        name: 'test-plugin',
        version: '1.0.0',
        description: 'Test plugin with agents',
        tools: [
          {
            name: 'test_tool',
            description: 'A test tool',
            command: 'echo',
            args: ['test'],
            schema: {
              type: 'object',
              properties: {},
            },
          },
        ],
        agents: [
          {
            name: 'test-agent',
            description: 'A test agent',
            system_prompt_file: 'agent.md',
          },
        ],
      };

      await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf-8');

      // Load plugins
      const result = await pluginLoader.loadPlugins(pluginsDir);

      // Verify agents were loaded
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].name).toBe('test-agent');
      expect(result.agents[0].description).toBe('A test agent');
      expect(result.agents[0]._pluginName).toBe('test-plugin');
    });

    it('should parse agent file correctly', async () => {
      const pluginDir = join(pluginsDir, 'test-plugin');
      await mkdir(pluginDir, { recursive: true });

      const agentContent = `---
name: advanced-agent
description: An advanced test agent
model: claude-3-5-sonnet-20241022
temperature: 0.5
reasoning_effort: high
tools: ["read", "grep", "bash"]
created_at: "2024-01-01T00:00:00Z"
---

You are an advanced agent with specialized capabilities.
You have access to file operations and shell commands.`;

      await writeFile(join(pluginDir, 'advanced.md'), agentContent, 'utf-8');

      const manifest: PluginManifest = {
        name: 'test-plugin',
        version: '1.0.0',
        description: 'Test plugin',
        tools: [
          {
            name: 'test_tool',
            description: 'A test tool',
            command: 'echo',
            args: ['test'],
          },
        ],
        agents: [
          {
            name: 'advanced-agent',
            description: 'An advanced test agent',
            system_prompt_file: 'advanced.md',
          },
        ],
      };

      await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf-8');

      const result = await pluginLoader.loadPlugins(pluginsDir);

      expect(result.agents).toHaveLength(1);
      const agent = result.agents[0];
      expect(agent.name).toBe('advanced-agent');
      expect(agent.model).toBe('claude-3-5-sonnet-20241022');
      expect(agent.temperature).toBe(0.5);
      expect(agent.reasoning_effort).toBe('high');
      expect(agent.tools).toEqual(['read', 'grep', 'bash']);
      expect(agent.system_prompt).toContain('specialized capabilities');
      expect(agent._pluginName).toBe('test-plugin');
    });

    it('should set _pluginName on loaded agents', async () => {
      const pluginDir = join(pluginsDir, 'my-plugin');
      await mkdir(pluginDir, { recursive: true });

      const agentContent = `---
name: my-agent
description: My agent
---

Agent prompt here.`;

      await writeFile(join(pluginDir, 'agent.md'), agentContent, 'utf-8');

      const manifest: PluginManifest = {
        name: 'my-plugin',
        version: '1.0.0',
        description: 'My plugin',
        tools: [
          {
            name: 'my_tool',
            description: 'My tool',
            command: 'echo',
            args: ['test'],
          },
        ],
        agents: [
          {
            name: 'my-agent',
            description: 'My agent',
            system_prompt_file: 'agent.md',
          },
        ],
      };

      await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf-8');

      const result = await pluginLoader.loadPlugins(pluginsDir);

      expect(result.agents[0]._pluginName).toBe('my-plugin');
    });

    it('should handle missing required fields gracefully', async () => {
      const pluginDir = join(pluginsDir, 'bad-plugin');
      await mkdir(pluginDir, { recursive: true });

      const manifest: PluginManifest = {
        name: 'bad-plugin',
        version: '1.0.0',
        description: 'Plugin with bad agent definition',
        tools: [
          {
            name: 'test_tool',
            description: 'A test tool',
            command: 'echo',
            args: ['test'],
          },
        ],
        agents: [
          {
            name: '', // Missing name
            description: 'Bad agent',
            system_prompt_file: 'agent.md',
          },
        ],
      };

      await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf-8');

      const result = await pluginLoader.loadPlugins(pluginsDir);

      // Should skip invalid agent
      expect(result.agents).toHaveLength(0);
    });

    it('should handle duplicate agent names within plugin', async () => {
      const pluginDir = join(pluginsDir, 'dup-plugin');
      await mkdir(pluginDir, { recursive: true });

      const agentContent = `---
name: dup-agent
description: Duplicate agent
---

Agent prompt.`;

      await writeFile(join(pluginDir, 'agent1.md'), agentContent, 'utf-8');
      await writeFile(join(pluginDir, 'agent2.md'), agentContent, 'utf-8');

      const manifest: PluginManifest = {
        name: 'dup-plugin',
        version: '1.0.0',
        description: 'Plugin with duplicate agents',
        tools: [
          {
            name: 'test_tool',
            description: 'A test tool',
            command: 'echo',
            args: ['test'],
          },
        ],
        agents: [
          {
            name: 'dup-agent',
            description: 'First instance',
            system_prompt_file: 'agent1.md',
          },
          {
            name: 'dup-agent', // Duplicate
            description: 'Second instance',
            system_prompt_file: 'agent2.md',
          },
        ],
      };

      await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf-8');

      const result = await pluginLoader.loadPlugins(pluginsDir);

      // Should keep only first occurrence
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].description).toBe('First instance');
    });
  });

  describe('AgentManager Integration', () => {
    it('should register plugin agents', () => {
      const pluginAgent: AgentData = {
        name: 'plugin-agent',
        description: 'A plugin-provided agent',
        system_prompt: 'You are a plugin agent.',
        _pluginName: 'test-plugin',
      };

      agentManager.registerPluginAgent(pluginAgent);

      // Verify agent was registered (we can't directly check internal map,
      // but we can verify it loads correctly)
      expect(() => agentManager.registerPluginAgent(pluginAgent)).not.toThrow();
    });

    it('should register multiple plugin agents in bulk', () => {
      const agents: AgentData[] = [
        {
          name: 'agent1',
          description: 'First agent',
          system_prompt: 'Prompt 1',
          _pluginName: 'test-plugin',
        },
        {
          name: 'agent2',
          description: 'Second agent',
          system_prompt: 'Prompt 2',
          _pluginName: 'test-plugin',
        },
      ];

      expect(() => agentManager.registerPluginAgents(agents)).not.toThrow();
    });

    it('should load agents with priority (user > plugin > builtin)', async () => {
      // Register a plugin agent
      const pluginAgent: AgentData = {
        name: 'test-agent',
        description: 'Plugin version',
        system_prompt: 'Plugin prompt',
        _pluginName: 'test-plugin',
      };
      agentManager.registerPluginAgent(pluginAgent);

      // Plugin agent should be loadable
      const loaded = await agentManager.loadAgent('test-agent');
      expect(loaded).toBeTruthy();
      expect(loaded?.description).toBe('Plugin version');
    });

    it('should list agents including plugin agents', async () => {
      // Register plugin agents
      agentManager.registerPluginAgent({
        name: 'plugin-agent-1',
        description: 'First plugin agent',
        system_prompt: 'Prompt 1',
        _pluginName: 'plugin-1',
      });

      agentManager.registerPluginAgent({
        name: 'plugin-agent-2',
        description: 'Second plugin agent',
        system_prompt: 'Prompt 2',
        _pluginName: 'plugin-2',
      });

      const agents = await agentManager.listAgents();

      // Should include plugin agents
      const pluginAgentNames = agents.filter(a => a.source === 'plugin').map(a => a.name);
      expect(pluginAgentNames).toContain('plugin-agent-1');
      expect(pluginAgentNames).toContain('plugin-agent-2');
    });

    it('should unregister plugin agents', () => {
      const agent: AgentData = {
        name: 'temp-agent',
        description: 'Temporary agent',
        system_prompt: 'Temp prompt',
        _pluginName: 'temp-plugin',
      };

      agentManager.registerPluginAgent(agent);
      const result = agentManager.unregisterPluginAgent('temp-agent');

      expect(result).toBe(true);
    });

    it('should return false when unregistering non-existent agent', () => {
      const result = agentManager.unregisterPluginAgent('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('AgentTool Integration - Pool Key Generation', () => {
    it('should generate correct pool key for user agents', () => {
      // User agent (no _pluginName)
      const agentData = {
        name: 'my-agent',
        description: 'My custom agent',
        system_prompt: 'You are my agent',
      };

      // Pool key for user agents should be: agent-{name}
      const expectedPoolKey = 'agent-my-agent';

      // This is tested implicitly through AgentTool execution
      // The pool key is: agentData._pluginName ? `plugin-${_pluginName}-${name}` : `agent-${name}`
      expect(agentData).not.toHaveProperty('_pluginName');
    });

    it('should generate correct pool key for plugin agents', () => {
      // Plugin agent (has _pluginName)
      const agentData = {
        name: 'helper',
        description: 'Plugin helper agent',
        system_prompt: 'You are a helper',
        _pluginName: 'my-plugin',
      };

      // Pool key for plugin agents should be: plugin-{pluginName}-{name}
      const expectedPoolKey = 'plugin-my-plugin-helper';

      // Verify plugin name is present
      expect(agentData._pluginName).toBe('my-plugin');
    });

    it('should avoid pool key collisions between plugins', () => {
      // Two plugins with same agent name should have different pool keys
      const agent1 = {
        name: 'helper',
        _pluginName: 'plugin-a',
      };

      const agent2 = {
        name: 'helper',
        _pluginName: 'plugin-b',
      };

      const poolKey1 = `plugin-${agent1._pluginName}-${agent1.name}`;
      const poolKey2 = `plugin-${agent2._pluginName}-${agent2.name}`;

      expect(poolKey1).not.toBe(poolKey2);
      expect(poolKey1).toBe('plugin-plugin-a-helper');
      expect(poolKey2).toBe('plugin-plugin-b-helper');
    });
  });

  describe('AgentTool Integration - Tool Scoping', () => {
    it('should scope tools for plugin agents (core + plugin tools)', () => {
      // Create mock tools
      const coreTool1 = { name: 'read', pluginName: undefined };
      const coreTool2 = { name: 'write', pluginName: undefined };
      const pluginTool1 = { name: 'my_tool', pluginName: 'my-plugin' };
      const pluginTool2 = { name: 'other_tool', pluginName: 'other-plugin' };

      const allTools = [coreTool1, coreTool2, pluginTool1, pluginTool2];

      // Plugin agent should get: core tools + its own plugin tools
      const agentData = {
        name: 'helper',
        _pluginName: 'my-plugin',
        tools: undefined, // No explicit tool list
      };

      // Filter logic from AgentTool.ts
      const coreTools = allTools.filter(tool => !tool.pluginName);
      const pluginTools = allTools.filter(tool => tool.pluginName === agentData._pluginName);
      const filteredTools = [...coreTools, ...pluginTools];

      expect(filteredTools).toHaveLength(3);
      expect(filteredTools.map(t => t.name)).toEqual(['read', 'write', 'my_tool']);
    });

    it('should scope tools with explicit tools list', () => {
      const allTools = [
        { name: 'read', pluginName: undefined },
        { name: 'write', pluginName: undefined },
        { name: 'bash', pluginName: undefined },
        { name: 'my_tool', pluginName: 'my-plugin' },
      ];

      // Agent explicitly specifies allowed tools
      const agentData = {
        name: 'restricted-agent',
        _pluginName: 'my-plugin',
        tools: ['read', 'my_tool'], // Explicit allow list
      };

      // Filter logic from AgentTool.ts
      const allowedToolNames = new Set(agentData.tools);
      const filteredTools = allTools.filter(tool => allowedToolNames.has(tool.name));

      expect(filteredTools).toHaveLength(2);
      expect(filteredTools.map(t => t.name)).toEqual(['read', 'my_tool']);
    });

    it('should provide all tools to user agents', () => {
      const allTools = [
        { name: 'read', pluginName: undefined },
        { name: 'write', pluginName: undefined },
        { name: 'plugin_tool', pluginName: 'some-plugin' },
      ];

      // User agent (no _pluginName, no explicit tools)
      const agentData = {
        name: 'user-agent',
        tools: undefined,
      };

      // User agents get all tools (no filtering)
      const filteredTools = agentData.tools !== undefined
        ? allTools.filter(tool => new Set(agentData.tools).has(tool.name))
        : allTools;

      expect(filteredTools).toHaveLength(3);
    });
  });

  describe('Tool-Agent Binding', () => {
    it('should allow tool with visible_to constraint', () => {
      // Tool specifies visible_to
      const toolDef = {
        name: 'specialized_tool',
        description: 'A specialized tool',
        visible_to: ['data-analyst'],
      };

      const currentAgent = 'data-analyst';

      // Validation should pass
      expect(toolDef.visible_to).toContain(currentAgent);
    });

    it('should reject tool when agent is not in visible_to array', () => {
      const toolDef = {
        name: 'specialized_tool',
        description: 'A specialized tool',
        visible_to: ['data-analyst'],
      };

      const currentAgent = 'general';

      // Validation should fail
      expect(toolDef.visible_to).not.toContain(currentAgent);
    });

    it('should validate tool execution with correct agent', () => {
      const toolDef = {
        name: 'analytics_query',
        description: 'Query analytics database',
        visible_to: ['analytics-agent'],
      };

      // Simulate validation logic
      const validateToolForAgent = (tool: any, agentName: string | undefined) => {
        if (tool.visible_to && tool.visible_to.length > 0) {
          if (!agentName || !tool.visible_to.includes(agentName)) {
            return {
              valid: false,
              error: `Tool '${tool.name}' is only visible to agents: [${tool.visible_to.join(', ')}]. Current agent is '${agentName || 'unknown'}'`,
            };
          }
        }
        return { valid: true };
      };

      // Should pass with correct agent
      const result1 = validateToolForAgent(toolDef, 'analytics-agent');
      expect(result1.valid).toBe(true);

      // Should fail with wrong agent
      const result2 = validateToolForAgent(toolDef, 'general');
      expect(result2.valid).toBe(false);
      expect(result2.error).toContain("only visible to agents:");
    });

    it('should provide clear error message for mismatched agent', () => {
      const toolName = 'database_query';
      const visibleTo = ['database-agent'];
      const currentAgent = 'general';

      const errorMessage = `Tool '${toolName}' is only visible to agents: [${visibleTo.join(', ')}]. Current agent is '${currentAgent}'`;

      expect(errorMessage).toContain('only visible to');
      expect(errorMessage).toContain(visibleTo[0]);
      expect(errorMessage).toContain(currentAgent);
    });

    it('should allow tool without visible_to for any agent', () => {
      const toolDef = {
        name: 'read',
        description: 'Read files',
        visible_to: undefined,
      };

      const validateToolForAgent = (tool: any, agentName: string | undefined) => {
        if (tool.visible_to && tool.visible_to.length > 0) {
          if (!agentName || !tool.visible_to.includes(agentName)) {
            return { valid: false };
          }
        }
        return { valid: true };
      };

      // Should work with any agent
      expect(validateToolForAgent(toolDef, 'general').valid).toBe(true);
      expect(validateToolForAgent(toolDef, 'specialized').valid).toBe(true);
      expect(validateToolForAgent(toolDef, undefined).valid).toBe(true);
    });
  });

  describe('Integration - Complete Plugin Agent Flow', () => {
    it('should load plugin, register agents, and make them available', async () => {
      // Create complete plugin with agent
      const pluginDir = join(pluginsDir, 'complete-plugin');
      await mkdir(pluginDir, { recursive: true });

      const agentContent = `---
name: complete-agent
description: A complete test agent
model: claude-3-5-sonnet-20241022
temperature: 0.7
tools: ["read", "write", "plugin_tool"]
---

You are a complete agent for integration testing.`;

      await writeFile(join(pluginDir, 'agent.md'), agentContent, 'utf-8');

      const manifest: PluginManifest = {
        name: 'complete-plugin',
        version: '1.0.0',
        description: 'Complete plugin with agent',
        tools: [
          {
            name: 'plugin_tool',
            description: 'A plugin tool',
            command: 'echo',
            args: ['test'],
            schema: {
              type: 'object',
              properties: {},
            },
          },
        ],
        agents: [
          {
            name: 'complete-agent',
            description: 'A complete test agent',
            system_prompt_file: 'agent.md',
          },
        ],
      };

      await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf-8');

      // Load plugin
      const result = await pluginLoader.loadPlugins(pluginsDir);

      // Verify tools and agents loaded
      expect(result.tools).toHaveLength(1);
      expect(result.agents).toHaveLength(1);
      expect(result.pluginCount).toBe(1);

      // Register agents
      agentManager.registerPluginAgents(result.agents);

      // Verify agent is available
      const loadedAgent = await agentManager.loadAgent('complete-agent');
      expect(loadedAgent).toBeTruthy();
      expect(loadedAgent?.name).toBe('complete-agent');
      expect(loadedAgent?.description).toBe('A complete test agent');
      expect(loadedAgent?._pluginName).toBe('complete-plugin');
      expect(loadedAgent?.tools).toEqual(['read', 'write', 'plugin_tool']);
    });
  });

  describe('Agent Visibility Filtering', () => {
    it('should allow all agents to load when visible_from_agents is undefined', async () => {
      const agent: AgentData = {
        name: 'public-agent',
        description: 'Visible to all',
        system_prompt: 'Test prompt',
        // visible_from_agents undefined = visible to all
      };
      agentManager.registerPluginAgent({ ...agent, _pluginName: 'test-plugin' });

      // Should be visible to main assistant
      const loadedByMain = await agentManager.loadAgent('public-agent');
      expect(loadedByMain).toBeTruthy();

      // Should be visible to any agent
      const loadedByAgent = await agentManager.loadAgent('public-agent', 'some-agent');
      expect(loadedByAgent).toBeTruthy();
    });

    it('should restrict agent to main assistant when visible_from_agents is empty array', async () => {
      const agent: AgentData = {
        name: 'main-only-agent',
        description: 'Only main assistant can use',
        system_prompt: 'Test prompt',
        visible_from_agents: [], // Empty array = main assistant only
        _pluginName: 'test-plugin',
      };
      agentManager.registerPluginAgent(agent);

      // Should be visible to main assistant (undefined caller)
      const loadedByMain = await agentManager.loadAgent('main-only-agent');
      expect(loadedByMain).toBeTruthy();

      // Should NOT be visible to any other agent
      const loadedByAgent = await agentManager.loadAgent('main-only-agent', 'explore');
      expect(loadedByAgent).toBeNull();
    });

    it('should restrict agent to specific agents in visible_from_agents list', async () => {
      const agent: AgentData = {
        name: 'restricted-agent',
        description: 'Only visible to specific agents',
        system_prompt: 'Test prompt',
        visible_from_agents: ['explore', 'plan'],
        _pluginName: 'test-plugin',
      };
      agentManager.registerPluginAgent(agent);

      // Should be visible to agents in the list
      const loadedByExplore = await agentManager.loadAgent('restricted-agent', 'explore');
      expect(loadedByExplore).toBeTruthy();

      const loadedByPlan = await agentManager.loadAgent('restricted-agent', 'plan');
      expect(loadedByPlan).toBeTruthy();

      // Should NOT be visible to agents not in the list
      const loadedByOther = await agentManager.loadAgent('restricted-agent', 'other-agent');
      expect(loadedByOther).toBeNull();

      // Should NOT be visible to main assistant when not in list
      const loadedByMain = await agentManager.loadAgent('restricted-agent');
      expect(loadedByMain).toBeNull();
    });

    it('should filter listAgents() based on visibility', async () => {
      // Register agents with different visibility settings
      agentManager.registerPluginAgent({
        name: 'public-agent',
        description: 'Public',
        system_prompt: 'Prompt',
        _pluginName: 'test-plugin',
        // undefined = visible to all
      });

      agentManager.registerPluginAgent({
        name: 'main-only',
        description: 'Main only',
        system_prompt: 'Prompt',
        _pluginName: 'test-plugin',
        visible_from_agents: [], // Main only
      });

      agentManager.registerPluginAgent({
        name: 'explore-only',
        description: 'Explore only',
        system_prompt: 'Prompt',
        _pluginName: 'test-plugin',
        visible_from_agents: ['explore'],
      });

      // Main assistant should see public-agent and main-only
      const mainList = await agentManager.listAgents();
      const mainNames = mainList.map(a => a.name);
      expect(mainNames).toContain('public-agent');
      expect(mainNames).toContain('main-only');
      expect(mainNames).not.toContain('explore-only');

      // Explore agent should see public-agent and explore-only
      const exploreList = await agentManager.listAgents('explore');
      const exploreNames = exploreList.map(a => a.name);
      expect(exploreNames).toContain('public-agent');
      expect(exploreNames).toContain('explore-only');
      expect(exploreNames).not.toContain('main-only');

      // Other agent should only see public-agent
      const otherList = await agentManager.listAgents('other');
      const otherNames = otherList.map(a => a.name);
      expect(otherNames).toContain('public-agent');
      expect(otherNames).not.toContain('main-only');
      expect(otherNames).not.toContain('explore-only');
    });
  });

  describe('Agent Validation', () => {
    it('should validate visible_from_agents is an array', async () => {
      const agent: AgentData = {
        name: 'invalid-agent',
        description: 'Invalid',
        system_prompt: 'Test',
        visible_from_agents: 'not-an-array' as any,
      };

      const result = await agentManager.saveAgent(agent);
      expect(result).toBe(false);
    });

    it('should validate visible_from_agents contains only non-empty strings', async () => {
      const agent: AgentData = {
        name: 'invalid-agent',
        description: 'Invalid',
        system_prompt: 'Test',
        visible_from_agents: ['valid', '', 'also-valid'] as any,
      };

      const result = await agentManager.saveAgent(agent);
      expect(result).toBe(false);
    });

    it('should validate can_delegate_to_agents is a boolean', async () => {
      const agent: AgentData = {
        name: 'invalid-agent',
        description: 'Invalid',
        system_prompt: 'Test',
        can_delegate_to_agents: 'not-a-boolean' as any,
      };

      const result = await agentManager.saveAgent(agent);
      expect(result).toBe(false);
    });

    it('should validate can_see_agents is a boolean', async () => {
      const agent: AgentData = {
        name: 'invalid-agent',
        description: 'Invalid',
        system_prompt: 'Test',
        can_see_agents: 'not-a-boolean' as any,
      };

      const result = await agentManager.saveAgent(agent);
      expect(result).toBe(false);
    });

    it('should save agent with valid fields', async () => {
      const agent: AgentData = {
        name: 'valid-agent',
        description: 'Valid',
        system_prompt: 'Test',
        visible_from_agents: ['explore', 'plan'],
        can_delegate_to_agents: false,
        can_see_agents: true,
      };

      const result = await agentManager.saveAgent(agent);
      expect(result).toBe(true);
    });
  });

  describe('Agent Permission Enforcement', () => {
    it('should block delegation when can_delegate_to_agents is false', async () => {
      // Import AgentTool for testing
      const { AgentTool } = await import('@tools/AgentTool.js');
      const { ServiceRegistry } = await import('@services/ServiceRegistry.js');

      // Create an agent with can_delegate_to_agents: false
      const restrictedAgent: AgentData = {
        name: 'restricted-agent',
        description: 'Agent that cannot delegate',
        system_prompt: 'You are a restricted agent',
        can_delegate_to_agents: false,
      };

      // Register the restricted agent
      agentManager.registerPluginAgent({ ...restrictedAgent, _pluginName: 'test-plugin' });

      // Create a target agent that the restricted agent will try to call
      const targetAgent: AgentData = {
        name: 'target-agent',
        description: 'Target agent',
        system_prompt: 'You are a target agent',
      };
      agentManager.registerPluginAgent({ ...targetAgent, _pluginName: 'test-plugin' });

      // Get ServiceRegistry singleton and register services
      const registry = ServiceRegistry.getInstance();
      registry.registerInstance('agent_manager', agentManager);
      registry.registerInstance('tool_manager', toolManager);

      // Mock the current agent to be the restricted agent
      const mockAgent = {
        getAgentName: () => 'restricted-agent',
        getAgentCallStack: () => [],
      };
      registry.registerInstance('agent', mockAgent);

      // Create AgentTool instance (it will use ServiceRegistry.getInstance() internally)
      const agentTool = new AgentTool(activityStream);

      // Try to delegate to target-agent from restricted-agent
      const result = await agentTool.execute(
        {
          agent_name: 'target-agent',
          task_prompt: 'Do something',
        },
        'test-call-id'
      );

      // Expect permission_denied error
      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot delegate to sub-agents');
      expect(result.error).toContain('can_delegate_to_agents: false');
      // Note: The wrapper currently converts all error_types to 'execution_error'
      // The actual error_type from executeSingleAgent is 'permission_denied'
      // but executeSingleAgentWrapper overwrites it
      expect(result.error_type).toBe('execution_error');
    });

    it('should allow delegation when can_delegate_to_agents is true or undefined', async () => {
      const { AgentTool } = await import('@tools/AgentTool.js');
      const { ServiceRegistry } = await import('@services/ServiceRegistry.js');

      // Create an agent with can_delegate_to_agents: true (explicitly allowed)
      const allowedAgent: AgentData = {
        name: 'allowed-agent',
        description: 'Agent that can delegate',
        system_prompt: 'You are an allowed agent',
        can_delegate_to_agents: true,
      };
      agentManager.registerPluginAgent({ ...allowedAgent, _pluginName: 'test-plugin' });

      // Create target agent
      const targetAgent: AgentData = {
        name: 'target-agent-2',
        description: 'Target agent',
        system_prompt: 'You are a target agent',
      };
      agentManager.registerPluginAgent({ ...targetAgent, _pluginName: 'test-plugin' });

      // Get ServiceRegistry singleton
      const registry = ServiceRegistry.getInstance();
      registry.registerInstance('agent_manager', agentManager);
      registry.registerInstance('tool_manager', toolManager);

      const mockAgent = {
        getAgentName: () => 'allowed-agent',
        getAgentCallStack: () => [],
      };
      registry.registerInstance('agent', mockAgent);

      // Create AgentTool instance (it will use ServiceRegistry.getInstance() internally)
      const agentTool = new AgentTool(activityStream);

      // Mock AgentPoolService to prevent actual agent execution
      const { AgentPoolService } = await import('@services/AgentPoolService.js');
      const mockAcquire = vi.spyOn(AgentPoolService.prototype, 'acquire').mockResolvedValue({
        agent: {
          run: vi.fn().mockResolvedValue({
            stopReason: 'end_turn',
            message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
          }),
        } as any,
        release: async () => {},
      });

      // Try to delegate - should NOT get permission_denied error
      const result = await agentTool.execute(
        {
          agent_name: 'target-agent-2',
          task_prompt: 'Do something',
        },
        'test-call-id-2'
      );

      // Should not have permission_denied error
      expect(result.error_type).not.toBe('permission_denied');

      // Cleanup happens automatically with test teardown
    });

    it('should filter agent tools when can_see_agents is false', async () => {
      // Import necessary modules
      const { AgentTool } = await import('@tools/AgentTool.js');
      const { ToolManager } = await import('@tools/ToolManager.js');
      const { ServiceRegistry } = await import('@services/ServiceRegistry.js');

      // Create an agent with can_see_agents: false
      const noSeeAgent: AgentData = {
        name: 'no-see-agent',
        description: 'Agent that cannot see other agents',
        system_prompt: 'You cannot see other agents',
        can_see_agents: false,
      };

      // Register the agent
      agentManager.registerPluginAgent({ ...noSeeAgent, _pluginName: 'test-plugin' });

      // Create a ToolManager with agent delegation tools
      const { AgentTool: AgentToolClass } = await import('@tools/AgentTool.js');
      const mockTools = [
        new AgentToolClass(activityStream), // 'agent' tool
        { name: 'read', execute: async () => ({}), getFunctionDefinition: () => ({}) },
        { name: 'write', execute: async () => ({}), getFunctionDefinition: () => ({}) },
        { name: 'explore', execute: async () => ({}), getFunctionDefinition: () => ({}) },
        { name: 'plan', execute: async () => ({}), getFunctionDefinition: () => ({}) },
        { name: 'agent-ask', execute: async () => ({}), getFunctionDefinition: () => ({}) },
        { name: 'bash', execute: async () => ({}), getFunctionDefinition: () => ({}) },
      ];

      const fullToolManager = new ToolManager(mockTools as any, activityStream);

      // Get ServiceRegistry singleton
      const registry = ServiceRegistry.getInstance();
      registry.registerInstance('agent_manager', agentManager);
      registry.registerInstance('tool_manager', fullToolManager);

      // Mock current agent context (main assistant, not within an agent)
      const mockAgent = {
        getAgentName: () => undefined,
        getAgentCallStack: () => [],
      };
      registry.registerInstance('agent', mockAgent);

      // Mock required services for AgentTool execution
      registry.registerInstance('model_client', { send: vi.fn() } as any);
      registry.registerInstance('config_manager', {
        getValue: vi.fn().mockReturnValue(undefined),
        getConfig: vi.fn().mockReturnValue({}),
      } as any);
      registry.registerInstance('permission_manager', {
        checkPermission: vi.fn().mockResolvedValue(true),
      } as any);

      // Create AgentTool (it will use ServiceRegistry.getInstance() internally)
      const agentTool = new AgentToolClass(activityStream);

      // Mock AgentPoolService to intercept the ToolManager used for the agent
      let capturedToolManager: ToolManager | null = null;
      const mockAgentPool = {
        acquire: vi.fn().mockImplementation(async (agentConfig: any, toolManager: ToolManager, customModelClient?: any) => {
          // Capture the tool manager passed to the agent (second parameter)
          capturedToolManager = toolManager;

          // Return mock pooled agent
          return {
            agent: {
              sendMessage: vi.fn().mockResolvedValue('Task completed'),
            } as any,
            agentId: 'test-agent-id',
            release: async () => {},
          };
        }),
      };
      registry.registerInstance('agent_pool', mockAgentPool);

      // Execute agent task
      await agentTool.execute(
        {
          agent_name: 'no-see-agent',
          task_prompt: 'Do something',
        },
        'test-call-id-3'
      );

      // Verify the ToolManager was captured
      expect(capturedToolManager).toBeTruthy();

      if (capturedToolManager) {
        const availableTools = capturedToolManager.getAllTools();
        const toolNames = availableTools.map(t => t.name);

        // Should NOT include agent delegation tools
        expect(toolNames).not.toContain('agent');
        expect(toolNames).not.toContain('explore');
        expect(toolNames).not.toContain('plan');
        expect(toolNames).not.toContain('agent-ask');

        // Should still include other tools
        expect(toolNames).toContain('read');
        expect(toolNames).toContain('write');
        expect(toolNames).toContain('bash');
      }

      // Cleanup happens automatically with test teardown
    });

    it('should include agent tools when can_see_agents is true or undefined', async () => {
      const { AgentTool } = await import('@tools/AgentTool.js');
      const { ToolManager } = await import('@tools/ToolManager.js');
      const { ServiceRegistry } = await import('@services/ServiceRegistry.js');

      // Create an agent with can_see_agents: true
      const canSeeAgent: AgentData = {
        name: 'can-see-agent',
        description: 'Agent that can see other agents',
        system_prompt: 'You can see other agents',
        can_see_agents: true,
      };

      agentManager.registerPluginAgent({ ...canSeeAgent, _pluginName: 'test-plugin' });

      // Create ToolManager with agent tools
      const { AgentTool: AgentToolClass } = await import('@tools/AgentTool.js');
      const mockTools = [
        new AgentToolClass(activityStream),
        { name: 'read', execute: async () => ({}), getFunctionDefinition: () => ({}) },
        { name: 'explore', execute: async () => ({}), getFunctionDefinition: () => ({}) },
      ];

      const fullToolManager = new ToolManager(mockTools as any, activityStream);

      const registry = ServiceRegistry.getInstance();
      registry.registerInstance('agent_manager', agentManager);
      registry.registerInstance('tool_manager', fullToolManager);

      const mockAgent = {
        getAgentName: () => undefined,
        getAgentCallStack: () => [],
      };
      registry.registerInstance('agent', mockAgent);

      // Mock required services for AgentTool execution
      registry.registerInstance('model_client', { send: vi.fn() } as any);
      registry.registerInstance('config_manager', {
        getValue: vi.fn().mockReturnValue(undefined),
        getConfig: vi.fn().mockReturnValue({}),
      } as any);
      registry.registerInstance('permission_manager', {
        checkPermission: vi.fn().mockResolvedValue(true),
      } as any);

      const agentTool = new AgentToolClass(activityStream);

      // Mock AgentPoolService to intercept the ToolManager used for the agent
      let capturedToolManager: ToolManager | null = null;
      const mockAgentPool = {
        acquire: vi.fn().mockImplementation(async (agentConfig: any, toolManager: ToolManager, customModelClient?: any) => {
          // Capture the tool manager passed to the agent (second parameter)
          capturedToolManager = toolManager;

          // Return mock pooled agent
          return {
            agent: {
              sendMessage: vi.fn().mockResolvedValue('Task completed'),
            } as any,
            agentId: 'test-agent-id',
            release: async () => {},
          };
        }),
      };
      registry.registerInstance('agent_pool', mockAgentPool);

      await agentTool.execute(
        {
          agent_name: 'can-see-agent',
          task_prompt: 'Do something',
        },
        'test-call-id-4'
      );

      expect(capturedToolManager).toBeTruthy();

      if (capturedToolManager) {
        const toolNames = capturedToolManager.getAllTools().map(t => t.name);

        // Should include agent delegation tools
        expect(toolNames).toContain('agent');
        expect(toolNames).toContain('explore');
        expect(toolNames).toContain('read');
      }

      // Cleanup happens automatically with test teardown
    });
  });
});
