/**
 * Tests for AgentTool
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentTool } from '@tools/AgentTool.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { AgentManager } from '@services/AgentManager.js';
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
    await mkdir(join(testDir, '.ally', 'agents'), { recursive: true });

    activityStream = new ActivityStream();
    registry = ServiceRegistry.getInstance();
    agentManager = new AgentManager();

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
      getAllTools: vi.fn().mockReturnValue([]),
    };

    const mockConfig = {
      model: 'test-model',
      endpoint: 'http://localhost:11434',
      context_size: 4096,
      temperature: 0.1,
      max_tokens: 2048,
      bash_timeout: 5000,
      auto_confirm: false,
      parallel_tools: false,
      theme: 'default',
      compact_threshold: 10,
      show_context_in_prompt: false,
      show_thinking_in_chat: false,
      show_full_tool_output: false,
      diff_display_enabled: true,
      diff_display_max_file_size: 1048576,
      diff_display_context_lines: 3,
      diff_display_theme: 'github-dark',
      diff_display_color_removed: 'red',
      diff_display_color_added: 'green',
      diff_display_color_modified: 'yellow',
      tool_result_max_context_percent: 0.2,
      tool_result_min_tokens: 200,
      setup_completed: true,
      reasoning_effort: undefined,
    };

    const mockConfigManager = {
      getConfig: vi.fn().mockReturnValue(mockConfig),
      getValue: vi.fn().mockImplementation((key: string, defaultValue?: any) => {
        return mockConfig[key as keyof typeof mockConfig] ?? defaultValue;
      }),
    };

    const mockPermissionManager = {
      checkPermission: vi.fn().mockResolvedValue(true),
    };

    // Register with correct service names
    registry.registerInstance('model_client', mockModelClient);
    registry.registerInstance('tool_manager', mockToolManager);
    registry.registerInstance('config_manager', mockConfigManager);
    registry.registerInstance('permission_manager', mockPermissionManager);

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
    it('should reject missing task_prompt parameter', async () => {
      const result = await tool.execute({}, 'test-call-id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('task_prompt');
    });

    it('should reject non-string task_prompt', async () => {
      const result = await tool.execute({
        task_prompt: 123,
      }, 'test-call-id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('must be a string');
    });

    it('should reject non-string agent_name', async () => {
      const result = await tool.execute({
        agent_name: 123,
        task_prompt: 'Test task',
      }, 'test-call-id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('agent_name must be a string');
    });

    it('should reject invalid thoroughness value', async () => {
      const result = await tool.execute({
        task_prompt: 'Test task',
        thoroughness: 'invalid',
      }, 'test-call-id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('thoroughness must be one of');
    });

    it('should reject agent delegation beyond maximum depth', async () => {
      // Mock a parent agent at depth 3 (maximum depth)
      const mockParentAgent = {
        getAgentDepth: vi.fn().mockReturnValue(3),
      };

      registry.registerInstance('agent', mockParentAgent);

      const result = await tool.execute({
        agent_name: 'general',
        task_prompt: 'Test task at excessive depth',
      }, 'test-call-id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('maximum nesting depth');
      expect(result.error).toContain('exceeded');
      expect(result.error_type).toBe('depth_limit_exceeded');
    });

    it('should allow agent delegation at depth 1', async () => {
      // Mock a root agent at depth 0
      const mockRootAgent = {
        getAgentDepth: vi.fn().mockReturnValue(0),
      };

      registry.registerInstance('agent', mockRootAgent);

      const result = await tool.execute({
        agent_name: 'general',
        task_prompt: 'Test task at depth 1',
      }, 'test-call-id');

      expect(result.success).toBe(true);
    });

    it('should allow agent delegation at maximum allowed depth', async () => {
      // Mock a parent agent at depth 2 (so new agent will be at depth 3, which is max)
      const mockParentAgent = {
        getAgentDepth: vi.fn().mockReturnValue(2),
      };

      registry.registerInstance('agent', mockParentAgent);

      const result = await tool.execute({
        agent_name: 'general',
        task_prompt: 'Test task at maximum allowed depth',
      }, 'test-call-id');

      expect(result.success).toBe(true);
    });

    it('should reject self-delegation (agent calling itself)', async () => {
      // Mock an agent trying to call itself
      const mockAgent = {
        getAgentDepth: vi.fn().mockReturnValue(1),
        getAgentName: vi.fn().mockReturnValue('general'),
        getAgentCallStack: vi.fn().mockReturnValue([]),
      };

      registry.registerInstance('agent', mockAgent);

      const result = await tool.execute({
        agent_name: 'general',
        task_prompt: 'Test self-delegation',
      }, 'test-call-id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot delegate to itself');
      expect(result.error_type).toBe('validation_error');
    });

    it('should reject circular delegation (A → B → A)', async () => {
      // Mock an agent with 'general' in its call stack
      const mockAgent = {
        getAgentDepth: vi.fn().mockReturnValue(2),
        getAgentName: vi.fn().mockReturnValue('specialized'),
        getAgentCallStack: vi.fn().mockReturnValue(['general']),
      };

      registry.registerInstance('agent', mockAgent);

      // Try to delegate back to 'general' - should be rejected
      const result = await tool.execute({
        agent_name: 'general',
        task_prompt: 'Test circular delegation',
      }, 'test-call-id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Circular delegation detected');
      expect(result.error).toContain('general → specialized → general');
      expect(result.error_type).toBe('validation_error');
    });

    it('should reject circular delegation (A → B → C → A)', async () => {
      // Mock an agent with a longer call stack
      const mockAgent = {
        getAgentDepth: vi.fn().mockReturnValue(2),
        getAgentName: vi.fn().mockReturnValue('agent-c'),
        getAgentCallStack: vi.fn().mockReturnValue(['agent-a', 'agent-b']),
      };

      registry.registerInstance('agent', mockAgent);

      // Try to delegate back to 'agent-a' - should be rejected
      const result = await tool.execute({
        agent_name: 'agent-a',
        task_prompt: 'Test longer circular delegation',
      }, 'test-call-id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Circular delegation detected');
      expect(result.error).toContain('agent-a → agent-b → agent-c → agent-a');
      expect(result.error_type).toBe('validation_error');
    });

    it('should allow delegation to different agent (no cycle)', async () => {
      // Mock an agent with some agents in call stack
      const mockAgent = {
        getAgentDepth: vi.fn().mockReturnValue(1),
        getAgentName: vi.fn().mockReturnValue('specialized'),
        getAgentCallStack: vi.fn().mockReturnValue([]),
      };

      registry.registerInstance('agent', mockAgent);

      // Delegate to a different agent (general) - should succeed
      const result = await tool.execute({
        agent_name: 'general',
        task_prompt: 'Test valid delegation',
      }, 'test-call-id');

      expect(result.success).toBe(true);
    });
  });

  describe('execution', () => {
    it('should execute single agent delegation', async () => {
      const result = await tool.execute({
        agent_name: 'general',
        task_prompt: 'Test task for agent',
      }, 'test-call-id');

      expect(result.success).toBe(true);
      expect(result.agent_name).toBeDefined();
      expect(result.content).toBeDefined();
    });

    it('should use default agent when agent_name not specified', async () => {
      const result = await tool.execute({
        task_prompt: 'Test task without agent name',
      }, 'test-call-id');

      expect(result.success).toBe(true);
      expect(result.agent_name).toBe('general');
    });

    it('should fail when agent does not exist', async () => {
      const result = await tool.execute({
        agent_name: 'nonexistent',
        task_prompt: 'Test task',
      }, 'test-call-id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });


    it('should include duration in results', async () => {
      const result = await tool.execute({
        agent_name: 'general',
        task_prompt: 'Test task',
      }, 'test-call-id');

      expect(result.success).toBe(true);
      expect(result.duration_seconds).toBeDefined();
      expect(typeof result.duration_seconds).toBe('number');
    });
  });

  describe('event emission', () => {
    it('should emit AGENT_START and AGENT_END events', async () => {
      const events: any[] = [];
      activityStream.subscribe('*', (event) => {
        events.push(event);
      });

      await tool.execute({
        agent_name: 'general',
        task_prompt: 'Test task',
      }, 'test-call-id');

      const startEvents = events.filter((e) => e.type === 'agent_start');
      const endEvents = events.filter((e) => e.type === 'agent_end');

      expect(startEvents.length).toBeGreaterThan(0);
      expect(endEvents.length).toBeGreaterThan(0);
    });
  });
});
