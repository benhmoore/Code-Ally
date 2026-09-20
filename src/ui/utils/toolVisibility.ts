/**
 * What a tool call shows: its children, output, errors and diff.
 *
 * Tools declare a default presentation (`collapsed`, `hideOutput`,
 * `alwaysShowFullOutput`), the user can expand or collapse a call, and the
 * `show_full_tool_output` preference overrides everything. Resolving these in
 * one place keeps the row, its height estimate and the keyboard toggle in
 * agreement.
 */

import type { ToolCallState } from '@shared/index.js';

export interface ToolVisibility {
  /** Children, output, errors and the diff are hidden. */
  collapsed: boolean;
  /** Output text is shown (subject to truncation). */
  showOutput: boolean;
  /** Output is shown without truncation. */
  fullOutput: boolean;
  /** Nested tool calls and notices are shown. */
  showChildren: boolean;
}

export interface ToolVisibilityConfig {
  show_full_tool_output?: boolean;
}

/** Whether the call is open: the user's choice when made, else the tool's default. */
export function isToolCallExpanded(toolCall: Pick<ToolCallState, 'expanded' | 'collapsed'>): boolean {
  return toolCall.expanded ?? !toolCall.collapsed;
}

export function resolveToolVisibility(toolCall: ToolCallState, config?: ToolVisibilityConfig): ToolVisibility {
  const full = config?.show_full_tool_output === true;
  const collapsed = !isToolCallExpanded(toolCall);
  const showOutput =
    !collapsed &&
    (toolCall.expanded === true ||
      full ||
      toolCall.isLinkedPlugin === true ||
      toolCall.alwaysShowFullOutput === true ||
      !toolCall.hideOutput);

  return {
    collapsed,
    showOutput,
    fullOutput: full || toolCall.alwaysShowFullOutput === true,
    showChildren: full || !collapsed,
  };
}
