import { describe, expect, it } from 'vitest';
import type { Completion } from '@services/CompletionProvider.js';
import {
  getCompletionAcceptDecision,
  moveCompletionSelection,
  shouldConsumeHistoryNextAtDraft,
  shouldNavigateHistoryNext,
  shouldNavigateHistoryPrevious,
} from '../inputInteraction.js';

const completion = (overrides: Partial<Completion> = {}): Completion => ({
  value: 'item',
  type: 'option',
  ...overrides,
});

describe('completion acceptance policy', () => {
  it('runs complete slash commands with Enter', () => {
    expect(getCompletionAcceptDecision(
      completion({ type: 'command', enterBehavior: 'submit' }),
      'enter'
    )).toEqual({ appendSpace: false, submit: true });
  });

  it('keeps structured slash commands in the editor with a separator', () => {
    expect(getCompletionAcceptDecision(
      completion({ type: 'command', enterBehavior: 'insert' }),
      'enter'
    )).toEqual({ appendSpace: true, submit: false });
  });

  it('never submits from Tab', () => {
    expect(getCompletionAcceptDecision(
      completion({ type: 'command', enterBehavior: 'submit' }),
      'tab'
    )).toEqual({ appendSpace: true, submit: false });
  });

  it('does not separate unfinished completion prefixes', () => {
    expect(getCompletionAcceptDecision(
      completion({ type: 'directory', continueInput: true }),
      'enter'
    )).toEqual({ appendSpace: false, submit: false });
  });
});

describe('completion selection navigation', () => {
  it('wraps in both directions', () => {
    expect(moveCompletionSelection(0, 3, -1)).toBe(2);
    expect(moveCompletionSelection(2, 3, 1)).toBe(0);
    expect(moveCompletionSelection(0, 0, 1)).toBe(0);
  });
});

describe('history key ownership', () => {
  it('owns Up throughout a single-line draft', () => {
    expect(shouldNavigateHistoryPrevious('draft', 3, false)).toBe(true);
  });

  it('leaves internal multiline arrows to the editor', () => {
    expect(shouldNavigateHistoryPrevious('one\ntwo', 5, false)).toBe(false);
    expect(shouldNavigateHistoryNext('one\ntwo', 2, false)).toBe(false);
  });

  it('keeps both arrows while history traversal is active', () => {
    expect(shouldNavigateHistoryPrevious('one\ntwo', 5, true)).toBe(true);
    expect(shouldNavigateHistoryNext('one\ntwo', 2, true)).toBe(true);
  });

  it('consumes Down on a single-line draft instead of moving its cursor', () => {
    expect(shouldConsumeHistoryNextAtDraft('draft', false)).toBe(true);
    expect(shouldConsumeHistoryNextAtDraft('one\ntwo', false)).toBe(false);
  });
});
