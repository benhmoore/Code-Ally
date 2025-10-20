# Collapsible Tool Output Feature

## Overview

Tools can now collapse their output and child tool calls when complete, showing only the main summary line. This is particularly useful for subagents, which can hide their internal tool executions once they complete.

## User Experience

**Before:**
```
→ agent (general, +1) [✓ 13.5s]
    → Output
        **Task Completed:**
        Successfully read README.md...
    → read (["README.md"], +2) [✓ 10ms]
        → Output
            === /Users/bhm128/code-ally/README.md ===
                 1    # Code Ally
                 2
                 3    AI pair programming assistant...
    → ls (true, +3) [✓ 22ms]
        → Output
            755            implementation_description/
            644     16246B CONCURRENT_TOOL_ARCHITECTURE.md
            ...
```

**After (collapsed):**
```
→ agent (general, +1) [✓ 13.5s]
```

The agent's execution details are hidden, keeping the output clean and focused on the final results.

## Implementation

### 1. ToolCallState (`src/types/index.ts`)

Added `collapsed` flag:

```typescript
export interface ToolCallState {
  id: string;
  status: ToolStatus;
  toolName: string;
  arguments: any;
  output?: string;
  error?: string;
  startTime: number;
  endTime?: number;
  parentId?: string;
  isTransparent?: boolean;
  collapsed?: boolean; // NEW: For tools that should hide their children
}
```

### 2. BaseTool (`src/tools/BaseTool.ts`)

Added `shouldCollapse` property:

```typescript
/**
 * Whether this tool should collapse its children when complete
 * Set to true for tools that should hide their output/children after completion
 * (e.g., subagents that should show only their summary line)
 */
readonly shouldCollapse: boolean = false;
```

### 3. AgentTool (`src/tools/AgentTool.ts`)

Enabled collapse for agent delegations:

```typescript
export class AgentTool extends BaseTool {
  readonly name = 'agent';
  readonly requiresConfirmation = false;
  readonly suppressExecutionAnimation = true;
  readonly shouldCollapse = true; // NEW: Collapse children when complete
  // ...
}
```

### 4. ToolOrchestrator (`src/agent/ToolOrchestrator.ts`)

Propagate collapse flag in TOOL_CALL_END events:

```typescript
this.emitEvent({
  id,
  type: ActivityEventType.TOOL_CALL_END,
  timestamp: Date.now(),
  parentId: effectiveParentId,
  data: {
    toolName,
    result,
    success: result.success,
    error: result.success ? undefined : result.error,
    isTransparent: tool?.isTransparentWrapper || false,
    collapsed: tool?.shouldCollapse || false, // NEW
  },
});
```

### 5. App.tsx (`src/ui/App.tsx`)

Capture collapsed flag from events:

```typescript
actions.updateToolCall(event.id, {
  status: event.data.success ? 'success' : 'error',
  endTime: event.timestamp,
  error: event.data.error,
  collapsed: event.data.collapsed || false, // NEW
});
```

### 6. ToolCallDisplay (`src/ui/components/ToolCallDisplay.tsx`)

Hide output, errors, and children when collapsed:

```typescript
{/* Error output as threaded child (hidden if collapsed) */}
{!toolCall.collapsed && toolCall.error && (
  <Box flexDirection="column">
    {/* Error display */}
  </Box>
)}

{/* Output as threaded child (hidden if collapsed) */}
{!toolCall.collapsed && toolCall.output && !toolCall.error && (
  <Box flexDirection="column">
    {/* Output display */}
  </Box>
)}

{/* Nested tool calls (hidden if collapsed) */}
{!toolCall.collapsed && children}
```

## How It Works

1. **Tool declares collapsibility**: AgentTool sets `shouldCollapse = true`
2. **Tool executes**: Child tools run normally (read, ls, etc.) and appear in the UI
3. **Tool completes**: ToolOrchestrator emits TOOL_CALL_END with `collapsed: true`
4. **UI updates**: App.tsx updates the ToolCallState with `collapsed: true`
5. **UI renders**: ToolCallDisplay skips rendering output, errors, and children
6. **Result**: Only the agent summary line is visible

## Benefits

1. **Cleaner output**: Hides implementation details of delegated tasks
2. **Focus on results**: User sees only the final outcomes, not intermediate steps
3. **Scalable**: Works with any number of nested tool calls
4. **Flexible**: Any tool can opt-in by setting `shouldCollapse = true`

## Future Enhancements

Potential improvements:
- **Interactive toggle**: Allow users to expand/collapse via keyboard shortcut
- **Selective collapse**: Collapse only successful agents, show failed ones
- **Configurable**: User preference to disable auto-collapse
- **Visual indicator**: Show "..." or "▶" to indicate collapsed content
