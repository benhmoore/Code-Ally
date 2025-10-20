# Batch Tool Transparency Implementation

## Overview

The BatchTool is now a **transparent wrapper** - it doesn't appear in the conversation output. Only the tools it executes are displayed, as if they were called directly by the model.

## User Experience

**Before:**
```
→ batch(...)
    → read(file_path="file1.txt")
    → read(file_path="file2.txt")
```

**After:**
```
→ read(file_path="file1.txt")
→ read(file_path="file2.txt")
```

The batch wrapper is completely invisible to the user.

## Implementation Details

### 1. Tool-Level Flag (`BaseTool.ts`)

Added `isTransparentWrapper` property to `BaseTool`:

```typescript
readonly isTransparentWrapper: boolean = false;
```

### 2. BatchTool Configuration (`BatchTool.ts`)

Marked BatchTool as transparent:

```typescript
export class BatchTool extends BaseTool {
  readonly isTransparentWrapper = true; // Don't show batch() in conversation
  // ...
}
```

### 3. Event Metadata (`ToolOrchestrator.ts`)

When emitting TOOL_CALL_START/END events, ToolOrchestrator marks transparent wrappers:

```typescript
const tool = this.toolManager.getTool(toolName);

this.emitEvent({
  id,
  type: ActivityEventType.TOOL_CALL_START,
  timestamp: Date.now(),
  parentId: effectiveParentId,
  data: {
    toolName,
    arguments: args,
    isTransparent: tool?.isTransparentWrapper || false, // Mark transparent wrappers
  },
});
```

### 4. Type System (`types/index.ts`)

Extended `ToolCallState` interface:

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
  isTransparent?: boolean; // For wrapper tools that should not be displayed
}
```

### 5. State Capture (`App.tsx`)

Captured `isTransparent` flag when creating ToolCallState from events:

```typescript
const toolCall: ToolCallState = {
  id: event.id,
  status: 'executing',
  toolName: event.data.toolName,
  arguments: event.data.arguments || {},
  startTime: event.timestamp,
  parentId: event.parentId,
  isTransparent: event.data.isTransparent || false, // For wrapper tools
};
```

### 6. UI Tree Processing (`ConversationView.tsx`)

After building the tool call tree, transparent wrappers are removed and their children promoted:

```typescript
const processTransparentWrappers = (
  calls: (ToolCallState & { children?: ToolCallState[] })[]
): (ToolCallState & { children?: ToolCallState[] })[] => {
  const result: (ToolCallState & { children?: ToolCallState[] })[] = [];

  for (const call of calls) {
    // If this is a transparent wrapper, promote its children
    if (call.isTransparent && call.children && call.children.length > 0) {
      // Recursively process children first
      const processedChildren = processTransparentWrappers(call.children);
      // Add children directly to result (promoting them)
      result.push(...processedChildren);
    } else {
      // Not transparent, recursively process its children
      if (call.children && call.children.length > 0) {
        call.children = processTransparentWrappers(call.children);
      }
      result.push(call);
    }
  }

  return result;
};

return processTransparentWrappers(rootCalls);
```

## Data Flow

1. **Execution**: Model calls `batch(tools=[...])`
2. **ToolOrchestrator**: Emits TOOL_CALL_START with `isTransparent: true`
3. **BatchTool**: Executes child tools, each emitting their own events with batch's ID as parentId
4. **App.tsx**: Captures events and creates ToolCallState objects (batch + children)
5. **ConversationView**: Builds tree structure
6. **processTransparentWrappers**: Removes batch tool and promotes its children to top level
7. **Render**: Only child tools are displayed

## Benefits

- **Cleaner UX**: Users only see the actual tools being executed, not the wrapper
- **No Breaking Changes**: Existing tools unaffected (default `isTransparentWrapper = false`)
- **Extensible**: Any tool can be made transparent by setting this flag
- **Proper Threading**: Child tools maintain correct timing and status tracking

## Future Wrapper Tools

Any new wrapper tools can use the same pattern:

```typescript
export class MyWrapperTool extends BaseTool {
  readonly isTransparentWrapper = true;
  // ...
}
```

The infrastructure will automatically handle transparency.
