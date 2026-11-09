/** Isolated request-boundary ablation; production prompts remain authoritative. */
import type { Message } from '../types/index.js';

export const BASELINE_OPERATION_RULE =
  '- For different independent operations, emit separate native tool calls in one response.';
export const OUTCOME_OPERATION_RULE =
  "- Emit independent native tool calls together when each can run without another call's result. Keep each read bounded to the required symbols or ranges. After each result, choose the next action from what is still missing; do not repeat a successful inspection or delegate work already completed.";
export type BehaviorVariant = 'baseline' | 'outcome' | 'exact-edit';

export const EXACT_EDIT_RULE = '- For existing files, call apply-patch with file_path, old_text, and new_text. old_text must match exactly once, including whitespace. Do not send unified diffs or numeric hunk headers. Use write only to create new files.';

export function applyBehaviorVariant(messages: readonly Message[], variant: BehaviorVariant): Message[] {
  return messages.map(message => {
    if (message.role !== 'system') return message;
    if (variant === 'exact-edit') {
      if (!message.content.includes(BASELINE_OPERATION_RULE)) return message;
      // Replace all schema-era edit guidance, rather than appending contradictory instructions.
      const lines = message.content.split('\n');
      const replacement = lines.map(line => /apply-patch|unified.diff|numeric.*hunk/i.test(line) ? EXACT_EDIT_RULE : line);
      if (!replacement.includes(EXACT_EDIT_RULE)) replacement.push(EXACT_EDIT_RULE);
      const content = replacement.filter((line, index) => line !== EXACT_EDIT_RULE || replacement.indexOf(line) === index).join('\n');
      return content === message.content ? message : { ...message, content };
    }
    if (!message.content.includes(BASELINE_OPERATION_RULE)) return message;
    return variant === 'baseline' ? message : { ...message, content: message.content.replace(BASELINE_OPERATION_RULE, OUTCOME_OPERATION_RULE) };
  });
}
