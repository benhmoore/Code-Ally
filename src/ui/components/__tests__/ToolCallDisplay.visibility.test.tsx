/**
 * Integration tests for ToolCallDisplay child tool visibility logic
 *
 * Tests the shouldShowChildTool function which determines when child tools
 * are visible in the UI based on:
 * - collapsed: Tool collapsed in UI
 * - hideOutput: Parent hides non-agent children (NOTE: affects OUTPUT only, not visibility)
 * - isAgentTool: Is this an agent delegation tool?
 * - show_full_tool_output: User config override
 *
 * Current implementation (simplified):
 * - show_full_tool_output=true → always visible
 * - collapsed=true → hidden
 * - otherwise → visible
 *
 * hideOutput does NOT affect child tool visibility (only affects output text)
 */

import { describe, test, expect } from 'vitest';
import { ToolCallState } from '@shared/index.js';
import { shouldShowChildTool } from '../ToolCallDisplay.js';

/**
 * Helper to create a mock ToolCallState with minimal required fields
 */
function createMockToolCall(toolName: string): ToolCallState {
  return {
    id: 'test-id',
    toolName,
    status: 'completed',
    startTime: Date.now(),
    arguments: {},
  } as ToolCallState;
}

describe('ToolCallDisplay - Child Tool Visibility', () => {
  /**
   * Comprehensive truth table test covering all 16 combinations
   *
   * Variables:
   * - collapsed: boolean (parent tool collapsed state)
   * - hideOutput: boolean (parent hideOutput flag - affects OUTPUT only)
   * - isAgentTool: boolean (whether child is an agent tool)
   * - show_full_tool_output: boolean (user config override)
   *
   * Expected behavior:
   * - show_full_tool_output=true → always visible (regardless of other flags)
   * - collapsed=true → hidden (unless show_full_tool_output=true)
   * - hideOutput has NO effect on visibility (only affects output text)
   */
  test.each([
    // Format: [collapsed, hideOutput, isAgentTool, show_full, expected]

    // collapsed=false, hideOutput=false (fully expanded, no hiding)
    [false, false, false, false, true],  // Normal non-agent tool → visible
    [false, false, false, true, true],   // Override enabled → visible
    [false, false, true, false, true],   // Agent tool → visible
    [false, false, true, true, true],    // Agent tool + override → visible

    // collapsed=false, hideOutput=true (expanded but output hiding enabled)
    // NOTE: hideOutput does NOT affect child tool visibility
    [false, true, false, false, true],   // hideOutput doesn't hide tool (only output)
    [false, true, false, true, true],    // Override enabled → visible
    [false, true, true, false, true],    // Agent tool always visible
    [false, true, true, true, true],     // Agent tool + override → visible

    // collapsed=true, hideOutput=false (collapsed but no output hiding)
    [true, false, false, false, false],  // Collapsed → hidden
    [true, false, false, true, true],    // Override overrides collapse
    [true, false, true, false, false],   // Collapsed agent → hidden
    [true, false, true, true, true],     // Override overrides collapse

    // collapsed=true, hideOutput=true (collapsed AND output hiding)
    [true, true, false, false, false],   // Collapsed → hidden
    [true, true, false, true, true],     // Override overrides collapse
    [true, true, true, false, false],    // Collapsed agent → hidden
    [true, true, true, true, true],      // Override overrides everything
  ])(
    'visibility: collapsed=%s hideOutput=%s isAgentTool=%s show_full=%s → visible=%s',
    (collapsed, hideOutput, isAgentTool, showFull, expectedVisible) => {
      // Create appropriate child tool (agent or non-agent)
      const toolName = isAgentTool ? 'agent' : 'read';
      const child = createMockToolCall(toolName);

      // Create config with show_full_tool_output setting
      const config = showFull ? { show_full_tool_output: true } : undefined;

      // Call the actual function
      const result = shouldShowChildTool(child, collapsed, hideOutput, config);

      // Verify result matches expected visibility
      expect(result).toBe(expectedVisible);
    }
  );

  describe('Edge Cases', () => {
    test('undefined config should default to show_full_tool_output=false', () => {
      const child = createMockToolCall('read');

      // Undefined config
      expect(shouldShowChildTool(child, false, false, undefined)).toBe(true);
      expect(shouldShowChildTool(child, true, false, undefined)).toBe(false);

      // Empty config object
      expect(shouldShowChildTool(child, false, false, {})).toBe(true);
      expect(shouldShowChildTool(child, true, false, {})).toBe(false);
    });

    test('undefined collapsed should be treated as false (not collapsed)', () => {
      const child = createMockToolCall('read');

      // undefined collapsed → not collapsed → visible
      expect(shouldShowChildTool(child, undefined, false, undefined)).toBe(true);
    });

    test('undefined hideOutput should not affect visibility', () => {
      const child = createMockToolCall('read');

      // hideOutput doesn't affect visibility anyway, but test undefined explicitly
      expect(shouldShowChildTool(child, false, undefined, undefined)).toBe(true);
      expect(shouldShowChildTool(child, true, undefined, undefined)).toBe(false);
    });

    test('all agent delegation tool types should behave identically', () => {
      const agentTools = ['agent', 'explore', 'plan', 'sessions', 'agent-ask'];
      const config = undefined;

      agentTools.forEach(toolName => {
        const child = createMockToolCall(toolName);

        // Not collapsed → visible
        expect(shouldShowChildTool(child, false, false, config)).toBe(true);
        expect(shouldShowChildTool(child, false, true, config)).toBe(true);

        // Collapsed → hidden
        expect(shouldShowChildTool(child, true, false, config)).toBe(false);
        expect(shouldShowChildTool(child, true, true, config)).toBe(false);
      });
    });

    test('all non-agent tool types should behave identically', () => {
      const nonAgentTools = ['read', 'grep', 'write', 'bash', 'edit'];
      const config = undefined;

      nonAgentTools.forEach(toolName => {
        const child = createMockToolCall(toolName);

        // Not collapsed → visible
        expect(shouldShowChildTool(child, false, false, config)).toBe(true);
        expect(shouldShowChildTool(child, false, true, config)).toBe(true);

        // Collapsed → hidden
        expect(shouldShowChildTool(child, true, false, config)).toBe(false);
        expect(shouldShowChildTool(child, true, true, config)).toBe(false);
      });
    });

    test('show_full_tool_output overrides all other settings', () => {
      const child = createMockToolCall('read');
      const config = { show_full_tool_output: true };

      // All combinations should be visible with override
      expect(shouldShowChildTool(child, false, false, config)).toBe(true);
      expect(shouldShowChildTool(child, false, true, config)).toBe(true);
      expect(shouldShowChildTool(child, true, false, config)).toBe(true);
      expect(shouldShowChildTool(child, true, true, config)).toBe(true);
    });

    test('hideOutput parameter has no effect on visibility', () => {
      const child = createMockToolCall('read');
      const config = undefined;

      // hideOutput=false vs hideOutput=true should produce same results
      expect(
        shouldShowChildTool(child, false, false, config)
      ).toBe(
        shouldShowChildTool(child, false, true, config)
      );

      expect(
        shouldShowChildTool(child, true, false, config)
      ).toBe(
        shouldShowChildTool(child, true, true, config)
      );
    });

    test('child parameter is unused (underscore prefix in implementation)', () => {
      // Different child tools should behave identically with same parent state
      const readChild = createMockToolCall('read');
      const agentChild = createMockToolCall('agent');

      // Both should be visible when not collapsed
      expect(shouldShowChildTool(readChild, false, false, undefined)).toBe(true);
      expect(shouldShowChildTool(agentChild, false, false, undefined)).toBe(true);

      // Both should be hidden when collapsed
      expect(shouldShowChildTool(readChild, true, false, undefined)).toBe(false);
      expect(shouldShowChildTool(agentChild, true, false, undefined)).toBe(false);
    });

    test('config with show_full_tool_output=false should behave like undefined', () => {
      const child = createMockToolCall('read');
      const configFalse = { show_full_tool_output: false };
      const configUndefined = undefined;

      // Both configs should produce identical results
      expect(
        shouldShowChildTool(child, false, false, configFalse)
      ).toBe(
        shouldShowChildTool(child, false, false, configUndefined)
      );

      expect(
        shouldShowChildTool(child, true, false, configFalse)
      ).toBe(
        shouldShowChildTool(child, true, false, configUndefined)
      );
    });
  });

  describe('Simplified Logic Validation', () => {
    test('implementation follows simplified two-rule logic', () => {
      const child = createMockToolCall('read');

      // Rule 1: show_full_tool_output=true → always visible
      expect(shouldShowChildTool(child, true, true, { show_full_tool_output: true })).toBe(true);
      expect(shouldShowChildTool(child, true, false, { show_full_tool_output: true })).toBe(true);

      // Rule 2: otherwise, visible = !collapsed
      expect(shouldShowChildTool(child, false, false, undefined)).toBe(true);  // !false = true
      expect(shouldShowChildTool(child, true, false, undefined)).toBe(false);  // !true = false
    });

    test('isAgentTool distinction does not affect visibility (only affects output)', () => {
      const agentChild = createMockToolCall('agent');
      const regularChild = createMockToolCall('read');

      // Both should have identical visibility behavior
      const testCases = [
        [false, false],
        [false, true],
        [true, false],
        [true, true],
      ] as const;

      testCases.forEach(([collapsed, hideOutput]) => {
        expect(
          shouldShowChildTool(agentChild, collapsed, hideOutput, undefined)
        ).toBe(
          shouldShowChildTool(regularChild, collapsed, hideOutput, undefined)
        );
      });
    });
  });

  describe('Real-World Scenarios', () => {
    test('scenario: user collapses agent tool to hide nested operations', () => {
      const nestedRead = createMockToolCall('read');
      const config = undefined;

      // Agent tool is collapsed → children should be hidden
      expect(shouldShowChildTool(nestedRead, true, false, config)).toBe(false);
    });

    test('scenario: user expands agent tool to see nested operations', () => {
      const nestedRead = createMockToolCall('read');
      const config = undefined;

      // Agent tool is expanded → children should be visible
      expect(shouldShowChildTool(nestedRead, false, false, config)).toBe(true);
    });

    test('scenario: user enables show_full_tool_output to see everything', () => {
      const nestedTool = createMockToolCall('grep');
      const config = { show_full_tool_output: true };

      // Even with collapsed parent, override makes children visible
      expect(shouldShowChildTool(nestedTool, true, true, config)).toBe(true);
    });

    test('scenario: hideOutput hides output text but not child tools', () => {
      const childTool = createMockToolCall('bash');
      const config = undefined;

      // hideOutput=true but not collapsed → child tool still visible
      // (hideOutput only affects the output text rendering, not tool visibility)
      expect(shouldShowChildTool(childTool, false, true, config)).toBe(true);
    });

    test('scenario: deeply nested agent delegation', () => {
      // Ally → explore → agent → read
      const deeplyNestedRead = createMockToolCall('read');
      const config = undefined;

      // Each level can independently control visibility via collapsed flag
      // At the innermost level, if parent is not collapsed, read is visible
      expect(shouldShowChildTool(deeplyNestedRead, false, false, config)).toBe(true);
    });

    test('scenario: user debugging with full output override', () => {
      const tools = ['agent', 'read', 'grep', 'explore', 'bash'];
      const config = { show_full_tool_output: true };

      // All tools should be visible regardless of collapse state
      tools.forEach(toolName => {
        const tool = createMockToolCall(toolName);
        expect(shouldShowChildTool(tool, true, true, config)).toBe(true);
      });
    });
  });
});
