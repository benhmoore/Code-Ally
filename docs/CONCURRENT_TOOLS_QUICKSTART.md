# Concurrent Tool Visualization - Quick Start Guide

**Get up and running with Code Ally's killer feature in 5 minutes**

---

## What Is This?

Concurrent tool visualization enables multiple tools to execute in parallel with independent, non-interleaving display regions. Each tool gets its own vertical space with status indicators, streaming output, and elapsed time tracking.

### Visual Example

```
┌───────────────────────────────────────────────────────────┐
│ Concurrent Tools: 3/4  ✓2 ✕0  (5 lines/tool)            │
├───────────────────────────────────────────────────────────┤
│ ⋯ BashTool 3s                                            │
│   Installing dependencies...                              │
│   npm install express...                                  │
│   added 50 packages in 2s                                 │
│   ... (12 more lines)                                     │
├───────────────────────────────────────────────────────────┤
│ ✓ ReadTool 1s                                            │
│   export const foo = ...                                  │
│   export const bar = ...                                  │
│   ✓ Completed successfully                                │
│                                                            │
├───────────────────────────────────────────────────────────┤
│ ⋯ GrepTool 2s                                            │
│   ./src/app.ts:15: TODO: refactor                         │
│   ./src/utils.ts:42: TODO: optimize                       │
│   ... (8 more lines)                                      │
│                                                            │
└───────────────────────────────────────────────────────────┘
```

---

## Running the Demo

```bash
# 1. Install dependencies
npm install

# 2. Run the concurrent tools example
npx tsx src/ui/examples/ConcurrentToolsExample.tsx
```

Watch as 4 tools execute concurrently with independent displays!

---

## Using in Your Code

### Basic Usage

```typescript
import { ToolGroupMessage } from './ui/components';
import { ToolCallState } from './types';

const MyApp: React.FC = () => {
  const [toolCalls, setToolCalls] = useState<ToolCallState[]>([]);

  return (
    <Box flexDirection="column">
      {toolCalls.length > 0 && (
        <ToolGroupMessage toolCalls={toolCalls} />
      )}
    </Box>
  );
};
```

### Adding Tools

```typescript
// Create a new tool call
const newTool: ToolCallState = {
  id: generateId(),
  status: 'executing',
  toolName: 'BashTool',
  arguments: { command: 'npm install' },
  output: '',
  startTime: Date.now(),
};

// Add to active tools
setToolCalls(prev => [...prev, newTool]);
```

### Updating Tool Status

```typescript
// Update a specific tool
const updateTool = (id: string, updates: Partial<ToolCallState>) => {
  setToolCalls(prev =>
    prev.map(tc => (tc.id === id ? { ...tc, ...updates } : tc))
  );
};

// Example: Update output
updateTool('tool-id', {
  output: 'New output line\n',
});

// Example: Mark as complete
updateTool('tool-id', {
  status: 'success',
  endTime: Date.now(),
});
```

### Removing Completed Tools

```typescript
// Remove tools after completion
const removeCompletedTools = () => {
  setToolCalls(prev =>
    prev.filter(tc => tc.status !== 'success' && tc.status !== 'error')
  );
};
```

---

## Component Reference

### ToolGroupMessage

Orchestrates multiple concurrent tool displays.

**Props:**
```typescript
interface ToolGroupMessageProps {
  toolCalls: ToolCallState[];        // Array of tool states
  terminalHeightOverride?: number;   // Optional (for testing)
}
```

**Features:**
- Dynamic height allocation
- Aggregate status border color
- Summary statistics header

### ToolMessage

Displays individual tool execution.

**Props:**
```typescript
interface ToolMessageProps {
  toolCall: ToolCallState;  // Tool state
  maxHeight: number;        // Vertical space allocated
}
```

**Features:**
- Status icon state machine
- Elapsed time counter
- Scrolling output display

### OutputScroller

Scrolling output with height constraints.

**Props:**
```typescript
interface OutputScrollerProps {
  output: string;            // Multi-line output
  maxLines: number;          // Max lines to show
  maxCharsPerLine?: number;  // Default: 120
}
```

**Features:**
- Shows last N lines
- Truncation indicator
- Line truncation

---

## ToolCallState Interface

