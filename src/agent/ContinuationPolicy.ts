/** Shared ordering for decisions at a completed response boundary. */
export type ContinuationDecision =
  | 'terminal'
  | 'required_tools'
  | 'requirements'
  | 'tools'
  | 'objective'
  | 'unfinished_work'
  | 'complete';

export interface ContinuationInputs {
  terminal?: boolean;
  missingRequiredTools?: boolean;
  unmetRequirements?: boolean;
  hasToolCalls?: boolean;
  durableObjective?: boolean;
  unfinishedWork?: boolean;
}

export function decideContinuation(input: ContinuationInputs): ContinuationDecision {
  if (input.terminal) return 'terminal';
  if (input.hasToolCalls) return 'tools';
  if (input.missingRequiredTools) return 'required_tools';
  if (input.unmetRequirements) return 'requirements';
  if (input.durableObjective) return 'objective';
  if (input.unfinishedWork) return 'unfinished_work';
  return 'complete';
}
