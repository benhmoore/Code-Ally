/**
 * Tests for ToolOrchestrator exploratory tool tracking
 *
 * Validates that the exploratory reminder injection logic (migrated from Agent.ts)
 * correctly tracks consecutive exploratory tool calls and injects warnings.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolOrchestrator, IAgentForOrchestrator } from '../ToolOrchestrator.js';
import { ToolManager } from '../../tools/ToolManager.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { TOOL_GUIDANCE } from '../../config/constants.js';
import type { AgentConfig } from '../../types/index.js';
import type { ToolCall } from '../../types/index.js';

describe('ToolOrchestrator Exploratory Tracking', () => {
  let orchestrator: ToolOrchestrator;
  let toolManager: ToolManager;
  let activityStream: ActivityStream;
  let mockAgent: IAgentForOrchestrator;
  let agentConfig: AgentConfig;

  // Create a mock exploratory tool
  const createMockExploratoryTool = (name: string) => ({
    name,
    description: `Mock ${name} tool`,
    isExploratoryTool: true,
    execute: vi.fn().mockResolvedValue({ success: true, output: 'mock result' }),
  });

  // Create a mock non-exploratory tool
  const createMockNonExploratoryTool = (name: string, breaksStreak = true) => ({
    name,
    description: `Mock ${name} tool`,
    isExploratoryTool: false,
    breaksExploratoryStreak: breaksStreak,
    execute: vi.fn().mockResolvedValue({ success: true, output: 'mock result' }),
  });

  // Create a tool call
  const createToolCall = (name: string, id: string = 'call-1'): ToolCall => ({
    id,
    function: {
      name,
      arguments: '{}',
    },
  });

  beforeEach(() => {
    activityStream = new ActivityStream();

    // Create tool manager with mock tools (using kebab-case names)
    toolManager = new ToolManager([
      createMockExploratoryTool('read') as any,
      createMockExploratoryTool('grep') as any,
      createMockExploratoryTool('glob') as any,
      createMockNonExploratoryTool('write') as any,
      createMockNonExploratoryTool('edit') as any,
      createMockNonExploratoryTool('task', false) as any, // Preserves streak
    ], activityStream);

    // Mock agent interface
    mockAgent = {
      resetToolCallActivity: vi.fn(),
      addMessage: vi.fn(),
      getToolAbortSignal: vi.fn().mockReturnValue(undefined),
      getTurnStartTime: vi.fn().mockReturnValue(Date.now()),
      getMaxDuration: vi.fn().mockReturnValue(undefined),
      getAgentName: vi.fn().mockReturnValue('test-agent'),
      getAgentDepth: vi.fn().mockReturnValue(0),
      getTokenManager: vi.fn().mockReturnValue({
        getContextUsagePercentage: vi.fn().mockReturnValue(0),
        trackToolResult: vi.fn().mockReturnValue(null),
      }),
      generateCheckpointReminder: vi.fn().mockReturnValue(null),
    };

    // Standard agent config (not specialized)
    agentConfig = {
      config: {
        model: 'test-model',
        endpoint: 'http://localhost',
        context_size: 8192,
        temperature: 0.7,
        max_tokens: 2048,
        bash_timeout: 120000,
        auto_confirm: false,
        parallel_tools: false,
        theme: 'default',
        compact_threshold: 95,
        show_context_in_prompt: true,
        show_thinking_in_chat: false,
        show_full_tool_output: false,
        tool_call_retry_enabled: true,
        tool_call_max_retries: 3,
        tool_call_repair_attempts: true,
        tool_call_verbose_errors: true,
        dir_tree_max_depth: 3,
        dir_tree_max_files: 50,
        dir_tree_enable: true,
        diff_display_enabled: true,
        diff_display_max_file_size: 1048576,
        diff_display_context_lines: 3,
        diff_display_theme: 'github',
        diff_display_color_removed: 'red',
        diff_display_color_added: 'green',
        diff_display_color_modified: 'yellow',
        tool_result_max_context_percent: 0.2,
        tool_result_min_tokens: 200,
        setup_completed: true,
      } as any,
      isSpecializedAgent: false,
      agentType: 'main',
    };

    orchestrator = new ToolOrchestrator(
      toolManager,
      activityStream,
      mockAgent,
      agentConfig
    );
  });

  describe('Streak tracking', () => {
    it('should start with streak at zero', () => {
      expect((orchestrator as any).currentExploratoryStreak).toBe(0);
    });

    it('should increment streak on exploratory tool call', () => {
      const toolCall = createToolCall('read');
      const result = { success: true, output: 'file contents' };

      (orchestrator as any).maybeInjectExploratoryReminder(toolCall, result);

      expect((orchestrator as any).currentExploratoryStreak).toBe(1);
    });

    it('should accumulate streak across consecutive exploratory calls', () => {
      const result = { success: true, output: 'result' };

      (orchestrator as any).maybeInjectExploratoryReminder(createToolCall('read'), result);
      (orchestrator as any).maybeInjectExploratoryReminder(createToolCall('grep'), { ...result });
      (orchestrator as any).maybeInjectExploratoryReminder(createToolCall('glob'), { ...result });

      expect((orchestrator as any).currentExploratoryStreak).toBe(3);
    });

    it('should reset streak on non-exploratory tool call', () => {
      const result = { success: true, output: 'result' };

      // Build up a streak
      (orchestrator as any).maybeInjectExploratoryReminder(createToolCall('read'), result);
      (orchestrator as any).maybeInjectExploratoryReminder(createToolCall('grep'), { ...result });
      expect((orchestrator as any).currentExploratoryStreak).toBe(2);

      // Non-exploratory tool resets it
      (orchestrator as any).maybeInjectExploratoryReminder(createToolCall('write'), { ...result });
      expect((orchestrator as any).currentExploratoryStreak).toBe(0);
    });

    it('should preserve streak for tools with breaksExploratoryStreak: false', () => {
      const result = { success: true, output: 'result' };

      // Build up a streak
      (orchestrator as any).maybeInjectExploratoryReminder(createToolCall('read'), result);
      (orchestrator as any).maybeInjectExploratoryReminder(createToolCall('grep'), { ...result });
      expect((orchestrator as any).currentExploratoryStreak).toBe(2);

      // Tool with breaksExploratoryStreak: false should NOT reset streak
      (orchestrator as any).maybeInjectExploratoryReminder(createToolCall('task'), { ...result });
      expect((orchestrator as any).currentExploratoryStreak).toBe(2);

      // Continue exploratory calls - streak continues from 2
      (orchestrator as any).maybeInjectExploratoryReminder(createToolCall('glob'), { ...result });
      expect((orchestrator as any).currentExploratoryStreak).toBe(3);
    });

    it('should reset streak via public method', () => {
      const result = { success: true, output: 'result' };

      (orchestrator as any).maybeInjectExploratoryReminder(createToolCall('read'), result);
      (orchestrator as any).maybeInjectExploratoryReminder(createToolCall('grep'), { ...result });
      expect((orchestrator as any).currentExploratoryStreak).toBe(2);

      orchestrator.resetExploratoryStreak();
      expect((orchestrator as any).currentExploratoryStreak).toBe(0);
    });
  });

  describe('Warning injection', () => {
    it('should not inject warning before threshold', () => {
      const result = { success: true, output: 'result' };

      // Call up to threshold - 1
      for (let i = 0; i < TOOL_GUIDANCE.EXPLORATORY_TOOL_THRESHOLD - 1; i++) {
        (orchestrator as any).maybeInjectExploratoryReminder(createToolCall('read'), { ...result });
      }

      expect(result.system_reminder).toBeUndefined();
    });

    it('should inject gentle warning at threshold', () => {
      const results: any[] = [];

      // Call exactly to threshold
      for (let i = 0; i < TOOL_GUIDANCE.EXPLORATORY_TOOL_THRESHOLD; i++) {
        const result = { success: true, output: 'result' };
        (orchestrator as any).maybeInjectExploratoryReminder(createToolCall('read'), result);
        results.push(result);
      }

      // Last result should have the warning
      const lastResult = results[results.length - 1];
      expect(lastResult.system_reminder).toBeDefined();
      expect(lastResult.system_reminder).toContain('consecutive');
      expect(lastResult.system_reminder).toContain('exploratory');
    });

    it('should inject stern warning at stern threshold', () => {
      const results: any[] = [];

      // Call to stern threshold
      for (let i = 0; i < TOOL_GUIDANCE.EXPLORATORY_TOOL_STERN_THRESHOLD; i++) {
        const result = { success: true, output: 'result' };
        (orchestrator as any).maybeInjectExploratoryReminder(createToolCall('read'), result);
        results.push(result);
      }

      // Last result should have stern warning
      const lastResult = results[results.length - 1];
      expect(lastResult.system_reminder).toBeDefined();
      // Stern warning should be more emphatic
      expect(lastResult.system_reminder).toContain(String(TOOL_GUIDANCE.EXPLORATORY_TOOL_STERN_THRESHOLD));
    });
  });

  describe('Specialized agent handling', () => {
    it('should skip injection for specialized agents', () => {
      // Create orchestrator with specialized agent config
      const specializedConfig: AgentConfig = {
        ...agentConfig,
        isSpecializedAgent: true,
        agentType: 'explore',
      };

      const specializedOrchestrator = new ToolOrchestrator(
        toolManager,
        activityStream,
        mockAgent,
        specializedConfig
      );

      const results: any[] = [];

      // Make many exploratory calls
      for (let i = 0; i < TOOL_GUIDANCE.EXPLORATORY_TOOL_STERN_THRESHOLD + 5; i++) {
        const result = { success: true, output: 'result' };
        (specializedOrchestrator as any).maybeInjectExploratoryReminder(createToolCall('read'), result);
        results.push(result);
      }

      // No results should have warnings (specialized agents are supposed to explore)
      for (const result of results) {
        expect(result.system_reminder).toBeUndefined();
      }
    });
  });
});
