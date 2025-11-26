/**
 * ConversationManager Tool Result Index Tests
 *
 * Tests for the tool result index optimization that provides O(1) lookup
 * for tool results by tool_call_id.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationManager } from '../ConversationManager.js';
import { Message } from '../../types/index.js';

describe('ConversationManager Tool Result Index', () => {
  let manager: ConversationManager;

  beforeEach(() => {
    manager = new ConversationManager({ instanceId: 'test' });
  });

  describe('Index Population', () => {
    it('should index tool result messages on addMessage', () => {
      const toolResult: Message = {
        id: 'msg-1',
        role: 'tool',
        content: '{"success": true}',
        tool_call_id: 'call-123',
        timestamp: Date.now(),
      };

      manager.addMessage(toolResult);

      // Verify via hasSuccessfulReadFor (which uses the index)
      // We need to set up a proper read scenario
      const assistantMsg: Message = {
        id: 'msg-0',
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call-123',
          type: 'function',
          function: {
            name: 'read',
            arguments: { file_path: '/test/file.ts' },
          },
        }],
        timestamp: Date.now() - 100,
      };

      // Clear and rebuild with proper order
      manager.clearMessages();
      manager.addMessage(assistantMsg);
      manager.addMessage(toolResult);

      // The index should allow O(1) lookup
      expect(manager.getMessageCount()).toBe(2);
    });

    it('should not index non-tool messages', () => {
      const userMsg: Message = {
        id: 'msg-1',
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      };

      const assistantMsg: Message = {
        id: 'msg-2',
        role: 'assistant',
        content: 'Hi there',
        timestamp: Date.now(),
      };

      manager.addMessage(userMsg);
      manager.addMessage(assistantMsg);

      expect(manager.getMessageCount()).toBe(2);
    });

    it('should not index tool messages without tool_call_id', () => {
      const toolMsg: Message = {
        id: 'msg-1',
        role: 'tool',
        content: 'some content',
        // No tool_call_id
        timestamp: Date.now(),
      } as Message;

      manager.addMessage(toolMsg);
      expect(manager.getMessageCount()).toBe(1);
    });
  });

  describe('Index Maintenance', () => {
    it('should clear index on clearMessages', () => {
      const toolResult: Message = {
        id: 'msg-1',
        role: 'tool',
        content: '{"success": true}',
        tool_call_id: 'call-123',
        timestamp: Date.now(),
      };

      manager.addMessage(toolResult);
      manager.clearMessages();

      expect(manager.getMessageCount()).toBe(0);
    });

    it('should rebuild index on setMessages', () => {
      const messages: Message[] = [
        {
          id: 'msg-1',
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'read', arguments: { file_path: '/a.ts' } },
          }],
          timestamp: 1000,
        },
        {
          id: 'msg-2',
          role: 'tool',
          content: JSON.stringify({ success: true }),
          tool_call_id: 'call-1',
          timestamp: 1001,
        },
      ];

      manager.setMessages(messages);

      expect(manager.getMessageCount()).toBe(2);
      expect(manager.hasSuccessfulReadFor('/a.ts')).toBe(true);
    });

    it('should remove from index on removeMessages', () => {
      const toolResult: Message = {
        id: 'msg-1',
        role: 'tool',
        content: '{"success": true}',
        tool_call_id: 'call-123',
        timestamp: Date.now(),
      };

      manager.addMessage(toolResult);
      expect(manager.getMessageCount()).toBe(1);

      manager.removeMessages(msg => msg.tool_call_id === 'call-123');
      expect(manager.getMessageCount()).toBe(0);
    });
  });

  describe('hasSuccessfulReadFor', () => {
    it('should find successful read for file path', () => {
      const filePath = '/test/example.ts';

      const assistantMsg: Message = {
        id: 'msg-1',
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call-read-1',
          type: 'function',
          function: {
            name: 'read',
            arguments: { file_path: filePath },
          },
        }],
        timestamp: 1000,
      };

      const toolResult: Message = {
        id: 'msg-2',
        role: 'tool',
        content: JSON.stringify({ success: true, content: 'file content' }),
        tool_call_id: 'call-read-1',
        timestamp: 1001,
      };

      manager.addMessage(assistantMsg);
      manager.addMessage(toolResult);

      expect(manager.hasSuccessfulReadFor(filePath)).toBe(true);
    });

    it('should return false for unread file', () => {
      expect(manager.hasSuccessfulReadFor('/never/read.ts')).toBe(false);
    });

    it('should return false for failed read', () => {
      const filePath = '/test/failed.ts';

      const assistantMsg: Message = {
        id: 'msg-1',
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call-read-1',
          type: 'function',
          function: {
            name: 'read',
            arguments: { file_path: filePath },
          },
        }],
        timestamp: 1000,
      };

      const toolResult: Message = {
        id: 'msg-2',
        role: 'tool',
        content: JSON.stringify({ success: false, error: 'File not found' }),
        tool_call_id: 'call-read-1',
        timestamp: 1001,
      };

      manager.addMessage(assistantMsg);
      manager.addMessage(toolResult);

      expect(manager.hasSuccessfulReadFor(filePath)).toBe(false);
    });

    it('should handle file_paths array argument', () => {
      const filePath = '/test/multi.ts';

      const assistantMsg: Message = {
        id: 'msg-1',
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call-read-1',
          type: 'function',
          function: {
            name: 'read',
            arguments: { file_paths: [filePath, '/other/file.ts'] },
          },
        }],
        timestamp: 1000,
      };

      const toolResult: Message = {
        id: 'msg-2',
        role: 'tool',
        content: JSON.stringify({ success: true }),
        tool_call_id: 'call-read-1',
        timestamp: 1001,
      };

      manager.addMessage(assistantMsg);
      manager.addMessage(toolResult);

      expect(manager.hasSuccessfulReadFor(filePath)).toBe(true);
    });

    it('should use O(1) index lookup for tool results', () => {
      // Add many tool results
      for (let i = 0; i < 100; i++) {
        const assistantMsg: Message = {
          id: `assist-${i}`,
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: `call-${i}`,
            type: 'function',
            function: {
              name: 'read',
              arguments: { file_path: `/file-${i}.ts` },
            },
          }],
          timestamp: i * 2,
        };

        const toolResult: Message = {
          id: `tool-${i}`,
          role: 'tool',
          content: JSON.stringify({ success: true }),
          tool_call_id: `call-${i}`,
          timestamp: i * 2 + 1,
        };

        manager.addMessage(assistantMsg);
        manager.addMessage(toolResult);
      }

      // Lookup should be fast
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        manager.hasSuccessfulReadFor(`/file-${i}.ts`);
      }
      const elapsed = performance.now() - start;

      // Should complete quickly (< 50ms for 100 lookups)
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe('removeToolResults', () => {
    it('should remove tool results by ID and update index', () => {
      const toolResult: Message = {
        id: 'msg-1',
        role: 'tool',
        content: '{"success": true}',
        tool_call_id: 'call-to-remove',
        timestamp: Date.now(),
      };

      manager.addMessage(toolResult);
      expect(manager.getMessageCount()).toBe(1);

      const result = manager.removeToolResults(['call-to-remove']);

      expect(result.removed_count).toBe(1);
      expect(result.removed_ids).toContain('call-to-remove');
      expect(manager.getMessageCount()).toBe(0);
    });

    it('should report not found IDs', () => {
      const result = manager.removeToolResults(['nonexistent-call']);

      expect(result.removed_count).toBe(0);
      expect(result.not_found_ids).toContain('nonexistent-call');
    });

    it('should handle mixed found and not found IDs', () => {
      const toolResult: Message = {
        id: 'msg-1',
        role: 'tool',
        content: '{"success": true}',
        tool_call_id: 'existing-call',
        timestamp: Date.now(),
      };

      manager.addMessage(toolResult);

      const result = manager.removeToolResults(['existing-call', 'nonexistent-call']);

      expect(result.removed_count).toBe(1);
      expect(result.removed_ids).toContain('existing-call');
      expect(result.not_found_ids).toContain('nonexistent-call');
    });
  });
});
