import { describe, expect, it } from 'vitest';
import {
  extractSemanticCheckpoint,
  fitSemanticCheckpointToTokenBudget,
  mergeSemanticCheckpoint,
  parseSemanticCheckpoint,
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

  it('summarizes envelopes that carry a trailing system-reminder block', () => {
    // Observed in a live 16k run: the harness appends turn guidance after the
    // JSON envelope, so a whole-payload parse fails and both the raw envelope
    // and the reminder text get embedded verbatim into checkpoint facts.
    const messages: Message[] = [toolResult({
      id: 't1',
      name: 'write',
      content: `[Tool Call ID: call-t1]\n${JSON.stringify({
        success: true,
        error: '',
        content: 'Created new file /repo/src/config.js (903 bytes)',
        file_path: '/repo/src/config.js',
        file_check: { checker: 'javascript', passed: true },
      })}\n\n<system-reminder>\nStay on task. Use todo-write to update status.\n</system-reminder>`,
    })];

    const state = extractSemanticCheckpoint(messages);

    expect(state.blockers).toHaveLength(0);
    const summary = state.completedWork[0]!.text;
    expect(summary).toBe('write: Created new file /repo/src/config.js (903 bytes)');
    expect(summary).not.toContain('system-reminder');
    expect(summary).not.toContain('"success"');
  });

  it('detects envelope failure even when a system-reminder follows it', () => {
    const messages: Message[] = [toolResult({
      id: 't1',
      name: 'bash',
      content: `[Tool Call ID: call-t1]\n${JSON.stringify({
        success: false,
        error: 'command exited with status 1',
        content: '',
      })}\n\n<system-reminder>Stay on task.</system-reminder>`,
    })];

    const state = extractSemanticCheckpoint(messages);

    expect(state.completedWork).toHaveLength(0);
    expect(state.blockers).toHaveLength(1);
    expect(state.blockers[0]!.exactError).toContain('exited with status 1');
  });

  it('classifies structured tool failures as blockers with the exact error', () => {
    const messages: Message[] = [
      toolResult({
        id: 't1',
        name: 'apply-patch',
        is_error: true,
        content: `[Tool Call ID: call-t1]\n<error type="validation_error">\nPatch context does not match the current file\n</error>`,
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
    expect(state.blockers[0]!.exactError).toContain('Patch context does not match');
    expect(state.blockers[1]!.exactError).toContain('exited with status 1');
  });

  it('carries the assistant last stated intent into activeWork, and skips evicted stubs', () => {
    const messages: Message[] = [
      {
        id: 'a1',
        role: 'assistant',
        content: 'Chunk mesher done. Moving to input handling and the player controller next.',
        timestamp: 1,
      },
      toolResult({
        id: 't1',
        content: '[Tool Call ID: call-t1]\n[Tool output evicted to reclaim context: ~800-token read result.]',
        metadata: { contentEvicted: true },
      }),
    ];

    const state = extractSemanticCheckpoint(messages);

    expect(state.activeWork.some(entry =>
      entry.text.includes('Moving to input handling'))).toBe(true);
    // Evicted stubs are not "completed work" — their artifacts carry the record.
    expect(state.completedWork).toHaveLength(0);
    expect(state.blockers).toHaveLength(0);
    expect(state.nextActions).toHaveLength(1);
    expect(state.nextActions[0]!.text).toContain('reconciling it with the newest tool evidence');
  });

  it('separates a planned action from an unverified diagnosis', () => {
    const state = extractSemanticCheckpoint([{
      id: 'a1',
      role: 'assistant',
      content: 'The server is definitely on port 5173. The page may be an overlay. Let me inspect the loaded scripts and title.',
      timestamp: 1,
    }]);

    expect(state.activeWork[0]!.text).toContain('Let me inspect the loaded scripts and title');
    expect(state.activeWork[0]!.text).not.toContain('definitely on port 5173');
    expect(state.nextActions[0]!.text).toContain('newest tool evidence');
  });

  it('replaces stale handoffs with the newest executable intent across generations', () => {
    const previous = emptySemanticCheckpoint();
    previous.activeWork = [{ text: 'Inspect all existing files.', sourceMessageIds: ['old'] }];
    previous.nextActions = [{ text: 'Read the repository.', sourceMessageIds: ['old'] }];

    const state = extractSemanticCheckpoint([{
      id: 'a-new',
      role: 'assistant',
      content: 'The API review is complete. Implement the player controller next.',
      timestamp: 2,
    }], previous);

    expect(state.activeWork).toHaveLength(1);
    expect(state.activeWork[0]!.text).toContain('Implement the player controller next');
    expect(state.nextActions).toHaveLength(1);
    expect(state.nextActions[0]!.text).toContain('Implement the player controller next');
    expect(state.activeWork[0]!.text).not.toContain('Inspect all existing files');
  });

  it('records cross-language declaration outlines on written artifacts', () => {
    const messages: Message[] = [{
      id: 'a1',
      role: 'assistant',
      content: 'Creating modules.',
      timestamp: 1,
      tool_calls: [{
        id: 'call-js', type: 'function', function: { name: 'write', arguments: {
          file_path: '/repo/world.ts',
          content: 'export class World {\n  getBlock(x: number) { return x; }\n}\nexport function createWorld() {}',
        } },
      }, {
        id: 'call-py', type: 'function', function: { name: 'write', arguments: {
          file_path: '/repo/service.py',
          content: 'class Service:\n    def run(self):\n        pass',
        } },
      }],
    }];

    const state = extractSemanticCheckpoint(messages);
    const world = state.artifacts.find(artifact => artifact.path === '/repo/world.ts')!;
    const service = state.artifacts.find(artifact => artifact.path === '/repo/service.py')!;
    expect(world.reason).toContain('export class World');
    expect(world.reason).toContain('getBlock(x: number)');
    expect(service.reason).toContain('class Service');
    expect(service.reason).toContain('def run(self)');
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

describe('parseSemanticCheckpoint', () => {
  it('salvages valid evidence when an independent array bucket is malformed', () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      objective: { text: 'Build the project.', sourceMessageIds: ['u1'] },
      currentRequest: { text: 'Continue implementation.', sourceMessageIds: ['u1'] },
      userConstraints: [],
      decisions: [{ text: 'invalid provenance', sourceMessageIds: ['invented'] }],
      completedWork: [{ text: 'Scaffolding created.', sourceMessageIds: ['t1'] }],
      activeWork: [],
      blockers: [],
      nextActions: [{ text: 'Implement the next module.', sourceMessageIds: ['a1'] }],
      unresolvedQuestions: [],
      durableFacts: [],
      artifacts: [
        { path: 'relative/file.js', reason: 'invalid', operation: 'created', sourceMessageIds: ['t1'] },
        { path: '/repo/file.js', reason: 'write tool', operation: 'created', sourceMessageIds: ['t1'] },
      ],
    });

    const state = parseSemanticCheckpoint(raw, ['u1', 't1', 'a1']);

    expect(state.decisions).toEqual([]);
    expect(state.completedWork[0]?.text).toBe('Scaffolding created.');
    expect(state.nextActions[0]?.text).toBe('Implement the next module.');
    expect(state.artifacts.map(item => item.path)).toEqual(['/repo/file.js']);
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
