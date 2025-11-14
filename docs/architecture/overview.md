# Architecture Overview

Code Ally uses an event-driven layered architecture with clear separation of concerns.

## System Architecture

```
CLI (cli.ts)
    ↓
Ink UI (React components)
    ↓
ActivityStream (event bus)
    ↓
Agent
    ├── Tool Manager → Tools
    ├── LLM Client → Ollama
    └── Service Registry → Services
```

## Core Layers

### CLI Layer

**Entry point:** `src/cli.ts`

**Responsibilities:**
- Command-line argument parsing
- Service initialization and dependency injection
- Plugin loading and activation
- UI rendering or once-mode execution
- Graceful shutdown

**Flow:**
1. Parse arguments (--model, --once, --resume, etc.)
2. Initialize ConfigManager and SessionManager
3. Load plugins from `~/.ally/plugins/`
4. Initialize PluginActivationManager
5. Create Agent with LLM client and tools
6. Render Ink UI or execute once-mode
7. Handle shutdown (cleanup services, stop background processes)

### UI Layer

**Location:** `src/ui/`

**Stack:** React 18 + Ink 4 (React renderer for terminals)

**Architecture:**
- **Contexts:** ActivityContext, AppContext
- **Hooks:** useActivityEvent, useToolState, useAnimation
- **Components:** ConversationView, InputPrompt, ToolMessage, StatusIndicator

**Data flow:**
```
User input → InputPrompt
    ↓
Agent.sendMessage()
    ↓
ActivityStream events
    ↓
React components update (via useActivityEvent)
```

**Key features:**
- Real-time streaming display
- Concurrent tool visualization
- Command history and tab completion
- Permission prompts
- Session selector, agent wizard, undo interface

### Event System

**Implementation:** `src/services/ActivityStream.ts`

**Purpose:** Decouples UI from business logic through pub/sub pattern

**Event types:**
- TOOL_CALL_START / TOOL_CALL_END
- AGENT_START / AGENT_END
- TOOL_OUTPUT_CHUNK (streaming output)
- USER_INTERRUPT_INITIATED
- INTERRUPT_ALL
- ERROR

**Usage:**
```typescript
// Subscribe
const unsubscribe = activityStream.subscribe(
  ActivityEventType.TOOL_CALL_START,
  (event) => {
    // Handle event
  }
);

// Emit
activityStream.emit({
  id: 'unique-id',
  type: ActivityEventType.TOOL_CALL_START,
  timestamp: Date.now(),
  data: { toolName: 'bash', args: {} }
});

// Cleanup
unsubscribe();
```

**Scoped streams:** Create isolated streams for nested agents

### Agent Layer

**Implementation:** `src/agent/Agent.ts` (2,279 lines)

**Responsibilities:**
- Conversation history management
- LLM request/response orchestration
- Tool call coordination via ToolOrchestrator
- Context tracking and auto-compaction
- Interruption handling
- Cycle detection (repetitive tool calls)

**Key components:**
- **Agent:** Main orchestrator
- **ToolOrchestrator:** Concurrent/sequential tool execution
- **InterruptionManager:** Handles Ctrl+C and interjections
- **TokenManager:** Tracks context usage
- **RequiredToolTracker:** Enforces mandatory tools

**Flow:**
```
User message → Agent.sendMessage()
    ↓
Agent.getLLMResponse()
    ↓
LLM returns tool calls
    ↓
Agent.processToolResponse()
    ↓
ToolOrchestrator.executeToolCalls()
    ↓
Tools execute (emit events)
    ↓
Agent gets follow-up LLM response
    ↓
Recursively process until completion
```

**Context management:**
- Monitors token usage via TokenManager
- Auto-compacts at 80% context threshold
- Summarizes conversation with LLM
- Preserves last user message

**Interruption handling:**
- User presses Escape during execution
- InterruptionManager sets interrupted flag
- Cancels ongoing LLM request
- Propagates interrupt to nested agents via INTERRUPT_ALL event
- Returns early with interruption message

### Tool System

**Location:** `src/tools/`

**Architecture:**
- **BaseTool:** Abstract base with event emission lifecycle
- **ToolManager:** Registry, validation, execution orchestration
- **ToolValidator:** Argument validation against schemas
- **Concrete tools:** Bash, Read, Write, Edit, Grep, Glob, etc.

**Built-in tools:**
- **Bash:** Shell command execution with streaming output
- **Read:** Multi-file reading with line numbers
- **Write:** File creation/overwriting
- **Edit:** Find-and-replace editing
- **Grep:** Content search with regex
- **Glob:** File pattern matching
- **LineEdit:** Line-based edits
- **Ls:** Directory listing
- **Agent:** Delegate to specialized agents
- **Sessions:** Session management
- **Todo:** Task tracking

