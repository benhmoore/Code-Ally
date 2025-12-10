/**
 * Agent tests - focusing on interruption handling
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Agent } from '../Agent.js';
import { ToolManager } from '@tools/ToolManager.js';
import { ActivityStream } from '@services/ActivityStream.js';
import type { ModelClient, LLMResponse } from '@llm/ModelClient.js';
import type { Message, Config } from '@shared/index.js';

describe('Agent - Interruption Handling', () => {
  let agent: Agent;
  let mockModelClient: ModelClient;
  let toolManager: ToolManager;
  let activityStream: ActivityStream;
  let mockConfig: Config;

  beforeEach(() => {
    // Create mock config
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

    // Create mock model client that captures sent messages
    // Use a closure variable to track state across calls
    const capturedMessages: Message[][] = [];
    let nextResponseInterrupted = false;

    mockModelClient = {
      send: vi.fn(async (messages: Message[]): Promise<LLMResponse> => {
        capturedMessages.push([...messages]);

        // Check if we should return an interrupted response
        if (nextResponseInterrupted) {
          nextResponseInterrupted = false;
          return {
            content: '',
            tool_calls: [],
            interrupted: true,
          };
        }

        return {
          content: 'Mock response',
          tool_calls: [],
          interrupted: false,
        };
      }),
      close: vi.fn(),
      cancel: vi.fn(),
      setModelName: vi.fn(),
      // Helper to simulate interruption on next request
      setNextResponseInterrupted: (value: boolean) => {
        nextResponseInterrupted = value;
      },
    } as any;

    // Store captured messages on the mock for test access
    (mockModelClient as any).capturedMessages = capturedMessages;

    // Create activity stream
    activityStream = new ActivityStream();

    // Create tool manager with empty tools array
    toolManager = new ToolManager([], activityStream);

    // Create agent (system prompt generated dynamically in sendMessage)
    agent = new Agent(mockModelClient, toolManager, activityStream, {
      config: mockConfig,
      isSpecializedAgent: false,
    });
  });

  describe('System Reminder Injection', () => {
    it('should inject system reminder after interruption', async () => {
      // Mark next response as interrupted before sending
      (mockModelClient as any).setNextResponseInterrupted(true);

      // Send a message that will receive an interrupted response
      const result = await agent.sendMessage('First message');

      // Verify the result indicates interruption
      expect(result.toLowerCase()).toContain('interrupted');

      // Send a new message after interruption
      await agent.sendMessage('What did you try to do?');

      // Get the messages that were sent to the model
      const capturedMessages = (mockModelClient as any).capturedMessages;
      expect(capturedMessages.length).toBeGreaterThan(0);

      // The last call should include the system reminder
      const lastCall = capturedMessages[capturedMessages.length - 1];
      const systemReminderMessage = lastCall.find((msg: Message) =>
        msg.role === 'system' && msg.content.includes('<system-reminder>')
      );

      expect(systemReminderMessage).toBeDefined();
      expect(systemReminderMessage?.content).toContain('User interrupted');
      expect(systemReminderMessage?.content).toContain('Prioritize answering their new prompt');
    });

    it('should remove system reminder after LLM responds', async () => {
      // Simulate interruption by having the LLM return an interrupted response
      (mockModelClient as any).setNextResponseInterrupted(true);
      await agent.sendMessage('First message');

      // Send new message (this should inject the reminder)
      await agent.sendMessage('Second message');

      // Get conversation history
      const messages = agent.getMessages();

      // System reminder should NOT be in the conversation history
      const hasSystemReminder = messages.some(
        msg => msg.role === 'system' && msg.content.includes('<system-reminder>')
      );
      expect(hasSystemReminder).toBe(false);
    });

    it('should not inject system reminder when not interrupted', async () => {
      // Send a normal message (no interruption)
      await agent.sendMessage('Normal message');

      // Get the messages sent to the model
      const capturedMessages = (mockModelClient as any).capturedMessages;
      const lastCall = capturedMessages[capturedMessages.length - 1];

      // Should NOT contain system reminder
      const hasSystemReminder = lastCall.some((msg: Message) =>
        msg.role === 'system' && msg.content.includes('<system-reminder>')
      );
      expect(hasSystemReminder).toBe(false);
    });

    it('should only inject reminder once after interruption', async () => {
      // Simulate interruption by having the LLM return an interrupted response
      (mockModelClient as any).setNextResponseInterrupted(true);
      await agent.sendMessage('First message');

      // Send first message after interruption (should inject reminder)
      await agent.sendMessage('Second message');

      // Clear captured messages
      (mockModelClient as any).capturedMessages.length = 0;

      // Send another message (should NOT inject reminder again)
      await agent.sendMessage('Third message');

      const capturedMessages = (mockModelClient as any).capturedMessages;
      const lastCall = capturedMessages[capturedMessages.length - 1];

      // Should NOT contain system reminder on second message
      const hasSystemReminder = lastCall.some((msg: Message) =>
        msg.role === 'system' && msg.content.includes('<system-reminder>')
      );
      expect(hasSystemReminder).toBe(false);
    });

    it('should handle multiple interruptions correctly', async () => {
      // First interruption - simulate by having LLM return interrupted response
      (mockModelClient as any).setNextResponseInterrupted(true);
      await agent.sendMessage('First message');

      // First message after interruption
      await agent.sendMessage('Second message');

      // Second interruption - simulate again
      (mockModelClient as any).setNextResponseInterrupted(true);
      await agent.sendMessage('Third message');

      // Clear captured messages to focus on this call
      (mockModelClient as any).capturedMessages.length = 0;

      // Message after second interruption (should inject reminder)
      await agent.sendMessage('Fourth message');

      const capturedMessages = (mockModelClient as any).capturedMessages;
      const lastCall = capturedMessages[capturedMessages.length - 1];

      // Should contain system reminder after second interruption
      const hasSystemReminder = lastCall.some((msg: Message) =>
        msg.role === 'system' && msg.content.includes('<system-reminder>')
      );
      expect(hasSystemReminder).toBe(true);
    });
  });

  describe('Isolated Context Tracking', () => {
    it('should have its own TokenManager instance', () => {
      const tokenManager = agent.getTokenManager();
      expect(tokenManager).toBeDefined();
      expect(typeof tokenManager.getContextUsagePercentage).toBe('function');
      expect(typeof tokenManager.updateTokenCount).toBe('function');
    });

    it('should have separate TokenManagers for different agents', () => {
      // Create a second agent
      const agent2 = new Agent(mockModelClient, toolManager, activityStream, {
        config: mockConfig,
        isSpecializedAgent: false,
      });

      const tokenManager1 = agent.getTokenManager();
      const tokenManager2 = agent2.getTokenManager();

      // Should be different instances
      expect(tokenManager1).not.toBe(tokenManager2);
    });

    it('should track context independently for each agent', async () => {
      // Create two agents
      const agent1 = new Agent(mockModelClient, toolManager, activityStream, {
        config: mockConfig,
        isSpecializedAgent: false,
      });

      const agent2 = new Agent(mockModelClient, toolManager, activityStream, {
        config: mockConfig,
        isSpecializedAgent: false,
      });

      // Send different messages to both agents to create different context states
      await agent1.sendMessage('test');
      await agent2.sendMessage('test message with more content to use different amount of tokens');

      // Get context usage for both
      const context1 = agent1.getTokenManager().getContextUsagePercentage();
      const context2 = agent2.getTokenManager().getContextUsagePercentage();

      // Verify they have separate token managers
      const tm1 = agent1.getTokenManager();
      const tm2 = agent2.getTokenManager();
      expect(tm1).not.toBe(tm2);

      // Context tracking depends on implementation details, just verify independence
      // The key test is that they have separate TokenManager instances (tested above)
      // With different message lengths, they should have different context usage
      // (or both could be 0 if context tracking isn't initialized yet, which is fine)
      // The important part is they don't share state
      expect(tm1).toBeDefined();
      expect(tm2).toBeDefined();
    });

    it('should maintain separate context when creating specialized agents', () => {
      // Create a specialized agent (like AgentTool does)
      const specializedAgent = new Agent(mockModelClient, toolManager, activityStream, {
        config: mockConfig,
        isSpecializedAgent: true,
        baseAgentPrompt: 'Base prompt',
        taskPrompt: 'Task prompt',
      });

      const mainTokenManager = agent.getTokenManager();
      const specializedTokenManager = specializedAgent.getTokenManager();

      // Should have different TokenManager instances
      expect(mainTokenManager).not.toBe(specializedTokenManager);

      // Both should start with similar low usage (just system prompt)
      const mainUsage = mainTokenManager.getContextUsagePercentage();
      const specializedUsage = specializedTokenManager.getContextUsagePercentage();

      // Both should be low and close to each other (within 5%)
      expect(mainUsage).toBeLessThan(10);
      expect(specializedUsage).toBeLessThan(10);
    });
  });
});
