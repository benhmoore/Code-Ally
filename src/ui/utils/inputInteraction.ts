import type { Completion } from '@services/CompletionProvider.js';

export type CompletionAcceptKey = 'enter' | 'tab';

export interface CompletionAcceptDecision {
  appendSpace: boolean;
  submit: boolean;
}

/**
 * One explicit acceptance policy shared by the keyboard handler and UI hints.
 * Enter may execute a complete slash command; Tab always edits. Providers can
 * mark unfinished prefixes (directories, `key=`) to suppress the separator.
 */
export function getCompletionAcceptDecision(
  completion: Completion,
  key: CompletionAcceptKey
): CompletionAcceptDecision {
  const submit = key === 'enter' &&
    completion.type === 'command' &&
    completion.enterBehavior !== 'insert';

  const appendSpace = !submit && completion.continueInput !== true;

  return { appendSpace, submit };
}

/** Arrow navigation wraps deliberately, so another keypress always has feedback. */
export function moveCompletionSelection(
  currentIndex: number,
  itemCount: number,
  direction: -1 | 1
): number {
  if (itemCount <= 0) return 0;
  return (currentIndex + direction + itemCount) % itemCount;
}

/**
 * Single-line prompts use shell-style history ownership. Multiline drafts keep
 * vertical cursor movement except at their absolute outer boundaries.
 */
export function shouldNavigateHistoryPrevious(
  value: string,
  cursorPosition: number,
  historyActive: boolean
): boolean {
  return historyActive || !value.includes('\n') || cursorPosition === 0;
}

export function shouldNavigateHistoryNext(
  value: string,
  cursorPosition: number,
  historyActive: boolean
): boolean {
  return historyActive || (!value.includes('\n') && cursorPosition === value.length);
}

/** Down on a single-line draft has no cursor meaning and must not jump to EOF. */
export function shouldConsumeHistoryNextAtDraft(
  value: string,
  historyActive: boolean
): boolean {
  return !historyActive && !value.includes('\n');
}
