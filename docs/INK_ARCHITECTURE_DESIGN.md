# Code Ally Ink Architecture Design

**Version:** 1.0
**Date:** 2025-10-20
**Purpose:** Strategic architecture for porting Code Ally from Python/Rich to TypeScript/Ink

---

## Executive Summary

This document outlines the complete architecture for reimplementing Code Ally using Ink (React for terminals). The redesign addresses Rich's limitations with concurrent updates while maintaining all existing functionality.

### Key Motivations

1. **Concurrent Agent Display**: Gemini-CLI demonstrates that Ink's React model enables true concurrent agent visualization
2. **Dynamic Updates**: Multiple UI elements can update independently without conflicts
3. **Better State Management**: React's component model provides cleaner state isolation
4. **Animation Flexibility**: Independent component re-renders enable smoother animations

---

## Architecture Comparison

### Python/Rich Stack
```
Python 3.11+
├── Rich (terminal rendering)
│   ├── Live displays (thread-based)
│   ├── Console output (imperative)
│   └── Panel/Table (static renderables)
├── prompt_toolkit (input)
└── asyncio (concurrency)
```

### TypeScript/Ink Stack
```
Node.js 18+
├── Ink 4.x (React for terminals)
│   ├── Component-based rendering
│   ├── React state management
│   └── Hooks (useState, useEffect, useInput)
├── React 18+ (core framework)
└── TypeScript (type safety)
```

---

## Core Architecture Layers

### Layer 1: Foundation Services

```typescript
services/
├── ServiceRegistry.ts          // DI container
├── ConfigManager.ts            // Configuration
├── PathResolver.ts             // Path resolution
└── ActivityStream.ts           // Event system (NEW)
```

**Key Addition: ActivityStream**

Inspired by Gemini-CLI, this is the event backbone:

```typescript
export enum ActivityEventType {
  TOOL_CALL_START = 'tool_call_start',
  TOOL_CALL_END = 'tool_call_end',
  TOOL_OUTPUT_CHUNK = 'tool_output_chunk',
  THOUGHT_CHUNK = 'thought_chunk',
  AGENT_START = 'agent_start',
  AGENT_END = 'agent_end',
  ERROR = 'error',
}

export interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  timestamp: number;
  parentId?: string;
  data: any;
}

export class ActivityStream {
  private listeners: Map<string, Set<ActivityCallback>>;

  emit(event: ActivityEvent): void;
  subscribe(eventType: string, callback: ActivityCallback): () => void;

  // Scoped streams for nested agents
  createScoped(parentId: string): ActivityStream;
}
```

### Layer 2: LLM Integration

```typescript
llm/
├── ModelClient.ts              // Abstract interface
├── OllamaClient.ts             // Ollama implementation
├── MessageHistory.ts           // Conversation state
└── FunctionCalling.ts          // Tool call parsing
```

**Key Interfaces:**

```typescript
export interface ModelClient {
  send(
    messages: Message[],
    functions: FunctionDefinition[],
    options: SendOptions
  ): Promise<ModelResponse>;

  stream(
    messages: Message[],
    functions: FunctionDefinition[],
    options: SendOptions
  ): AsyncIterator<StreamChunk>;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}
```

### Layer 3: Tool System

```typescript
tools/
├── BaseTool.ts                 // Abstract base
├── ToolManager.ts              // Registry & execution
├── ToolValidator.ts            // Argument validation
└── tools/
    ├── BashTool.ts
    ├── ReadTool.ts
    ├── WriteTool.ts
    ├── EditTool.ts
    ├── GrepTool.ts
    ├── GlobTool.ts
    └── AgentTool.ts            // Delegation
```

**Event Emission Pattern:**

```typescript
export abstract class BaseTool {
  protected emitEvent(event: ActivityEvent): void {
    this.activityStream.emit(event);
  }

  async execute(args: any): Promise<ToolResult> {
    const callId = generateId();

    this.emitEvent({
      id: callId,
      type: ActivityEventType.TOOL_CALL_START,
      timestamp: Date.now(),
      data: { toolName: this.name, arguments: args }
    });

    try {
      const result = await this.executeImpl(args);

      this.emitEvent({
        id: callId,
        type: ActivityEventType.TOOL_CALL_END,
        timestamp: Date.now(),
        data: { toolName: this.name, result, success: true }
      });

      return result;
    } catch (error) {
      this.emitEvent({
        id: callId,
        type: ActivityEventType.ERROR,
        timestamp: Date.now(),
        data: { toolName: this.name, error }
      });

      throw error;
    }
  }

  protected abstract executeImpl(args: any): Promise<ToolResult>;
}
```

