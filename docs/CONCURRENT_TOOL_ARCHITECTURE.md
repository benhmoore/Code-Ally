# Concurrent Tool Visualization Architecture

**Visual Guide to Component Interactions**

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Terminal (24 lines)                      │
├─────────────────────────────────────────────────────────────────┤
│  ConversationView (static history)                       ↑      │
│    - Previous user messages                              │      │
│    - Previous assistant responses                        │      │
│    - Completed tool results                              │      │
│                                                          Scroll  │
├─────────────────────────────────────────────────────────────────┤
│  ToolGroupMessage (active concurrent tools)              ↓      │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Summary: Concurrent Tools: 3/4  ✓2 ✕0  (5 lines/tool)    │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │ ⋯ BashTool 3s                          ← ToolMessage 1    │ │
│  │   Installing dependencies...             (5 lines)        │ │
│  │   npm install express...                                  │ │
│  │   added 50 packages in 2s                                 │ │
│  │   ... (12 more lines)                                     │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │ ✓ ReadTool 1s                          ← ToolMessage 2    │ │
│  │   export const foo = ...                 (5 lines)        │ │
│  │   export const bar = ...                                  │ │
│  │   ✓ Completed successfully                                │ │
│  │                                                            │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │ ⋯ GrepTool 2s                          ← ToolMessage 3    │ │
│  │   ./src/app.ts:15: TODO: refactor       (5 lines)        │ │
│  │   ./src/utils.ts:42: TODO: optimize                       │ │
│  │   ... (8 more lines)                                      │ │
│  │                                                            │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │ ● GlobTool 0s                          ← ToolMessage 4    │ │
│  │   {                                      (5 lines)        │ │
│  │     "pattern": "**/*.ts"                                  │ │
│  │   }                                                        │ │
│  │                                                            │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  StatusLine (context usage, token count)                   ↑    │
├─────────────────────────────────────────────────────────────────┤
│  InputPrompt                                              Static │
│  > █                                                        (4)  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Component Hierarchy

```
App
├── ConversationView
│   ├── Static<Message[]>          ← Completed messages (no re-render)
│   └── Message[]                  ← Pending messages (dynamic)
│       └── MessageDisplay
│
├── ToolGroupMessage               ← THE KILLER FEATURE
│   ├── Summary Header
│   │   └── Text (stats)
│   │
│   └── Box[toolCalls.length]      ← Dynamic height allocation
│       └── ToolMessage[]          ← One per concurrent tool
│           ├── Header
│           │   ├── StatusIcon     ← useMemo (status)
│           │   ├── ToolName       ← useMemo (color)
│           │   └── ElapsedTime    ← useState + useEffect
│           │
│           └── OutputScroller     ← useMemo (lines)
│               ├── TruncationIndicator
│               └── Text[]         ← Last N lines
│
├── StatusLine
│   └── Text (context usage)
│
└── InputPrompt
    └── useInput (keyboard handling)
```

---

## Data Flow

### 1. Tool Execution Starts

```
ToolOrchestrator.executeConcurrent()
         ↓
activityStream.emit(TOOL_CALL_START)
         ↓
App.useActivityEvent() subscriber
         ↓
setActiveToolCalls([...prev, newToolCall])
         ↓
React re-renders ToolGroupMessage
         ↓
ToolMessage renders with status='executing'
```

### 2. Tool Output Streaming

```
BaseTool.execute() emits output chunks
         ↓
activityStream.emit(TOOL_OUTPUT_CHUNK)
         ↓
App updates toolCall.output
         ↓
React re-renders only changed ToolMessage
         ↓
OutputScroller recalculates displayLines (useMemo)
         ↓
New output appears in tool's region
```

### 3. Tool Completion

```
BaseTool.execute() completes
         ↓
activityStream.emit(TOOL_CALL_END)
         ↓
App updates toolCall.status='success'
         ↓
React re-renders ToolMessage
         ↓
StatusIcon changes to ✓
ToolName color changes to green
         ↓
ToolGroupMessage recalculates borderColor (useMemo)
         ↓
Border color updates if all tools complete
```

---

## Height Allocation Flow

### Calculation Steps

