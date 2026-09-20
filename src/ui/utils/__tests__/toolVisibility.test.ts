import { describe, expect, it } from 'vitest';
import type { ToolCallState } from '@shared/index.js';
import { isToolCallExpanded, resolveToolVisibility } from '../toolVisibility.js';

const call = (overrides: Partial<ToolCallState>): ToolCallState => ({
  id: 't', status: 'success', toolName: 'read', arguments: {}, startTime: 1, ...overrides,
});

describe('resolveToolVisibility', () => {
  it('follows the tool default until the user decides', () => {
    expect(resolveToolVisibility(call({}))).toMatchObject({ collapsed: false, showOutput: true, showChildren: true });
    expect(resolveToolVisibility(call({ collapsed: true }))).toMatchObject({ collapsed: true, showOutput: false, showChildren: false });
    expect(isToolCallExpanded(call({ collapsed: true }))).toBe(false);
  });

  it('hides output a tool keeps quiet, unless the user opens the call', () => {
    expect(resolveToolVisibility(call({ hideOutput: true })).showOutput).toBe(false);
    expect(resolveToolVisibility(call({ hideOutput: true, expanded: true })).showOutput).toBe(true);
    expect(resolveToolVisibility(call({ hideOutput: true, expanded: true })).fullOutput).toBe(false);
  });

  it('lets the user close a call the tool left open', () => {
    expect(resolveToolVisibility(call({ expanded: false }))).toMatchObject({ collapsed: true, showOutput: false, showChildren: false });
  });

  it('shows everything untruncated under show_full_tool_output', () => {
    const visibility = resolveToolVisibility(call({ collapsed: true, hideOutput: true }), { show_full_tool_output: true });
    expect(visibility).toMatchObject({ collapsed: true, showOutput: false, showChildren: true, fullOutput: true });
    expect(resolveToolVisibility(call({ hideOutput: true }), { show_full_tool_output: true }).showOutput).toBe(true);
  });

  it('never truncates tools that insist on full output', () => {
    expect(resolveToolVisibility(call({ alwaysShowFullOutput: true, hideOutput: true }))).toMatchObject({ showOutput: true, fullOutput: true });
  });
});
