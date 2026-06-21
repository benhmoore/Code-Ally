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

  // ----------------------------------------------------------------------------
  // CHARACTERIZATION TESTS
  //
  // These pin AgentTool's CURRENT observable behavior — the public tool contract
  // and the untested, refactor-risky paths (extended validation, cycle guard,
  // empty-response recovery, display helpers). They exist as a safety net for the
  // planned AgentTool -> BaseDelegationTool consolidation: any behavior change in
  // these areas should be a deliberate, visible test edit, not a silent regression.
  // ----------------------------------------------------------------------------

  describe('function definition contract', () => {
    it('should expose the documented parameter schema', () => {
      const def = tool.getFunctionDefinition();
      expect(def.type).toBe('function');
      expect(def.function.name).toBe('agent');

      const props = def.function.parameters.properties as Record<string, any>;
      // The full public parameter surface the consolidation must preserve.
      expect(Object.keys(props).sort()).toEqual(
        ['agent_type', 'context_files', 'context_images', 'notify_when_done', 'run_in_background', 'task_prompt', 'thoroughness'].sort()
      );
      expect(props.task_prompt.type).toBe('string');
      expect(props.agent_type.type).toBe('string');
      expect(props.thoroughness.type).toBe('string');
      expect(props.context_files.type).toBe('array');
      expect(props.context_files.items.type).toBe('string');
      expect(props.context_images.type).toBe('array');
      expect(props.context_images.items.type).toBe('string');
      expect(props.run_in_background.type).toBe('boolean');
      expect(props.notify_when_done.type).toBe('boolean');

      // task_prompt is the only required parameter.
      expect(def.function.parameters.required).toEqual(['task_prompt']);
    });
  });

  describe('extended validation', () => {
    it('should reject agent_type that is empty after trimming', async () => {
      const result = await tool.execute({
        agent_type: '   ',
        task_prompt: 'Test task',
      }, 'test-call-id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('agent_type cannot be empty');
    });

    it('should reject agent_type with path-traversal / invalid characters', async () => {
      const result = await tool.execute({
        agent_type: '../etc/passwd',
        task_prompt: 'Test task',
      }, 'test-call-id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid characters');
    });

    it('should reject agent_type longer than 100 characters', async () => {
      const result = await tool.execute({
        agent_type: 'a'.repeat(101),
        task_prompt: 'Test task',
      }, 'test-call-id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('too long');
    });

    it('should reject non-array context_files', async () => {
      const result = await tool.execute({
        task_prompt: 'Test task',
        context_files: 'src/file.ts',
      }, 'test-call-id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('context_files must be an array');
    });

    it('should reject context_files containing non-strings', async () => {
      const result = await tool.execute({
        task_prompt: 'Test task',
        context_files: ['ok.ts', 42],
      }, 'test-call-id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('context_files must contain only strings');
    });

    it('should reject non-array context_images', async () => {
      const result = await tool.execute({
        task_prompt: 'Test task',
        context_images: 'shot.png',
      }, 'test-call-id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('context_images must be an array');
    });

    it('should reject context_images containing non-strings', async () => {
      const result = await tool.execute({
        task_prompt: 'Test task',
        context_images: ['shot.png', 7],
      }, 'test-call-id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('context_images must contain only strings');
    });
  });

  describe('cycle-depth guard', () => {
    it('should reject when the target agent already fills the call chain to MAX_AGENT_CYCLE_DEPTH', async () => {
      // Exercise the cycle guard in isolation: depth 0 (so the depth check passes)
      // but a call stack already holding the target agent MAX_AGENT_CYCLE_DEPTH times.
      const stack = new Array(AGENT_CONFIG.MAX_AGENT_CYCLE_DEPTH).fill('task');
      const mockAgent = {
        getAgentDepth: vi.fn().mockReturnValue(0),
        getAgentName: vi.fn().mockReturnValue('ally'),
        getAgentCallStack: vi.fn().mockReturnValue(stack),
      };
      registry.registerInstance('agent', mockAgent);

      const result = await tool.execute({
        agent_type: 'task',
        task_prompt: 'Recursive task',
        run_in_background: false,
      }, 'test-call-id');

      expect(result.success).toBe(false);
      expect(result.error_type).toBe('validation_error');
      expect(result.error).toContain('cycle depth');
    });
  });

  describe('empty-response recovery', () => {
    it('should fall back to a completion notice when the agent yields nothing', async () => {
      // Override the pool so the agent returns empty for both the task and the
      // explicit-summary retry, and has no extractable assistant messages.
      registry.registerInstance('agent_pool', {
        acquire: vi.fn().mockResolvedValue({
          agent: {
            sendMessage: vi.fn().mockResolvedValue(''),
            getMessages: vi.fn().mockReturnValue([]),
            getTokenManager: vi.fn().mockReturnValue({ getContextUsagePercentage: () => 0 }),
            getToolUseCount: vi.fn().mockReturnValue(0),
          },
          agentId: 'empty-agent-id',
          release: async () => {},
        }),
      });

      const result = await tool.execute({
        agent_type: 'task',
        task_prompt: 'Task that produces no output',
        run_in_background: false,
      }, 'test-call-id');

      expect(result.success).toBe(true);
      expect(result.content).toContain('did not provide a summary');
    });
  });

  describe('display helpers', () => {
    it('formatSubtext returns the task prompt, or null when absent', () => {
      expect(tool.formatSubtext({ task_prompt: 'Do the thing' })).toBe('Do the thing');
      expect(tool.formatSubtext({})).toBeNull();
    });

    it('getSubtextParameters lists task_prompt and description', () => {
      expect(tool.getSubtextParameters()).toEqual(['task_prompt', 'description']);
    });

    it('getResultPreview shows duration and content for a successful result', () => {
      const preview = tool.getResultPreview({
        success: true,
        error: '',
        content: 'A short agent summary',
        duration_seconds: 2,
      } as any);

      expect(preview.some(l => l.startsWith('Duration:'))).toBe(true);
      expect(preview.some(l => l.includes('A short agent summary'))).toBe(true);
    });

    it('getResultPreview truncates long content with an ellipsis', () => {
      const long = 'x'.repeat(200);
      const preview = tool.getResultPreview({
        success: true,
        error: '',
        content: long,
      } as any, 3);

      const contentLine = preview.find(l => l.includes('x'));
      expect(contentLine).toBeDefined();
      expect(contentLine!.endsWith('...')).toBe(true);
      expect(contentLine!.length).toBeLessThan(long.length);
    });

    it('getResultPreview delegates to the base implementation for failures', () => {
      // A failed result should not surface a "Duration:" success line.
      const preview = tool.getResultPreview({
        success: false,
        error: 'something broke',
        content: '',
      } as any);

      expect(preview.some(l => l.startsWith('Duration:'))).toBe(false);
    });
  });
});
