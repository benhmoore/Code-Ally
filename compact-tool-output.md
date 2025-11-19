# Compact Tool Output Implementation

## Overview

This document describes the design and implementation approach for adding customizable compact output forms to tool calls in CodeAlly.

## Current State

Tool calls are currently displayed in the UI with the following format:

```
[icon] [displayName] · [subtext] · [duration]
```

**Example:**
```
✓ Edit Line · Add JSDoc to Platform constructor · 1.2s
```

**Component Breakdown:**
- `✓` - Status icon (success/error/executing)
- `Edit Line` - Tool display name
- `Add JSDoc to Platform constructor` - Subtext (customizable via `formatSubtext()`)
- `1.2s` - Duration (shown for agents or tools >5 seconds)

## Proposed Enhancement

Add an optional compact output phrase that displays execution results:

```
✓ Edit Line · Add JSDoc to Platform constructor · [compact output phrase] · 1.2s
```

**Example:**
```
✓ Edit Line · Add JSDoc to Platform constructor · 2 replacements · 1.2s
```

## Design Principles

1. **Opt-in**: Tools only implement compact output when it adds value
2. **Backward compatible**: Default behavior shows no compact output
3. **Result-based**: Compact output computed from execution result (not arguments)
4. **Concise**: Keep output brief (recommended < 40 characters)
5. **Plugin-friendly**: Support template-based formatting for plugin tools

## Architecture

### Current Architecture

**Tool Output Rendering:**
- Primary component: `/src/ui/components/ToolCallDisplay.tsx:330-375`
- Status icons: `/src/ui/utils/statusUtils.ts:48-67`
- UI symbols: `/src/config/uiSymbols.ts:24-39`

**Tool Customization:**
- Tools already customize display via `BaseTool.formatSubtext(args)`
- Plugin tools use template-based substitution with `{param}` placeholders

**Data Flow:**
1. `ToolOrchestrator` executes tool
2. Emits `TOOL_CALL_END` event with result
3. `ToolCallDisplay` component renders output
4. Tool state tracked in `ToolCallState` interface

### Implementation Approach

#### 1. Add Method to BaseTool

**File:** `/src/tools/BaseTool.ts`

```typescript
/**
 * Format compact output phrase shown after execution
 * Appears as: ✓ Tool Name · [subtext] · [compact phrase] · (duration)
 *
 * @param result - Tool execution result
 * @returns Compact phrase or null to skip
 */
formatCompactOutput(result: ToolResult): string | null {
  return null; // Default: no compact output
}
```

#### 2. Extend ToolCallState Interface

**File:** `/src/types/index.ts`

```typescript
interface ToolCallState {
  id: string;
  status: ToolStatus;
  toolName: string;
  arguments: any;
  output?: string;
  error?: string;
  startTime: number;
  endTime?: number;
  compactOutput?: string;  // NEW: Compact result phrase
}
```

#### 3. Emit Compact Output in ToolOrchestrator

**File:** `/src/agent/ToolOrchestrator.ts` (around line 756-772)

```typescript
// After tool execution
const compactOutput = tool?.formatCompactOutput?.(result);

this.emitEvent({
  id,
  type: ActivityEventType.TOOL_CALL_END,
  data: {
    // ... existing fields
    compactOutput,
  }
});
```

#### 4. Render in ToolCallDisplay

**File:** `/src/ui/components/ToolCallDisplay.tsx` (around line 362-374)

```tsx
{/* Subtext */}
{subtext && !isAgentDelegation && (
  <Text dimColor> · {subtext}</Text>
)}

{/* Compact output - NEW */}
{toolCall.compactOutput && (
  <Text dimColor> · {toolCall.compactOutput}</Text>
)}

{/* Duration */}
{(isAgentDelegation || duration > 5000) && (
  <Text dimColor> · {durationStr}</Text>
)}
```

#### 5. Add Plugin Support

**File:** `/src/plugins/ExecutableToolWrapper.ts`

Add support for `compact_output` field in tool definitions:
- Support template-based formatting: `"{count} files changed"`
- Extract from tool result if plugin returns `compact_output` field

