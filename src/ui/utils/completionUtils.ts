import type { Completion } from '@services/CompletionProvider.js';

export interface CompletionApplication {
  completion: Completion;
  insertText: string;
  nextValue: string;
  nextCursorPosition: number;
}

export interface CompletionApplicationOptions {
  appendSpace?: boolean;
}

/**
 * Replace the token at the cursor with the selected completion.
 */
export function applyCompletionToInput(
  value: string,
  cursorPosition: number,
  completion: Completion,
  options: CompletionApplicationOptions = {}
): CompletionApplication {
  const insertText = completion.insertText || completion.value;
  const wordStart = getCompletionWordStart(value, cursorPosition, completion);
  const wordEnd = getCompletionWordEnd(value, cursorPosition);
  const before = value.slice(0, wordStart);
  const after = value.slice(wordEnd);
  const acceptedText = shouldAppendSpace(insertText, after, options)
    ? `${insertText} `
    : insertText;

  return {
    completion,
    insertText,
    nextValue: before + acceptedText + after,
    nextCursorPosition: wordStart + acceptedText.length,
  };
}

function getCompletionWordStart(
  value: string,
  cursorPosition: number,
  completion: Completion
): number {
  let wordStart = cursorPosition;

  while (wordStart > 0) {
    const char = value[wordStart - 1];
    if (!char || isCompletionBoundary(char, completion)) break;
    wordStart--;
  }

  return wordStart;
}

function isCompletionBoundary(char: string, completion: Completion): boolean {
  if (completion.type === 'file') {
    return /[\s/]/.test(char);
  }

  return /\s/.test(char);
}

function getCompletionWordEnd(value: string, cursorPosition: number): number {
  let wordEnd = cursorPosition;

  while (wordEnd < value.length) {
    const char = value[wordEnd];
    if (!char || /\s/.test(char)) break;
    wordEnd++;
  }

  return wordEnd;
}

function shouldAppendSpace(
  insertText: string,
  after: string,
  options: CompletionApplicationOptions
): boolean {
  return Boolean(
    options.appendSpace &&
    insertText.length > 0 &&
    !insertText.endsWith(' ') &&
    !after.startsWith(' ')
  );
}
