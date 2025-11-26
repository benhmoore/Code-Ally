/**
 * Tests for MessageHistory
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MessageHistory } from '../MessageHistory.js';
import { Message } from '@shared/index.js';

describe('MessageHistory', () => {
  let history: MessageHistory;

  beforeEach(() => {
    history = new MessageHistory({
      maxMessages: 100,
      maxTokens: 1000,
    });
  });

  describe('Message Management', () => {
    it('should add a single message', () => {
      const message: Message = {
        role: 'user',
        content: 'Hello',
      };

      history.addMessage(message);

      expect(history.messageCount).toBe(1);
      expect(history.getMessages()).toHaveLength(1);
      expect(history.getMessages()[0]).toEqual(message);
    });

    it('should add multiple messages', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      history.addMessages(messages);

      expect(history.messageCount).toBe(2);
      expect(history.getMessages()).toEqual(messages);
    });

    it('should get last N messages', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Message 1' },
        { role: 'assistant', content: 'Message 2' },
        { role: 'user', content: 'Message 3' },
      ];

      history.addMessages(messages);

      const lastTwo = history.getLastMessages(2);
      expect(lastTwo).toHaveLength(2);
      expect(lastTwo[0].content).toBe('Message 2');
      expect(lastTwo[1].content).toBe('Message 3');
    });
  });

  describe('System Message Management', () => {
    it('should update system message', () => {
      history.updateSystemMessage('You are a helpful assistant');

      const systemMsg = history.getSystemMessage();
      expect(systemMsg).toBeDefined();
      expect(systemMsg?.role).toBe('system');
      expect(systemMsg?.content).toBe('You are a helpful assistant');
    });

    it('should replace existing system message', () => {
      history.updateSystemMessage('First system message');
      history.updateSystemMessage('Second system message');

      const messages = history.getMessages();
      const systemMessages = messages.filter(m => m.role === 'system');

      expect(systemMessages).toHaveLength(1);
      expect(systemMessages[0].content).toBe('Second system message');
    });

    it('should preserve system message during clear conversation', () => {
      history.updateSystemMessage('System message');
      history.addMessage({ role: 'user', content: 'User message' });
      history.addMessage({ role: 'assistant', content: 'Assistant message' });

      history.clearConversation();

      expect(history.messageCount).toBe(1);
      expect(history.getSystemMessage()?.content).toBe('System message');
    });
  });

  describe('Token Estimation', () => {
    it('should estimate token count', () => {
      const message: Message = {
        role: 'user',
        content: 'a'.repeat(400), // 400 chars
      };

      history.addMessage(message);

      const tokenCount = history.estimateTokenCount();
      // ~400 chars / 4 = ~100 tokens, plus overhead
      expect(tokenCount).toBeGreaterThan(90);
      expect(tokenCount).toBeLessThan(150);
    });

    it('should calculate context usage percentage', () => {
      // Add a message that uses ~25% of context
      const message: Message = {
        role: 'user',
        content: 'a'.repeat(1000), // 1000 chars = ~250 tokens (25% of 1000)
      };

      history.addMessage(message);

      const usage = history.getContextUsagePercent();
      expect(usage).toBeGreaterThan(20);
      expect(usage).toBeLessThan(30);
    });

    it('should detect when near capacity', () => {
      // Fill up to 85% capacity
      const largeMessage: Message = {
        role: 'user',
        content: 'a'.repeat(3400), // 3400 chars = ~850 tokens (85% of 1000)
      };

      history.addMessage(largeMessage);

      expect(history.isNearCapacity(80)).toBe(true);
      expect(history.isNearCapacity(90)).toBe(false);
    });
  });

  describe('Constraint Enforcement', () => {
    it('should enforce message count limit', () => {
      const smallHistory = new MessageHistory({
        maxMessages: 3,
        maxTokens: 10000,
      });

      smallHistory.updateSystemMessage('System');

      for (let i = 0; i < 5; i++) {
        smallHistory.addMessage({ role: 'user', content: `Message ${i}` });
      }

      // Should keep system + 2 most recent messages = 3 total
      expect(smallHistory.messageCount).toBe(3);
      expect(smallHistory.getSystemMessage()).toBeDefined();
    });

    it('should never remove system message', () => {
      const tinyHistory = new MessageHistory({
        maxMessages: 2,
        maxTokens: 10000,
      });

      tinyHistory.updateSystemMessage('System message');
      tinyHistory.addMessage({ role: 'user', content: 'Message 1' });
      tinyHistory.addMessage({ role: 'user', content: 'Message 2' });
      tinyHistory.addMessage({ role: 'user', content: 'Message 3' });

      const messages = tinyHistory.getMessages();
      expect(messages[0].role).toBe('system');
      expect(tinyHistory.messageCount).toBe(2);
    });
  });

  describe('Clear Operations', () => {
    it('should clear conversation but keep system message', () => {
      history.updateSystemMessage('System');
      history.addMessage({ role: 'user', content: 'User' });
      history.addMessage({ role: 'assistant', content: 'Assistant' });

      history.clearConversation();

      expect(history.messageCount).toBe(1);
      expect(history.getSystemMessage()).toBeDefined();
    });

    it('should clear all messages including system', () => {
      history.updateSystemMessage('System');
      history.addMessage({ role: 'user', content: 'User' });

      history.clearAll();

      expect(history.messageCount).toBe(0);
      expect(history.getSystemMessage()).toBeUndefined();
    });
  });

  describe('Statistics', () => {
    it('should provide accurate stats', () => {
      history.updateSystemMessage('System message');
      history.addMessage({ role: 'user', content: 'User message' });
      history.addMessage({ role: 'assistant', content: 'Assistant message' });
      history.addMessage({ role: 'user', content: 'Another user message' });

      const stats = history.getStats();

      expect(stats.messageCount).toBe(4);
      expect(stats.hasSystemMessage).toBe(true);
      expect(stats.messagesByRole).toEqual({
        system: 1,
        user: 2,
        assistant: 1,
      });
      expect(stats.tokenCount).toBeGreaterThan(0);
      expect(stats.contextUsage).toBeGreaterThan(0);
      expect(stats.contextUsage).toBeLessThanOrEqual(100);
    });

    it('should generate a summary', () => {
      history.updateSystemMessage('System');
      history.addMessage({ role: 'user', content: 'Hello' });

      const summary = history.getSummary();

      expect(summary).toContain('Messages: 2');
      expect(summary).toContain('System: Yes');
      expect(summary).toContain('Tokens:');
    });
  });

  describe('JSON Serialization', () => {
    it('should export to JSON', () => {
      history.addMessage({ role: 'user', content: 'Test' });

      const json = history.toJSON();

      expect(Array.isArray(json)).toBe(true);
      expect(json).toHaveLength(1);
      expect(json[0].role).toBe('user');
    });

    it('should load from JSON', () => {
      const messages: Message[] = [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'User' },
      ];

      history.fromJSON(messages);

      expect(history.messageCount).toBe(2);
      expect(history.getSystemMessage()?.content).toBe('System');
    });
  });
});
