import { describe, expect, it } from 'vitest';
import { applyBehaviorVariant, BASELINE_OPERATION_RULE, OUTCOME_OPERATION_RULE } from '../behaviorPolicies.js';
import type { Message } from '../../types/index.js';

describe('behavior policy ablation', () => {
  it('changes only the named system directive without mutating the live conversation', () => {
    const messages: Message[] = [
      { role: 'system', content: `Stable identity\n${BASELINE_OPERATION_RULE}\nProject constraints` },
      { role: 'user', content: BASELINE_OPERATION_RULE },
      { role: 'tool', content: BASELINE_OPERATION_RULE },
    ];
    const candidate = applyBehaviorVariant(messages, 'outcome');
    expect(candidate[0]?.content).toBe(`Stable identity\n${OUTCOME_OPERATION_RULE}\nProject constraints`);
    expect(candidate.slice(1)).toEqual(messages.slice(1));
    expect(messages[0]?.content).toContain(BASELINE_OPERATION_RULE);
    expect(applyBehaviorVariant(messages, 'baseline')).toEqual(messages);
    expect(applyBehaviorVariant(candidate, 'outcome')).toEqual(candidate);
  });
});
