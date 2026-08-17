import { describe, expect, it } from 'vitest';
import {
  extractSemanticCheckpoint,
  fitSemanticCheckpointToTokenBudget,
  mergeSemanticCheckpoint,
} from '../compaction/CheckpointReducer.js';
import { emptySemanticCheckpoint, type SemanticCheckpointStateV1 } from '../compaction/types.js';
import type { Message } from '../../types/index.js';

function toolResult(overrides: Partial<Message> & { id: string; content: string }): Message {
  return {
    role: 'tool',
    name: 'read',
    tool_call_id: `call-${overrides.id}`,
    timestamp: 1,
    ...overrides,
  } as Message;
}

/** Content shaped exactly like FunctionCalling.createToolResultMessage output. */
function envelopeContent(callId: string, payload: Record<string, unknown>): string {
  return `[Tool Call ID: ${callId}]\n${JSON.stringify(payload, null, 2)}`;
}

describe('extractSemanticCheckpoint', () => {
  it('does not classify successful tool envelopes as blockers despite the empty error field', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Build the app.', timestamp: 1 },
      toolResult({
        id: 't1',
        name: 'read',
        content: envelopeContent('call-t1', {
          success: true,
          error: '',
          content: '=== /repo/src/World.js ===\n[188 lines]\n     1\texport default class World {}',
          files_read: 1,
          total_lines: 188,
        }),
      }),
    ];

    const state = extractSemanticCheckpoint(messages);

    expect(state.blockers).toHaveLength(0);
    expect(state.completedWork).toHaveLength(1);
    expect(state.completedWork[0]!.text).toContain('/repo/src/World.js');
  });

  it('summarizes read results to a file inventory instead of embedding payloads', () => {
    const bigBody = ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']
      .map(file => `=== ${file} ===\n${'line of source code\n'.repeat(200)}`)
      .join('\n');
    const messages: Message[] = [toolResult({
      id: 't1',
      content: envelopeContent('call-t1', {
        success: true, error: '', content: bigBody, files_read: 3, total_lines: 600,
      }),
    })];

    const state = extractSemanticCheckpoint(messages);

    const summary = state.completedWork[0]!.text;
    expect(summary).toContain('Read 3 file(s)');
    expect(summary).toContain('/repo/a.ts');
    expect(summary).toContain('/repo/c.ts');
    expect(summary.length).toBeLessThan(600);
  });

  it('classifies structured tool failures as blockers with the exact error', () => {
    const messages: Message[] = [
      toolResult({
        id: 't1',
        name: 'edit',
        is_error: true,
        content: `[Tool Call ID: call-t1]\n<error type="validation_error">\nold_string not found in file\n</error>`,
      }),
      toolResult({
        id: 't2',
        name: 'bash',
        content: envelopeContent('call-t2', {
          success: false,
          error: 'command exited with status 1',
          content: '',
        }),
      }),
    ];

    const state = extractSemanticCheckpoint(messages);

    expect(state.completedWork).toHaveLength(0);
    expect(state.blockers).toHaveLength(2);
    expect(state.blockers[0]!.exactError).toContain('old_string not found');
    expect(state.blockers[1]!.exactError).toContain('exited with status 1');
  });

  it('accumulates the artifact inventory across generations, newest kept on overflow', () => {
    const previous = emptySemanticCheckpoint();
    previous.artifacts = [{
      path: '/repo/src/World.js', operation: 'created', reason: 'write tool', sourceMessageIds: ['old'],
    }];
    const messages: Message[] = [{
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: 2,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'write', arguments: JSON.stringify({ file_path: '/repo/src/Chunk.js' }) },
      }],
    }];

    const state = extractSemanticCheckpoint(messages, previous);

    const paths = state.artifacts.map(artifact => artifact.path);
    expect(paths).toContain('/repo/src/World.js');
    expect(paths).toContain('/repo/src/Chunk.js');
  });
});

describe('fitSemanticCheckpointToTokenBudget', () => {
  const estimate = (text: string) => Math.ceil(text.length / 4);

  function crowdedState(): SemanticCheckpointStateV1 {
    const state = emptySemanticCheckpoint();
    state.completedWork = Array.from({ length: 12 }, (_, index) => ({
      text: `completed step ${index}: ${'detail '.repeat(40)}`,
      sourceMessageIds: [`m-${index}`],
    }));
    state.durableFacts = Array.from({ length: 6 }, (_, index) => ({
      text: `fact ${index}: ${'detail '.repeat(40)}`,
      sourceMessageIds: [`f-${index}`],
    }));
    state.artifacts = Array.from({ length: 40 }, (_, index) => ({
      path: `/repo/src/module-${index}.ts`,
      operation: 'created' as const,
      reason: 'write tool',
      sourceMessageIds: [`a-${index}`],
    }));
    return state;
  }

  it('sacrifices fact text before the artifact inventory', () => {
    const fitted = fitSemanticCheckpointToTokenBudget(crowdedState(), 1_500, estimate);

    // Facts were trimmed while the file inventory survived intact.
    expect(fitted.artifacts).toHaveLength(40);
    expect(fitted.completedWork.length).toBeLessThan(12);
  });

  it('keeps a usable artifact floor even under extreme pressure', () => {
    const fitted = fitSemanticCheckpointToTokenBudget(crowdedState(), 400, estimate);

    expect(fitted.artifacts.length).toBeGreaterThanOrEqual(3);
    // The survivors are the newest entries.
    expect(fitted.artifacts.at(-1)!.path).toBe('/repo/src/module-39.ts');
  });
});

describe('mergeSemanticCheckpoint', () => {
  it('deduplicates artifacts keeping the newest occurrence of each path/operation', () => {
    const previous = emptySemanticCheckpoint();
    previous.artifacts = [
      { path: '/repo/a.ts', operation: 'created', reason: 'write tool', sourceMessageIds: ['old-a'] },
      { path: '/repo/b.ts', operation: 'created', reason: 'write tool', sourceMessageIds: ['old-b'] },
    ];
    const proposed = emptySemanticCheckpoint();
    proposed.artifacts = [
      { path: '/repo/a.ts', operation: 'created', reason: 'rewritten', sourceMessageIds: ['new-a'] },
    ];

    const merged = mergeSemanticCheckpoint(previous, proposed);

    expect(merged.artifacts).toHaveLength(2);
    const entryA = merged.artifacts.find(artifact => artifact.path === '/repo/a.ts');
    expect(entryA?.sourceMessageIds).toEqual(['new-a']);
  });
});
