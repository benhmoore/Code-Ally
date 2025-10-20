# Concurrent Tool Visualization Implementation

**Version:** 1.0
**Date:** 2025-10-20
**Status:** Implemented

---

## Overview

This document describes the implementation of Code Ally's **killer feature**: Gemini-CLI-style concurrent tool visualization using Ink's React component model.

### The Problem

The Python/Rich version of Code Ally faced fundamental limitations with concurrent displays:
- Rich's `Live` displays use threads and lock-based updates
- Multiple concurrent tool updates caused visual artifacts and conflicts
- No clean way to allocate independent display regions per tool

### The Solution

Ink's React component model enables true concurrent visualization where:
- Each tool gets its own React component with independent state
- Components re-render independently without conflicts
- Dynamic height allocation provides equal vertical space per tool
- Aggregate status visualization shows overall progress at a glance

---

## Architecture

### Component Hierarchy

```
ToolGroupMessage (Orchestrator)
├── Border with aggregate status color
├── Summary header (N/M tools, success/error counts)
└── ToolMessage[] (One per concurrent tool)
    ├── Status icon + tool name + elapsed time
    └── OutputScroller (Last N lines of output)
```

### Key Components

#### 1. **OutputScroller** (`/src/ui/components/OutputScroller.tsx`)

Displays scrolling output with height constraints.

**Features:**
- Shows last N lines of tool output
- Truncates long lines to prevent horizontal overflow
- Displays "... (X more lines)" indicator if content exceeds height
- Memoized line processing for performance

**Props:**
```typescript
interface OutputScrollerProps {
  output: string;           // Raw output text (multi-line)
  maxLines: number;         // Maximum lines to display
  maxCharsPerLine?: number; // Max chars before truncation (default: 120)
}
```

**Usage:**
```tsx
<OutputScroller
  output={toolOutput}
  maxLines={10}
  maxCharsPerLine={120}
/>
```

#### 2. **ToolMessage** (`/src/ui/components/ToolMessage.tsx`)

Displays individual tool execution with status and output.

**Features:**
- Status icon state machine: ○ pending, ● validating, spinner executing, ✓ success, ✕ error
- Real-time elapsed seconds counter
- Color-coded tool name based on status
- Height-constrained output display
- Shows arguments for pending/validating tools

**Props:**
```typescript
interface ToolMessageProps {
  toolCall: ToolCallState;  // Tool state (status, output, etc.)
  maxHeight: number;        // Vertical space allocated
}
```

**Status State Machine:**
```
pending → validating → executing → success/error/cancelled
   ○          ●         spinner       ✓ / ✕ / ⊘
```

**Usage:**
```tsx
<ToolMessage
  toolCall={{
    id: 'abc123',
    status: 'executing',
    toolName: 'BashTool',
    arguments: { command: 'npm install' },
    output: 'Installing dependencies...',
    startTime: Date.now(),
  }}
  maxHeight={10}
/>
```

#### 3. **ToolGroupMessage** (`/src/ui/components/ToolGroupMessage.tsx`)

Orchestrates multiple concurrent tool displays.

**Features:**
- Dynamic height allocation: `(terminalHeight - staticHeight) / toolCount`
- Aggregate status border color (red=error, green=complete, yellow=pending)
- Summary statistics (total, completed, success, error counts)
- Minimum height per tool to prevent cramping
- Flexbox column layout for equal vertical distribution

**Props:**
```typescript
interface ToolGroupMessageProps {
  toolCalls: ToolCallState[];        // Array of concurrent tools
  terminalHeightOverride?: number;   // For testing
}
```

**Border Color Logic:**
```typescript
const borderColor = useMemo(() => {
  if (anyError) return 'red';
  if (allSuccess) return 'green';
  if (allCancelled) return 'gray';
  if (anyExecuting) return 'yellow';
  return 'blue';
}, [toolCalls]);
```

**Usage:**
```tsx
<ToolGroupMessage
  toolCalls={[
    { id: '1', status: 'executing', toolName: 'BashTool', ... },
    { id: '2', status: 'success', toolName: 'ReadTool', ... },
    { id: '3', status: 'executing', toolName: 'GrepTool', ... },
  ]}
/>
```

---

## Dynamic Height Allocation

