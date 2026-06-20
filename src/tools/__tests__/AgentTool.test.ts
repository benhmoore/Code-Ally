/**
 * Tests for AgentTool
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentTool } from '@tools/AgentTool.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { AgentManager } from '@services/AgentManager.js';
import { AGENT_CONFIG } from '@config/constants.js';
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
      show_tool_parameters_in_chat: false,
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

    // Mock AgentPoolService
    const mockAgentPool = {
      acquire: vi.fn().mockImplementation(async () => {
        // Return mock pooled agent
        return {
          agent: {
            sendMessage: vi.fn().mockResolvedValue('Agent task completed successfully'),
            getTokenManager: vi.fn().mockReturnValue({
              getContextUsagePercentage: () => 0,
            }),
            getToolUseCount: vi.fn().mockReturnValue(0),
          },
          agentId: 'test-agent-id',
          release: async () => {},
        };
      }),
    };

    // Register with correct service names
    registry.registerInstance('model_client', mockModelClient);
    registry.registerInstance('tool_manager', mockToolManager);
    registry.registerInstance('config_manager', mockConfigManager);
    registry.registerInstance('permission_manager', mockPermissionManager);
    registry.registerInstance('agent_pool', mockAgentPool);

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

    it('should reject non-string agent parameter', async () => {
      const result = await tool.execute({
        agent_type: 123,
        task_prompt: 'Test task',
      }, 'test-call-id');

      expect(result.success).toBe(false);
      // The error occurs when trying to call .trim() on a number
      expect(result.error).toContain('trim is not a function');
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
      // Mock a parent agent at maximum depth
      const mockParentAgent = {
        getAgentDepth: vi.fn().mockReturnValue(AGENT_CONFIG.MAX_AGENT_DEPTH),
      };

      registry.registerInstance('agent', mockParentAgent);

      const result = await tool.execute({
        agent_type: 'task',
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
        agent_type: 'task',
        task_prompt: 'Test task at depth 1',
        run_in_background: false,
      }, 'test-call-id');

      expect(result.success).toBe(true);
    });

    it('should reject delegation from a sub-agent (single-level delegation)', async () => {
      // Single-level delegation: a sub-agent (depth >= 1) is a leaf and cannot
      // delegate further, so newDepth would exceed MAX_AGENT_DEPTH (1). This is the
      // hard backstop behind stripping delegation tools and the agent roster from
      // sub-agent prompts.
      const mockSubAgent = {
        getAgentDepth: vi.fn().mockReturnValue(1),
        getAgentName: vi.fn().mockReturnValue('task'),
        getAgentCallStack: vi.fn().mockReturnValue([]),
      };

      registry.registerInstance('agent', mockSubAgent);

      const result = await tool.execute({
        agent_type: 'task',
        task_prompt: 'Sub-agent attempting to delegate',
        run_in_background: false,
      }, 'test-call-id');

      expect(result.success).toBe(false);
      expect(result.error_type).toBe('depth_limit_exceeded');
    });
  });

  describe('execution', () => {
    it('should execute single agent delegation', async () => {
      const result = await tool.execute({
        agent_type: 'task',
        task_prompt: 'Test task for agent',
        run_in_background: false,
      }, 'test-call-id');

      expect(result.success).toBe(true);
      expect(result.agent_used).toBeDefined();
      expect(result.content).toBeDefined();
    });

    it('should use default agent when agent not specified', async () => {
      const result = await tool.execute({
        task_prompt: 'Test task without agent name',
        run_in_background: false,
      }, 'test-call-id');

      expect(result.success).toBe(true);
      expect(result.agent_used).toBe('task');
    });

    it('should fall back to task agent when agent does not exist', async () => {
      const result = await tool.execute({
        agent_type: 'nonexistent',
        task_prompt: 'Test task',
        run_in_background: false,
      }, 'test-call-id');

      // Should succeed by falling back to task agent
      expect(result.success).toBe(true);
      expect(result.agent_used).toBe('nonexistent'); // Displays as requested name
    });


    it('should include duration in results', async () => {
      const result = await tool.execute({
        agent_type: 'task',
        task_prompt: 'Test task',
        run_in_background: false,
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
        agent_type: 'task',
        task_prompt: 'Test task',
        run_in_background: false,
      }, 'test-call-id');

      const startEvents = events.filter((e) => e.type === 'agent_start');
      const endEvents = events.filter((e) => e.type === 'agent_end');

      expect(startEvents.length).toBeGreaterThan(0);
      expect(endEvents.length).toBeGreaterThan(0);
    });
  });
});
