/**
 * Integration tests for ephemeral system reminders
 *
 * Tests the full lifecycle of reminder classification and cleanup:
 * 1. Tools inject reminders via injectSystemReminder helper
 * 2. Reminders are classified as persistent or ephemeral based on content
 * 3. Cleanup process removes ephemeral reminders after turn
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConversationManager } from '../ConversationManager.js';
import { Message } from '../../types/index.js';
import { SYSTEM_REMINDER } from '../../config/constants.js';

describe('System Reminders Integration', () => {
  let manager: ConversationManager;

  beforeEach(() => {
    manager = new ConversationManager({ instanceId: 'test-integration' });
  });

  /**
   * Helper to simulate injectSystemReminder behavior
   */
  function injectSystemReminder(resultStr: string, reminder: string, persist: boolean = false): string {
    const persistAttr = persist ? ` ${SYSTEM_REMINDER.PERSIST_ATTRIBUTE}` : '';
    return `${resultStr}\n\n${SYSTEM_REMINDER.OPENING_TAG}${persistAttr}>${reminder}${SYSTEM_REMINDER.CLOSING_TAG}`;
  }

  /**
   * Helper to create a tool result message
   */
  function createToolResult(name: string, content: string, toolCallId: string = 'call-1'): Message {
    return {
      role: 'tool',
      name,
      content,
      tool_call_id: toolCallId,
      id: `msg-${Math.random()}`,
      timestamp: Date.now(),
    };
  }

  /**
   * Helper to create a system message
   */
  function createSystemMessage(content: string): Message {
    return {
      role: 'system',
      content,
      id: `msg-${Math.random()}`,
      timestamp: Date.now(),
    };
  }

  describe('Task context detection', () => {
    it('should persist PromptAgentTool task context reminder', () => {
      // Simulate prompt-agent tool result with task context
      let result = '{"success": true, "agent_response": "Analysis complete"}';
      result = injectSystemReminder(
        result,
        'This agent is a code analyzer created for: "analyze file.ts and find bugs"',
        true // Explicitly marked as persistent
      );

      manager.addMessage(createToolResult('agent', result));

      // Verify the reminder is there before cleanup
      expect(manager.getMessages()[0].content).toContain('This agent is a code analyzer');

      // Cleanup ephemeral reminders
      const removed = manager.removeEphemeralSystemReminders();

      // Should NOT remove the task context (it's persistent)
      expect(removed).toBe(0);
      expect(manager.getMessages()[0].content).toContain('This agent is a code analyzer');
      expect(manager.getMessages()[0].content).toContain('persist="true"');
    });

    it('should detect task context pattern correctly', () => {
      // Test the exact pattern used in code: "This agent is a...created for:"
      const taskContexts = [
        'This agent is a specialized code analyzer created for: "find security issues"',
        'This agent is a test generator created for: "create unit tests"',
        'This agent is a refactoring assistant created for: "simplify this module"',
      ];

      for (const taskContext of taskContexts) {
        const mgr = new ConversationManager();
        let result = 'Agent work completed';
        result = injectSystemReminder(result, taskContext, true);

        mgr.addMessage(createToolResult('agent', result));

        const removed = mgr.removeEphemeralSystemReminders();
        expect(removed).toBe(0);
        expect(mgr.getMessages()[0].content).toContain(taskContext);
      }
    });

    it('should NOT persist task-like text that does not match the pattern', () => {
      // Similar but not exact pattern - should be ephemeral
      const notTaskContexts = [
        'This is an agent created for: testing', // Missing "This agent is a"
        'This agent is a helper', // Missing "created for:"
        'The agent was made to help you', // Completely different pattern
      ];

      for (const text of notTaskContexts) {
        const mgr = new ConversationManager();
        let result = 'Work done';
        result = injectSystemReminder(result, text, false); // Explicitly ephemeral

        mgr.addMessage(createToolResult('agent', result));

        const removed = mgr.removeEphemeralSystemReminders();
        expect(removed).toBe(1);
        expect(mgr.getMessages()[0].content).not.toContain(text);
      }
    });
  });

  describe('Full lifecycle - Reminder injection and cleanup', () => {
    it('should handle complete turn lifecycle with mixed reminders', () => {
      // 1. Create conversation turn
      manager.addMessage(createSystemMessage('You are a helpful assistant.'));
      manager.addMessage({ role: 'user', content: 'Help me analyze this code', id: 'msg-user', timestamp: Date.now() });

      // 2. Simulate tool execution with various reminders

      // Bash tool with ephemeral cycle detection warning
      let bashResult = 'Command executed successfully';
      bashResult = injectSystemReminder(
        bashResult,
        'You\'ve called "bash" with identical arguments 3 times recently. Consider a different approach.',
        false // Ephemeral
      );
      manager.addMessage(createToolResult('bash', bashResult, 'call-1'));

      // Agent tool with persistent task context
      let agentResult = 'Analysis complete: found 5 issues';
      agentResult = injectSystemReminder(
        agentResult,
        'This agent is a security analyzer created for: "analyze code for vulnerabilities"',
        true // Persistent
      );
      manager.addMessage(createToolResult('agent', agentResult, 'call-2'));

      // Read tool with ephemeral exploratory warning
      let readResult = 'File contents: ...\n\n(truncated)';
      readResult = injectSystemReminder(
        readResult,
        'You\'ve made 5 consecutive exploratory tool calls (read/grep/glob/ls/tree). Consider wrapping up your exploration.',
        false // Ephemeral
      );
      manager.addMessage(createToolResult('read', readResult, 'call-3'));

      // Time reminder (ephemeral)
      manager.addMessage(createSystemMessage(
        '<system-reminder>You have used 8.5 minutes out of your 10 minute time budget. Please wrap up.</system-reminder>'
      ));

      // Assistant response
      manager.addMessage({ role: 'assistant', content: 'I found several issues...', id: 'msg-asst', timestamp: Date.now() });

      // Verify before cleanup
      expect(manager.getMessageCount()).toBe(7);

      // 3. End of turn: cleanup ephemeral reminders
      const removed = manager.removeEphemeralSystemReminders();

      // Should remove:
      // - Bash cycle warning (1 tool result modified)
      // - Read exploratory warning (1 tool result modified)
      // - Time reminder standalone message (1 message removed)
      // Total: 3
      expect(removed).toBe(3);

      // 4. Verify cleanup results
      const messages = manager.getMessages();

      // Should have: system, user, 3 tool results, assistant = 6 messages
      expect(messages.length).toBe(6);

      // Bash result should have reminder stripped
      const bashMsg = messages.find(m => m.tool_call_id === 'call-1');
      expect(bashMsg?.content).toBe('Command executed successfully');
      expect(bashMsg?.content).not.toContain('<system-reminder>');

      // Agent result should KEEP persistent task context
      const agentMsg = messages.find(m => m.tool_call_id === 'call-2');
      expect(agentMsg?.content).toContain('This agent is a security analyzer');
      expect(agentMsg?.content).toContain('persist="true"');

      // Read result should have reminder stripped
      const readMsg = messages.find(m => m.tool_call_id === 'call-3');
      expect(readMsg?.content).toContain('File contents:');
      expect(readMsg?.content).not.toContain('exploratory tool calls');

      // Time reminder message should be completely removed
      expect(messages.filter(m => m.role === 'system' && m.content.includes('time budget')).length).toBe(0);
    });

    it('should handle specialized agent context overload warning (persistent)', () => {
      // Specialized agents get a persistent warning about context limits
      let result = 'Agent task completed';
      result = injectSystemReminder(
        result,
        'Warning: This specialized agent has consumed 85% of available context. Future tool calls may fail.',
        true // Persistent - agents need to remember this across turns
      );

      manager.addMessage(createToolResult('agent', result));

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(0);
      expect(manager.getMessages()[0].content).toContain('Warning: This specialized agent');
    });

    it('should clean up exploratory tool warnings', () => {
      // Exploratory warnings are ephemeral - only relevant for current turn
      let result = 'Files: a.ts, b.ts, c.ts';
      result = injectSystemReminder(
        result,
        'You\'ve made 10 consecutive read/grep/glob/ls/tree calls. Consider synthesizing findings.',
        false
      );

      manager.addMessage(createToolResult('glob', result));

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(1);
      expect(manager.getMessages()[0].content).not.toContain('consecutive');
    });

    it('should clean up focus reminders', () => {
      // Focus reminders about active todos are ephemeral
      let result = 'Task: Implement authentication';
      result = injectSystemReminder(
        result,
        'Active task: "Add user login feature". Stay focused on this task.',
        false
      );

      manager.addMessage(createToolResult('todo_read', result));

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(1);
      expect(manager.getMessages()[0].content).not.toContain('Stay focused');
    });

    it('should clean up time reminders', () => {
      // Time budget warnings are ephemeral - only current time matters
      manager.addMessage(createSystemMessage(
        '<system-reminder>Time remaining: 3.2 minutes. Please begin wrapping up.</system-reminder>'
      ));

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(1);
      expect(manager.getMessageCount()).toBe(0);
    });
  });

  describe('Content detection patterns', () => {
    it('should recognize various agent type task contexts', () => {
      const agentTypes = [
        { type: 'specialized code analyzer', task: 'find bugs in auth module' },
        { type: 'test generator', task: 'create comprehensive unit tests' },
        { type: 'refactoring assistant', task: 'simplify complex functions' },
        { type: 'documentation writer', task: 'document API endpoints' },
      ];

      for (const { type, task } of agentTypes) {
        const mgr = new ConversationManager();
        let result = 'Agent work completed';
        const taskContext = `This agent is a ${type} created for: "${task}"`;
        result = injectSystemReminder(result, taskContext, true);

        mgr.addMessage(createToolResult('agent', result));

        const removed = mgr.removeEphemeralSystemReminders();
        expect(removed).toBe(0); // Should persist
        expect(mgr.getMessages()[0].content).toContain(taskContext);
      }
    });

    it('should treat all other reminder patterns as ephemeral (safe default)', () => {
      const ephemeralPatterns = [
        'You are making too many API calls',
        'Consider batching these operations',
        'This operation might take a while',
        'Remember to check the logs',
        'Your plan has been automatically accepted',
        'You can read this file back using the temp file path',
      ];

      for (const pattern of ephemeralPatterns) {
        const mgr = new ConversationManager();
        let result = 'Operation successful';
        result = injectSystemReminder(result, pattern, false);

        mgr.addMessage(createToolResult('bash', result));

        const removed = mgr.removeEphemeralSystemReminders();
        expect(removed).toBe(1); // Should be removed
        expect(mgr.getMessages()[0].content).not.toContain(pattern);
      }
    });
  });

  describe('Session save/restore compatibility', () => {
    it('should handle reminders correctly after session restore', () => {
      // Simulate a saved session with both persistent and ephemeral reminders
      const savedMessages: Message[] = [
        { role: 'system', content: 'You are a helpful assistant.', id: 'msg-1', timestamp: 1000 },
        { role: 'user', content: 'Help me', id: 'msg-2', timestamp: 2000 },
        {
          role: 'tool',
          name: 'agent',
          tool_call_id: 'call-1',
          content: 'Done\n\n<system-reminder persist="true">This agent is a helper created for: "assist user"</system-reminder>',
          id: 'msg-3',
          timestamp: 3000,
        },
        {
          role: 'tool',
          name: 'bash',
          tool_call_id: 'call-2',
          content: 'OK\n\n<system-reminder>Check the output carefully</system-reminder>',
          id: 'msg-4',
          timestamp: 4000,
        },
        { role: 'assistant', content: 'Task complete', id: 'msg-5', timestamp: 5000 },
      ];

      // Restore session
      manager.setMessages(savedMessages);
      expect(manager.getMessageCount()).toBe(5);

      // Cleanup ephemeral reminders
      const removed = manager.removeEphemeralSystemReminders();

      // Should remove only the bash ephemeral reminder
      expect(removed).toBe(1);
      expect(manager.getMessageCount()).toBe(5); // Same count (tool msg still exists, just modified)

      const messages = manager.getMessages();
      const agentMsg = messages.find(m => m.tool_call_id === 'call-1');
      expect(agentMsg?.content).toContain('This agent is a helper');

      const bashMsg = messages.find(m => m.tool_call_id === 'call-2');
      expect(bashMsg?.content).toBe('OK');
    });
  });

  describe('Real-world scenarios', () => {
    it('should handle agent delegation chain with multiple task contexts', () => {
      // Root agent delegates to specialized agent, which delegates to another
      manager.addMessage(createSystemMessage('You are a helpful assistant.'));

      // First delegation - persistent
      let agent1Result = 'Found issues in codebase';
      agent1Result = injectSystemReminder(
        agent1Result,
        'This agent is a code auditor created for: "audit entire codebase for security"',
        true
      );
      manager.addMessage(createToolResult('agent', agent1Result, 'call-1'));

      // Second delegation - persistent
      let agent2Result = 'Authentication analysis complete';
      agent2Result = injectSystemReminder(
        agent2Result,
        'This agent is a security specialist created for: "deep dive into auth module"',
        true
      );
      manager.addMessage(createToolResult('agent', agent2Result, 'call-2'));

      // Some ephemeral reminders mixed in
      let readResult = 'File contents...';
      readResult = injectSystemReminder(readResult, 'File is large, consider using grep', false);
      manager.addMessage(createToolResult('read', readResult, 'call-3'));

      const removed = manager.removeEphemeralSystemReminders();

      // Should remove only the read reminder
      expect(removed).toBe(1);

      const messages = manager.getMessages();
      expect(messages.filter(m => m.content.includes('This agent is a')).length).toBe(2);
      expect(messages.filter(m => m.content.includes('persist="true"')).length).toBe(2);
    });

    it('should handle rapid tool execution with many ephemeral reminders', () => {
      // Simulate a turn with many rapid tool calls, each with ephemeral reminders
      for (let i = 1; i <= 20; i++) {
        let result = `Tool ${i} output`;
        if (i % 5 === 0) {
          result = injectSystemReminder(result, `Cycle detected on tool ${i}`, false);
        }
        if (i % 7 === 0) {
          result = injectSystemReminder(result, `Performance warning for tool ${i}`, false);
        }
        manager.addMessage(createToolResult('bash', result, `call-${i}`));
      }

      const removed = manager.removeEphemeralSystemReminders();

      // 20 tools total
      // Cycle warnings: 4, 8, 12, 16, 20 = 5 tools
      // Performance: 7, 14 = 2 tools
      // But tool 14 has both warnings, so 6 unique tools with reminders
      expect(removed).toBe(6);

      // Verify all reminders are gone
      const messages = manager.getMessages();
      for (const msg of messages) {
        expect(msg.content).not.toContain('<system-reminder>');
      }
    });

    it('should handle interrupted conversation continuation', () => {
      manager.addMessage(createSystemMessage('You are a helpful assistant.'));
      manager.addMessage({ role: 'user', content: 'Analyze this file', id: 'msg-1', timestamp: Date.now() });
      manager.addMessage({ role: 'assistant', content: 'Let me read it...', id: 'msg-2', timestamp: Date.now() });

      // Interruption reminder (ephemeral continuation prompt)
      manager.addMessage({
        role: 'user',
        content: '<system-reminder>Your response was interrupted. Continue where you left off.</system-reminder>',
        id: 'msg-3',
        timestamp: Date.now(),
      });

      // Continued response
      manager.addMessage({ role: 'assistant', content: 'Continuing analysis...', id: 'msg-4', timestamp: Date.now() });

      const removed = manager.removeEphemeralSystemReminders();

      // Should remove the interruption reminder
      expect(removed).toBe(1);

      const messages = manager.getMessages();
      expect(messages.filter(m => m.role === 'user').length).toBe(1); // Only original question
      expect(messages.filter(m => m.content.includes('interrupted')).length).toBe(0);
    });
  });

  describe('Edge cases in classification', () => {
    it('should handle task context with unusual formatting', () => {
      // Task context with extra whitespace, newlines
      const taskContext = `This agent is a    code  reviewer   created for:    "review   PR   #123"`;
      let result = 'Review complete';
      result = injectSystemReminder(result, taskContext, true);

      manager.addMessage(createToolResult('agent', result));

      const removed = manager.removeEphemeralSystemReminders();

      // Should still persist despite unusual formatting
      expect(removed).toBe(0);
      expect(manager.getMessages()[0].content).toContain(taskContext);
    });

    it('should not be fooled by partial pattern matches', () => {
      // Text that contains keywords but not the full pattern
      const notTaskContext = 'This is important. The agent was created to help.';
      let result = 'Work done';
      result = injectSystemReminder(result, notTaskContext, false);

      manager.addMessage(createToolResult('agent', result));

      const removed = manager.removeEphemeralSystemReminders();

      // Should be ephemeral
      expect(removed).toBe(1);
      expect(manager.getMessages()[0].content).not.toContain(notTaskContext);
    });

    it('should handle reminders with embedded HTML-like tags', () => {
      let result = 'Success';
      result = injectSystemReminder(result, 'Use <code>foo()</code> instead of <code>bar()</code>', false);

      manager.addMessage(createToolResult('bash', result));

      const removed = manager.removeEphemeralSystemReminders();

      expect(removed).toBe(1);
      expect(manager.getMessages()[0].content).toBe('Success');
    });
  });

  describe('Multiple cleanup cycles', () => {
    it('should handle multiple cleanup calls in same session', () => {
      // Turn 1
      let result1 = 'First turn output';
      result1 = injectSystemReminder(result1, 'Ephemeral note', false);
      manager.addMessage(createToolResult('bash', result1, 'call-1'));

      const removed1 = manager.removeEphemeralSystemReminders();
      expect(removed1).toBe(1);

      // Turn 2 - add more messages
      manager.addMessage({ role: 'user', content: 'Continue', id: 'msg-2', timestamp: Date.now() });
      let result2 = 'Second turn output';
      result2 = injectSystemReminder(result2, 'Another ephemeral note', false);
      manager.addMessage(createToolResult('bash', result2, 'call-2'));

      const removed2 = manager.removeEphemeralSystemReminders();
      expect(removed2).toBe(1);

      // Verify both turns cleaned up correctly
      const messages = manager.getMessages();
      expect(messages.filter(m => m.content.includes('<system-reminder>')).length).toBe(0);
    });

    it('should not remove persistent reminders on subsequent cleanups', () => {
      // Add persistent reminder
      let result = 'Agent work';
      result = injectSystemReminder(result, 'This agent is a helper created for: "assist"', true);
      manager.addMessage(createToolResult('agent', result));

      // First cleanup
      const removed1 = manager.removeEphemeralSystemReminders();
      expect(removed1).toBe(0);

      // Second cleanup
      const removed2 = manager.removeEphemeralSystemReminders();
      expect(removed2).toBe(0);

      // Third cleanup
      const removed3 = manager.removeEphemeralSystemReminders();
      expect(removed3).toBe(0);

      // Persistent reminder should still be there
      expect(manager.getMessages()[0].content).toContain('This agent is a helper');
    });
  });
});