### Layer 4: Agent Orchestration

```typescript
agent/
├── Agent.ts                    // Main orchestrator
├── ToolOrchestrator.ts         // Concurrent execution
├── TokenManager.ts             // Context management
├── TrustManager.ts             // Permissions
└── ExecutionContext.ts         // Delegation tracking
```

**Concurrent Tool Execution:**

```typescript
export class ToolOrchestrator {
  async executeConcurrent(toolCalls: ToolCall[]): Promise<void> {
    // Group tool calls
    const groupId = generateId();

    this.emitEvent({
      id: groupId,
      type: ActivityEventType.TOOL_GROUP_START,
      timestamp: Date.now(),
      data: { toolCalls }
    });

    // Execute in parallel
    const results = await Promise.all(
      toolCalls.map(tc => this.executeSingle(tc, groupId))
    );

    this.emitEvent({
      id: groupId,
      type: ActivityEventType.TOOL_GROUP_END,
      timestamp: Date.now(),
      data: { results }
    });
  }

  private async executeSingle(
    toolCall: ToolCall,
    parentId: string
  ): Promise<ToolResult> {
    const tool = this.toolManager.getTool(toolCall.function.name);
    const args = JSON.parse(toolCall.function.arguments);

    return await tool.execute(args);
  }
}
```

### Layer 5: UI Components (Ink/React)

```typescript
ui/
├── App.tsx                     // Root component
├── components/
│   ├── ConversationView.tsx   // Main conversation
│   ├── MessageList.tsx         // Static messages
│   ├── ToolGroupMessage.tsx    // Concurrent tools
│   ├── ToolMessage.tsx         // Single tool
│   ├── AgentMessage.tsx        // Agent delegation
│   ├── ThinkingIndicator.tsx   // Animations
│   ├── InputPrompt.tsx         // User input
│   └── StatusLine.tsx          // Context info
├── hooks/
│   ├── useActivityStream.ts    // Event subscription
│   ├── useToolState.ts         // Tool status
│   └── useAnimation.ts         // Animation state
└── contexts/
    ├── AppContext.tsx          // Global state
    └── ActivityContext.tsx     // Event stream
```

---

## Component Architecture Details

### Root App Component

```typescript
export const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCallState[]>([]);
  const activityStream = useRef(new ActivityStream());

  // Subscribe to events
  useEffect(() => {
    const unsubscribe = activityStream.current.subscribe(
      ActivityEventType.TOOL_CALL_START,
      (event) => {
        setActiveToolCalls(prev => [...prev, {
          id: event.id,
          status: 'executing',
          ...event.data
        }]);
      }
    );

    return unsubscribe;
  }, []);

  return (
    <ActivityContext.Provider value={activityStream.current}>
      <Box flexDirection="column" height="100%">
        <Box flexGrow={1}>
          <ConversationView messages={messages} />
        </Box>

        <Box>
          {activeToolCalls.length > 0 && (
            <ToolGroupMessage toolCalls={activeToolCalls} />
          )}
        </Box>

        <Box>
          <InputPrompt onSubmit={handleSubmit} />
        </Box>
      </Box>
    </ActivityContext.Provider>
  );
};
```

### ToolGroupMessage Component

Gemini-CLI's killer feature for concurrent agent display:

```typescript
export const ToolGroupMessage: React.FC<Props> = ({ toolCalls }) => {
  const { terminalHeight } = useStdout();

  // Calculate available height
  const toolsWithResults = toolCalls.filter(tc => tc.output);
  const availableHeight = terminalHeight - STATIC_HEIGHT;
  const heightPerTool = Math.floor(availableHeight / toolsWithResults.length);

  // Determine border color based on status
  const borderColor = useMemo(() => {
    if (toolCalls.some(tc => tc.status === 'error')) return 'red';
    if (toolCalls.every(tc => tc.status === 'success')) return 'green';
    return 'yellow';
  }, [toolCalls]);

  return (
    <Box borderStyle="round" borderColor={borderColor} flexDirection="column">
      {toolCalls.map(tc => (
        <Box key={tc.id} height={heightPerTool} flexDirection="column">
          <ToolMessage
            toolCall={tc}
            maxHeight={heightPerTool}
          />
        </Box>
      ))}
    </Box>
  );
};
```

