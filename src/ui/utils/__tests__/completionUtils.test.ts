import { describe, expect, it } from 'vitest';
import { applyCompletionToInput } from '../completionUtils.js';
import type { Completion } from '@services/CompletionProvider.js';

describe('completionUtils', () => {
  it('replaces a partial slash command and appends a space when requested', () => {
    const completion: Completion = {
      value: 'task',
      type: 'command',
      insertText: '/task',
      enterBehavior: 'insert',
    };

    const result = applyCompletionToInput('/ta', 3, completion, { appendSpace: true });

    expect(result.nextValue).toBe('/task ');
    expect(result.nextCursorPosition).toBe('/task '.length);
  });

  it('replaces a partial slash command without changing Tab behavior', () => {
    const completion: Completion = {
      value: 'task',
      type: 'command',
      insertText: '/task',
      enterBehavior: 'insert',
    };

    const result = applyCompletionToInput('/ta', 3, completion);

    expect(result.nextValue).toBe('/task');
    expect(result.nextCursorPosition).toBe('/task'.length);
  });

  it('does not duplicate an existing following space', () => {
    const completion: Completion = {
      value: 'task',
      type: 'command',
      insertText: '/task',
      enterBehavior: 'insert',
    };

    const result = applyCompletionToInput('/ta now', 3, completion, { appendSpace: true });

    expect(result.nextValue).toBe('/task now');
    expect(result.nextCursorPosition).toBe('/task'.length);
  });

  it('preserves the typed directory prefix for file completions', () => {
    const completion: Completion = {
      value: 'CompletionProvider.ts',
      type: 'file',
    };
    const input = '/open src/Com';

    const result = applyCompletionToInput(input, input.length, completion);

    expect(result.nextValue).toBe('/open src/CompletionProvider.ts');
  });

  it('uses the provider edit range instead of guessing token boundaries', () => {
    const input = '/open src/Com';
    const completion: Completion = {
      value: 'CompletionProvider.ts',
      type: 'file',
      insertText: 'CompletionProvider.ts',
      replaceStart: '/open src/'.length,
      replaceEnd: input.length,
    };

    const result = applyCompletionToInput(input, input.length, completion);

    expect(result.nextValue).toBe('/open src/CompletionProvider.ts');
    expect(result.nextCursorPosition).toBe(result.nextValue.length);
  });

  it('preserves mention syntax while replacing a fuzzy @ token', () => {
    const input = 'review @Comp please';
    const completion: Completion = {
      value: 'CompletionProvider.ts',
      type: 'file',
      insertText: '@src/CompletionProvider.ts',
      replaceStart: 'review '.length,
      replaceEnd: 'review @Comp'.length,
    };

    const result = applyCompletionToInput(input, 'review @Comp'.length, completion, { appendSpace: true });

    expect(result.nextValue).toBe('review @src/CompletionProvider.ts please');
    expect(result.nextCursorPosition).toBe('review @src/CompletionProvider.ts'.length);
  });
});
