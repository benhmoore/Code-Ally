/**
 * Tests for AgentTool
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentTool } from '../../tools/AgentTool.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { AgentManager } from '../../services/AgentManager.js';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

describe('AgentTool', () => {
  let activityStream: ActivityStream;
  let registry: ServiceRegistry;
  let agentManager: AgentManager;
  let tool: AgentTool;
  let testDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    // Create a temporary directory for testing
    testDir = await mkdtemp(join(tmpdir(), 'agent-test-'));

    // Mock home directory to point to test directory
    originalHome = process.env.HOME;
    process.env.HOME = testDir;

    // Create agents directory
    await mkdir(join(testDir, '.code_ally', 'agents'), { recursive: true });

    activityStream = new ActivityStream();
    registry = ServiceRegistry.getInstance();
    agentManager = new AgentManager();

    // Ensure default agent exists
    await agentManager.ensureDefaultAgent();

    registry.registerInstance('agent_manager', agentManager);

    // Mock LLM client and other services for sub-agent creation
    const mockModelClient = {
      send: vi.fn().mockResolvedValue({
        content: 'Mock agent response',
        tool_calls: [],
        interrupted: false,
        error: null,
      }),
      cancel: vi.fn(),
      close: vi.fn(),
    };

    const mockToolManager = {
      getTools: vi.fn().mockReturnValue([]),
      getFunctionDefinitions: vi.fn().mockReturnValue([]),
      clearCurrentTurn: vi.fn(),
    };

    const mockConfig = {
      model: 'test-model',
      endpoint: 'http://localhost:11434',
      context_size: 4096,
      temperature: 0.1,
      max_tokens: 2048,
      bash_timeout: 5000,
      auto_confirm: false,
      check_context_msg: true,
      parallel_tools: false,
      theme: 'default',
      compact_threshold: 10,
      show_token_usage: true,
      show_context_in_prompt: false,
      tool_result_preview_lines: 3,
      tool_result_preview_enabled: true,
      diff_display_enabled: true,
      diff_display_max_file_size: 1048576,
      diff_display_context_lines: 3,
      diff_display_theme: 'github-dark',
      diff_display_color_removed: 'red',
      diff_display_color_added: 'green',
      diff_display_color_modified: 'yellow',
      tool_result_max_tokens_normal: 1000,
      tool_result_max_tokens_moderate: 750,
      tool_result_max_tokens_aggressive: 500,
      tool_result_max_tokens_critical: 200,
      setup_completed: true,
    };

    registry.registerInstance('llm_client', mockModelClient);
    registry.registerInstance('tool_manager', mockToolManager);
    registry.registerInstance('config', mockConfig);

    tool = new AgentTool(activityStream);
  });

  afterEach(async () => {
    // Restore original home
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    }

    await registry.shutdown();

    // Remove test directory
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('metadata', () => {
    it('should have correct metadata', () => {
      expect(tool.name).toBe('agent');
      expect(tool.requiresConfirmation).toBe(false);
      expect(tool.suppressExecutionAnimation).toBe(true);
    });
  });

  describe('validation', () => {
    it('should reject missing agents parameter', async () => {
      const result = await tool.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('agents parameter is required');
    });

    it('should reject empty agents array', async () => {
      const result = await tool.execute({ agents: [] });

      expect(result.success).toBe(false);
      expect(result.error).toContain('at least one agent spec');
    });

    it('should reject non-array agents parameter', async () => {
      const result = await tool.execute({ agents: 'not an array' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('at least one agent spec');
    });

    it('should reject agent spec without task_prompt', async () => {
      const result = await tool.execute({
        agents: [{ agent_name: 'general' }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('missing required field: task_prompt');
    });

    it('should reject non-string task_prompt', async () => {
      const result = await tool.execute({
        agents: [{ task_prompt: 123 }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('task_prompt must be a string');
    });

    it('should reject non-string agent_name', async () => {
      const result = await tool.execute({
        agents: [{ agent_name: 123, task_prompt: 'Test task' }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('agent_name must be a string');
    });
  });

  describe('execution', () => {
    it('should execute single agent delegation', async () => {
      const result = await tool.execute({
        agents: [
          {
            agent_name: 'general',
            task_prompt: 'Test task for agent',
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.agents_completed).toBe(1);
      expect(result.agents_failed).toBe(0);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].success).toBe(true);
    });

    it('should use default agent when agent_name not specified', async () => {
      const result = await tool.execute({
        agents: [
          {
            task_prompt: 'Test task without agent name',
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.agents_completed).toBe(1);
      expect(result.results[0].agent_name).toBe('general');
    });

    it('should fail when agent does not exist', async () => {
      const result = await tool.execute({
        agents: [
          {
            agent_name: 'nonexistent',
            task_prompt: 'Test task',
          },
        ],
      });

      expect(result.success).toBe(true); // Overall success
      expect(result.agents_completed).toBe(0);
      expect(result.agents_failed).toBe(1);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toContain('not found');
    });

    it('should execute multiple agents concurrently', async () => {
      const result = await tool.execute({
        agents: [
          {
            agent_name: 'general',
            task_prompt: 'First task',
          },
          {
            agent_name: 'general',
            task_prompt: 'Second task',
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.agents_completed).toBe(2);
      expect(result.agents_failed).toBe(0);
      expect(result.results).toHaveLength(2);
    });

    it('should include duration in results', async () => {
      const result = await tool.execute({
        agents: [
          {
            agent_name: 'general',
            task_prompt: 'Test task',
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.results[0].duration_seconds).toBeDefined();
      expect(typeof result.results[0].duration_seconds).toBe('number');
    });
  });

  describe('event emission', () => {
    it('should emit AGENT_START and AGENT_END events', async () => {
      const events: any[] = [];
      activityStream.subscribe('*', (event) => {
        events.push(event);
      });

      await tool.execute({
        agents: [
          {
            agent_name: 'general',
            task_prompt: 'Test task',
          },
        ],
      });

      const startEvents = events.filter((e) => e.type === 'agent_start');
      const endEvents = events.filter((e) => e.type === 'agent_end');

      expect(startEvents.length).toBeGreaterThan(0);
      expect(endEvents.length).toBeGreaterThan(0);
    });
  });
});