### ToolMessage Component

Individual tool display with state machine:

```typescript
export const ToolMessage: React.FC<Props> = ({ toolCall, maxHeight }) => {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startTime = useRef(Date.now());

  // Update elapsed time
  useEffect(() => {
    if (toolCall.status === 'executing') {
      const interval = setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - startTime.current) / 1000));
      }, 1000);

      return () => clearInterval(interval);
    }
  }, [toolCall.status]);

  const statusIcon = useMemo(() => {
    switch (toolCall.status) {
      case 'validating': return <Text color="yellow">●</Text>;
      case 'executing': return <Spinner type="dots" />;
      case 'success': return <Text color="green">✓</Text>;
      case 'error': return <Text color="red">✕</Text>;
      default: return null;
    }
  }, [toolCall.status]);

  return (
    <Box flexDirection="column">
      <Box>
        {statusIcon}
        <Text color="cyan"> {toolCall.toolName}</Text>
        <Text color="gray"> {elapsedSeconds}s</Text>
      </Box>

      {toolCall.output && (
        <Box height={maxHeight - 1} flexDirection="column">
          <OutputScroller output={toolCall.output} maxLines={maxHeight - 1} />
        </Box>
      )}
    </Box>
  );
};
```

### AgentMessage Component

For nested agent delegation:

```typescript
export const AgentMessage: React.FC<Props> = ({ agentCall }) => {
  const scopedStream = useRef(
    activityStream.createScoped(agentCall.id)
  );

  const [subToolCalls, setSubToolCalls] = useState<ToolCallState[]>([]);
  const [thoughts, setThoughts] = useState<string>('');

  // Subscribe to scoped events
  useEffect(() => {
    const unsubscribe = scopedStream.current.subscribe(
      ActivityEventType.THOUGHT_CHUNK,
      (event) => {
        setThoughts(prev => prev + event.data.text);
      }
    );

    return unsubscribe;
  }, []);

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        <Text color="magenta">→ {agentCall.agentName}</Text>
        <Text color="gray"> ({agentCall.taskPrompt})</Text>
      </Box>

      {thoughts && (
        <Box paddingLeft={2}>
          <Text color="cyan" dimColor>💭 {thoughts}</Text>
        </Box>
      )}

      {subToolCalls.length > 0 && (
        <Box paddingLeft={2}>
          <ToolGroupMessage toolCalls={subToolCalls} />
        </Box>
      )}

      {agentCall.status === 'complete' && (
        <Text color="green">Complete ({agentCall.duration}s)</Text>
      )}
    </Box>
  );
};
```

### Static vs Dynamic Rendering

Following Gemini-CLI's approach:

```typescript
export const ConversationView: React.FC = ({ messages }) => {
  const [completedMessages, setCompletedMessages] = useState<Message[]>([]);
  const [pendingMessages, setPendingMessages] = useState<Message[]>([]);

  // Split messages into completed and pending
  useEffect(() => {
    const completed = messages.filter(m => m.status === 'complete');
    const pending = messages.filter(m => m.status !== 'complete');

    setCompletedMessages(completed);
    setPendingMessages(pending);
  }, [messages]);

  return (
    <Box flexDirection="column">
      {/* Static rendering for completed messages (no re-renders) */}
      <Static items={completedMessages}>
        {message => <MessageDisplay key={message.id} message={message} />}
      </Static>

      {/* Dynamic rendering for pending messages */}
      {pendingMessages.map(message => (
        <MessageDisplay key={message.id} message={message} />
      ))}
    </Box>
  );
};
```

---

## State Management Strategy

### Global State (AppContext)

```typescript
interface AppState {
  messages: Message[];
  config: Config;
  activeSession: Session | null;
  contextUsage: number;
  toolCallsActive: number;
}

export const AppContext = createContext<AppState | null>(null);

export const useAppState = () => {
  const context = useContext(AppContext);
  if (!context) throw new Error('useAppState must be used within AppProvider');
  return context;
};
```

### Activity Stream Context

