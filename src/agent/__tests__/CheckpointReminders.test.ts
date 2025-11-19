/**
 * Tests for Checkpoint Reminder System
 *
 * This test suite validates the within-turn checkpoint reminder feature that helps
 * agents stay aligned with the user's original request during long-running responses
 * with many tool calls.
 *
 * Key behaviors tested:
 * - Per-turn tracking (counters reset after each turn)
 * - Checkpoint triggering at configured interval
 * - Prompt truncation at sentence boundaries
 * - Skip logic for specialized agents and short prompts
 * - Session restoration (prompt extraction)
 * - Conversation clear (counter reset)
 * - Counter increment on tool execution
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Agent } from '../Agent.js';
import { ToolManager } from '../../tools/ToolManager.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import type { ModelClient, LLMResponse } from '../../llm/ModelClient.js';
import type { Message, Config, AgentConfig } from '../../types/index.js';
import { TOOL_GUIDANCE, TOKEN_MANAGEMENT } from '../../config/constants.js';

describe('Checkpoint Reminder System', () => {
  let agent: Agent;
  let mockModelClient: ModelClient;
  let toolManager: ToolManager;
  let activityStream: ActivityStream;
  let mockConfig: Config;

  beforeEach(() => {
    // Create mock config (full system config)
    mockConfig = {
      model: 'test-model',
      endpoint: 'http://localhost:11434',
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
    };

    // Create mock model client
    mockModelClient = {
      send: vi.fn(async (messages: Message[]): Promise<LLMResponse> => {
        return {
          content: 'Mock response',
          tool_calls: [],
          interrupted: false,
        };
      }),
      close: vi.fn(),
      cancel: vi.fn(),
      setModelName: vi.fn(),
    } as any;

    // Create activity stream
    activityStream = new ActivityStream();

    // Create tool manager with empty tools array
    toolManager = new ToolManager([], activityStream);

    // Create agent config
    const agentConfig: AgentConfig = {
      config: mockConfig,
      isSpecializedAgent: false,
      agentType: 'main',
    };

    // Create agent
    agent = new Agent(mockModelClient, toolManager, activityStream, agentConfig);
  });

  describe('Counter tracking', () => {
    it('should start with counters at zero', () => {
      // Access private properties for testing via type assertion
      expect((agent as any).toolCallsSinceStart).toBe(0);
      expect((agent as any).toolCallsSinceLastCheckpoint).toBe(0);
    });

    it('should increment counters when tools are called', () => {
      // Directly call the private method for unit testing
      (agent as any).incrementToolCallCounters(3);

      expect((agent as any).toolCallsSinceStart).toBe(3);
      expect((agent as any).toolCallsSinceLastCheckpoint).toBe(3);
    });

    it('should accumulate counters across multiple increments', () => {
      (agent as any).incrementToolCallCounters(2);
      (agent as any).incrementToolCallCounters(3);
      (agent as any).incrementToolCallCounters(1);

      expect((agent as any).toolCallsSinceStart).toBe(6);
      expect((agent as any).toolCallsSinceLastCheckpoint).toBe(6);
    });

    it('should ignore invalid tool call counts', () => {
      (agent as any).incrementToolCallCounters(0);
      (agent as any).incrementToolCallCounters(-1);

      expect((agent as any).toolCallsSinceStart).toBe(0);
      expect((agent as any).toolCallsSinceLastCheckpoint).toBe(0);
    });
  });

  describe('Checkpoint triggering', () => {
    beforeEach(() => {
      // Set up a valid user prompt (meets minimum token requirement)
      const longPrompt = 'Please help me implement a comprehensive feature. '.repeat(20);
      (agent as any).initialUserPrompt = longPrompt;
    });

    it('should not trigger before reaching interval', () => {
      (agent as any).incrementToolCallCounters(TOOL_GUIDANCE.CHECKPOINT_INTERVAL - 1);

      const checkpoint = agent.generateCheckpointReminder();
      expect(checkpoint).toBeNull();
    });

    it('should trigger when reaching exact interval', () => {
      (agent as any).incrementToolCallCounters(TOOL_GUIDANCE.CHECKPOINT_INTERVAL);

      const checkpoint = agent.generateCheckpointReminder();
      expect(checkpoint).not.toBeNull();
      expect(checkpoint).toContain('Progress checkpoint');
      expect(checkpoint).toContain('Original request:');
    });

    it('should trigger when exceeding interval', () => {
      (agent as any).incrementToolCallCounters(TOOL_GUIDANCE.CHECKPOINT_INTERVAL + 5);

      const checkpoint = agent.generateCheckpointReminder();
      expect(checkpoint).not.toBeNull();
    });

    it('should reset checkpoint counter after generating reminder', () => {
      (agent as any).incrementToolCallCounters(TOOL_GUIDANCE.CHECKPOINT_INTERVAL);

      agent.generateCheckpointReminder();

      // toolCallsSinceStart should remain, but toolCallsSinceLastCheckpoint should reset
      expect((agent as any).toolCallsSinceStart).toBe(TOOL_GUIDANCE.CHECKPOINT_INTERVAL);
      expect((agent as any).toolCallsSinceLastCheckpoint).toBe(0);
    });

    it('should trigger second checkpoint after another interval', () => {
      // First checkpoint
      (agent as any).incrementToolCallCounters(TOOL_GUIDANCE.CHECKPOINT_INTERVAL);
      const first = agent.generateCheckpointReminder();
      expect(first).not.toBeNull();

      // Before second interval
      (agent as any).incrementToolCallCounters(TOOL_GUIDANCE.CHECKPOINT_INTERVAL - 1);
      const notYet = agent.generateCheckpointReminder();
      expect(notYet).toBeNull();

      // At second interval
      (agent as any).incrementToolCallCounters(1);
      const second = agent.generateCheckpointReminder();
      expect(second).not.toBeNull();
    });
  });

  describe('Skip logic - specialized agents', () => {
    it('should skip checkpoints for specialized agents', () => {
      // Create a specialized agent config
      const specializedAgentConfig: AgentConfig = {
        config: mockConfig,
        isSpecializedAgent: true,
        agentType: 'specialized',
      };

      const specializedAgent = new Agent(
        mockModelClient,
        toolManager,
        activityStream,
        specializedAgentConfig
      );

      const longPrompt = 'Please help me implement a comprehensive feature. '.repeat(20);
      (specializedAgent as any).initialUserPrompt = longPrompt;
      (specializedAgent as any).incrementToolCallCounters(TOOL_GUIDANCE.CHECKPOINT_INTERVAL);

      const checkpoint = specializedAgent.generateCheckpointReminder();
      expect(checkpoint).toBeNull();
    });
  });

  describe('Skip logic - short prompts', () => {
    it('should skip checkpoints when prompt is too short', () => {
      // Create a prompt just below the minimum token threshold
      const minChars = TOOL_GUIDANCE.CHECKPOINT_MIN_PROMPT_TOKENS * TOKEN_MANAGEMENT.CHARS_PER_TOKEN_ESTIMATE;
      const shortPrompt = 'x'.repeat(minChars - 10);

      (agent as any).initialUserPrompt = shortPrompt;
      (agent as any).incrementToolCallCounters(TOOL_GUIDANCE.CHECKPOINT_INTERVAL);

      const checkpoint = agent.generateCheckpointReminder();
      expect(checkpoint).toBeNull();
    });

    it('should allow checkpoints when prompt meets minimum length', () => {
      const minChars = TOOL_GUIDANCE.CHECKPOINT_MIN_PROMPT_TOKENS * TOKEN_MANAGEMENT.CHARS_PER_TOKEN_ESTIMATE;
      const validPrompt = 'x'.repeat(minChars + 10);

      (agent as any).initialUserPrompt = validPrompt;
      (agent as any).incrementToolCallCounters(TOOL_GUIDANCE.CHECKPOINT_INTERVAL);

      const checkpoint = agent.generateCheckpointReminder();
      expect(checkpoint).not.toBeNull();
    });
  });

  describe('Skip logic - missing prompt', () => {
    it('should skip checkpoints when no prompt captured', () => {
      (agent as any).initialUserPrompt = '';
      (agent as any).incrementToolCallCounters(TOOL_GUIDANCE.CHECKPOINT_INTERVAL);

      const checkpoint = agent.generateCheckpointReminder();
      expect(checkpoint).toBeNull();
    });
  });

  describe('Prompt truncation', () => {
    it('should not truncate short prompts', () => {
      // Create a prompt that's long enough to trigger checkpoint but short enough not to truncate
      // Minimum: 50 tokens * 4 chars/token = 200 chars
      // Maximum: 150 tokens * 4 chars/token = 600 chars
      const shortPrompt = 'Help me implement a new feature with proper error handling, comprehensive unit tests, integration tests, and detailed documentation for all the new functionality being added to the system and its dependencies.';
      (agent as any).initialUserPrompt = shortPrompt;
      (agent as any).incrementToolCallCounters(TOOL_GUIDANCE.CHECKPOINT_INTERVAL);

      const checkpoint = agent.generateCheckpointReminder();
      expect(checkpoint).not.toBeNull();
      expect(checkpoint).toContain(shortPrompt);
      expect(checkpoint).not.toContain('...');
    });

    it('should truncate long prompts to token limit', () => {
      const maxChars = TOOL_GUIDANCE.CHECKPOINT_MAX_PROMPT_TOKENS * TOKEN_MANAGEMENT.CHARS_PER_TOKEN_ESTIMATE;
      const longPrompt = 'x'.repeat(maxChars * 2);

      (agent as any).initialUserPrompt = longPrompt;
      (agent as any).incrementToolCallCounters(TOOL_GUIDANCE.CHECKPOINT_INTERVAL);

      const checkpoint = agent.generateCheckpointReminder();

      // Extract the quoted prompt from the checkpoint
      const match = checkpoint?.match(/"([^"]*)"/);
      const truncatedPrompt = match ? match[1] : '';

      // Should be truncated (much shorter than original)
      expect(truncatedPrompt.length).toBeLessThan(longPrompt.length);
      expect(truncatedPrompt.length).toBeLessThanOrEqual(maxChars + 10); // Allow small buffer
    });

    it('should break at sentence boundary (period) when possible', () => {
      const maxChars = TOOL_GUIDANCE.CHECKPOINT_MAX_PROMPT_TOKENS * TOKEN_MANAGEMENT.CHARS_PER_TOKEN_ESTIMATE;
      // Create text with a period near the truncation point
      const beforePeriod = 'x'.repeat(Math.floor(maxChars * 0.7));
      const afterPeriod = 'y'.repeat(maxChars);
      const promptWithPeriod = beforePeriod + '. ' + afterPeriod;

      (agent as any).initialUserPrompt = promptWithPeriod;
      (agent as any).incrementToolCallCounters(TOOL_GUIDANCE.CHECKPOINT_INTERVAL);

      const checkpoint = agent.generateCheckpointReminder();
      const match = checkpoint?.match(/"([^"]*)"/);
      const truncatedPrompt = match ? match[1] : '';

      // Should end with period (found good boundary)
      expect(truncatedPrompt.endsWith('.')).toBe(true);
      expect(truncatedPrompt).not.toContain('...');
    });

    it('should break at newline when no period available', () => {
      const maxChars = TOOL_GUIDANCE.CHECKPOINT_MAX_PROMPT_TOKENS * TOKEN_MANAGEMENT.CHARS_PER_TOKEN_ESTIMATE;
      const beforeNewline = 'x'.repeat(Math.floor(maxChars * 0.7));
      const afterNewline = 'y'.repeat(maxChars);
      const promptWithNewline = beforeNewline + '\n' + afterNewline;

      (agent as any).initialUserPrompt = promptWithNewline;
      (agent as any).incrementToolCallCounters(TOOL_GUIDANCE.CHECKPOINT_INTERVAL);

      const checkpoint = agent.generateCheckpointReminder();
      const match = checkpoint?.match(/"([^"]*)"/);
      const truncatedPrompt = match ? match[1] : '';

      // Should break cleanly at newline (no ellipsis)
      expect(truncatedPrompt).not.toContain('y');
      expect(truncatedPrompt).not.toContain('...');
    });

    it('should add ellipsis when no good boundary found', () => {
      const maxChars = TOOL_GUIDANCE.CHECKPOINT_MAX_PROMPT_TOKENS * TOKEN_MANAGEMENT.CHARS_PER_TOKEN_ESTIMATE;
      // Create text with period very early (before 60% threshold)
      const earlyPeriod = 'x'.repeat(Math.floor(maxChars * 0.2)) + '. ';
      const rest = 'y'.repeat(maxChars * 2);
      const promptWithEarlyPeriod = earlyPeriod + rest;

      (agent as any).initialUserPrompt = promptWithEarlyPeriod;
      (agent as any).incrementToolCallCounters(TOOL_GUIDANCE.CHECKPOINT_INTERVAL);

      const checkpoint = agent.generateCheckpointReminder();
      const match = checkpoint?.match(/"([^"]*)"/);
      const truncatedPrompt = match ? match[1] : '';

      // Should use ellipsis since boundary was too early
      expect(truncatedPrompt.endsWith('...')).toBe(true);
    });
  });

  describe('Checkpoint content', () => {
    beforeEach(() => {
      const longPrompt = 'Please help me implement a comprehensive feature. '.repeat(20);
      (agent as any).initialUserPrompt = longPrompt;
      (agent as any).incrementToolCallCounters(TOOL_GUIDANCE.CHECKPOINT_INTERVAL);
    });

    it('should include progress indicator with tool call count', () => {
      const checkpoint = agent.generateCheckpointReminder();

      expect(checkpoint).toContain(`Progress checkpoint (${TOOL_GUIDANCE.CHECKPOINT_INTERVAL} tool calls)`);
    });

    it('should include original request in quotes', () => {
      const checkpoint = agent.generateCheckpointReminder();

      expect(checkpoint).toContain('Original request:');
      expect(checkpoint).toMatch(/".*"/);
    });

    it('should include verification questions', () => {
      const checkpoint = agent.generateCheckpointReminder();

      expect(checkpoint).toContain('Verify alignment:');
      expect(checkpoint).toContain('Are you still working toward this goal?');
      expect(checkpoint).toContain('Have you drifted into unrelated improvements?');
      expect(checkpoint).toContain('Course-correct now if off-track, or continue if aligned.');
    });

    it('should be firm but professional (no CAPS)', () => {
      const checkpoint = agent.generateCheckpointReminder();

      // Should not have excessive capitalization
      expect(checkpoint).not.toMatch(/[A-Z]{5,}/); // No 5+ consecutive caps

      // Should be professional
      expect(checkpoint).not.toContain('STOP');
      expect(checkpoint).not.toContain('MUST');
      expect(checkpoint).not.toContain('WARNING');
    });
  });

  describe('Per-turn reset behavior', () => {
    it('should reset counters when conversation is cleared', () => {
      const longPrompt = 'Please help me implement a comprehensive feature. '.repeat(20);
      (agent as any).initialUserPrompt = longPrompt;
      (agent as any).incrementToolCallCounters(5);

      agent.clearConversationHistory();

      expect((agent as any).toolCallsSinceStart).toBe(0);
      expect((agent as any).toolCallsSinceLastCheckpoint).toBe(0);
      expect((agent as any).initialUserPrompt).toBe('');
    });

    it('should allow fresh tracking after clear', () => {
      // First session
      const firstPrompt = 'First task. '.repeat(50);
      (agent as any).initialUserPrompt = firstPrompt;
      (agent as any).incrementToolCallCounters(TOOL_GUIDANCE.CHECKPOINT_INTERVAL);
      const first = agent.generateCheckpointReminder();
      expect(first).toContain('First task');

      // Clear and start fresh
      agent.clearConversationHistory();

      // Second session
      const secondPrompt = 'Second task. '.repeat(50);
      (agent as any).initialUserPrompt = secondPrompt;
      (agent as any).incrementToolCallCounters(TOOL_GUIDANCE.CHECKPOINT_INTERVAL);
      const second = agent.generateCheckpointReminder();
      expect(second).toContain('Second task');
      expect(second).not.toContain('First task');
    });
  });

  describe('Session restoration', () => {
    it('should NOT extract initial prompt from restored messages', () => {
      // Session restoration should not set initialUserPrompt
      // It will be set by the next sendMessage() call with the current turn's prompt
      const messages = [
        { role: 'user', content: 'Please help me with this task.', timestamp: Date.now() },
        { role: 'assistant', content: 'Sure, I can help.', timestamp: Date.now() },
      ];

      agent.setMessages(messages as any);

      // Should remain empty until next sendMessage() call
      expect((agent as any).initialUserPrompt).toBe('');
    });

    it('should NOT extract prompt even with multiple user messages', () => {
      // Session restoration should not set initialUserPrompt
      // Checkpoint tracking is per-turn only, not based on historical messages
      const messages = [
        { role: 'system', content: 'System prompt', timestamp: Date.now() },
        { role: 'user', content: 'First user request.', timestamp: Date.now() },
        { role: 'assistant', content: 'Response', timestamp: Date.now() },
        { role: 'user', content: 'Second user request.', timestamp: Date.now() },
      ];

      agent.setMessages(messages as any);

      // Should remain empty until next sendMessage() call
      expect((agent as any).initialUserPrompt).toBe('');
    });

    it('should not touch existing prompt when restoring messages', () => {
      // Set initial prompt (as would happen during a turn)
      (agent as any).initialUserPrompt = 'Current turn prompt';

      // Restore messages (e.g., during compaction)
      const messages = [
        { role: 'user', content: 'Historical prompt from saved session', timestamp: Date.now() },
        { role: 'assistant', content: 'Historical response', timestamp: Date.now() },
      ];

      agent.setMessages(messages as any);

      // setMessages() should not modify initialUserPrompt at all
      expect((agent as any).initialUserPrompt).toBe('Current turn prompt');
    });

    it('should handle empty message array', () => {
      agent.setMessages([]);

      // Should not crash, initialUserPrompt stays empty
      expect((agent as any).initialUserPrompt).toBe('');
    });

    it('should handle messages with no user role', () => {
      const messages = [
        { role: 'system', content: 'System only', timestamp: Date.now() },
        { role: 'assistant', content: 'Assistant only', timestamp: Date.now() },
      ];

      agent.setMessages(messages as any);

      // Should not crash, initialUserPrompt stays empty
      expect((agent as any).initialUserPrompt).toBe('');
    });
  });

  describe('Integration scenarios', () => {
    it('should handle typical flow: message -> tools -> checkpoint -> more tools', () => {
      const prompt = 'Implement a complete authentication system. '.repeat(30);
      (agent as any).initialUserPrompt = prompt;

      // First batch of tools
      (agent as any).incrementToolCallCounters(4);
      expect(agent.generateCheckpointReminder()).toBeNull();

      // Second batch (hits threshold)
      (agent as any).incrementToolCallCounters(4);
      const checkpoint = agent.generateCheckpointReminder();
      expect(checkpoint).not.toBeNull();
      expect(checkpoint).toContain('8 tool calls');

      // More tools after checkpoint
      (agent as any).incrementToolCallCounters(3);
      expect(agent.generateCheckpointReminder()).toBeNull();
    });

    it('should handle edge case: exactly at interval threshold', () => {
      const prompt = 'Build feature. '.repeat(50);
      (agent as any).initialUserPrompt = prompt;

      // Increment to exactly the interval
      for (let i = 0; i < TOOL_GUIDANCE.CHECKPOINT_INTERVAL; i++) {
        (agent as any).incrementToolCallCounters(1);
      }

      const checkpoint = agent.generateCheckpointReminder();
      expect(checkpoint).not.toBeNull();
      expect((agent as any).toolCallsSinceLastCheckpoint).toBe(0);
    });

    it('should handle multiple checkpoints in single turn', () => {
      const prompt = 'Complex refactoring task. '.repeat(50);
      (agent as any).initialUserPrompt = prompt;

      // First checkpoint
      (agent as any).incrementToolCallCounters(TOOL_GUIDANCE.CHECKPOINT_INTERVAL);
      const first = agent.generateCheckpointReminder();
      expect(first).toContain('8 tool calls');

      // Second checkpoint
      (agent as any).incrementToolCallCounters(TOOL_GUIDANCE.CHECKPOINT_INTERVAL);
      const second = agent.generateCheckpointReminder();
      expect(second).toContain('16 tool calls');

      // Third checkpoint
      (agent as any).incrementToolCallCounters(TOOL_GUIDANCE.CHECKPOINT_INTERVAL);
      const third = agent.generateCheckpointReminder();
      expect(third).toContain('24 tool calls');
    });
  });

  describe('Constants validation', () => {
    it('should use configured checkpoint interval', () => {
      expect(TOOL_GUIDANCE.CHECKPOINT_INTERVAL).toBe(8);
    });

    it('should use configured minimum prompt tokens', () => {
      expect(TOOL_GUIDANCE.CHECKPOINT_MIN_PROMPT_TOKENS).toBe(50);
    });

    it('should use configured maximum prompt tokens', () => {
      expect(TOOL_GUIDANCE.CHECKPOINT_MAX_PROMPT_TOKENS).toBe(150);
    });
  });
});
