import { describe, expect, it } from 'vitest';
import { BEHAVIOR_PROTOCOL_VERSION, assertBehaviorProtocol, resolveBehaviorFactors } from '../behaviorFactors.js';
describe('explicit behavior campaign factors', () => {
  it('makes a single baseline exercise current production', () => {
    expect(resolveBehaviorFactors(['baseline'])).toEqual({
      baseline: { editSurface: 'exact', promptVariant: 'baseline' },
    });
  });
  it('changes only prompt advice in the behavior comparison', () => {
    const factors = resolveBehaviorFactors(['baseline', 'outcome']);
    expect(factors.baseline?.editSurface).toBe('exact');
    expect(factors.outcome?.editSurface).toBe('exact');
    expect(factors.baseline?.promptVariant).toBe('baseline');
    expect(factors.outcome?.promptVariant).toBe('outcome');
  });
  it('changes only edit interface in the editing comparison', () => {
    const factors = resolveBehaviorFactors(['baseline', 'exact-edit']);
    expect(factors.baseline).toEqual({ editSurface: 'historical-unified', promptVariant: 'baseline' });
    expect(factors['exact-edit']).toEqual({ editSurface: 'exact', promptVariant: 'baseline' });
  });
  it('does not depend on caller variant ordering', () => {
    expect(resolveBehaviorFactors(['exact-edit', 'baseline'])).toEqual(
      resolveBehaviorFactors(['baseline', 'exact-edit'])
    );
  });
  it('rejects mixed independent variables and repeated labels', () => {
    expect(() => resolveBehaviorFactors(['outcome', 'exact-edit'])).toThrow();
    expect(() => resolveBehaviorFactors(['baseline', 'baseline'])).toThrow();
    expect(() => resolveBehaviorFactors(['baseline', 'outcome', 'exact-edit'])).toThrow();
  });
});

it('resolves actual factory schemas with exactly one factor changed per pair', async () => {
  const { createBuiltInTools } = await import('../../tools/createBuiltInTools.js');
  const { ActivityStream } = await import('../../services/ActivityStream.js');
  const { DEFAULT_CONFIG } = await import('../../config/defaults.js');
  const { applyBehaviorVariant, BASELINE_OPERATION_RULE } = await import('../behaviorPolicies.js');
  const messages = [{ role: 'system' as const, content: `Identity\n${BASELINE_OPERATION_RULE}` }];
  const payload = (factors: {
    editSurface: 'exact' | 'historical-unified';
    promptVariant: 'baseline' | 'outcome';
  }) => ({
    messages: applyBehaviorVariant(messages, factors.promptVariant),
    tools: createBuiltInTools(new ActivityStream(), DEFAULT_CONFIG, { editSurface: factors.editSurface }).map(tool =>
      tool.getFunctionDefinition()
    ),
  });
  const behavior = resolveBehaviorFactors(['baseline', 'outcome']);
  const base = payload(behavior.baseline!);
  const outcome = payload(behavior.outcome!);
  expect(base.tools).toEqual(outcome.tools);
  expect(base.messages).not.toEqual(outcome.messages);
  const editing = resolveBehaviorFactors(['baseline', 'exact-edit']);
  const historical = payload(editing.baseline!);
  const exact = payload(editing['exact-edit']!);
  expect(historical.messages).toEqual(exact.messages);
  const differences = historical.tools.filter(
    (tool, index) => JSON.stringify(tool) !== JSON.stringify(exact.tools[index])
  );
  expect(differences.map(tool => tool.function.name)).toEqual(['apply-patch']);
  const actualDefault = createBuiltInTools(new ActivityStream(), DEFAULT_CONFIG).find(
    tool => tool.name === 'apply-patch'
  );
  expect(actualDefault?.getFunctionDefinition().function.parameters.required).toEqual([
    'file_path',
    'old_text',
    'new_text',
  ]);
});

it('rejects earlier task/verifier protocols even when their labels and resolved factors match', () => {
  expect(() => assertBehaviorProtocol(BEHAVIOR_PROTOCOL_VERSION)).not.toThrow();
  for (const version of [1, 2, undefined, null, String(BEHAVIOR_PROTOCOL_VERSION)])
    expect(() => assertBehaviorProtocol(version)).toThrow('protocol changed');
});
