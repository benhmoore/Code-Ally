import { describe, expect, it } from 'vitest';
import {
  reconstructToolCallsFromMessages,
  supplementTranscriptToolResults,
} from '../useSessionResume.js';
import type { ServiceRegistry } from '../../../services/ServiceRegistry.js';
import type { Message } from '../../../types/index.js';

const registryWithoutTools = { get: () => undefined } as unknown as ServiceRegistry;

const callMessage: Message = {
  role: 'assistant',
  content: '',
  timestamp: 1,
  tool_calls: [{
    id: 'call-1',
    type: 'function',
    function: { name: 'bash', arguments: '{"command":"sleep 30"}' },
  }],
};

describe('reconstructToolCallsFromMessages', () => {
  it('preserves protocol-level errors when display metadata is absent', () => {
    const result: Message = {
      role: 'tool',
      tool_call_id: 'call-1',
      name: 'bash',
      content: '<error type="interrupted">interrupted</error>',
      is_error: true,
    };

    const [toolCall] = reconstructToolCallsFromMessages(
      [callMessage, result],
      registryWithoutTools
    );

    expect(toolCall?.status).toBe('error');
    expect(toolCall?.endTime).toBe(toolCall?.startTime);
  });

  it('prefers the protocol error flag over inconsistent status metadata', () => {
    const result: Message = {
      role: 'tool',
      tool_call_id: 'call-1',
      name: 'bash',
      content: '<error>failed</error>',
      is_error: true,
      timestamp: 2,
      metadata: {
        tool_status: { 'call-1': 'success' },
        tool_result: { 'call-1': { error: 'failed' } },
      },
    };

    const [toolCall] = reconstructToolCallsFromMessages(
      [callMessage, result],
      registryWithoutTools
    );

    expect(toolCall?.status).toBe('error');
    expect(toolCall?.error).toBe('failed');
  });

  it('does not treat an empty display error as a failed call', () => {
    const result: Message = {
      role: 'tool',
      tool_call_id: 'call-1',
      name: 'bash',
      content: '{}',
      timestamp: 2,
      metadata: {
        tool_result: { 'call-1': { content: 'done', error: '' } },
      },
    };

    const [toolCall] = reconstructToolCallsFromMessages(
      [callMessage, result],
      registryWithoutTools
    );

    expect(toolCall?.status).toBe('success');
  });
});

describe('supplementTranscriptToolResults', () => {
  it('adds a recovery result missing from the immutable transcript', () => {
    const recoveredResult: Message = {
      role: 'tool',
      tool_call_id: 'call-1',
      name: 'bash',
      content: '<error>interrupted</error>',
      is_error: true,
    };

    const result = supplementTranscriptToolResults(
      [callMessage],
      [callMessage, recoveredResult]
    );

    expect(result).toEqual([callMessage, recoveredResult]);
  });

  it('does not replace an existing transcript result', () => {
    const transcriptResult: Message = {
      role: 'tool',
      tool_call_id: 'call-1',
      name: 'bash',
      content: 'original',
    };
    const transcript = [callMessage, transcriptResult];

    const result = supplementTranscriptToolResults(transcript, [
      callMessage,
      { ...transcriptResult, content: 'active-window copy' },
    ]);

    expect(result).toBe(transcript);
  });
});
