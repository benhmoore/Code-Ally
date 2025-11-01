# Agent Tool Output Display Issue - Diagnosis Report

## Executive Summary

**Root Cause**: The `collapsed` state is set unconditionally when an agent tool completes (`shouldCollapse = true`), which blocks rendering of nested tool calls/output even when `show_full_tool_output` is enabled.

**Why it affects agents but not regular tools**: 
- Agent tools have `shouldCollapse = true` and `hideOutput = true`
- Regular tools have both set to `false`
- When a tool with `shouldCollapse = true` completes, its `collapsed` flag is set to `true`, preventing child rendering

**The fix**: Modify the rendering condition in ToolCallDisplay.tsx to respect the `show_full_tool_output` config override.

---

## Detailed Analysis

### 1. How Agent Tools Are Configured (AgentTool.ts:29-32)

```typescript
readonly shouldCollapse = true;        // Collapse after completion
readonly hideOutput = true;            // Never show agent output in chat
```

This is intentional - agent output goes to the assistant's response, not the UI.

### 2. Event Emission (ToolOrchestrator.ts:216-235)

These flags are properly passed to TOOL_CALL_START events:

```typescript
this.emitEvent({
  id: toolCall.id,
  type: ActivityEventType.TOOL_CALL_START,
  data: {
    toolName: toolCall.function.name,
    shouldCollapse,      // true for agents
    hideOutput,          // true for agents
    // ...
  },
});
```

### 3. UI State Creation (App.tsx:520-532)

The state is correctly initialized:

```typescript
const toolCall: ToolCallState = {
  id: event.id,
  status: 'executing',
  toolName: event.data.toolName,
  parentId: event.parentId,           // For nesting
  hideOutput: event.data.hideOutput,  // true for agents
  collapsed: event.data.collapsed || false,  // false initially
  shouldCollapse: event.data.shouldCollapse,
  // ...
};
```

### 4. Tool Call Tree Building (ConversationView.tsx:59-146)

The tree building correctly uses `parentId` to establish parent-child relationships:

```typescript
function buildToolCallTree(toolCalls: ToolCallState[]) {
  // ...
  toolCalls.forEach((tc) => {
    if (tc.parentId) {
      const parent = toolCallMap.get(tc.parentId);
      if (parent?.children) {
        parent.children.push(toolCallWithChildren);  // Nested tools added
      }
    } else {
      rootCalls.push(toolCallWithChildren);
    }
  });
  // ...
}
```

**Nested tool calls ARE captured and stored correctly.**

### 5. Completion Event Processing (App.tsx:538-582)

When a tool completes, the TOOL_CALL_END event updates its state:

```typescript
useActivityEvent(ActivityEventType.TOOL_CALL_END, (event) => {
  const updates: Partial<ToolCallState> = {
    status: event.data.success ? 'success' : 'error',
    endTime: event.timestamp,
  };

  if (event.data.shouldCollapse) {
    updates.collapsed = true;  // CRITICAL: Set collapsed = true
  }

  scheduleToolUpdate.current(event.id, updates, true);
});
```

**This is where the problem happens**: When `shouldCollapse = true`, `collapsed` is set to `true`.

### 6. Rendering (ToolCallDisplay.tsx:177-204)

The component checks visibility before rendering:

```typescript
// Line 178: Show output if not collapsed and (not hidden OR override enabled)
{!toolCall.collapsed && (!toolCall.hideOutput || config?.show_full_tool_output) && toolCall.output && ...}

// Line 204: Show children if not collapsed and (not hidden OR override enabled)
{!toolCall.collapsed && (!toolCall.hideOutput || config?.show_full_tool_output) && children}
```

**The logic problem**: 
- When agent tool completes: `collapsed = true`, `hideOutput = true`
- Evaluation: `!true && (!true || true) && children`
- Result: `false && true && children` = **HIDDEN**

---

## Why The Config Override Doesn't Work

The rendering condition says: `(!toolCall.hideOutput || config?.show_full_tool_output)`

For agent tools:
- `!toolCall.hideOutput` = `!true` = `false`
- `config?.show_full_tool_output` = `true`
- `false || true` = `true` ✓ This part passes!

But the FIRST condition blocks it:
- `!toolCall.collapsed` = `!true` = `false`
- `false && true && children` = **false** (AND operator short-circuits)

---

## Why Regular Tools Work

Tools like `ls()`:
- Have `hideOutput = false` or undefined
- Have `shouldCollapse = false` or undefined
- When they complete, `collapsed` stays `false`
- Rendering: `!false && ... && children` = `true && ... && children` ✓ VISIBLE

---

## The Fix

**File**: `src/ui/components/ToolCallDisplay.tsx`

**Current code (lines 177-204)**:
```typescript
{!toolCall.collapsed && (!toolCall.hideOutput || config?.show_full_tool_output) && toolCall.output && !toolCall.error && (
  // Output display
)}

{!toolCall.collapsed && (!toolCall.hideOutput || config?.show_full_tool_output) && isAgentDelegation && toolCallCount > 3 && (
  // Truncation indicator
)}

{!toolCall.collapsed && (!toolCall.hideOutput || config?.show_full_tool_output) && children}
```

**Fixed code**:
```typescript
{!toolCall.collapsed && (!toolCall.hideOutput || config?.show_full_tool_output) && toolCall.output && !toolCall.error && (
  // Output display
)}

{!toolCall.collapsed && (!toolCall.hideOutput || config?.show_full_tool_output) && isAgentDelegation && toolCallCount > 3 && (
  // Truncation indicator
)}

{(!toolCall.collapsed || config?.show_full_tool_output) && (!toolCall.hideOutput || config?.show_full_tool_output) && children}
```

**The change**: For the final children rendering, allow them to render if:
- Tool is NOT collapsed, OR
- `show_full_tool_output` is enabled (override)

This respects the user's explicit choice to see full output.

---

## Alternative Approach (Not Recommended)

If you want to keep the condition exactly the same, you could change ToolOrchestrator to conditionally set collapsed:

**In ToolOrchestrator.ts (lines 573-579)**:
```typescript
// Only set collapsed if the tool actually has hidden output
if (event.data.shouldCollapse && event.data.hideOutput) {
  updates.collapsed = true;
}
```

But this requires ToolOrchestrator to know about `show_full_tool_output`, which it doesn't have access to. **The UI-level fix is cleaner.**

---

## Impact Analysis

**Files affected by fix**:
- `src/ui/components/ToolCallDisplay.tsx` - Lines 178, 196, 204 (5 line changes)

**Behavior changes**:
1. When `show_full_tool_output` is enabled, agent tools will show their nested children
2. Users can now see what tools the agent called by enabling the config flag
3. No impact on default behavior (when config is false)
4. No impact on non-agent tools

**Testing strategy**:
1. Test with `show_full_tool_output = false` (default): Agent output hidden (current behavior)
2. Test with `show_full_tool_output = true`: Agent nested tools visible (new behavior)
3. Test that regular tools still work as before
4. Test that errors in nested tools are still shown