```typescript
export const ActivityContext = createContext<ActivityStream | null>(null);

export const useActivityStream = () => {
  const stream = useContext(ActivityContext);
  if (!stream) throw new Error('useActivityStream must be used within ActivityProvider');
  return stream;
};

// Custom hook for subscribing to events
export const useActivityEvent = (
  eventType: ActivityEventType,
  callback: ActivityCallback,
  deps: any[] = []
) => {
  const stream = useActivityStream();

  useEffect(() => {
    const unsubscribe = stream.subscribe(eventType, callback);
    return unsubscribe;
  }, deps);
};
```

### Tool State Hook

```typescript
export const useToolState = (toolCallId: string) => {
  const [status, setStatus] = useState<ToolStatus>('pending');
  const [output, setOutput] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useActivityEvent(ActivityEventType.TOOL_CALL_START, (event) => {
    if (event.id === toolCallId) {
      setStatus('executing');
    }
  }, [toolCallId]);

  useActivityEvent(ActivityEventType.TOOL_OUTPUT_CHUNK, (event) => {
    if (event.id === toolCallId) {
      setOutput(prev => prev + event.data.chunk);
    }
  }, [toolCallId]);

  useActivityEvent(ActivityEventType.TOOL_CALL_END, (event) => {
    if (event.id === toolCallId) {
      setStatus(event.data.success ? 'success' : 'error');
      if (!event.data.success) {
        setError(event.data.error);
      }
    }
  }, [toolCallId]);

  return { status, output, error };
};
```

---

## Implementation Phases

### Phase 1: Foundation (Week 1)

**Goal**: Set up project and core infrastructure

Tasks:
1. Initialize TypeScript project with proper tooling
2. Set up Ink and React dependencies
3. Implement ServiceRegistry with DI
4. Implement ConfigManager
5. Create ActivityStream event system
6. Set up basic project structure

**Deliverable**: Running "Hello World" Ink app with service registry

### Phase 2: LLM Integration (Week 1)

**Goal**: Connect to Ollama and handle basic conversations

Tasks:
1. Port ModelClient interface
2. Implement OllamaClient
3. Add message history management
4. Parse function calling responses
5. Basic conversation loop (without tools)

**Deliverable**: Chat with Ollama model through Ink UI

### Phase 3: Tool System Foundation (Week 2)

**Goal**: Core tool architecture without UI

Tasks:
1. Implement BaseTool abstract class
2. Create ToolManager with registry
3. Add tool validation
4. Implement event emission in tools
5. Port BashTool (simplest tool)
6. Port ReadTool

**Deliverable**: Execute bash commands and read files via tool system

### Phase 4: Basic UI Components (Week 2)

**Goal**: Display conversations and tool results

Tasks:
1. Create App root component
2. Implement MessageList with Static rendering
3. Create ToolMessage component
4. Add basic InputPrompt
5. Display tool call results
6. Add status indicators

**Deliverable**: See tool execution in Ink UI with basic formatting

### Phase 5: Concurrent Tool Display (Week 3)

**Goal**: Implement Gemini-CLI's concurrent visualization

Tasks:
1. Create ToolGroupMessage component
2. Implement dynamic height allocation
3. Add border color state machine
4. Implement output scrolling
5. Add elapsed time tracking
6. Test with multiple concurrent tools

**Deliverable**: Multiple tools executing concurrently with independent displays

### Phase 6: Agent Delegation (Week 3)

**Goal**: Nested agent visualization

Tasks:
1. Implement AgentTool
2. Create scoped activity streams
3. Implement AgentMessage component
4. Add indented nested tool displays
5. Test thought streaming
6. Verify isolation

**Deliverable**: Nested agents displaying correctly with thoughts

### Phase 7: Remaining Tools (Week 4)

**Goal**: Port all Python tools

Tasks:
1. Port WriteTool, EditTool, LineEditTool
2. Port GrepTool, GlobTool, LsTool
3. Implement tool mixins (validation, patching)
4. Add diff preview system
5. Test all tools

**Deliverable**: Feature parity with Python tools

### Phase 8: Advanced UI Features (Week 4)

**Goal**: Polish and animations

Tasks:
1. Add thinking indicators
2. Implement streaming responses
3. Add context usage display
4. Create todo list display
5. Add color coding and themes
6. Implement keyboard shortcuts

**Deliverable**: Production-ready UI with all animations

