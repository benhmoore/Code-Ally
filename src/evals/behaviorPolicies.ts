/** Isolated request-boundary ablation; production prompts remain authoritative. */
import type { Message } from '../types/index.js';
import type { PromptVariant } from './behaviorFactors.js';
export type { CampaignVariant as BehaviorVariant, PromptVariant } from './behaviorFactors.js';

export const BASELINE_OPERATION_RULE =
  '- For different independent operations, emit separate native tool calls in one response.';
export const OUTCOME_OPERATION_RULE =
  "- Emit independent native tool calls together when each can run without another call's result. Keep each read bounded to the required symbols or ranges. After each result, choose the next action from what is still missing; do not repeat a successful inspection or delegate work already completed.";
export function applyBehaviorVariant(messages: readonly Message[], variant: PromptVariant): Message[] {
  return messages.map(message => {
    if (message.role !== 'system' || !message.content.includes(BASELINE_OPERATION_RULE)) return message;
    return variant === 'baseline'
      ? message
      : {
          ...message,
          content: message.content.replace(BASELINE_OPERATION_RULE, OUTCOME_OPERATION_RULE),
        };
  });
}
