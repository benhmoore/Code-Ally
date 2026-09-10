import type { LLMResponse } from './ModelClient.js';

/** Provider-reported output exhaustion is not a deliberate completed response. */
export function isOutputLimited(response: Pick<LLMResponse, 'finishReason'>): boolean {
  return response.finishReason === 'length'
    || response.finishReason === 'max_tokens'
    || response.finishReason === 'max_output_tokens';
}
