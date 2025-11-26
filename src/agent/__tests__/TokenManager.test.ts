/**
 * TokenManager Tests
 *
 * Tests for performance optimizations:
 * - Tool result hash deduplication (O(1) lookup)
 * - Message token caching by ID
 * - Incremental token counting
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TokenManager } from '../TokenManager.js';
import { Message } from '../../types/index.js';

describe('TokenManager', () => {
  let tokenManager: TokenManager;

  beforeEach(() => {
    tokenManager = new TokenManager(16000);
  });

  describe('Tool Result Hash Deduplication', () => {
    it('should return null for first occurrence of content', () => {
      const result = tokenManager.trackToolResult('call-1', 'unique content');
      expect(result).toBeNull();
    });

    it('should return first call ID when duplicate content is found', () => {
      tokenManager.trackToolResult('call-1', 'duplicate content');
      const result = tokenManager.trackToolResult('call-2', 'duplicate content');
      expect(result).toBe('call-1');
    });

    it('should not consider same call ID as duplicate of itself', () => {
      tokenManager.trackToolResult('call-1', 'some content');
      const result = tokenManager.trackToolResult('call-1', 'some content');
      expect(result).toBeNull();
    });

    it('should track multiple different contents independently', () => {
      tokenManager.trackToolResult('call-1', 'content A');
      tokenManager.trackToolResult('call-2', 'content B');

      const resultA = tokenManager.trackToolResult('call-3', 'content A');
      const resultB = tokenManager.trackToolResult('call-4', 'content B');

      expect(resultA).toBe('call-1');
      expect(resultB).toBe('call-2');
    });

    it('should use O(1) lookup via hash map', () => {
      // Add many entries
      for (let i = 0; i < 100; i++) {
        tokenManager.trackToolResult(`call-${i}`, `unique content ${i}`);
      }

      // Lookup should still be fast (this tests the implementation indirectly)
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        tokenManager.trackToolResult(`new-call-${i}`, 'content to find');
      }
      const elapsed = performance.now() - start;

      // Should complete in reasonable time (< 100ms for 1000 lookups)
      expect(elapsed).toBeLessThan(100);
    });

    it('isToolResultDuplicate should return true for existing content', () => {
      tokenManager.trackToolResult('call-1', 'existing content');
      expect(tokenManager.isToolResultDuplicate('existing content')).toBe(true);
    });

    it('isToolResultDuplicate should return false for new content', () => {
      expect(tokenManager.isToolResultDuplicate('new content')).toBe(false);
    });
  });

  describe('Message Token Caching', () => {
    it('should cache token count by message ID', () => {
      const message: Message = {
        id: 'msg-1',
        role: 'user',
        content: 'Hello world',
        timestamp: Date.now(),
      };

      const messages = [message];

      // First call calculates tokens
      const count1 = tokenManager.estimateMessagesTokens(messages);

      // Second call should use cache (same result)
      const count2 = tokenManager.estimateMessagesTokens(messages);

      expect(count1).toBe(count2);
      expect(count1).toBeGreaterThan(0);
    });

    it('should handle messages without ID gracefully', () => {
      const message: Message = {
        role: 'user',
        content: 'No ID message',
        timestamp: Date.now(),
      } as Message;

      const messages = [message];

      // Should not throw, just skip caching
      const count = tokenManager.estimateMessagesTokens(messages);
      expect(count).toBeGreaterThan(0);
    });

    it('should return same count for spread message with same ID', () => {
      const original: Message = {
        id: 'msg-1',
        role: 'user',
        content: 'Original content',
        timestamp: Date.now(),
      };

      // Calculate and cache
      tokenManager.estimateMessagesTokens([original]);

      // Spread into new object (simulating what ConversationManager does)
      const spread: Message = { ...original };

      // Should still get cached result via ID lookup
      const count = tokenManager.estimateMessagesTokens([spread]);
      expect(count).toBeGreaterThan(0);
    });
  });

  describe('Incremental Token Counting', () => {
    it('should add tokens for a single message', () => {
      const message: Message = {
        id: 'msg-1',
        role: 'user',
        content: 'Hello world',
        timestamp: Date.now(),
      };

      expect(tokenManager.getCurrentTokenCount()).toBe(0);

      tokenManager.addMessageTokens(message);

      expect(tokenManager.getCurrentTokenCount()).toBeGreaterThan(0);
    });

    it('should accumulate tokens for multiple messages', () => {
      const msg1: Message = {
        id: 'msg-1',
        role: 'user',
        content: 'First message',
        timestamp: Date.now(),
      };
      const msg2: Message = {
        id: 'msg-2',
        role: 'assistant',
        content: 'Second message',
        timestamp: Date.now(),
      };

      tokenManager.addMessageTokens(msg1);
      const countAfterFirst = tokenManager.getCurrentTokenCount();

      tokenManager.addMessageTokens(msg2);
      const countAfterSecond = tokenManager.getCurrentTokenCount();

      expect(countAfterSecond).toBeGreaterThan(countAfterFirst);
    });

    it('should cache tokens when adding message with ID', () => {
      const message: Message = {
        id: 'msg-1',
        role: 'user',
        content: 'Cached message',
        timestamp: Date.now(),
      };

      tokenManager.addMessageTokens(message);

      // Now estimateMessagesTokens should use cached value
      const messages = [message];
      const count = tokenManager.estimateMessagesTokens(messages);

      expect(count).toBe(tokenManager.getCurrentTokenCount());
    });

    it('should produce same result as full recalculation', () => {
      const messages: Message[] = [
        { id: 'msg-1', role: 'user', content: 'Hello', timestamp: Date.now() },
        { id: 'msg-2', role: 'assistant', content: 'Hi there', timestamp: Date.now() },
        { id: 'msg-3', role: 'user', content: 'How are you?', timestamp: Date.now() },
      ];

      // Method 1: Incremental
      const tm1 = new TokenManager(16000);
      for (const msg of messages) {
        tm1.addMessageTokens(msg);
      }
      const incrementalCount = tm1.getCurrentTokenCount();

      // Method 2: Full recalculation
      const tm2 = new TokenManager(16000);
      tm2.updateTokenCount(messages);
      const fullCount = tm2.getCurrentTokenCount();

      expect(incrementalCount).toBe(fullCount);
    });
  });

  describe('Reset', () => {
    it('should clear all tracking state', () => {
      const message: Message = {
        id: 'msg-1',
        role: 'user',
        content: 'Test message',
        timestamp: Date.now(),
      };

      tokenManager.addMessageTokens(message);
      tokenManager.trackToolResult('call-1', 'some content');
      tokenManager.trackFileContent('/path/to/file', 'file content');

      expect(tokenManager.getCurrentTokenCount()).toBeGreaterThan(0);

      tokenManager.reset();

      expect(tokenManager.getCurrentTokenCount()).toBe(0);
      expect(tokenManager.isToolResultDuplicate('some content')).toBe(false);
      expect(tokenManager.hasSeenContent('/path/to/file')).toBe(false);
    });
  });
});