```typescript
export interface ToolCallState {
  id: string;              // Unique identifier
  status: ToolStatus;      // Current status
  toolName: string;        // Tool name (e.g., 'BashTool')
  arguments: any;          // Tool arguments
  output?: string;         // Accumulated output
  error?: string;          // Error message if failed
  startTime: number;       // Start timestamp (ms)
  endTime?: number;        // End timestamp (ms)
}

export type ToolStatus =
  | 'pending'      // Not started
  | 'validating'   // Validating arguments
  | 'scheduled'    // Scheduled for execution
  | 'executing'    // Currently running
  | 'success'      // Completed successfully
  | 'error'        // Failed with error
  | 'cancelled';   // Cancelled by user
```

---

## Status Icons

| Status       | Icon | Color  | Meaning                  |
|--------------|------|--------|--------------------------|
| `pending`    | ○    | Gray   | Waiting to start         |
| `validating` | ●    | Yellow | Validating arguments     |
| `scheduled`  | ◐    | Blue   | Scheduled for execution  |
| `executing`  | ⋯    | Cyan   | Currently running        |
| `success`    | ✓    | Green  | Completed successfully   |
| `error`      | ✕    | Red    | Failed with error        |
| `cancelled`  | ⊘    | Gray   | Cancelled by user        |

---

## Border Colors

The ToolGroupMessage border color reflects aggregate status:

| Color  | Condition                          |
|--------|------------------------------------|
| Red    | At least one tool errored          |
| Green  | All tools completed successfully   |
| Gray   | All tools cancelled                |
| Yellow | Any tool executing/pending         |
| Blue   | Default                            |

---

## Common Patterns

### Pattern 1: Streaming Output

```typescript
// Simulate streaming output
const streamOutput = async (toolId: string) => {
  const lines = ['Line 1', 'Line 2', 'Line 3'];

  for (const line of lines) {
    await new Promise(resolve => setTimeout(resolve, 500));

    updateTool(toolId, {
      output: prev => (prev || '') + line + '\n',
    });
  }

  // Mark complete
  updateTool(toolId, {
    status: 'success',
    endTime: Date.now(),
  });
};
```

### Pattern 2: Error Handling

```typescript
try {
  const result = await executeTool(tool);

  updateTool(tool.id, {
    status: 'success',
    output: result.output,
    endTime: Date.now(),
  });
} catch (error) {
  updateTool(tool.id, {
    status: 'error',
    error: error.message,
    endTime: Date.now(),
  });
}
```

### Pattern 3: Concurrent Execution

```typescript
// Execute multiple tools in parallel
const executeToolsConcurrent = async (tools: ToolCallState[]) => {
  // Add all tools to active list
  setToolCalls(prev => [...prev, ...tools]);

  // Execute in parallel
  await Promise.all(
    tools.map(tool => executeTool(tool))
  );
};
```

---

## Height Allocation

The system automatically allocates vertical space:

```
Terminal Height: 24 lines
├── Static UI: 4 lines (prompt, status)
└── Available: 20 lines
    └── Per Tool: 20 / N tools

Examples:
  - 2 tools: 10 lines each
  - 4 tools: 5 lines each
  - 8 tools: 3 lines each (minimum)
```

Minimum height per tool: **3 lines** (header + 2 output lines)

---

## Tips & Tricks

### Tip 1: Tool Priority

Show important tools first in the array:

```typescript
const sortedTools = toolCalls.sort((a, b) => {
  if (a.status === 'error') return -1;  // Errors first
  if (b.status === 'error') return 1;
  return 0;
});
```

### Tip 2: Auto-Remove Completed

Automatically remove completed tools after delay:

```typescript
useEffect(() => {
  const completed = toolCalls.filter(
    tc => tc.status === 'success' && tc.endTime
  );

  if (completed.length > 0) {
    const timer = setTimeout(() => {
      setToolCalls(prev =>
        prev.filter(tc => tc.status !== 'success')
      );
    }, 5000); // Remove after 5 seconds

    return () => clearTimeout(timer);
  }
}, [toolCalls]);
```

### Tip 3: Terminal Size Detection

Override terminal height for testing:

```typescript
<ToolGroupMessage
  toolCalls={toolCalls}
  terminalHeightOverride={30}  // Test with 30-line terminal
/>
```

