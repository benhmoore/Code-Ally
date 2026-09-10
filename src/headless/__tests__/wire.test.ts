import { describe, it, expect } from 'vitest';
import { advertisedToolNames } from '../wire.js';

describe('advertisedToolNames', () => {
  const TOOLS = ['bash', 'read', 'write', 'mcp-github-create-issue'];

  it('lists every tool when the run forbids none', () => {
    expect(advertisedToolNames(TOOLS, [])).toEqual(TOOLS);
  });

  it('drops a tool the run cannot call', () => {
    expect(advertisedToolNames(TOOLS, ['bash', 'write'])).toEqual(['read', 'mcp-github-create-issue']);
  });

  it('matches the spellings and globs the deny list accepts', () => {
    expect(advertisedToolNames(TOOLS, ['Bash'])).toEqual(['read', 'write', 'mcp-github-create-issue']);
    expect(advertisedToolNames(TOOLS, ['mcp__github__*'])).toEqual(['bash', 'read', 'write']);
  });
});
