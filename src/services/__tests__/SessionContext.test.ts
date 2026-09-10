import { describe, expect, it } from 'vitest';
import { SessionContext } from '../SessionContext.js';

describe('SessionContext', () => {
  it('renders entries in insertion order and drops blanks', () => {
    const context = new SessionContext();
    context.add('  first  ');
    context.add('   ');
    context.add('second');
    expect(context.isEmpty()).toBe(false);
    expect(context.render()).toBe('first\n\nsecond');
  });

  it('renders nothing when empty', () => {
    const context = new SessionContext();
    expect(context.isEmpty()).toBe(true);
    expect(context.render()).toBe('');
  });
});
