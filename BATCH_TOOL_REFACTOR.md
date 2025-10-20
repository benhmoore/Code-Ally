# BatchTool Transparency Refactor

## Problem

BatchTool was duplicating ToolOrchestrator's responsibilities:
- Manually emitting TOOL_CALL_START/END/ERROR events
- Managing timing and execution
- Calling ToolManager.executeTool directly
- Trying to track and display child tool results

This caused several issues:
1. **Incorrect timing**: All child tools showed the same duration (the batch total)
2. **Event duplication**: Events were emitted twice (once by batch, once by tool manager)
3. **Complexity**: BatchTool had 150+ lines of orchestration logic it shouldn't need
4. **Violation of SRP**: Tool was both a wrapper AND an orchestrator

## Solution

**BatchTool is now truly transparent** - it's just a thin validation layer. The real work happens in ToolOrchestrator.

### Architecture Changes

#### Before:
```
Model → Agent → ToolOrchestrator → BatchTool (executes & emits events) → ToolManager → Child Tools
```

#### After:
```
Model → Agent → ToolOrchestrator (unwraps batch) → Child Tools (executed directly)
                              ↓
                         BatchTool (validation only, never executes)
```

### Code Changes

#### 1. ToolOrchestrator (`src/agent/ToolOrchestrator.ts`)

Added `unwrapBatchCalls()` method that intercepts batch tool calls:

```typescript
private unwrapBatchCalls(toolCalls: ToolCall[]): ToolCall[] {
  const unwrapped: ToolCall[] = [];

  for (const toolCall of toolCalls) {
    if (toolCall.function.name === 'batch') {
      const tools = toolCall.function.arguments.tools;

      if (Array.isArray(tools)) {
        // Convert each tool spec into a proper tool call
        tools.forEach((spec: any, index: number) => {
          unwrapped.push({
            id: `${toolCall.id}-unwrapped-${index}`,
            type: 'function',
            function: {
              name: spec.name,
              arguments: spec.arguments,
            },
          });
        });
      }
    } else {
      unwrapped.push(toolCall);
    }
  }

  return unwrapped;
}
```

Called in `executeToolCalls()`:
```typescript
async executeToolCalls(toolCalls: ToolCall[]): Promise<void> {
  // Unwrap batch tool calls into individual tool calls
  const unwrappedCalls = this.unwrapBatchCalls(toolCalls);

  // Execute as normal (concurrent or sequential)
  const canRunConcurrently = this.canRunConcurrently(unwrappedCalls);
  // ...
}
```

#### 2. BatchTool (`src/tools/BatchTool.ts`)

Simplified from ~220 lines to ~120 lines:

**Removed:**
- All event emission code
- ToolManager execution logic
- Result aggregation
- Custom result preview
- ServiceRegistry dependency

**Kept:**
- Function definition (for model)
- Argument validation
- Simple success response

```typescript
protected async executeImpl(args: any): Promise<ToolResult> {
  this.captureParams(args);

  const toolSpecs = args.tools;

  // Validate tools parameter
  if (!Array.isArray(toolSpecs) || toolSpecs.length === 0) {
    return this.formatErrorResponse(
      'tools parameter is required and must contain at least one tool specification',
      'validation_error',
      'Example: batch(tools=[...])'
    );
  }

  // Validate all tool specs
  for (let i = 0; i < toolSpecs.length; i++) {
    const validationError = this.validateToolSpec(toolSpecs[i], i);
    if (validationError) {
      return this.formatErrorResponse(validationError, 'validation_error');
    }
  }

  // NOTE: Actual execution happens in ToolOrchestrator.unwrapBatchCalls()
  return this.formatSuccessResponse({
    content: `Batch execution: ${toolSpecs.length} tool${toolSpecs.length !== 1 ? 's' : ''} executed concurrently`,
    tools_executed: toolSpecs.length,
  });
}
```

## Benefits

### 1. **Correct Timing**
Each tool now gets its own accurate start/end time:
- Tool A: 50ms
- Tool B: 150ms
- Tool C: 100ms

Instead of all showing 150ms (the batch total).

### 2. **No Event Duplication**
Events are emitted once, by ToolOrchestrator, for each child tool.

### 3. **Simplified Codebase**
- BatchTool: -100 lines
- Single source of truth for tool execution (ToolOrchestrator)
- No duplicate logic

### 4. **True Transparency**
BatchTool doesn't appear in the UI at all - only its children appear, as if they were called directly by the model.

### 5. **Easier Maintenance**
- Changes to tool execution logic only need to happen in one place
- No risk of BatchTool's execution diverging from normal tool execution
- Clear separation of concerns

## How It Works

1. **Model calls batch tool:**
   ```json
   {
     "name": "batch",
     "arguments": {
       "tools": [
         {"name": "read", "arguments": {"file_path": "file1.txt"}},
         {"name": "read", "arguments": {"file_path": "file2.txt"}}
       ]
     }
   }
   ```

2. **ToolOrchestrator unwraps it:**
   ```javascript
   [
     {id: "batch-123-unwrapped-0", function: {name: "read", arguments: {file_path: "file1.txt"}}},
     {id: "batch-123-unwrapped-1", function: {name: "read", arguments: {file_path: "file2.txt"}}}
   ]
   ```

3. **Tools execute normally:**
   - Each gets TOOL_CALL_START with its own timestamp
   - Each executes independently
   - Each gets TOOL_CALL_END with its own timestamp
   - Each appears in UI with accurate timing

4. **BatchTool validates but doesn't execute:**
   - Returns simple success message
   - Never appears in UI (isTransparentWrapper = true)

## Testing

The model can now call:
```
batch(tools=[
  {name: "agent", arguments: {task_prompt: "Read README.md"}},
  {name: "agent", arguments: {task_prompt: "Read docs/guide.md"}}
])
```

And each agent will:
- Start at different times
- Execute tools independently
- Show accurate individual durations
- Appear as separate top-level items in the UI
