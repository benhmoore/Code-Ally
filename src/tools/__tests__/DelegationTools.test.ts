/**
 * Characterization tests for BaseDelegationTool via ExploreTool.
 *
 * ExploreTool is the canonical read-only delegation subclass; exercising it
 * drives BaseDelegationTool.executeDelegation end-to-end (service resolution,
 * agentConfig build via buildDelegationAgentConfig, pooled-agent acquire/run,
 * response resolution, cleanup, success formatting). These pin the shared base
 * path as a safety net for the AgentTool -> BaseDelegationTool consolidation,
 * which modifies that base. The delegation subclasses had no direct coverage
 * before this file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ExploreTool } from '@tools/ExploreTool.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';

describe('BaseDelegationTool (via ExploreTool)', () => {
  let activityStream: ActivityStream;
  let registry: ServiceRegistry;
  let tool: ExploreTool;

  beforeEach(() => {
    activityStream = new ActivityStream();
    registry = ServiceRegistry.getInstance();

    const mockModelClient = {
      send: vi.fn().mockResolvedValue({ content: 'ok', tool_calls: [], interrupted: false, error: null }),
      cancel: vi.fn(),
      close: vi.fn(),
      getModelName: vi.fn().mockReturnValue('test-model'),
    };

    const mockToolManager = {
      getTools: vi.fn().mockReturnValue([]),
      getFunctionDefinitions: vi.fn().mockReturnValue([]),
      getTool: vi.fn().mockReturnValue(undefined),
      clearCurrentTurn: vi.fn(),
      getAllTools: vi.fn().mockReturnValue([]),
    };

    const mockConfig = {
      model: 'test-model',
      endpoint: 'http://localhost:11434',
      context_size: 4096,
      temperature: 0.1,
      max_tokens: 2048,
      temp_directory: '/tmp',
      setup_completed: true,
    };

    const mockConfigManager = {
      getConfig: vi.fn().mockReturnValue(mockConfig),
      getValue: vi.fn().mockImplementation((k: string, d?: any) => (mockConfig as any)[k] ?? d),
    };

    // A pooled agent exposing every method BaseDelegationTool.executeDelegation calls.
    const makePooledAgent = (response: string) => ({
      agent: {
        sendMessage: vi.fn().mockResolvedValue(response),
        getMessages: vi.fn().mockReturnValue([]),
        getContextUsagePercentage: vi.fn().mockReturnValue(0),
        getToolUseCount: vi.fn().mockReturnValue(0),
        interrupt: vi.fn(),
        addUserInterjection: vi.fn(),
        cleanup: vi.fn().mockResolvedValue(undefined),
      },
      agentId: 'explore-agent-id',
      release: vi.fn(),
    });

    registry.registerInstance('model_client', mockModelClient);
    registry.registerInstance('tool_manager', mockToolManager);
    registry.registerInstance('config_manager', mockConfigManager);
    registry.registerInstance('permission_manager', { checkPermission: vi.fn().mockResolvedValue(true) });
    registry.registerInstance('agent_pool', {
      acquire: vi.fn().mockResolvedValue(makePooledAgent('Exploration found the relevant handler in src/foo.ts.')),
    });
    // Intentionally NOT registering 'background_agent_manager' -> base uses its
    // synchronous foreground path, which is what we want to characterize.

    tool = new ExploreTool(activityStream);
  });

  afterEach(async () => {
    await registry.shutdown();
  });

  describe('contract', () => {
    it('exposes the explore function definition', () => {
      expect(tool.name).toBe('explore');
      const def = tool.getFunctionDefinition();
      expect(def.function.name).toBe('explore');
      expect(def.function.parameters.required).toEqual(['task_prompt']);
      const props = def.function.parameters.properties as Record<string, any>;
      expect(props.task_prompt.type).toBe('string');
      expect(props.thoroughness.type).toBe('string');
    });
  });

  describe('validation', () => {
    it('rejects a missing task_prompt', async () => {
      const result = await tool.execute({}, 'call-1');
      expect(result.success).toBe(false);
      expect(result.error).toContain('task_prompt');
    });

    it('rejects an invalid thoroughness', async () => {
      const result = await tool.execute({ task_prompt: 'find x', thoroughness: 'bogus' }, 'call-1');
      expect(result.success).toBe(false);
      expect(result.error).toContain('thoroughness');
    });
  });

  describe('delegation (base.executeDelegation foreground path)', () => {
    it('runs the agent and returns a formatted success result', async () => {
      const result = await tool.execute({ task_prompt: 'Find the error handler', thoroughness: 'quick' }, 'call-1');

      expect(result.success).toBe(true);
      expect(result.agent_used).toBe('explore');
      expect(typeof result.duration_seconds).toBe('number');
      expect(result.content).toContain('Exploration found the relevant handler');
      // Pooled agents always surface their id for reuse.
      expect(result.agent_id).toBe('explore-agent-id');
    });

    it('emits AGENT_START and AGENT_END events', async () => {
      const events: any[] = [];
      activityStream.subscribe('*', (e) => events.push(e));

      await tool.execute({ task_prompt: 'Find the error handler' }, 'call-1');

      expect(events.some((e) => e.type === 'agent_start')).toBe(true);
      expect(events.some((e) => e.type === 'agent_end')).toBe(true);
    });

    it('falls back to the configured empty-response text when the agent yields nothing', async () => {
      registry.registerInstance('agent_pool', {
        acquire: vi.fn().mockResolvedValue({
          agent: {
            sendMessage: vi.fn().mockResolvedValue(''),
            getMessages: vi.fn().mockReturnValue([]),
            getContextUsagePercentage: vi.fn().mockReturnValue(0),
            getToolUseCount: vi.fn().mockReturnValue(0),
            interrupt: vi.fn(),
            cleanup: vi.fn().mockResolvedValue(undefined),
          },
          agentId: 'empty-explore-id',
          release: vi.fn(),
        }),
      });

      const result = await tool.execute({ task_prompt: 'Find nothing' }, 'call-1');
      expect(result.success).toBe(true);
      expect(result.content).toContain('Exploration completed but no summary was provided');
    });
  });

  describe('result preview', () => {
    it('shows duration and content for a successful result', () => {
      const preview = tool.getResultPreview({
        success: true,
        error: '',
        content: 'Found it',
        duration_seconds: 3,
      } as any);

      expect(preview.some((l) => l.includes('Completed in 3s'))).toBe(true);
      expect(preview.some((l) => l.includes('Found it'))).toBe(true);
    });

    it('delegates to the base implementation for a failed result', () => {
      const preview = tool.getResultPreview({ success: false, error: 'boom', content: '' } as any);
      expect(preview.some((l) => l.includes('Completed in'))).toBe(false);
    });
  });
});