### Phase 9: Testing & Optimization (Week 5)

**Goal**: Ensure reliability and performance

Tasks:
1. Add unit tests for core systems
2. Integration tests for tool execution
3. Performance profiling
4. Memory leak detection
5. Error handling improvements
6. Documentation

**Deliverable**: Tested, documented system

### Phase 10: Migration & Deployment (Week 5)

**Goal**: Replace Python version

Tasks:
1. Side-by-side comparison testing
2. Migration guide
3. Configuration migration tool
4. Packaging for npm
5. CLI installation
6. Release v1.0

**Deliverable**: Released Code Ally Ink v1.0

---

## Key Design Decisions

### 1. Event-Driven Architecture

**Decision**: Use ActivityStream as central event bus
**Rationale**: Enables React components to subscribe to tool/agent events without tight coupling
**Trade-off**: Additional complexity vs. clean separation of concerns

### 2. Component-Based Tool Display

**Decision**: Each tool call gets its own React component
**Rationale**: Independent re-rendering, better state isolation
**Trade-off**: More components vs. performance benefits

### 3. Static vs Dynamic Rendering

**Decision**: Use Ink's <Static> for completed messages
**Rationale**: Prevents unnecessary re-renders, better performance
**Trade-off**: Two rendering paths vs. significant performance gain

### 4. Scoped Activity Streams

**Decision**: Create child streams for nested agents
**Rationale**: Clean event isolation, prevents cross-agent pollution
**Trade-off**: Stream management complexity vs. correctness

### 5. TypeScript Throughout

**Decision**: No JavaScript, TypeScript everywhere
**Rationale**: Type safety catches bugs early, better IDE support
**Trade-off**: Compilation step vs. reliability

---

## Performance Considerations

### Memory Management

1. **Message History Limit**: Keep only last 1000 messages in memory
2. **Output Scrolling**: Show only visible window of tool output
3. **Event Cleanup**: Unsubscribe from streams on unmount
4. **Static Rendering**: Freeze completed messages

### Rendering Optimization

1. **React.memo**: Memoize expensive components
2. **useMemo**: Cache computed values (border colors, status icons)
3. **useCallback**: Stable callbacks to prevent re-renders
4. **Virtualization**: For large message lists (future)

### Concurrent Execution

1. **Promise.all**: Parallel tool execution
2. **Worker Threads**: For CPU-intensive tools (future)
3. **Streaming**: Progressive output updates
4. **Cancellation**: Proper cleanup on interrupt

---

## Testing Strategy

### Unit Tests

- Service registry registration/retrieval
- Configuration loading/saving
- Tool argument validation
- Path resolution logic
- Event emission/subscription

### Integration Tests

- End-to-end tool execution
- Nested agent delegation
- Concurrent tool coordination
- Message history management
- Session persistence

### UI Tests

- Component rendering
- User input handling
- Keyboard shortcuts
- State updates
- Animation timing

---

## Success Criteria

### Functional Requirements

- ✅ All Python tools ported and working
- ✅ Concurrent tool display with independent updates
- ✅ Nested agent visualization
- ✅ Configuration compatibility with Python version
- ✅ Session management and persistence

### Non-Functional Requirements

- ✅ Startup time < 1 second
- ✅ Memory usage < 200MB for typical session
- ✅ Smooth animations (60 FPS target)
- ✅ No visual artifacts during concurrent updates
- ✅ Responsive to user input (< 100ms latency)

### Developer Experience

- ✅ Type-safe API with TypeScript
- ✅ Clear component hierarchy
- ✅ Easy to add new tools
- ✅ Comprehensive documentation
- ✅ Good error messages

---

## Next Steps

1. **Review this architecture** with the team
2. **Set up development environment** (Node, TypeScript, Ink)
3. **Create initial project structure**
4. **Begin Phase 1 implementation**
5. **Establish testing framework early**

---

## Questions to Resolve

1. **Node version**: Require 18+ for native fetch?
2. **Package manager**: npm, yarn, or pnpm?
3. **Build tool**: tsc, esbuild, or swc?
4. **Test framework**: Jest, Vitest, or native Node test runner?
5. **Distribution**: npm package, standalone binary, or both?

---

**Document Status**: Ready for Review
**Last Updated**: 2025-10-20
**Next Review**: After Phase 1 completion
