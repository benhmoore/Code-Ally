/**
 * AutoToolCleanupService unit tests
 *
 * Tests automatic identification and cleanup of irrelevant tool calls
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AutoToolCleanupService } from '../AutoToolCleanupService.js';
import { ModelClient, LLMResponse } from '../../llm/ModelClient.js';
import { Message } from '../../types/index.js';
import { AUTO_TOOL_CLEANUP } from '../../config/constants.js';

// Mock ModelClient
class MockModelClient extends ModelClient {
  private mockAnalysis: any = {
    irrelevant_ids: [],
  };

  private shouldThrow: boolean = false;
  private shouldInterrupt: boolean = false;
  public cancelCalled: boolean = false;

  setMockAnalysis(analysis: any) {
    this.mockAnalysis = analysis;
  }

  setShouldThrow(value: boolean) {
    this.shouldThrow = value;
  }

  setShouldInterrupt(value: boolean) {
    this.shouldInterrupt = value;
  }

  async send(): Promise<LLMResponse> {
    if (this.shouldThrow) {
      throw new Error('API error');
    }

    const response: any = {
      role: 'assistant',
      content: JSON.stringify(this.mockAnalysis),
    };

    if (this.shouldInterrupt) {
      response.interrupted = true;
    }

    return response;
  }

  cancel(): void {
    this.cancelCalled = true;
  }

  get modelName(): string {
    return 'mock-model';
  }

  get endpoint(): string {
    return 'http://mock';
  }
}

// Mock SessionManager
class MockSessionManager {
  private metadata: any = {};
  private sessionData: any = null;

  async updateMetadata(_sessionName: string, updates: any) {
    this.metadata = { ...this.metadata, ...updates };
    return true;
  }

  async loadSession(_sessionName: string) {
    return this.sessionData;
  }

  setSessionData(data: any) {
    this.sessionData = data;
  }

  getMetadata() {
    return this.metadata;
  }

  getCurrentSession() {
    return 'test_session';
  }
}

describe('AutoToolCleanupService', () => {
  let mockClient: MockModelClient;
  let mockSessionManager: MockSessionManager;
  let service: AutoToolCleanupService;


  beforeEach(() => {
    mockClient = new MockModelClient();
    mockSessionManager = new MockSessionManager();
    service = new AutoToolCleanupService(mockClient, mockSessionManager as any, true);
  });

  afterEach(async () => {
    await service.cleanup();
  });

  describe('shouldAnalyze', () => {
    it('should require minimum tool results', () => {
      // Create messages with fewer than MIN_TOOL_RESULTS
      const messages: Message[] = Array(AUTO_TOOL_CLEANUP.MIN_TOOL_RESULTS - 1)
        .fill(null)
        .map((_, i) => ({
          role: 'tool',
          content: `result ${i}`,
          tool_call_id: `call_${i}`,
        }));

      const result = service.shouldAnalyze(messages);
      expect(result).toBe(false);
    });

    it('should require minimum time interval', () => {
      // Create messages with enough tool results
      const messages: Message[] = Array(AUTO_TOOL_CLEANUP.MIN_TOOL_RESULTS)
        .fill(null)
        .map((_, i) => ({
          role: 'tool',
          content: `result ${i}`,
          tool_call_id: `call_${i}`,
        }));

      // Set last analysis to just now (within MIN_INTERVAL)
      const lastAnalysisAt = Date.now();

      const result = service.shouldAnalyze(messages, lastAnalysisAt);
      expect(result).toBe(false);
    });

    it('should return false when already analyzing', () => {
      const messages: Message[] = Array(AUTO_TOOL_CLEANUP.MIN_TOOL_RESULTS)
        .fill(null)
        .map((_, i) => ({
          role: 'tool',
          content: `result ${i}`,
          tool_call_id: `call_${i}`,
        }));

      // Start a background analysis to set isAnalyzing flag
      service.cleanupBackground('test', messages);

      // Should return false because already analyzing
      const result = service.shouldAnalyze(messages);
      expect(result).toBe(false);
    });

    it('should return true when all conditions met', () => {
      // Create messages with enough tool results
      const messages: Message[] = Array(AUTO_TOOL_CLEANUP.MIN_TOOL_RESULTS)
        .fill(null)
        .map((_, i) => ({
          role: 'tool',
          content: `result ${i}`,
          tool_call_id: `call_${i}`,
        }));

      // Set last analysis to long ago (beyond MIN_INTERVAL)
      const lastAnalysisAt = Date.now() - AUTO_TOOL_CLEANUP.MIN_INTERVAL - 1000;

      const result = service.shouldAnalyze(messages, lastAnalysisAt);
      expect(result).toBe(true);
    });
  });

  describe('analyzeToolCalls', () => {
    it('should identify failed and retried tool calls', async () => {
      // Create messages with failed tool call followed by successful retry
      // Then add a recent assistant turn to ensure the old calls are analyzed
      const oldMessages: Message[] = [
        {
          role: 'assistant',
          content: 'Let me search for that',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'grep', arguments: { pattern: 'test' } },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Error: pattern not found',
          tool_call_id: 'call_1',
        },
        {
          role: 'assistant',
          content: 'Let me try a different pattern',
          tool_calls: [
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'grep', arguments: { pattern: 'test2' } },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Found 5 matches',
          tool_call_id: 'call_2',
        },
      ];

      // Add a user message to separate turns, then a recent assistant turn
      const recentTurn: Message[] = [
        {
          role: 'user',
          content: 'Now do something else',
        },
        {
          role: 'assistant',
          content: 'Recent work in progress',
          tool_calls: [
            {
              id: 'call_recent',
              type: 'function',
              function: { name: 'read', arguments: { path: 'test.ts' } },
            },
          ],
        },
        {
          role: 'tool',
          content: 'File contents',
          tool_call_id: 'call_recent',
        },
      ];

      const messages = [...oldMessages, ...recentTurn];

      mockClient.setMockAnalysis({ irrelevant_ids: ['call_1'] });

      const result = await service.analyzeToolCalls(messages);
      expect(result.irrelevantToolCallIds).toEqual(['call_1']);
    });

    it('should identify duplicate reads', async () => {
      const toolMessages: Message[] = [
        {
          role: 'assistant',
          content: 'Reading file',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: { path: 'test.ts' } },
            },
          ],
        },
        {
          role: 'tool',
          content: 'File contents here',
          tool_call_id: 'call_1',
        },
        {
          role: 'assistant',
          content: 'Reading same file again',
          tool_calls: [
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'read', arguments: { path: 'test.ts' } },
            },
          ],
        },
        {
          role: 'tool',
          content: 'File contents here',
          tool_call_id: 'call_2',
        },
      ];

      // Add a user message to separate turns, then a recent assistant turn
      const recentTurn: Message[] = [
        {
          role: 'user',
          content: 'Continue',
        },
        {
          role: 'assistant',
          content: 'Recent work',
        },
      ];

      const messages = [...toolMessages, ...recentTurn];

      mockClient.setMockAnalysis({ irrelevant_ids: ['call_2'] });

      const result = await service.analyzeToolCalls(messages);
      expect(result.irrelevantToolCallIds).toContain('call_2');
    });

    it('should update session metadata with pendingToolCleanups', async () => {
      // Need at least 2 tool calls in old turns so 50% = 1 call analyzed
      const toolMessages: Message[] = [
        {
          role: 'assistant',
          content: 'First tool call',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Result 1',
          tool_call_id: 'call_1',
        },
        {
          role: 'assistant',
          content: 'Second tool call',
          tool_calls: [
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'grep', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Result 2',
          tool_call_id: 'call_2',
        },
      ];

      // Add a user message to separate turns, then a recent assistant turn
      const recentTurn: Message[] = [
        {
          role: 'user',
          content: 'Next step',
        },
        {
          role: 'assistant',
          content: 'Recent work',
        },
      ];

      const messages = [...toolMessages, ...recentTurn];

      mockClient.setMockAnalysis({ irrelevant_ids: ['call_1'] });
      mockSessionManager.setSessionData({
        id: 'test',
        name: 'test',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        messages: [],
        metadata: {},
      });

      // Run cleanup in background
      service.cleanupBackground('test_session', messages);

      // Wait for background operation
      await new Promise(resolve => setTimeout(resolve, 150));

      const metadata = mockSessionManager.getMetadata();
      expect(metadata.pendingToolCleanups).toBeDefined();
      expect(Array.isArray(metadata.pendingToolCleanups)).toBe(true);
      expect(metadata.pendingToolCleanups).toContain('call_1');
    });

    it('should update lastCleanupAnalysisAt timestamp', async () => {
      // Need at least 2 tool calls in old turns so 50% = 1 call analyzed
      const toolMessages: Message[] = [
        {
          role: 'assistant',
          content: 'First tool call',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Result 1',
          tool_call_id: 'call_1',
        },
        {
          role: 'assistant',
          content: 'Second tool call',
          tool_calls: [
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'grep', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Result 2',
          tool_call_id: 'call_2',
        },
      ];

      // Add a user message to separate turns, then a recent assistant turn
      const recentTurn: Message[] = [
        {
          role: 'user',
          content: 'Next step',
        },
        {
          role: 'assistant',
          content: 'Recent work',
        },
      ];

      const messages = [...toolMessages, ...recentTurn];

      mockClient.setMockAnalysis({ irrelevant_ids: ['call_1'] });
      mockSessionManager.setSessionData({
        id: 'test',
        name: 'test',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        messages: [],
        metadata: {},
      });

      const beforeTime = Date.now();

      // Run cleanup in background
      service.cleanupBackground('test_session', messages);

      // Wait for background operation
      await new Promise(resolve => setTimeout(resolve, 150));

      const metadata = mockSessionManager.getMetadata();
      expect(metadata.lastCleanupAnalysisAt).toBeDefined();
      expect(metadata.lastCleanupAnalysisAt).toBeGreaterThanOrEqual(beforeTime);
      expect(metadata.lastCleanupAnalysisAt).toBeLessThanOrEqual(Date.now());
    });

    it('should filter to high-confidence only', async () => {
      // Need at least 2 tool calls in old turns so 50% = 1 call analyzed
      const toolMessages: Message[] = [
        {
          role: 'assistant',
          content: 'First tool call',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Result 1',
          tool_call_id: 'call_1',
        },
        {
          role: 'assistant',
          content: 'Second tool call',
          tool_calls: [
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'grep', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Result 2',
          tool_call_id: 'call_2',
        },
      ];

      // Add a user message to separate turns, then a recent assistant turn
      const recentTurn: Message[] = [
        {
          role: 'user',
          content: 'Next step',
        },
        {
          role: 'assistant',
          content: 'Recent work',
        },
      ];

      const messages = [...toolMessages, ...recentTurn];

      // Model returns only high-confidence removals
      mockClient.setMockAnalysis({ irrelevant_ids: ['call_1'] });

      const result = await service.analyzeToolCalls(messages);
      expect(result.irrelevantToolCallIds).toEqual(['call_1']);
    });

    it('should handle empty analysis gracefully', async () => {
      const messages: Message[] = [];

      const result = await service.analyzeToolCalls(messages);
      expect(result.irrelevantToolCallIds).toEqual([]);
    });

    it('should handle model errors gracefully', async () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: 'Tool call',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Result',
          tool_call_id: 'call_1',
        },
      ];

      mockClient.setShouldThrow(true);

      const result = await service.analyzeToolCalls(messages);
      expect(result.irrelevantToolCallIds).toEqual([]);
    });

    it('should handle interrupted responses gracefully', async () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: 'Tool call',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Result',
          tool_call_id: 'call_1',
        },
      ];

      mockClient.setShouldInterrupt(true);

      const result = await service.analyzeToolCalls(messages);
      expect(result.irrelevantToolCallIds).toEqual([]);
    });

    it('should return empty when cleanup disabled', async () => {
      const disabledService = new AutoToolCleanupService(
        mockClient,
        mockSessionManager as any,
        false
      );

      const messages: Message[] = [
        {
          role: 'assistant',
          content: 'Tool call',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Result',
          tool_call_id: 'call_1',
        },
      ];

      mockClient.setMockAnalysis({ irrelevant_ids: ['call_1'] });

      const result = await disabledService.analyzeToolCalls(messages);
      expect(result.irrelevantToolCallIds).toEqual([]);

      await disabledService.cleanup();
    });
  });

  describe('cleanupBackground', () => {
    it('should skip if conditions not met', () => {
      // Create messages with insufficient tool results
      const messages: Message[] = [
        {
          role: 'user',
          content: 'Test message',
        },
      ];

      // This should not trigger analysis
      service.cleanupBackground('test_session', messages);

      // The service shouldn't be analyzing
      const shouldAnalyze = service.shouldAnalyze(messages);
      expect(shouldAnalyze).toBe(false);
    });

    it('should not start if already analyzing', () => {
      const messages: Message[] = Array(AUTO_TOOL_CLEANUP.MIN_TOOL_RESULTS)
        .fill(null)
        .map((_, i) => ({
          role: 'tool',
          content: `result ${i}`,
          tool_call_id: `call_${i}`,
        }));

      // Start first analysis
      service.cleanupBackground('test_session_1', messages);

      // Try to start second analysis - should be skipped
      service.cleanupBackground('test_session_2', messages);

      // Should still be analyzing from first call
      expect(service.shouldAnalyze(messages)).toBe(false);
    });

    it('should handle errors without throwing', async () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: 'Tool call',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Result',
          tool_call_id: 'call_1',
        },
      ];

      mockClient.setShouldThrow(true);
      mockSessionManager.setSessionData({
        id: 'test',
        name: 'test',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        messages: [],
        metadata: {},
      });

      // Should not throw
      expect(() => {
        service.cleanupBackground('test_session', messages);
      }).not.toThrow();

      // Wait for background operation to complete
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    it('should prevent duplicate analyses for same session', async () => {
      // Need at least 2 tool calls in old turns so 50% = 1 call analyzed
      const toolMessages: Message[] = [
        {
          role: 'assistant',
          content: 'First tool call',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Result 1',
          tool_call_id: 'call_1',
        },
        {
          role: 'assistant',
          content: 'Second tool call',
          tool_calls: [
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'grep', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Result 2',
          tool_call_id: 'call_2',
        },
      ];

      // Add a user message to separate turns, then a recent assistant turn
      const recentTurn: Message[] = [
        {
          role: 'user',
          content: 'Next step',
        },
        {
          role: 'assistant',
          content: 'Recent work',
        },
      ];

      const messages = [...toolMessages, ...recentTurn];

      mockSessionManager.setSessionData({
        id: 'test',
        name: 'test',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        messages: [],
        metadata: {},
      });

      let callCount = 0;
      const countingClient = new MockModelClient();
      countingClient.send = async () => {
        callCount++;
        await new Promise(resolve => setTimeout(resolve, 50));
        return {
          role: 'assistant',
          content: JSON.stringify({ irrelevant_ids: [] }),
        };
      };

      const countingService = new AutoToolCleanupService(
        countingClient,
        mockSessionManager as any,
        true
      );

      // Call multiple times quickly
      countingService.cleanupBackground('test_session', messages);
      countingService.cleanupBackground('test_session', messages);
      countingService.cleanupBackground('test_session', messages);

      // Wait for operations
      await new Promise(resolve => setTimeout(resolve, 200));

      // Should only have called once
      expect(callCount).toBe(1);

      await countingService.cleanup();
    });
  });

  describe('cancel', () => {
    it('should cancel ongoing analysis', async () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: 'Tool call',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Result',
          tool_call_id: 'call_1',
        },
      ];

      // Start analysis
      service.cleanupBackground('test_session', messages);

      // Cancel it
      service.cancel();

      expect(mockClient.cancelCalled).toBe(true);
    });

    it('should reset isAnalyzing flag', () => {
      const messages: Message[] = Array(AUTO_TOOL_CLEANUP.MIN_TOOL_RESULTS)
        .fill(null)
        .map((_, i) => ({
          role: 'tool',
          content: `result ${i}`,
          tool_call_id: `call_${i}`,
        }));

      // Start analysis
      service.cleanupBackground('test_session', messages);

      // Should be analyzing
      expect(service.shouldAnalyze(messages)).toBe(false);

      // Cancel
      service.cancel();

      // Should not be analyzing anymore
      const lastAnalysisAt = Date.now() - AUTO_TOOL_CLEANUP.MIN_INTERVAL - 1000;
      expect(service.shouldAnalyze(messages, lastAnalysisAt)).toBe(true);
    });
  });

  describe('extractToolCallInfos', () => {
    it('should preserve all tool calls when no user messages exist', async () => {
      // Test the edge case where conversation has only assistant and tool messages
      // In this case, all tool calls should be preserved (none analyzed)
      const messages: Message[] = [
        {
          role: 'assistant',
          content: 'First tool call',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: { path: 'test.ts' } },
            },
          ],
        },
        {
          role: 'tool',
          content: 'File contents',
          tool_call_id: 'call_1',
        },
        {
          role: 'assistant',
          content: 'Second tool call',
          tool_calls: [
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'grep', arguments: { pattern: 'test' } },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Search results',
          tool_call_id: 'call_2',
        },
      ];

      mockClient.setMockAnalysis({ irrelevant_ids: ['call_1', 'call_2'] });

      const result = await service.analyzeToolCalls(messages);
      // Should return empty because no tool calls are eligible for analysis
      // (entire conversation is treated as one turn and should be preserved)
      expect(result.irrelevantToolCallIds).toEqual([]);
    });

    it('should extract tool call information correctly', async () => {
      const toolMessages: Message[] = [
        {
          role: 'assistant',
          content: 'Running tools',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: { path: 'test.ts' } },
            },
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'grep', arguments: { pattern: 'test' } },
            },
          ],
        },
        {
          role: 'tool',
          content: 'File contents',
          tool_call_id: 'call_1',
        },
        {
          role: 'tool',
          content: 'Search results',
          tool_call_id: 'call_2',
        },
      ];

      // Add a user message to separate turns, then a recent assistant turn
      const recentTurn: Message[] = [
        {
          role: 'user',
          content: 'Next step',
        },
        {
          role: 'assistant',
          content: 'Recent work',
        },
      ];

      const messages = [...toolMessages, ...recentTurn];

      mockClient.setMockAnalysis({ irrelevant_ids: ['call_1', 'call_2'] });

      const result = await service.analyzeToolCalls(messages);
      expect(result.irrelevantToolCallIds.length).toBe(2);
    });

    it('should preserve last assistant turn', async () => {
      // Create messages with old tool calls followed by a recent assistant turn
      // Need at least 2 tool calls in old turns so 50% = 1 call analyzed
      const oldMessages: Message[] = [
        {
          role: 'assistant',
          content: 'First old tool call',
          tool_calls: [
            {
              id: 'call_old_1',
              type: 'function',
              function: { name: 'read', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Old result 1',
          tool_call_id: 'call_old_1',
        },
        {
          role: 'assistant',
          content: 'Second old tool call',
          tool_calls: [
            {
              id: 'call_old_2',
              type: 'function',
              function: { name: 'glob', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Old result 2',
          tool_call_id: 'call_old_2',
        },
      ];

      // Add user message to separate turns, then last assistant turn with recent tool call (should be excluded from analysis)
      const lastAssistantTurn: Message[] = [
        {
          role: 'user',
          content: 'Do something else',
        },
        {
          role: 'assistant',
          content: 'Recent tool call',
          tool_calls: [
            {
              id: 'call_recent',
              type: 'function',
              function: { name: 'grep', arguments: { pattern: 'test' } },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Recent result',
          tool_call_id: 'call_recent',
        },
      ];

      const messages = [...oldMessages, ...lastAssistantTurn];

      mockClient.setMockAnalysis({ irrelevant_ids: ['call_old_1'] });

      const result = await service.analyzeToolCalls(messages);
      // Last assistant turn should be preserved, so only old calls are analyzed
      expect(result.irrelevantToolCallIds).toEqual(['call_old_1']);
    });
  });

  describe('parseAnalysisResponse', () => {
    it('should parse valid JSON response', async () => {
      // Need at least 2 tool calls in old turns so 50% = 1 call analyzed
      const toolMessages: Message[] = [
        {
          role: 'assistant',
          content: 'First tool call',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Result 1',
          tool_call_id: 'call_1',
        },
        {
          role: 'assistant',
          content: 'Second tool call',
          tool_calls: [
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'grep', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Result 2',
          tool_call_id: 'call_2',
        },
      ];

      // Add a user message to separate turns, then a recent assistant turn
      const recentTurn: Message[] = [
        {
          role: 'user',
          content: 'Next step',
        },
        {
          role: 'assistant',
          content: 'Recent work',
        },
      ];

      const messages = [...toolMessages, ...recentTurn];

      mockClient.setMockAnalysis({ irrelevant_ids: ['call_1'] });

      const result = await service.analyzeToolCalls(messages);
      expect(result.irrelevantToolCallIds).toEqual(['call_1']);
    });

    it('should handle malformed JSON gracefully', async () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: 'Tool call',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Result',
          tool_call_id: 'call_1',
        },
      ];

      // Set invalid JSON
      mockClient.send = async () => ({
        role: 'assistant',
        content: 'Not valid JSON at all',
      });

      const result = await service.analyzeToolCalls(messages);
      expect(result.irrelevantToolCallIds).toEqual([]);
    });

    it('should handle response with text around JSON', async () => {
      // Need at least 2 tool calls in old turns so 50% = 1 call analyzed
      const toolMessages: Message[] = [
        {
          role: 'assistant',
          content: 'First tool call',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Result 1',
          tool_call_id: 'call_1',
        },
        {
          role: 'assistant',
          content: 'Second tool call',
          tool_calls: [
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'grep', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Result 2',
          tool_call_id: 'call_2',
        },
      ];

      // Add a user message to separate turns, then a recent assistant turn
      const recentTurn: Message[] = [
        {
          role: 'user',
          content: 'Next step',
        },
        {
          role: 'assistant',
          content: 'Recent work',
        },
      ];

      const messages = [...toolMessages, ...recentTurn];

      // Set response with surrounding text
      mockClient.send = async () => ({
        role: 'assistant',
        content: 'Here is the analysis:\n\n{"irrelevant_ids": ["call_1"]}\n\nDone!',
      });

      const result = await service.analyzeToolCalls(messages);
      expect(result.irrelevantToolCallIds).toEqual(['call_1']);
    });
  });

  describe('cleanup', () => {
    it('should wait for pending analyses', async () => {
      let analysisComplete = false;

      const slowClient = new MockModelClient();
      slowClient.send = async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        analysisComplete = true;
        return {
          role: 'assistant',
          content: JSON.stringify({ irrelevant_ids: [] }),
        };
      };

      const slowService = new AutoToolCleanupService(
        slowClient,
        mockSessionManager as any,
        true
      );

      // Need at least 2 tool calls in old turns so 50% = 1 call analyzed
      const toolMessages: Message[] = [
        {
          role: 'assistant',
          content: 'First tool call',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Result 1',
          tool_call_id: 'call_1',
        },
        {
          role: 'assistant',
          content: 'Second tool call',
          tool_calls: [
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'grep', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Result 2',
          tool_call_id: 'call_2',
        },
      ];

      // Add a user message to separate turns, then a recent assistant turn
      const recentTurn: Message[] = [
        {
          role: 'user',
          content: 'Next step',
        },
        {
          role: 'assistant',
          content: 'Recent work',
        },
      ];

      const messages = [...toolMessages, ...recentTurn];

      mockSessionManager.setSessionData({
        id: 'test',
        name: 'test',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        messages: [],
        metadata: {},
      });

      // Start background analysis
      slowService.cleanupBackground('test_session', messages);

      // Cleanup should wait
      await slowService.cleanup();

      expect(analysisComplete).toBe(true);
    });

    it('should timeout if analyses take too long', async () => {
      const verySlowClient = new MockModelClient();
      verySlowClient.send = async () => {
        await new Promise(resolve => setTimeout(resolve, 10000)); // 10 seconds
        return {
          role: 'assistant',
          content: JSON.stringify({ irrelevant_ids: [] }),
        };
      };

      const verySlowService = new AutoToolCleanupService(
        verySlowClient,
        mockSessionManager as any,
        true
      );

      const messages: Message[] = [
        {
          role: 'assistant',
          content: 'Tool call',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Result',
          tool_call_id: 'call_1',
        },
      ];

      mockSessionManager.setSessionData({
        id: 'test',
        name: 'test',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        messages: [],
        metadata: {},
      });

      // Start background analysis
      verySlowService.cleanupBackground('test_session', messages);

      const startTime = Date.now();
      await verySlowService.cleanup();
      const endTime = Date.now();

      // Should timeout within ~5 seconds (CLEANUP_MAX_WAIT)
      expect(endTime - startTime).toBeLessThan(7000);
    }, 10000); // Increase test timeout to 10 seconds
  });

  describe('configuration', () => {
    it('should accept custom configuration', () => {
      const customService = new AutoToolCleanupService(
        mockClient,
        mockSessionManager as any,
        true,
        {
          maxTokens: 100,
          temperature: 0.5,
        }
      );

      // Configuration is accepted but not exposed as properties
      expect(customService).toBeDefined();
    });

    it('should work with default configuration', () => {
      expect(service).toBeDefined();
    });

    it('should respect enableCleanup flag', async () => {
      const disabledService = new AutoToolCleanupService(
        mockClient,
        mockSessionManager as any,
        false
      );

      const messages: Message[] = [
        {
          role: 'assistant',
          content: 'Tool call',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read', arguments: {} },
            },
          ],
        },
        {
          role: 'tool',
          content: 'Result',
          tool_call_id: 'call_1',
        },
      ];

      const result = await disabledService.analyzeToolCalls(messages);
      expect(result.irrelevantToolCallIds).toEqual([]);

      await disabledService.cleanup();
    });
  });
});