The most critical feature is dynamic height allocation, enabling equal vertical space per tool.

### Algorithm

```typescript
// 1. Get terminal height from useStdout hook
const { stdout } = useStdout();
const terminalHeight = stdout?.rows || 24;

// 2. Calculate available height
const STATIC_UI_HEIGHT = 4; // prompt, status line, etc.
const availableHeight = terminalHeight - STATIC_UI_HEIGHT;

// 3. Allocate height per tool
const MIN_HEIGHT_PER_TOOL = 3;
const heightPerTool = Math.max(
  MIN_HEIGHT_PER_TOOL,
  Math.floor(availableHeight / toolCalls.length)
);

// 4. Pass to each ToolMessage
<ToolMessage maxHeight={heightPerTool} />
```

### Example Scenarios

**Scenario 1: 2 tools, 24-line terminal**
```
availableHeight = 24 - 4 = 20 lines
heightPerTool = 20 / 2 = 10 lines each
```

**Scenario 2: 4 tools, 24-line terminal**
```
availableHeight = 24 - 4 = 20 lines
heightPerTool = 20 / 4 = 5 lines each
```

**Scenario 3: 6 tools, 24-line terminal**
```
availableHeight = 24 - 4 = 20 lines
heightPerTool = 20 / 6 = 3 lines each (minimum)
```

### Constraints

- **MIN_HEIGHT_PER_TOOL**: 3 lines minimum to show header + output
- **STATIC_UI_HEIGHT**: 4 lines reserved for prompt and status
- **Terminal resize**: Components automatically adjust via `useStdout()` hook

---

## State Management

### ToolCallState Interface

```typescript
export interface ToolCallState {
  id: string;              // Unique tool call identifier
  status: ToolStatus;      // Current execution status
  toolName: string;        // Tool name (e.g., 'BashTool')
  arguments: any;          // Tool arguments
  output?: string;         // Accumulated output
  error?: string;          // Error message if failed
  startTime: number;       // Execution start timestamp
  endTime?: number;        // Execution end timestamp
}

export type ToolStatus =
  | 'pending'      // Queued, not started
  | 'validating'   // Validating arguments
  | 'scheduled'    // Scheduled for execution
  | 'executing'    // Currently executing
  | 'success'      // Completed successfully
  | 'error'        // Failed with error
  | 'cancelled';   // Cancelled by user
```

### State Updates

Tools update their state via activity stream events:

```typescript
// Tool starts
activityStream.emit({
  id: toolCallId,
  type: ActivityEventType.TOOL_CALL_START,
  data: { toolName, arguments }
});

// Output streaming
activityStream.emit({
  id: toolCallId,
  type: ActivityEventType.TOOL_OUTPUT_CHUNK,
  data: { chunk: newOutput }
});

// Tool completes
activityStream.emit({
  id: toolCallId,
  type: ActivityEventType.TOOL_CALL_END,
  data: { success: true, result }
});
```

The App component subscribes to these events and updates the `toolCalls` array, triggering React re-renders.

---

## Performance Optimizations

### 1. Memoization

All expensive computations are memoized:

```typescript
// Border color (aggregate status)
const borderColor = useMemo(() => {
  // Compute based on toolCalls
}, [toolCalls]);

// Status icon
const statusIcon = useMemo(() => {
  // Compute based on status
}, [toolCall.status]);

// Output scrolling
const { displayLines, hasMoreLines } = useMemo(() => {
  // Process output
}, [output, maxLines, maxCharsPerLine]);
```

### 2. Component Keys

Each ToolMessage uses `toolCall.id` as the key:

```tsx
{toolCalls.map(tc => (
  <ToolMessage key={tc.id} toolCall={tc} maxHeight={h} />
))}
```

This ensures React efficiently updates only changed tools.

### 3. Height Constraints

Output is constrained to allocated height, preventing excessive rendering:

```typescript
const outputMaxLines = Math.max(1, maxHeight - 1);
<OutputScroller maxLines={outputMaxLines} />
```

---

## Integration with App

### App Component Usage