**Tool execution flow:**
```
LLM returns tool_calls
    ↓
ToolManager validates tool exists
    ↓
ToolValidator validates arguments
    ↓
Permission check (if requiresConfirmation)
    ↓
BaseTool.execute()
    ├─ Emit TOOL_CALL_START
    ├─ executeImpl() (tool-specific logic)
    ├─ Emit TOOL_OUTPUT_CHUNK (if streaming)
    └─ Emit TOOL_CALL_END or ERROR
```

**Event emission:** All tools emit lifecycle events that UI components subscribe to

### Plugin System

**Location:** `src/plugins/`

**Purpose:** Extend functionality through custom tools without modifying core

**Components:**
- **PluginLoader:** Discovery, validation, dependency installation
- **PluginActivationManager:** Controls which plugins are active per session
- **PluginEnvironmentManager:** Creates isolated Python venvs
- **ExecutableToolWrapper:** Wraps executable plugins (stdio JSON)
- **BackgroundToolWrapper:** Wraps RPC daemon plugins (Unix sockets)
- **BackgroundProcessManager:** Daemon lifecycle and health monitoring
- **SocketClient:** JSON-RPC communication
- **EventSubscriptionManager:** Routes activity events to plugins

**Plugin types:**

1. **Executable:** Spawn process per call
   - Command runs with args
   - Reads JSON from stdin
   - Writes JSON to stdout
   - Simple, stateless

2. **Background RPC:** Long-running daemon
   - Starts once, serves multiple requests
   - JSON-RPC over Unix socket
   - Can subscribe to activity events
   - Stateful, persistent

**Activation modes:**
- **always:** Auto-activated every session
- **tagged:** Activate with `+plugin-name` in message

**Dependency management:**
- Automatic Python venv creation
- Installs from requirements.txt
- Isolated per plugin in `~/.ally/plugin-envs/`
- Cached across restarts

### LLM Integration

**Location:** `src/llm/`

**Components:**
- **ModelClient:** Abstract interface for LLM providers
- **OllamaClient:** Ollama-specific implementation
- **MessageHistory:** Conversation state tracking
- **FunctionCalling:** Tool schema ↔ OpenAI function format conversion

**OllamaClient features:**
- Streaming and non-streaming requests
- Function calling support (both modern and legacy formats)
- Automatic tool call validation and repair
- Retry logic with exponential backoff
- Cancellation support

**Message format:**
```typescript
{
  role: 'system' | 'user' | 'assistant' | 'tool',
  content: string,
  tool_calls?: ToolCall[],
  tool_call_id?: string
}
```

### Service Layer

**Location:** `src/services/`

**Pattern:** Dependency injection via ServiceRegistry

**Core services:**
- **ServiceRegistry:** DI container, singleton pattern
- **ConfigManager:** Config persistence to `~/.ally/config.json`
- **SessionManager:** Session auto-save/restore
- **TodoManager:** Task tracking
- **PatchManager:** Undo system (file diffs)
- **FocusManager:** Directory restriction enforcement
- **PathResolver:** Focus-aware path resolution
- **CompletionProvider:** Tab completion engine
- **AgentPoolService:** Agent instance pooling
- **AgentManager:** Custom agent definitions
- **ProjectContextDetector:** Detects project type

**Lifecycle:**
- Services implement IService interface (initialize/cleanup)
- Singleton, transient, and scoped lifecycles
- Automatic dependency resolution
- Lazy initialization

## Data Flow Examples

### User submits message

```
1. InputPrompt captures input
2. Agent.sendMessage(userMessage)
3. Check for plugin tags (+plugin-name)
4. PluginActivationManager.parseAndActivateTags()
5. Agent.getLLMResponse()
   - Passes active plugin tools to LLM
6. LLM returns tool_calls
7. Agent.processToolResponse()
8. ToolOrchestrator.executeToolCalls()
   - Concurrent if all are read-only
   - Sequential if any are writes
9. Tools emit events (TOOL_CALL_START → END)
10. UI updates via useActivityEvent hooks
11. SessionManager.autoSave()
12. Agent gets follow-up LLM response
13. Repeat from step 6 if more tool calls
14. Display final response
```

### User presses Escape

```
1. InputPrompt detects Escape key
2. Agent.interrupt()
3. InterruptionManager.interrupt('cancel')
4. ModelClient.cancel() (aborts HTTP request)
5. ActivityStream.emit(INTERRUPT_ALL)
6. All nested agents receive event
7. Nested agents set interrupted flag
8. Tools check abort signal
9. Agent.processLLMResponse() checks isInterrupted()
10. Returns early with "Interrupted" message
```

