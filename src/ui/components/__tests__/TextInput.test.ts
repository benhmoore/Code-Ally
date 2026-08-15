import { describe, expect, test } from 'vitest';
import { enterInsertsNewline } from '../TextInput.js';

describe('TextInput submit invariant', () => {
  test('Shift+Enter inserts a newline only in multiline inputs', () => {
    expect(enterInsertsNewline(true, true)).toBe(true);
    expect(enterInsertsNewline(false, true)).toBe(false);
  });

  test('plain Enter always submits', () => {
    expect(enterInsertsNewline(true, false)).toBe(false);
    expect(enterInsertsNewline(false, false)).toBe(false);
  });
});
