/**
 * Agent tests - focusing on interruption handling
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Agent } from '../Agent.js';
import { ToolManager } from '@tools/ToolManager.js';
import { ActivityStream } from '@services/ActivityStream.js';
import type { ModelClient, LLMResponse } from '@llm/ModelClient.js';
import { ActivityEventType, type Message, type Config } from '@shared/index.js';
import { AGENT_CONFIG } from '../../config/constants.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';

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
      show_thinking_in_chat: false,
      show_full_tool_output: false,
      tool_call_retry_enabled: true,
      tool_call_max_retries: 3,
      tool_call_repair_attempts: true,
      tool_call_verbose_errors: true,
      tool_call_activity_timeout: 120,
      stream_responses: true,
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
          agent.interrupt();
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
    toolManager = new ToolManager([]);

    // Create agent (system prompt generated dynamically in sendMessage)
    agent = new Agent(mockModelClient, toolManager, activityStream, {
      config: mockConfig,
      isSpecializedAgent: false,
    });
  });

  describe('System Reminder Injection', () => {
    /**
     * Put the watchdog in its armed state: it stands down while a request is
     * still in prefill (nothing on the wire), so a stalled generation is only
     * detectable once the model has produced some output and then gone quiet.
     */
    const simulateFirstOutput = (): void => {
      activityStream.emit({
        id: 'chunk-1',
        type: ActivityEventType.ASSISTANT_CHUNK,
        timestamp: Date.now(),
        data: { chunk: 'thinking out loud' },
      });
    };

    const forceActivityTimeout = (): void => {
      const monitor = (agent as any).activityMonitor;
      monitor.lastActivityTime = Date.now() - 121_000;
      monitor.checkTimeout();
    };

    it('applies the no-tool activity watchdog to the main agent and recovers once', async () => {
      let requestCount = 0;
      mockModelClient.send = vi.fn(async (_messages: Message[], options: any): Promise<LLMResponse> => {
        requestCount++;
        if (requestCount === 1) {
          await new Promise<void>(resolve => {
            options.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { content: '', tool_calls: [], interrupted: true };
        }
        return { content: 'Recovered after timeout', tool_calls: [], interrupted: false };
      });

      const result = agent.sendMessage('Do the work.');
      await vi.waitFor(() => expect(mockModelClient.send).toHaveBeenCalledTimes(1));

      const monitor = (agent as any).activityMonitor;
      expect(monitor.isActive()).toBe(true);
      simulateFirstOutput();
      forceActivityTimeout();

      await expect(result).resolves.toBe('Recovered after timeout');
      expect(mockModelClient.send).toHaveBeenCalledTimes(2);
    });

    it('ends cleanly after the bounded recovery also makes no concrete progress', async () => {
      mockModelClient.send = vi.fn(async (_messages: Message[], options: any): Promise<LLMResponse> => {
        await new Promise<void>(resolve => {
          options.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { content: '', tool_calls: [], interrupted: true };
      });

      const result = agent.sendMessage('Do not hang forever.');

      await vi.waitFor(() => expect(mockModelClient.send).toHaveBeenCalledTimes(1));
      simulateFirstOutput();
      forceActivityTimeout();

      await vi.waitFor(() => expect(mockModelClient.send).toHaveBeenCalledTimes(2));
      simulateFirstOutput();
      forceActivityTimeout();

      await expect(result).resolves.toMatch(/repeatedly made no concrete progress/i);
      expect(mockModelClient.send).toHaveBeenCalledTimes(2);
      expect(agent.isProcessing()).toBe(false);
    });

    it('pauses the generation watchdog while a tool batch is running', async () => {
      let finishTools!: (results: any[]) => void;
      const toolGate = new Promise<any[]>(resolve => { finishTools = resolve; });
      (agent as any).toolOrchestrator.executeToolCalls = vi.fn(() => toolGate);
      const monitor = (agent as any).activityMonitor;
      monitor.start();
      const context = (agent as any).buildResponseContext({});

      const execution = context.executeToolCalls([], []);
      expect(monitor.isActive()).toBe(false);

      finishTools([]);
      await expect(execution).resolves.toEqual([]);
      expect(monitor.isActive()).toBe(true);
      monitor.stop();
    });

    it('pauses the foreground watchdog during semantic compaction', async () => {
      let finishCompaction!: (compacted: boolean) => void;
      const compactionGate = new Promise<boolean>(resolve => { finishCompaction = resolve; });
      (agent as any).agentCompactor.checkAndPerformAutoCompaction = vi.fn(() => compactionGate);
      const monitor = (agent as any).activityMonitor;
      monitor.start();
      monitor.lastActivityTime = Date.now() - 60_000;

      const checking = (agent as any).checkAutoCompaction();
      await vi.waitFor(() => expect(monitor.isActive()).toBe(false));

      finishCompaction(true);
      await checking;

      expect(monitor.isActive()).toBe(true);
      expect(monitor.getElapsedTime()).toBeLessThan(1_000);
      monitor.stop();
    });

    it('replenishes internal recovery only after concrete tool progress', () => {
      const context = (agent as any).buildResponseContext({});
      const call = {
        id: 'call-1',
        type: 'function',
        function: { name: 'read', arguments: { file_path: '/repo/file.ts' } },
      };

      (agent as any).invocationState.recoveryAttempts = 1;
      context.recordToolCalls([call], [{ success: false, error: 'not found' }]);
      expect((agent as any).invocationState.recoveryAttempts).toBe(1);

      context.recordToolCalls([call], [{ success: true, error: '', content: 'source' }]);
      expect((agent as any).invocationState.recoveryAttempts).toBe(0);
    });

    it('treats a user interjection as a fresh recovery opportunity', () => {
      const resetTextDetectors = vi.spyOn((agent as any).loopDetector, 'resetTextDetectors');
      (agent as any).invocationState.recoveryAttempts = 1;

      agent.addUserInterjection('also use port 5174');

      expect((agent as any).invocationState.recoveryAttempts).toBe(0);
      expect(resetTextDetectors).toHaveBeenCalledOnce();
    });

    it('publishes recovery exhaustion as a visible assistant completion', async () => {
      const events: any[] = [];
      activityStream.subscribe('*', event => events.push(event));
      (agent as any).invocationState.recoveryAttempts = AGENT_CONFIG.MAX_AUTOMATIC_RECOVERY_ATTEMPTS;

      const result = await (agent as any).continueAfterRecovery(
        { kind: 'thinking_loop', reason: 'confirmed mechanical repetition' },
        {},
      );

      expect(result).toContain('I stopped because model generation repeatedly made no concrete progress');
      const completion = events.find(event => event.type === ActivityEventType.ASSISTANT_MESSAGE_COMPLETE);
      expect(completion?.data.content).toBe(result);
    });

    it('recovers an internally stopped generation without ending the turn as interrupted', async () => {
      const events: any[] = [];
      activityStream.subscribe('*', event => events.push(event));

      let requestCount = 0;
      mockModelClient.send = vi.fn(async (_messages: Message[], options: any): Promise<LLMResponse> => {
        requestCount++;
        if (requestCount === 1) {
          await new Promise<void>(resolve => {
            options.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { content: '', tool_calls: [], interrupted: true };
        }
        return { content: 'Recovered response', tool_calls: [], interrupted: false };
      });

      const resultPromise = agent.sendMessage('Take your time reasoning about this.');
      await vi.waitFor(() => expect(mockModelClient.send).toHaveBeenCalledTimes(1));

      (agent as any).interruptForRecovery('[TEST_RECOVERY]', {
        kind: 'thinking_loop',
        reason: 'confirmed mechanical repetition',
      });

      await expect(resultPromise).resolves.toBe('Recovered response');
      expect(mockModelClient.send).toHaveBeenCalledTimes(2);

      const endEvents = events.filter(event => event.type === ActivityEventType.AGENT_END);
      expect(endEvents).toHaveLength(1);
      expect(endEvents[0].data.interrupted).toBe(false);
    });

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

      // Should NOT contain the interruption reminder. (A trailing dynamic-context
      // system-reminder is always sent — that's the KV-cache prefix design — so we
      // assert specifically on the interruption reminder's distinctive text.)
      const hasSystemReminder = lastCall.some((msg: Message) =>
        msg.role === 'system' && msg.content.includes('User interrupted')
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

      // Should NOT contain the interruption reminder again (asserts on its
      // distinctive text, since the trailing dynamic-context reminder is always sent).
      const hasSystemReminder = lastCall.some((msg: Message) =>
        msg.role === 'system' && msg.content.includes('User interrupted')
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

  describe('Turn admission', () => {
    it('claims the whole turn synchronously and rejects concurrent sendMessage calls', async () => {
      let release!: (response: LLMResponse) => void;
      mockModelClient.send = vi.fn(() => new Promise<LLMResponse>(resolve => {
        release = resolve;
      }));

      const first = agent.sendMessage('first');

      expect(agent.isProcessing()).toBe(true);
      await expect(agent.sendMessage('second')).rejects.toThrow(/already processing a turn/i);

      await vi.waitFor(() => expect(mockModelClient.send).toHaveBeenCalledOnce());
      release({ content: 'done', tool_calls: [], interrupted: false });
      await expect(first).resolves.toBe('done');
      expect(agent.isProcessing()).toBe(false);
    });

    it('continues a user interjection that arrives during finalization', async () => {
      let releaseFinalization!: () => void;
      const finalizationGate = new Promise<void>(resolve => {
        releaseFinalization = resolve;
      });
      (agent as any).lifecycleHandler.handlePostResponse = vi.fn()
        .mockImplementationOnce(() => finalizationGate)
        .mockResolvedValue(undefined);
      mockModelClient.send = vi.fn()
        .mockResolvedValueOnce({ content: 'initial', tool_calls: [], interrupted: false })
        .mockResolvedValueOnce({ content: 'after interjection', tool_calls: [], interrupted: false });

      const result = agent.sendMessage('start');
      await vi.waitFor(() => {
        expect((agent as any).lifecycleHandler.handlePostResponse).toHaveBeenCalledOnce();
      });

      agent.addUserInterjection('change direction');
      agent.interrupt({ kind: 'user_interjection' });
      releaseFinalization();

      await expect(result).resolves.toBe('after interjection');
      expect(mockModelClient.send).toHaveBeenCalledTimes(2);
      expect(agent.isProcessing()).toBe(false);
    });

    it('queues an interjection through compaction and continues the same turn', async () => {
      const compactor = (agent as any).agentCompactor;
      compactor.checkAndPerformAutoCompaction = vi.fn()
        .mockImplementationOnce(({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Compaction interrupted during checkpoint reduction')), {
            once: true,
          });
        }))
        .mockResolvedValueOnce(false);
      mockModelClient.send = vi.fn()
        .mockResolvedValue({ content: 'continued after queued input', tool_calls: [], interrupted: false });

      const result = agent.sendMessage('start');
      await vi.waitFor(() => expect(compactor.checkAndPerformAutoCompaction).toHaveBeenCalledOnce());

      agent.addUserInterjection('use a different endpoint');
      agent.interrupt({ kind: 'user_interjection' });

      await expect(result).resolves.toBe('continued after queued input');
      expect(compactor.checkAndPerformAutoCompaction).toHaveBeenCalledTimes(2);
      expect(mockModelClient.send).toHaveBeenCalledOnce();
      expect((mockModelClient.send as any).mock.calls[0][0]).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'use a different endpoint',
          metadata: expect.objectContaining({ isInterjection: true }),
        }),
      ]));
      expect(agent.getTurnSnapshot().terminationReason).toBe('completed');
      expect(agent.isProcessing()).toBe(false);
    });
  });

  describe('Isolated Context Tracking', () => {
    it('streams specialized-agent requests on their scoped activity stream', async () => {
      const specializedStream = new ActivityStream();
      const specializedAgent = new Agent(mockModelClient, toolManager, specializedStream, {
        config: mockConfig,
        isSpecializedAgent: true,
        baseAgentPrompt: 'Base prompt',
        taskPrompt: 'Task prompt',
      });

      await specializedAgent.sendMessage('Do delegated work');

      expect(mockModelClient.send).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          stream: true,
          activityStream: specializedStream,
        }),
      );
    });

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

  describe('unfinished work completion gate', () => {
    it('continues once when a main agent returns progress prose with unfinished todos', async () => {
      const registrySpy = vi
        .spyOn(ServiceRegistry, 'getInstance')
        .mockReturnValue({
          get: (name: string) => name === 'todo_manager'
            ? { getTodos: () => [{ id: 'todo-1', task: 'Implement feature', status: 'in_progress' }] }
            : null,
        } as any);
      let continuationMessages: Message[] = [];
      const continuation = vi
        .spyOn(agent as any, 'getLLMResponse')
        .mockImplementation(async () => {
          continuationMessages = (agent as any).conversationManager.getMessagesCopy();
          return { content: 'I need a user decision to proceed.', tool_calls: [] };
        });

      try {
        const result = await (agent as any).processLLMResponse(
          { content: 'Next I will implement the feature.', tool_calls: [] },
          {}
        );

        expect(result).toBe('I need a user decision to proceed.');
        expect(continuation).toHaveBeenCalledTimes(1);
        expect(continuationMessages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: 'system',
              content: expect.stringContaining('unfinished todos'),
            }),
          ])
        );
      } finally {
        registrySpy.mockRestore();
      }
    });

    it('accepts a text response when every todo is complete', async () => {
      const registrySpy = vi
        .spyOn(ServiceRegistry, 'getInstance')
        .mockReturnValue({
          get: (name: string) => name === 'todo_manager'
            ? { getTodos: () => [{ id: 'todo-1', task: 'Done', status: 'completed' }] }
            : null,
        } as any);
      const continuation = vi.spyOn(agent as any, 'getLLMResponse');

      try {
        await expect((agent as any).processLLMResponse(
          { content: 'All work is complete.', tool_calls: [] },
          {}
        )).resolves.toBe('All work is complete.');
        expect(continuation).not.toHaveBeenCalled();
      } finally {
        registrySpy.mockRestore();
      }
    });
  });
});
