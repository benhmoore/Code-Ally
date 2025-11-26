/**
 * Tests for ConversationManager.removeEphemeralSystemReminders()
 *
 * This test suite covers the ephemeral system reminders feature which allows
 * some reminders to be cleaned up after each turn while others persist.
 *
 * Reminders marked with persist="true" are kept in conversation history.
 * All other reminders are considered ephemeral and removed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationManager } from '../ConversationManager.js';
import { Message } from '../../types/index.js';
import { SYSTEM_REMINDER } from '../../config/constants.js';

describe('ConversationManager.removeEphemeralSystemReminders', () => {
  let manager: ConversationManager;

  beforeEach(() => {
    manager = new ConversationManager({ instanceId: 'test-instance' });
  });

  /**
   * Helper to create a message with proper structure
   */
  function createMessage(role: Message['role'], content: string): Message {
    return {
      role,
      content,
      id: `msg-${Math.random()}`,
      timestamp: Date.now(),
    };
  }

  describe('Basic functionality', () => {
    it('should remove ephemeral standalone system messages', () => {
      manager.addMessage(createMessage('system', '<system-reminder>This is ephemeral</system-reminder>'));
      manager.addMessage(createMessage('user', 'Hello'));

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(1);
      expect(manager.getMessageCount()).toBe(1);
      expect(manager.getMessages()[0].role).toBe('user');
    });

    it('should keep persistent standalone system messages', () => {
      manager.addMessage(createMessage('system', '<system-reminder persist="true">This is persistent</system-reminder>'));
      manager.addMessage(createMessage('user', 'Hello'));

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(0);
      expect(manager.getMessageCount()).toBe(2);
      expect(manager.getMessages()[0].role).toBe('system');
      expect(manager.getMessages()[0].content).toContain('persist="true"');
    });

    it('should strip ephemeral tags from tool results', () => {
      const toolResult = createMessage(
        'tool',
        'Success\n\n<system-reminder>Check the output</system-reminder>'
      );
      toolResult.tool_call_id = 'call-123';
      toolResult.name = 'bash';

      manager.addMessage(toolResult);

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(1);
      expect(manager.getMessages()[0].content).toBe('Success');
      expect(manager.getMessages()[0].content).not.toContain('<system-reminder>');
    });

    it('should keep persistent tags in tool results', () => {
      const toolResult = createMessage(
        'tool',
        'Success\n\n<system-reminder persist="true">Important context</system-reminder>'
      );
      toolResult.tool_call_id = 'call-123';
      toolResult.name = 'agent';

      manager.addMessage(toolResult);

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(0);
      expect(manager.getMessages()[0].content).toContain('<system-reminder persist="true">');
      expect(manager.getMessages()[0].content).toContain('Important context');
    });

    it('should return accurate count of removals', () => {
      // 2 ephemeral standalone messages
      manager.addMessage(createMessage('system', '<system-reminder>Ephemeral 1</system-reminder>'));
      manager.addMessage(createMessage('user', '<system-reminder>Interrupted prompt</system-reminder>'));

      // 1 tool result with ephemeral tag
      const toolResult = createMessage('tool', 'OK\n\n<system-reminder>Check logs</system-reminder>');
      toolResult.tool_call_id = 'call-1';
      manager.addMessage(toolResult);

      // 1 persistent message (should not be counted)
      manager.addMessage(createMessage('system', '<system-reminder persist="true">Keep this</system-reminder>'));

      const removed = manager.removeEphemeralSystemReminders();

      // Should count: 2 standalone messages + 1 tool result with tags stripped = 3
      expect(removed).toBe(3);
      expect(manager.getMessageCount()).toBe(2); // Only tool result and persistent message remain
    });
  });

  describe('Edge cases - Attribute variations', () => {
    it('should handle persist="true" not as first attribute', () => {
      manager.addMessage(createMessage(
        'system',
        '<system-reminder foo="bar" persist="true" baz="qux">Important</system-reminder>'
      ));

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(0);
      expect(manager.getMessages()[0].content).toContain('Important');
    });

    it('should handle case variations - persist="TRUE"', () => {
      manager.addMessage(createMessage('system', '<system-reminder persist="TRUE">Keep this</system-reminder>'));

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(0);
      expect(manager.getMessages()[0].content).toContain('Keep this');
    });

    it('should handle case variations - persist="True"', () => {
      manager.addMessage(createMessage('system', '<system-reminder persist="True">Keep this</system-reminder>'));

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(0);
      expect(manager.getMessages()[0].content).toContain('Keep this');
    });

    it('should handle case variations - persist="tRuE"', () => {
      manager.addMessage(createMessage('system', '<system-reminder persist="tRuE">Keep this</system-reminder>'));

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(0);
      expect(manager.getMessages()[0].content).toContain('Keep this');
    });

    it('should handle extra whitespace - persist = "true"', () => {
      manager.addMessage(createMessage('system', '<system-reminder persist = "true">Keep this</system-reminder>'));

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(0);
      expect(manager.getMessages()[0].content).toContain('Keep this');
    });

    it('should handle extra whitespace - persist  =  "true"', () => {
      manager.addMessage(createMessage('system', '<system-reminder persist  =  "true">Keep this</system-reminder>'));

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(0);
      expect(manager.getMessages()[0].content).toContain('Keep this');
    });

    it('should handle single quotes - persist=\'true\'', () => {
      manager.addMessage(createMessage('system', '<system-reminder persist=\'true\'>Keep this</system-reminder>'));

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(0);
      expect(manager.getMessages()[0].content).toContain('Keep this');
    });
  });

  describe('Edge cases - Multiple tags', () => {
    it('should remove multiple ephemeral tags in same tool result', () => {
      const toolResult = createMessage(
        'tool',
        'Success\n\n<system-reminder>First reminder</system-reminder>\n\n<system-reminder>Second reminder</system-reminder>'
      );
      toolResult.tool_call_id = 'call-1';
      manager.addMessage(toolResult);

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(1); // Counts as 1 tool result modified
      expect(manager.getMessages()[0].content).toBe('Success');
      expect(manager.getMessages()[0].content).not.toContain('<system-reminder>');
    });

    it('should handle mixed persistent and ephemeral tags in same tool result', () => {
      const toolResult = createMessage(
        'tool',
        'Success\n\n<system-reminder>Ephemeral</system-reminder>\n\n<system-reminder persist="true">Persistent</system-reminder>'
      );
      toolResult.tool_call_id = 'call-1';
      manager.addMessage(toolResult);

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(1);
      const content = manager.getMessages()[0].content;
      expect(content).toContain('<system-reminder persist="true">Persistent</system-reminder>');
      expect(content).not.toContain('Ephemeral');
    });

    it('should keep standalone message if ANY tag has persist="true"', () => {
      manager.addMessage(createMessage(
        'system',
        '<system-reminder>Ephemeral part</system-reminder>\n\n<system-reminder persist="true">Persistent part</system-reminder>'
      ));

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(0);
      expect(manager.getMessages()[0].content).toContain('Ephemeral part');
      expect(manager.getMessages()[0].content).toContain('Persistent part');
    });

    it('should remove standalone message if ALL tags are ephemeral', () => {
      manager.addMessage(createMessage(
        'system',
        '<system-reminder>First</system-reminder>\n\n<system-reminder>Second</system-reminder>\n\n<system-reminder>Third</system-reminder>'
      ));

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(1);
      expect(manager.getMessageCount()).toBe(0);
    });
  });

  describe('Edge cases - Content variations', () => {
    it('should handle empty content after tag removal', () => {
      const toolResult = createMessage('tool', '<system-reminder>Only this</system-reminder>');
      toolResult.tool_call_id = 'call-1';
      manager.addMessage(toolResult);

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(1);
      expect(manager.getMessages()[0].content).toBe('');
    });

    it('should handle multi-line reminder content', () => {
      const toolResult = createMessage(
        'tool',
        'Output\n\n<system-reminder>Line 1\nLine 2\nLine 3</system-reminder>'
      );
      toolResult.tool_call_id = 'call-1';
      manager.addMessage(toolResult);

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(1);
      expect(manager.getMessages()[0].content).toBe('Output');
    });

    it('should handle special characters in content', () => {
      const toolResult = createMessage(
        'tool',
        'OK\n\n<system-reminder>Special chars: &lt; &gt; &amp; "quotes" \'apostrophes\'</system-reminder>'
      );
      toolResult.tool_call_id = 'call-1';
      manager.addMessage(toolResult);

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(1);
      expect(manager.getMessages()[0].content).toBe('OK');
    });

    it('should trim excessive blank lines after removal', () => {
      const toolResult = createMessage(
        'tool',
        'Line 1\n\n\n<system-reminder>Middle</system-reminder>\n\n\nLine 2'
      );
      toolResult.tool_call_id = 'call-1';
      manager.addMessage(toolResult);

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(1);
      const content = manager.getMessages()[0].content;
      // Should reduce 3+ consecutive newlines to 2
      expect(content).not.toContain('\n\n\n');
      expect(content).toContain('Line 1');
      expect(content).toContain('Line 2');
    });

    it('should handle malformed tags without closing tags', () => {
      const toolResult = createMessage(
        'tool',
        'Output\n\n<system-reminder>Unclosed tag'
      );
      toolResult.tool_call_id = 'call-1';
      manager.addMessage(toolResult);

      const removed = manager.removeEphemeralSystemReminders();

      // Should not remove malformed tags (avoid data corruption)
      expect(removed).toBe(0);
      expect(manager.getMessages()[0].content).toContain('<system-reminder>Unclosed tag');
    });
  });

  describe('Role coverage', () => {
    it('should remove ephemeral tags from system messages', () => {
      manager.addMessage(createMessage('system', '<system-reminder>System-level reminder</system-reminder>'));

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(1);
      expect(manager.getMessageCount()).toBe(0);
    });

    it('should remove ephemeral tags from user messages (continuation prompts)', () => {
      manager.addMessage(createMessage('user', '<system-reminder>Your response was interrupted</system-reminder>'));

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(1);
      expect(manager.getMessageCount()).toBe(0);
    });

    it('should strip tags from tool messages but keep the message', () => {
      const toolResult = createMessage('tool', 'Result\n\n<system-reminder>Note</system-reminder>');
      toolResult.tool_call_id = 'call-1';
      manager.addMessage(toolResult);

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(1);
      expect(manager.getMessageCount()).toBe(1); // Message still exists
      expect(manager.getMessages()[0].content).toBe('Result');
    });

    it('should not modify assistant messages', () => {
      manager.addMessage(createMessage('assistant', 'Let me help with that.'));

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(0);
      expect(manager.getMessages()[0].content).toBe('Let me help with that.');
    });

    it('should not modify messages without reminder tags', () => {
      manager.addMessage(createMessage('system', 'You are a helpful assistant'));
      manager.addMessage(createMessage('user', 'Hello'));
      manager.addMessage(createMessage('assistant', 'Hi there!'));
      const toolResult = createMessage('tool', '{"success": true}');
      toolResult.tool_call_id = 'call-1';
      manager.addMessage(toolResult);

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(0);
      expect(manager.getMessageCount()).toBe(4);
    });
  });

  describe('Performance', () => {
    it('should handle large conversations (1000+ messages)', () => {
      // Add 1000 messages with mixed content
      for (let i = 0; i < 1000; i++) {
        if (i % 3 === 0) {
          manager.addMessage(createMessage('system', '<system-reminder>Ephemeral</system-reminder>'));
        } else if (i % 3 === 1) {
          const toolResult = createMessage('tool', 'OK\n\n<system-reminder>Note</system-reminder>');
          toolResult.tool_call_id = `call-${i}`;
          manager.addMessage(toolResult);
        } else {
          manager.addMessage(createMessage('user', 'Normal message'));
        }
      }

      const startTime = Date.now();
      const removed = manager.removeEphemeralSystemReminders();
      const duration = Date.now() - startTime;

      // Should complete reasonably fast (< 100ms for 1000 messages)
      expect(duration).toBeLessThan(100);

      // Should have removed ~666 messages (333 standalone + 333 tool results)
      expect(removed).toBeGreaterThan(600);
      expect(removed).toBeLessThan(700);
    });

    it('should handle messages with many tags (10+ tags per message)', () => {
      const manyTags = Array.from({ length: 10 }, (_, i) =>
        `<system-reminder>Tag ${i}</system-reminder>`
      ).join('\n\n');

      const toolResult = createMessage('tool', `Output\n\n${manyTags}`);
      toolResult.tool_call_id = 'call-1';
      manager.addMessage(toolResult);

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(1);
      expect(manager.getMessages()[0].content).toBe('Output');
    });

    it('should use pre-check optimization to skip messages without tags', () => {
      // Add many messages without tags
      for (let i = 0; i < 100; i++) {
        manager.addMessage(createMessage('user', `Message ${i}`));
      }

      const startTime = Date.now();
      const removed = manager.removeEphemeralSystemReminders();
      const duration = Date.now() - startTime;

      expect(removed).toBe(0);
      // Should be very fast due to pre-check (< 10ms)
      expect(duration).toBeLessThan(10);
    });
  });

  describe('Complex scenarios', () => {
    it('should handle real-world conversation with mixed reminders', () => {
      // Initial system message
      manager.addMessage(createMessage('system', 'You are a helpful coding assistant.'));

      // User question
      manager.addMessage(createMessage('user', 'What files are in this directory?'));

      // Tool call result with ephemeral reminder
      const lsResult = createMessage('tool', 'file1.ts\nfile2.ts\n\n<system-reminder>Found 2 files</system-reminder>');
      lsResult.tool_call_id = 'call-1';
      lsResult.name = 'ls';
      manager.addMessage(lsResult);

      // Assistant response
      manager.addMessage(createMessage('assistant', 'I found 2 files in the directory.'));

      // User follow-up
      manager.addMessage(createMessage('user', 'Can you help me understand file1.ts?'));

      // Agent delegation with persistent task context
      const agentResult = createMessage(
        'tool',
        'Analysis complete\n\n<system-reminder persist="true">This agent is a code analyzer created for: "understand file1.ts"</system-reminder>'
      );
      agentResult.tool_call_id = 'call-2';
      agentResult.name = 'agent';
      manager.addMessage(agentResult);

      // Cleanup
      const removed = manager.removeEphemeralSystemReminders();

      // Should remove only the ephemeral ls reminder
      expect(removed).toBe(1);
      expect(manager.getMessageCount()).toBe(6);

      // Verify persistent task context is still there
      const messages = manager.getMessages();
      const agentMessage = messages.find(m => m.tool_call_id === 'call-2');
      expect(agentMessage?.content).toContain('This agent is a code analyzer');

      // Verify ephemeral ls reminder is gone
      const lsMessage = messages.find(m => m.tool_call_id === 'call-1');
      expect(lsMessage?.content).not.toContain('<system-reminder>');
    });

    it('should handle interrupted conversation with continuation prompt', () => {
      manager.addMessage(createMessage('system', 'You are a helpful assistant.'));
      manager.addMessage(createMessage('user', 'First question'));
      manager.addMessage(createMessage('assistant', 'Partial response...'));

      // Continuation prompt (ephemeral user message)
      manager.addMessage(createMessage(
        'user',
        '<system-reminder>Your response was interrupted. Please continue where you left off.</system-reminder>'
      ));

      manager.addMessage(createMessage('assistant', 'Continuing my response...'));

      const removed = manager.removeEphemeralSystemReminders();

      // Should remove the continuation prompt
      expect(removed).toBe(1);
      expect(manager.getMessageCount()).toBe(4);

      const messages = manager.getMessages();
      expect(messages.filter(m => m.role === 'user').length).toBe(1); // Only original question
    });

    it('should handle nested content with reminders at different positions', () => {
      const toolResult = createMessage(
        'tool',
        '<system-reminder>Start</system-reminder>\nMiddle content\n<system-reminder persist="true">Important</system-reminder>\nMore content\n<system-reminder>End</system-reminder>'
      );
      toolResult.tool_call_id = 'call-1';
      manager.addMessage(toolResult);

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(1);
      const content = manager.getMessages()[0].content;
      expect(content).toContain('Middle content');
      expect(content).toContain('More content');
      expect(content).toContain('<system-reminder persist="true">Important</system-reminder>');
      expect(content).not.toContain('Start');
      expect(content).not.toContain('End');
    });
  });

  describe('Backward compatibility', () => {
    it('should support deprecated removeSystemReminders() method', () => {
      manager.addMessage(createMessage('system', '<system-reminder>Ephemeral</system-reminder>'));

      // Use deprecated method
      const removed = manager.removeSystemReminders();

      expect(removed).toBe(1);
      expect(manager.getMessageCount()).toBe(0);
    });
  });

  describe('Return value accuracy', () => {
    it('should return 0 when no reminders are present', () => {
      manager.addMessage(createMessage('user', 'Hello'));
      manager.addMessage(createMessage('assistant', 'Hi'));

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(0);
    });

    it('should return 0 when only persistent reminders are present', () => {
      manager.addMessage(createMessage('system', '<system-reminder persist="true">Keep this</system-reminder>'));
      const toolResult = createMessage('tool', 'OK\n\n<system-reminder persist="true">Keep this too</system-reminder>');
      toolResult.tool_call_id = 'call-1';
      manager.addMessage(toolResult);

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(0);
    });

    it('should count each affected message only once (not per tag)', () => {
      const toolResult = createMessage(
        'tool',
        'OK\n\n<system-reminder>A</system-reminder>\n\n<system-reminder>B</system-reminder>\n\n<system-reminder>C</system-reminder>'
      );
      toolResult.tool_call_id = 'call-1';
      manager.addMessage(toolResult);

      const removed = manager.removeEphemeralSystemReminders();

      // Should count as 1 (one tool result modified), not 3
      expect(removed).toBe(1);
    });
  });

  describe('Non-string content handling', () => {
    it('should skip messages with non-string content', () => {
      const msg: Message = {
        role: 'system',
        content: {} as any, // Invalid content type
        id: 'msg-1',
        timestamp: Date.now(),
      };

      manager.addMessage(msg);

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(0);
      expect(manager.getMessageCount()).toBe(1);
    });
  });
});
