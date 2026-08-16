/**
 * Regression tests for gap-filling tool results when a batch is abandoned.
 *
 * The bug this guards: sequential execution appends each tool's result as it
 * completes, so when a later tool in the batch is denied, the recovery path used
 * to append a denial result for EVERY call — including ones already answered.
 * That produced two `role:'tool'` messages sharing a `tool_call_id`; the index
 * keeps only the last, so history and index disagreed and providers reject the
 * resulting message array.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationManager } from '../ConversationManager.js';
import { Message } from '../../types/index.js';
import { PERMISSION_DENIED_TOOL_RESULT } from '../../config/constants.js';

const call = (id: string, name = 'read') => ({ id, function: { name } });

describe('ConversationManager.addMissingToolResults', () => {
  let manager: ConversationManager;

  beforeEach(() => {
    manager = new ConversationManager({ instanceId: 'test' });
  });

  const toolResultIdsInHistory = () =>
    manager
      .getMessages()
      .filter(m => m.role === 'tool')
      .map(m => m.tool_call_id);

  it('appends a result for every unanswered call', () => {
    const added = manager.addMissingToolResults(
      [call('a'), call('b')],
      PERMISSION_DENIED_TOOL_RESULT,
      'permission_denied'
    );

    expect(added).toBe(2);
    expect(toolResultIdsInHistory()).toEqual(['a', 'b']);
  });

  it('skips calls that already have a result — no duplicate tool_call_id', () => {
    const existing: Message = {
      id: 'msg-1',
      role: 'tool',
      tool_call_id: 'a',
      name: 'read',
      content: '{"success":true}',
      timestamp: Date.now(),
    };
    manager.addMessage(existing);

    // The exact live sequence: tool 'a' completed, tool 'b' was denied, and
    // recovery is handed BOTH calls.
    const added = manager.addMissingToolResults(
      [call('a'), call('b')],
      PERMISSION_DENIED_TOOL_RESULT,
      'permission_denied'
    );

    expect(added).toBe(1);

    const ids = toolResultIdsInHistory();
    expect(ids).toEqual(['a', 'b']);
    expect(new Set(ids).size).toBe(ids.length);

    // The already-answered call keeps its real result rather than being
    // overwritten by a denial.
    const first = manager.getMessages().find(m => m.tool_call_id === 'a');
    expect(first?.content).toBe('{"success":true}');
  });

  it('keeps history and the tool result index in agreement', () => {
    manager.addMissingToolResults([call('a'), call('b')], PERMISSION_DENIED_TOOL_RESULT);

    for (const id of ['a', 'b']) {
      const fromHistory = manager.getMessages().find(m => m.role === 'tool' && m.tool_call_id === id);
      expect(fromHistory).toBeDefined();
      // A second call must be a no-op now that the index knows about them.
      expect(manager.addMissingToolResults([call(id)], PERMISSION_DENIED_TOOL_RESULT)).toBe(0);
    }
  });

  it('is idempotent when recovery runs twice', () => {
    manager.addMissingToolResults([call('a')], PERMISSION_DENIED_TOOL_RESULT);
    manager.addMissingToolResults([call('a')], PERMISSION_DENIED_TOOL_RESULT);

    expect(toolResultIdsInHistory()).toEqual(['a']);
  });

  it('builds results through the canonical wire builder, not a raw literal', () => {
    manager.addMissingToolResults([call('a')], PERMISSION_DENIED_TOOL_RESULT, 'permission_denied');

    const message = manager.getMessages().find(m => m.role === 'tool');
    // The canonical builder marks errors so open models get the error signal;
    // the old hand-rolled literal did not.
    expect(message?.is_error).toBe(true);
    expect(message?.name).toBe('read');
    expect(message?.content).toContain('permission');
  });

  it('does nothing when given no calls', () => {
    expect(manager.addMissingToolResults([], PERMISSION_DENIED_TOOL_RESULT)).toBe(0);
    expect(toolResultIdsInHistory()).toEqual([]);
  });
});
