import { describe, expect, it } from 'vitest';
import { scoreSchemaReliability } from '../schemaReliabilityScoring.js';
import type { LLMResponse } from '../../llm/ModelClient.js';
const response = (name: string, args: Record<string, unknown>): LLMResponse => ({ role: 'assistant', content: '',
  tool_calls: [{ id: 'call', function: { name, arguments: args } }],
});

describe('schema reliability scoring', () => {
  it('cannot give full marks to memory writes missing their required description', () => {
    const args = { action: 'save', name: 'package-manager', type: 'feedback', body: 'Use pnpm' };
    const invalid = scoreSchemaReliability('memory_save', response('memory', args));
    expect(invalid.dimensions.functional.score).toBe(0);
    expect(invalid.notes.join(' ')).toContain('description');
    const valid = scoreSchemaReliability('memory_save', response('memory', { ...args, description: 'Use pnpm for workspaces' }));
    expect(valid.score).toBe(valid.maxScore);
  });

  it('rejects even valid arguments for a capability absent from the captured surface', () => {
    const result = scoreSchemaReliability('memory_save', response('memory', {
      action: 'save', name: 'package-manager', type: 'feedback', body: 'Use pnpm', description: 'Use pnpm for workspaces',
    }), undefined, []);
    expect(result.dimensions.functional.score).toBe(0);
    expect(result.notes.join(' ')).toContain('not exposed');
  });

  it('cannot give full marks to scheduling calls without a title or with conflicting timing modes', () => {
    const args = { action: 'create', policy_preset: 'none', run_prompt: 'Run npm test', schedule: { type: 'once', run_in_minutes: 30 } };
    const invalid = scoreSchemaReliability('relative_schedule', response('scheduled-tasks', args));
    expect(invalid.dimensions.functional.score).toBe(0);
    expect(invalid.notes.join(' ')).toContain('title');
    const valid = scoreSchemaReliability('relative_schedule', response('scheduled-tasks', { ...args, title: 'Run tests' }));
    expect(valid.score).toBe(valid.maxScore);
    const conflict = scoreSchemaReliability('relative_schedule', response('scheduled-tasks', {
      ...args, title: 'Run tests', schedule: { ...args.schedule, run_at: '2099-01-01T00:00:00Z' },
    }));
    expect(conflict.dimensions.functional.score).toBe(0);
  });
});