```
1. useStdout() → terminalHeight (24 lines)
                 ↓
2. STATIC_UI_HEIGHT (4 lines)
                 ↓
3. availableHeight = 24 - 4 = 20 lines
                 ↓
4. toolCount = toolCalls.length (4 tools)
                 ↓
5. heightPerTool = floor(20 / 4) = 5 lines
                 ↓
6. Each ToolMessage gets maxHeight={5}
                 ↓
7. OutputScroller gets maxLines={5 - 1} = 4
   (minus 1 for header line)
```

### Visual Layout

```
Terminal: 24 lines
├── Scroll area: 15 lines (dynamic)
├── ToolGroupMessage: 20 lines
│   ├── Summary: 1 line
│   └── Tools: 19 lines
│       ├── Tool 1: 5 lines (header + 4 output)
│       ├── Tool 2: 5 lines
│       ├── Tool 3: 5 lines
│       └── Tool 4: 4 lines (remaining)
└── Static UI: 4 lines
    ├── StatusLine: 1 line
    └── InputPrompt: 3 lines
```

---

## State Management

### ToolCallState Lifecycle

```
Initial State:
{
  id: 'abc123',
  status: 'pending',
  toolName: 'BashTool',
  arguments: { command: 'npm install' },
  startTime: 1634567890000
}
         ↓
Validating:
{
  ...prev,
  status: 'validating'
}
         ↓
Executing:
{
  ...prev,
  status: 'executing',
  output: 'Installing dependencies...'
}
         ↓
Streaming Output:
{
  ...prev,
  output: 'Installing dependencies...\nnpm install express...'
}
         ↓
Complete:
{
  ...prev,
  status: 'success',
  endTime: 1634567893000,
  output: '...\n✓ Completed successfully'
}
```

### Status Icon State Machine

```
                   ┌──────────────┐
                   │   pending    │
                   │      ○       │
                   └──────┬───────┘
                          │
                   ┌──────▼───────┐
                   │ validating   │
                   │      ●       │
                   └──────┬───────┘
                          │
                   ┌──────▼───────┐
                   │  executing   │
                   │      ⋯       │
                   └──┬─────┬─────┘
                      │     │
             ┌────────▼     ▼────────┐
             │                       │
      ┌──────▼───────┐        ┌──────▼───────┐
      │   success    │        │    error     │
      │      ✓       │        │      ✕       │
      └──────────────┘        └──────────────┘
```

### Border Color Aggregation

```
Priority Order (first match wins):

1. Any error?     → RED
   └─ At least one tool.status === 'error'

2. All success?   → GREEN
   └─ All tools.status === 'success'

3. All cancelled? → GRAY
   └─ All tools.status === 'cancelled'

4. Any active?    → YELLOW
   └─ Any tool.status ∈ ['executing', 'validating', 'pending']

5. Default        → BLUE
```

---

## Performance Characteristics

### Memoization Impact

```
Without useMemo:
  Tool updates → All ToolMessages re-render
              → All border colors recalculate
              → All status icons recalculate
              → 60+ FPS animations lag

With useMemo:
  Tool updates → Only changed ToolMessage re-renders
              → Memoized values cached
              → Smooth 60 FPS animations
```

### Height Constraint Benefits

```
Without height constraint:
  Large output → Render 1000s of lines
              → Terminal buffer overflow
              → Performance degradation

With height constraint:
  Large output → Render only visible lines (maxLines)
              → Constant memory usage
              → Smooth scrolling
```

---

## Concurrent Update Handling

### Rich (Python) - The Problem

```
Thread 1: Live.update(tool1_output)  ┐
Thread 2: Live.update(tool2_output)  ├─ Race condition!
Thread 3: Live.update(tool3_output)  ┘

Result: Visual artifacts, interleaved output, conflicts
```

### Ink (React) - The Solution

```
Event 1: tool1_output → setToolCalls([...prev, { id: '1', output: '...' }])
Event 2: tool2_output → setToolCalls([...prev, { id: '2', output: '...' }])
Event 3: tool3_output → setToolCalls([...prev, { id: '3', output: '...' }])

React batches state updates → Single re-render → No conflicts!

ToolMessage components re-render independently:
  - ToolMessage[id='1'] re-renders (its output changed)
  - ToolMessage[id='2'] re-renders (its output changed)
  - ToolMessage[id='3'] re-renders (its output changed)
  - No interference between components!
```

---

## Edge Cases

### 1. Too Many Tools

**Problem:** 10 tools on 24-line terminal = 2 lines per tool (cramped)