**File:** `/src/plugins/PluginLoader.ts`

Add `compact_output` to ToolDefinition schema (similar to existing `subtext`).

## Example Implementations

### EditTool

```typescript
formatCompactOutput(result: ToolResult): string | null {
  if (!result.success) return null;
  const count = result.replacements_made ?? 0;
  return `${count} replacement${count !== 1 ? 's' : ''}`;
}
```

**Display:** `✓ Edit · Update variable name · 2 replacements · 1.2s`

### BashTool

```typescript
formatCompactOutput(result: ToolResult): string | null {
  if (!result.success) return null;
  const code = result.return_code ?? 0;
  return code === 0 ? 'exit 0' : `exit ${code}`;
}
```

**Display:** `✓ Bash · Run tests · exit 0 · 3.4s`

### ReadTool

```typescript
formatCompactOutput(result: ToolResult): string | null {
  if (!result.success) return null;
  const lines = result.content?.split('\n').length ?? 0;
  return `${lines} lines`;
}
```

**Display:** `✓ Read · package.json · 1,234 lines · 0.1s`

### GrepTool

```typescript
formatCompactOutput(result: ToolResult): string | null {
  if (!result.success) return null;
  const matches = result.match_count ?? 0;
  const files = result.files_with_matches ?? 0;
  return `${matches} matches in ${files} file${files !== 1 ? 's' : ''}`;
}
```

**Display:** `✓ Grep · Search for "TODO" · 15 matches in 3 files · 0.5s`

### Plugin Tool Example

**Tool Definition:**
```json
{
  "name": "format_code",
  "description": "Format code files",
  "compact_output": "{files_formatted} file(s) formatted"
}
```

**Plugin Result:**
```json
{
  "success": true,
  "files_formatted": 5
}
```

**Display:** `✓ Format Code · src/**/*.ts · 5 file(s) formatted · 2.1s`

## Files Requiring Changes

1. `/src/tools/BaseTool.ts` - Add `formatCompactOutput()` method
2. `/src/types/index.ts` - Add `compactOutput` to ToolCallState
3. `/src/agent/ToolOrchestrator.ts` - Emit compact output in TOOL_CALL_END
4. `/src/ui/components/ToolCallDisplay.tsx` - Render compact output
5. `/src/plugins/ExecutableToolWrapper.ts` - Add plugin support
6. `/src/plugins/PluginLoader.ts` - Add `compact_output` to ToolDefinition
7. `/src/tools/__tests__/BaseTool.test.ts` - Add tests for compact output

## Implementation Considerations

### What to Display

**Good compact output:**
- Exit codes: `exit 0`
- Counts: `5 files`, `12 replacements`, `3 matches`
- Status: `cached`, `up to date`
- Sizes: `1.2 MB`, `450 lines`

**Avoid:**
- Redundant information already in subtext
- Long messages (keep under 40 characters)
- Technical details better suited for full output
- Error messages (status icon already indicates failure)

### Error Handling

Return `null` for errors - the status icon (✕) already indicates failure:

```typescript
formatCompactOutput(result: ToolResult): string | null {
  if (!result.success) return null;  // Don't show compact output on error
  // ... format successful result
}
```

### Agent Tools

Agent delegations may want different compact output formatting. Consider if agents should show compact output differently or skip it entirely (they already have custom rendering).

### Testing

Add tests to verify:
- Default behavior returns null
- Compact output appears in correct position
- Plugin template substitution works
- Truncation of overly long output
- Error cases return null

## Benefits

1. **At-a-glance results**: See tool outcomes without expanding output
2. **Consistency**: Standardized way for tools to show results
3. **Extensibility**: Easy for new tools and plugins to adopt
4. **User experience**: Reduces need to expand tool output for common information
5. **Minimal changes**: Leverages existing architecture patterns

## Backward Compatibility

- Default `formatCompactOutput()` returns `null`
- Existing tools continue working unchanged
- No breaking changes to plugin API
- UI gracefully handles missing compact output
- Tools can adopt incrementally as needed