### Tip 4: Output Formatting

Format output before passing to component:

```typescript
const formattedOutput = rawOutput
  .split('\n')
  .map(line => line.trim())
  .filter(line => line.length > 0)
  .join('\n');

updateTool(id, { output: formattedOutput });
```

---

## Troubleshooting

### Issue: Tools appear cramped

**Cause:** Too many concurrent tools for terminal height

**Solution:** Either reduce concurrent tool count or increase terminal height

```typescript
// Limit concurrent tools
const MAX_CONCURRENT = 4;
const limitedTools = toolCalls.slice(0, MAX_CONCURRENT);
```

### Issue: Output not updating

**Cause:** State not updating correctly

**Solution:** Ensure you're updating state immutably

```typescript
// ❌ Wrong: Mutating state
toolCall.output += 'new line';

// ✅ Correct: Immutable update
setToolCalls(prev =>
  prev.map(tc =>
    tc.id === id ? { ...tc, output: tc.output + 'new line' } : tc
  )
);
```

### Issue: Border color not changing

**Cause:** React not detecting state change

**Solution:** Create new array reference

```typescript
// ❌ Wrong: Same array reference
toolCalls[0].status = 'success';
setToolCalls(toolCalls);

// ✅ Correct: New array
setToolCalls(prev => [...prev]);
```

---

## Integration with ActivityStream

### Subscribing to Events

```typescript
import { ActivityEventType } from './types';
import { useActivityStream } from './ui/hooks/useActivityStream';

const App: React.FC = () => {
  const activityStream = useActivityStream();

  useEffect(() => {
    const unsubscribe = activityStream.subscribe(
      ActivityEventType.TOOL_CALL_START,
      (event) => {
        setToolCalls(prev => [
          ...prev,
          {
            id: event.id,
            status: 'executing',
            toolName: event.data.toolName,
            arguments: event.data.arguments,
            startTime: Date.now(),
          },
        ]);
      }
    );

    return unsubscribe;
  }, []);

  // ...
};
```

### Emitting Events from Tools

```typescript
// In your tool implementation
export class BashTool extends BaseTool {
  async execute(args: any): Promise<ToolResult> {
    const callId = generateId();

    // Start event
    this.activityStream.emit({
      id: callId,
      type: ActivityEventType.TOOL_CALL_START,
      data: { toolName: 'BashTool', arguments: args },
    });

    try {
      // Execute command
      const result = await this.executeCommand(args.command);

      // End event
      this.activityStream.emit({
        id: callId,
        type: ActivityEventType.TOOL_CALL_END,
        data: { success: true, result },
      });

      return result;
    } catch (error) {
      // Error event
      this.activityStream.emit({
        id: callId,
        type: ActivityEventType.ERROR,
        data: { error: error.message },
      });

      throw error;
    }
  }
}
```

---

## Next Steps

1. **Read the Architecture**: `/docs/CONCURRENT_TOOL_ARCHITECTURE.md`
2. **Explore the Example**: `/src/ui/examples/ConcurrentToolsExample.tsx`
3. **Review Full Docs**: `/docs/CONCURRENT_TOOL_VISUALIZATION.md`
4. **Integrate with App**: Connect to your ActivityStream
5. **Test Real Tools**: Replace example with actual tool execution

---

## Resources

- **Components**: `/src/ui/components/`
  - `OutputScroller.tsx` - Scrolling output display
  - `ToolMessage.tsx` - Individual tool display
  - `ToolGroupMessage.tsx` - Concurrent tool orchestrator

- **Example**: `/src/ui/examples/ConcurrentToolsExample.tsx`

- **Documentation**:
  - `/docs/CONCURRENT_TOOL_VISUALIZATION.md` - Complete guide
  - `/docs/CONCURRENT_TOOL_ARCHITECTURE.md` - Architecture details
  - `/IMPLEMENTATION_SUMMARY.md` - Implementation summary

- **Types**: `/src/types/index.ts`
  - `ToolCallState` interface
  - `ToolStatus` type
  - `ActivityEvent` types

---

**Ready to build? Start with the demo:**

```bash
npx tsx src/ui/examples/ConcurrentToolsExample.tsx
```

**Questions?** Check the full documentation or review the example code!

---

**Last Updated:** 2025-10-20