```tsx
export const App: React.FC = () => {
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCallState[]>([]);

  // Subscribe to activity stream events
  useEffect(() => {
    const unsubscribe = activityStream.subscribe(
      ActivityEventType.TOOL_CALL_START,
      (event) => {
        setActiveToolCalls(prev => [...prev, {
          id: event.id,
          status: 'executing',
          toolName: event.data.toolName,
          arguments: event.data.arguments,
          startTime: Date.now()
        }]);
      }
    );
    return unsubscribe;
  }, []);

  return (
    <Box flexDirection="column" height="100%">
      {/* Conversation history */}
      <ConversationView messages={messages} />

      {/* Active concurrent tools */}
      {activeToolCalls.length > 0 && (
        <ToolGroupMessage toolCalls={activeToolCalls} />
      )}

      {/* Input prompt */}
      <InputPrompt onSubmit={handleSubmit} />
    </Box>
  );
};
```

---

## Testing

### Running the Example

```bash
# Install dependencies
npm install

# Run the concurrent tools demo
npx tsx src/ui/examples/ConcurrentToolsExample.tsx
```

### Testing Scenarios

1. **2 tools executing**: Verify equal height allocation
2. **4 tools with mixed status**: Check border color logic
3. **Terminal resize**: Confirm dynamic height adjustment
4. **Output scrolling**: Test with large output
5. **Error handling**: Verify error status display

---

## Comparison with Gemini-CLI

### Similarities

- ✅ Concurrent tool display with independent regions
- ✅ Dynamic height allocation
- ✅ Status-based border coloring
- ✅ Non-interleaving output
- ✅ Real-time elapsed time counters

### Improvements

- ✅ **Aggregate statistics**: Summary header shows success/error counts
- ✅ **Minimum height guarantee**: Prevents cramming too many tools
- ✅ **Status state machine**: More granular states (validating, scheduled, etc.)
- ✅ **Error message preview**: First line of error shown in header
- ✅ **Arguments display**: Shows arguments for pending/validating tools

---

## Future Enhancements

### 1. Nested Agent Display

```tsx
<ToolGroupMessage toolCalls={parentTools}>
  <AgentMessage agentCall={nestedAgent}>
    <ToolGroupMessage toolCalls={nestedTools} />
  </AgentMessage>
</ToolGroupMessage>
```

### 2. Tool Prioritization

Allow important tools to receive more vertical space:

```typescript
interface ToolCallState {
  priority?: 'low' | 'normal' | 'high';
}

// High priority tools get 1.5x normal height
const heightPerTool = calculateWeightedHeight(toolCalls);
```

### 3. Output Filtering

Add search/filter for tool output:

```tsx
<OutputScroller
  output={output}
  maxLines={10}
  filter="ERROR" // Only show lines matching pattern
/>
```

### 4. Collapsible Tools

Allow collapsing completed tools to save space:

```tsx
<ToolMessage
  toolCall={tc}
  maxHeight={tc.collapsed ? 1 : heightPerTool}
  onToggleCollapse={() => toggleCollapse(tc.id)}
/>
```

---

## Troubleshooting

### Issue: Tools appear cramped

**Solution**: Increase terminal height or reduce concurrent tool count.

```typescript
const MIN_HEIGHT_PER_TOOL = 5; // Increase from 3
```

### Issue: Border color not updating

**Solution**: Ensure `useMemo` dependencies include full `toolCalls` array.

```typescript
const borderColor = useMemo(() => {
  // logic
}, [toolCalls]); // Not [toolCalls.length]!
```

### Issue: Output not scrolling

**Solution**: Verify `maxLines` is less than total output lines.

```typescript
console.log('Output lines:', output.split('\n').length);
console.log('Max lines:', maxLines);
```

---

## Conclusion

The concurrent tool visualization system represents a significant improvement over the Python/Rich implementation:

1. **True Concurrency**: React's component model enables independent updates
2. **Dynamic Allocation**: Automatic height distribution based on terminal size
3. **Visual Clarity**: Aggregate status and per-tool status at a glance
4. **Performance**: Memoization and height constraints prevent lag
5. **Extensibility**: Easy to add nested agents and advanced features

This implementation provides the foundation for sophisticated multi-agent workflows with clear, non-conflicting visualization.

---

**Implementation Status**: ✅ Complete
**Next Steps**: Integrate with activity stream and test with real tools
**Last Updated**: 2025-10-20