### Plugin activation

```
1. User types "+plugin-name hello"
2. Agent.sendMessage() parses tags
3. PluginActivationManager.activate('plugin-name')
4. Session.active_plugins updated
5. SessionManager.autoSave()
6. System message: "Activated plugins: plugin-name"
7. Agent.getLLMResponse()
8. ToolManager.getFunctionDefinitions()
   - Filters by active plugins
9. LLM sees only active plugin tools
```

## Architectural Patterns

### Dependency Injection

ServiceRegistry provides centralized DI:
```typescript
registry.registerSingleton('config', ConfigManager);
registry.registerSingleton('llm_client', OllamaClient,
  undefined,
  { config: 'config' }
);
const client = registry.get<OllamaClient>('llm_client');
```

### Event-Driven Communication

ActivityStream decouples components:
- Tools emit events when executing
- UI subscribes to render updates
- Agent subscribes to coordinate nested agents
- Plugins subscribe to observe activity

### Command Pattern

Slash commands handled uniformly:
```typescript
class CommandHandler {
  async execute(command: string, args: string[]): Promise<void>
}
```

### Observer Pattern

UI components observe state changes:
- useActivityEvent for event subscriptions
- useAppContext for global state
- Automatic cleanup on unmount

### Strategy Pattern

Multiple tool types with unified interface:
- ExecutableToolWrapper
- BackgroundToolWrapper
- Both implement same execute() method

### Pool Pattern

AgentPoolService reuses agent instances:
- LRU eviction when pool is full
- Reduces initialization overhead
- Isolated contexts via scoped registries

## Configuration Locations

- **Config:** `~/.ally/config.json`
- **Sessions:** `~/.ally/sessions/`
- **Plugins:** `~/.ally/plugins/`
- **Plugin environments:** `~/.ally/plugin-envs/`
- **Custom agents:** `~/.ally/agents/`
- **Patches (undo):** `~/.ally/patches/`

## Key Design Decisions

### TypeScript strict mode

Full type safety throughout reduces runtime errors.

### ES modules

Modern JavaScript modules with explicit `.js` extensions in imports.

### Event-driven architecture

ActivityStream enables:
- Decoupled UI and business logic
- Real-time updates
- Concurrent tool visualization
- Plugin extensibility

### React for terminal UI

Ink provides:
- Familiar React patterns
- Component composition
- State management via hooks
- Declarative UI

### Plugin isolation

Each plugin gets:
- Separate virtual environment
- Independent process space
- Controlled communication (stdio/socket)
- Session-scoped activation

### Automatic context management

Agent handles:
- Token counting
- Auto-compaction at 80% threshold
- LLM-generated summaries
- Seamless continuation

## Performance Considerations

### Concurrent tool execution

Tools execute in parallel when safe:
- All read-only → concurrent
- Any writes → sequential
- Controlled via ToolOrchestrator

### Agent pooling

AgentPoolService caches:
- Reuses agents for same configuration
- LRU eviction policy
- Reduces initialization time

### Lazy loading

Services and tools:
- Initialized on first use
- Not all loaded at startup
- Reduces memory footprint

### Streaming output

Long-running tools:
- Emit TOOL_OUTPUT_CHUNK events
- UI displays incrementally
- Better perceived performance

## Security

### Permission system

File operations require confirmation:
- write, edit, line-edit → permission prompt
- User can allow once or always for session
- Extremely dangerous commands always prompt

### Focus mode

Restrict operations to directory:
```bash
ally --focus /path/to/project
```
- All file operations validated
- Path traversal blocked
- Protects system files

### Plugin sandboxing

Plugins run in isolation:
- Separate processes
- Virtual environments
- Limited communication channels

### Undo system

PatchManager tracks file changes:
- Stores diffs for all modifications
- `/undo` command reverts changes
- Works across restarts

## Testing

Test organization:
- **Unit tests:** `src/**/__tests__/`
- **Integration tests:** Vitest with real services
- **Test framework:** Vitest (NOT Jest)
- **Coverage:** Focus on service layer and tools

Run tests:
```bash
npm test                    # All tests
npm test -- src/services/   # Specific directory
npm run type-check          # TypeScript validation
```

## Further Reading

- [Plugin System Architecture](./plugin-system.md)
- [Plugin Development Guide](../guides/plugin-development.md)
- [Configuration Reference](../reference/configuration.md)
- Source READMEs: `src/agent/`, `src/tools/`, `src/services/`, `src/ui/`