**Solution:**
```typescript
const MIN_HEIGHT_PER_TOOL = 3;
const heightPerTool = Math.max(
  MIN_HEIGHT_PER_TOOL,
  Math.floor(availableHeight / toolCalls.length)
);
```

Result: Each tool guaranteed 3 lines minimum, even if it exceeds terminal height (scrolling).

### 2. Terminal Resize

**Problem:** User resizes terminal during execution

**Solution:**
```typescript
const { stdout } = useStdout();
const terminalHeight = stdout?.rows || 24;

// useMemo dependencies include terminalHeight
const heightPerTool = useMemo(() => {
  return calculateHeight(terminalHeight, toolCalls.length);
}, [terminalHeight, toolCalls.length]);
```

Result: Components automatically adjust on resize.

### 3. No Output

**Problem:** Tool executing but no output yet

**Solution:**
```typescript
{!toolCall.output && (toolCall.status === 'validating' || toolCall.status === 'pending') && (
  <Box paddingLeft={2}>
    <Text color="gray" dimColor>
      {JSON.stringify(toolCall.arguments, null, 2)}
    </Text>
  </Box>
)}
```

Result: Show arguments while waiting for output.

---

## Testing Strategy

### Unit Tests

```typescript
describe('OutputScroller', () => {
  it('shows last N lines', () => {
    render(<OutputScroller output="line1\nline2\nline3" maxLines={2} />);
    expect(screen.getByText('line2')).toBeInTheDocument();
    expect(screen.getByText('line3')).toBeInTheDocument();
    expect(screen.queryByText('line1')).not.toBeInTheDocument();
  });

  it('shows truncation indicator', () => {
    render(<OutputScroller output="line1\nline2\nline3" maxLines={2} />);
    expect(screen.getByText(/\.\.\. \(1 more lines\)/)).toBeInTheDocument();
  });
});
```

### Integration Tests

```typescript
describe('ToolGroupMessage', () => {
  it('allocates height equally', () => {
    const tools = [
      { id: '1', status: 'executing', toolName: 'Tool1', ... },
      { id: '2', status: 'executing', toolName: 'Tool2', ... }
    ];

    render(<ToolGroupMessage toolCalls={tools} terminalHeightOverride={24} />);

    // Each tool should get (24 - 4) / 2 = 10 lines
    const tool1 = screen.getByText('Tool1').closest('Box');
    expect(tool1).toHaveStyle({ height: 10 });
  });

  it('updates border color on status change', () => {
    const { rerender } = render(
      <ToolGroupMessage toolCalls={[{ status: 'executing', ... }]} />
    );

    expect(screen.getByTestId('border')).toHaveStyle({ borderColor: 'yellow' });

    rerender(
      <ToolGroupMessage toolCalls={[{ status: 'success', ... }]} />
    );

    expect(screen.getByTestId('border')).toHaveStyle({ borderColor: 'green' });
  });
});
```

---

## Future Architecture

### Nested Agents

```
ToolGroupMessage (parent tools)
├── ToolMessage[0] (regular tool)
├── ToolMessage[1] (regular tool)
└── ToolMessage[2] (agent delegation)
    └── AgentMessage
        ├── Thoughts display
        └── ToolGroupMessage (nested tools)
            ├── ToolMessage[0]
            └── ToolMessage[1]
```

### Collapsible Tools

```
ToolGroupMessage
├── ToolMessage[0] (collapsed)    ← height: 1 line
├── ToolMessage[1] (expanded)     ← height: 10 lines
└── ToolMessage[2] (expanded)     ← height: 10 lines

Height allocation:
  availableHeight = 21 lines
  collapsedCount = 1 (1 line total)
  expandedCount = 2
  heightPerExpanded = (21 - 1) / 2 = 10 lines
```

---

## Conclusion

The concurrent tool visualization architecture leverages Ink's React component model to solve the fundamental concurrency limitations of the Python/Rich implementation. Key architectural decisions:

1. **Component Isolation**: Each tool is an independent React component
2. **State-Driven Rendering**: React state changes drive UI updates
3. **Dynamic Height Allocation**: Mathematical distribution of vertical space
4. **Memoization Strategy**: Performance optimization through caching
5. **Event-Driven Integration**: ActivityStream decouples execution from UI

This architecture provides the foundation for sophisticated multi-agent workflows with clear, conflict-free visualization.

---

**Last Updated:** 2025-10-20
