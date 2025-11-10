# Plugin → Ally Communication Architecture Report

## Executive Summary

Ally has a **one-way communication model** where plugins can *receive* events from Ally but cannot actively send messages or requests back into the conversation. This is a deliberate design choice for security and simplicity, but it creates significant limitations for plugins that want to actively participate in conversations.

---

## 1. WHAT EXISTS: Current Plugin → Ally Communication

### 1.1 Event Emission (Ally → Plugins)

**Direction**: Unidirectional (Ally broadcasts to plugins)

Plugins can **subscribe to and receive** read-only events from Ally:

**Implementation**: `EventSubscriptionManager.ts`
- Location: `/src/plugins/EventSubscriptionManager.ts`
- Mechanism: JSON-RPC 2.0 notifications sent over Unix domain sockets
- Approved Events (12 types):
  - Tool execution: `TOOL_CALL_START`, `TOOL_CALL_END`
  - Agent lifecycle: `AGENT_START`, `AGENT_END`
  - Permissions: `PERMISSION_REQUEST`, `PERMISSION_RESPONSE`
  - Context: `COMPACTION_START`, `COMPACTION_COMPLETE`, `CONTEXT_USAGE_UPDATE`
  - Metadata: `TODO_UPDATE`, `THOUGHT_COMPLETE`, `DIFF_PREVIEW`

**Integration Path**: ActivityStream → EventSubscriptionManager

```typescript
// ActivityStream.emit() → EventSubscriptionManager.dispatch()
emit(event: ActivityEvent) {
  // Notify UI listeners
  typeListeners.forEach(callback => callback(event));
  
  // Forward to plugins via EventSubscriptionManager
  manager.dispatch(pluginEventType, event.data);
}
```

**Delivery Model**:
- Fire-and-forget (non-blocking, best-effort)
- Async/await with `Promise.allSettled()`
- No response expected (notifications, not requests)
- Failures logged but don't interrupt Ally
- Auto-unsubscribe if daemon not running

**Example**: conversation-monitor plugin at `/examples/plugins/conversation-monitor/`
```python
def process_message(self, message: Dict[str, Any]) -> None:
    if message.get('method') == 'on_event':
        event_type = message['params']['event_type']
        event_data = message['params']['event_data']
        self.monitor.handle_event(event_type, event_data)
```

### 1.2 Background RPC Tool Execution (Plugins → Ally)

**Direction**: Bidirectional (Ally calls plugin methods)

Plugins can provide **RPC tools** that Ally calls:

**Implementation**: BackgroundToolWrapper + SocketClient
- Location: `/src/plugins/BackgroundToolWrapper.ts` + `/src/plugins/SocketClient.ts`
- Mechanism: JSON-RPC 2.0 requests over Unix domain sockets
- Agent calls tools → BackgroundToolWrapper executes RPC → SocketClient sends request → Plugin processes → Response

**Tool Definition** (from plugin.json):
```json
{
  "tools": [
    {
      "name": "get-conversation-stats",
      "type": "background_rpc",
      "method": "get_stats",
      "requiresConfirmation": false,
      "schema": { "type": "object", "properties": {}, "required": [] }
    }
  ]
}
```

**Communication Flow**:
1. Agent calls tool via `toolOrchestrator.executeToolCalls()`
2. BackgroundToolWrapper.execute() is invoked
3. SocketClient.sendRequest() sends JSON-RPC request
4. Plugin receives request at its JSON-RPC server
5. Plugin executes method and returns result
6. SocketClient parses response
7. Result added to conversation as tool result message

**Timeout**: Default 30 seconds per request

**Example**: conversation-monitor's get_stats method
```python
# Plugin RPC handler
if method == 'get_stats':
    result = self.monitor.get_stats()
    return {
        'jsonrpc': '2.0',
        'result': result,
        'id': message_id
    }
```

### 1.3 Plugin Configuration (Ally ↔ Plugins)

**Direction**: Bidirectional (Configuration request/response)

Plugins can have interactive configuration:
- `PLUGIN_CONFIG_REQUEST` event
- `PLUGIN_CONFIG_COMPLETE` event response
- Handled by PluginCommand

**Limitation**: Configuration is for plugin setup, not for message/event emission.

---

## 2. WHAT'S MISSING: Critical Gaps for Plugin Message Emission

### 2.1 No Plugin → Agent Message API

**Gap**: Plugins cannot create messages in the conversation.

Current State:
- `Agent.addMessage()` exists but is **private**
- No public API for plugins to inject messages
- No mechanism to trigger agent responses
- Messages are only created by:
  - User input
  - LLM responses
  - Tool results

What's Needed:
```typescript
// This does NOT exist
public addMessageFromPlugin(message: Message): void
public getAgent(): Agent  // To access addMessage()
```

### 2.2 No Plugin Event Emission

**Gap**: Plugins cannot emit activity events that appear in the UI.

Current State:
- Only Ally can emit events
- Plugins receive events (read-only)
- EventSubscriptionManager is unidirectional
- ActivityStream does not accept plugin events

What's Needed:
```typescript
// This does NOT exist
eventManager.emitFromPlugin(pluginName: string, event: ActivityEvent)
// Or
agent.emitEvent(event: ActivityEvent, pluginName?: string)
```

### 2.3 No Plugin → Ally Request Channel

**Gap**: Plugins cannot request actions from Ally (only provide RPC tools).

Current State:
- SocketClient only sends notifications to plugins
- SocketClient only receives requests FROM plugins (as tools)
- No reverse request/response mechanism
- No plugin introspection API

What's Needed:
```typescript
// This does NOT exist
// Plugins would need to be able to call back to Ally
const response = await allyClient.sendRequest('add_message', {
  role: 'assistant',
  content: 'Message from plugin'
});
```

### 2.4 No Plugin Context/State Access

**Gap**: Plugins cannot read conversation state or agent context.

Current State:
- Plugins receive events (read-only snapshots of data)
- No access to:
  - Conversation history
  - Current agent state
  - Token usage
  - Todo list
  - File system context

What's Needed:
```typescript
// This does NOT exist
interface AllyContext {
  getMessages(): Message[]
  getTodos(): Todo[]
  getTokenUsage(): TokenUsage
  getCurrentFocus(): string
}
```

### 2.5 No Plugin Task/Action Registration

**Gap**: Plugins cannot register custom actions or async tasks.

Current State:
- Plugins provide tools (Ally-initiated)
- No way for plugins to initiate background work
- No task queue or action scheduler
- No async work that doesn't fit the tool execution model

What's Needed:
```typescript
// This does NOT exist
interface PluginAction {
  name: string
  description: string
  execute(): Promise<void>
}

plugin.registerAction(action: PluginAction)
```

---

## 3. ARCHITECTURE ANALYSIS

### 3.1 Current Communication Patterns

```
┌─────────────────────────────────────────────────────────────┐
│                        ALLY APPLICATION                     │
├─────────────────────────────────────────────────────────────┤
│  Agent ─→ LLM ─→ Tool Calls ─→ ToolOrchestrator            │
│             ↓                            ↓                   │
│         ActivityStream ──→ EventSubscriptionManager          │
│             ↑                            │                   │
│          UI/React                        │                   │
│                                          ↓                   │
│                           ┌──────────────────────────────┐   │
│                           │  Plugin Daemon Process       │   │
│                           │  (Background RPC Server)     │   │
│                           │                              │   │
│                           │  • Listens for events        │   │
│                           │  • Responds to RPC requests  │   │
│                           │    (from ToolOrchestrator)   │   │
│                           └──────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**Key Characteristics**:
1. Event flow is one-way: Ally → Plugins
2. Tool execution is request/response: Ally ↔ Plugin
3. No plugin → conversation pathway
4. All messages originate from LLM or user
5. Plugins are passive observers + RPC service providers

### 3.2 Design Principles (Inferred from Code)

1. **Stateless Event Notifications**: Fire-and-forget, non-blocking
2. **Tool-based Extension**: Plugins extend functionality via tools, not by modifying conversation
3. **Security**: Read-only events, no direct conversation access
4. **Isolation**: Plugins are separate processes, limited communication
5. **Simplicity**: One communication pattern (JSON-RPC) for tools and events

### 3.3 Key Classes and Responsibilities

| Class | Location | Role | Direction |
|-------|----------|------|-----------|
| `EventSubscriptionManager` | `/src/plugins/` | Routes events to plugins | Ally → Plugin |
| `ActivityStream` | `/src/services/` | Emits events to UI + plugins | Ally → Plugin |
| `BackgroundToolWrapper` | `/src/plugins/` | Executes plugin RPC tools | Ally ↔ Plugin |
| `SocketClient` | `/src/plugins/` | JSON-RPC communication | Bidirectional |
| `BackgroundProcessManager` | `/src/plugins/` | Manages daemon lifecycle | Ally → Plugin |
| `Agent` | `/src/agent/` | Message management | Local only |

---

## 4. DESIGN PROPOSAL: Plugin Message Emission

### 4.1 High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    ALLY APPLICATION                          │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  Agent ←────────────────┐                                    │
│    │                    │                                    │
│    ↓                    │                                    │
│  LLM Response           │  Plugin → Agent Channel            │
│    │                    │  (NEW)                             │
│    ↓                    │                                    │
│  Messages[]             │                                    │
│    ↑                    │                                    │
│    └────────────────────┴───────────────────────┐           │
│                                                 │           │
│                                    ┌────────────↓───────┐   │
│                                    │ PluginMessageBus   │   │
│                                    │ (NEW)              │   │
│                                    │                    │   │
│                                    │ • acceptFromPlugin │   │
│                                    │ • emitFromPlugin   │   │
│                                    │ • getPluginState   │   │
│                                    └────────────┬───────┘   │
│                                                 ↑           │
│        ActivityStream ───→ EventSubscriptionManager          │
│             ↓                       │                        │
│          UI/React                   │                        │
│                                     ↓                        │
│                         ┌───────────────────────────────┐    │
│                         │  Plugin Daemon Process        │    │
│                         │  (Background RPC Server)      │    │
│                         │                               │    │
│                         │  • Listen for events (Ally→)  │    │
│                         │  • Send RPC requests (←Ally)  │    │
│                         │  • Emit events (→Ally) [NEW]  │    │
│                         │  • Call agent methods [NEW]   │    │
│                         └───────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 Core Components

#### 4.2.1 PluginMessageBus (New)

**Purpose**: Single source of truth for plugin → Agent communication

```typescript
// File: src/plugins/PluginMessageBus.ts

export interface PluginMessage {
  pluginName: string;
  type: 'conversation' | 'system' | 'event';
  content: any;
  timestamp: number;
}

export class PluginMessageBus {
  private agent: Agent;
  private activityStream: ActivityStream;
  private listeners: Map<string, Set<Function>> = new Map();

  constructor(agent: Agent, activityStream: ActivityStream) {
    this.agent = agent;
    this.activityStream = activityStream;
  }

  /**
   * Accept a message from a plugin for the conversation
   */
  async acceptMessage(
    pluginName: string, 
    message: {
      role: 'user' | 'assistant' | 'system';
      content: string;
    }
  ): Promise<void> {
    const fullMessage: Message = {
      role: message.role,
      content: message.content,
      timestamp: Date.now(),
      metadata: {
        sourcePlugin: pluginName,
        isPluginGenerated: true,
      },
    };

    // Add to conversation history
    this.agent.addMessage(fullMessage);

    // Emit event for UI
    this.activityStream.emit({
      id: crypto.randomUUID(),
      type: ActivityEventType.PLUGIN_MESSAGE_RECEIVED,
      timestamp: Date.now(),
      data: {
        pluginName,
        message: fullMessage,
      },
    });

    // If this is a user message, consider triggering agent response
    if (message.role === 'user') {
      this.agent.interrupt('interjection');
    }
  }

  /**
   * Emit an activity event from a plugin
   */
  emitEvent(
    pluginName: string,
    event: Omit<ActivityEvent, 'id' | 'timestamp'>
  ): void {
    this.activityStream.emit({
      ...event,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      metadata: { ...event.data, sourcePlugin: pluginName },
    });
  }

  /**
   * Get current agent/conversation context (read-only)
   */
  getContext(pluginName: string): AgentContext {
    return {
      messages: this.agent.getMessages(),
      focus: getFocusManager().getFocusDirectory(),
      tokenUsage: this.agent.getTokenManager().getContextUsagePercentage(),
      isProcessing: this.agent.isProcessing(),
      readOnly: true,
    };
  }
}
```

#### 4.2.2 New ActivityEventType

```typescript
// In src/types/index.ts

export enum ActivityEventType {
  // ... existing types ...
  PLUGIN_MESSAGE_RECEIVED = 'plugin_message_received',
  PLUGIN_EVENT_EMITTED = 'plugin_event_emitted',
  PLUGIN_ACTION_REQUESTED = 'plugin_action_requested',
}
```

#### 4.2.3 Enhanced EventSubscriptionManager

```typescript
// In EventSubscriptionManager.ts

export class EventSubscriptionManager {
  private messageBus?: PluginMessageBus;

  setMessageBus(bus: PluginMessageBus): void {
    this.messageBus = bus;
  }

  /**
   * Allow plugins to call back to Ally (reverse communication)
   */
  async handlePluginRequest(
    pluginName: string,
    method: string,
    params: any
  ): Promise<any> {
    if (!this.messageBus) {
      throw new Error('PluginMessageBus not initialized');
    }

    switch (method) {
      case 'add_message':
        await this.messageBus.acceptMessage(pluginName, params);
        return { success: true };

      case 'emit_event':
        this.messageBus.emitEvent(pluginName, params);
        return { success: true };

      case 'get_context':
        return this.messageBus.getContext(pluginName);

      default:
        throw new Error(`Unknown plugin method: ${method}`);
    }
  }
}
```

#### 4.2.4 New RPC Methods for Plugins

```typescript
// Plugins would call these via reverse JSON-RPC requests

/**
 * Add a message to the conversation
 */
{
  "jsonrpc": "2.0",
  "method": "add_message",
  "params": {
    "role": "assistant",
    "content": "Analysis complete: ..."
  },
  "id": 1
}

/**
 * Emit an activity event
 */
{
  "jsonrpc": "2.0",
  "method": "emit_event",
  "params": {
    "type": "plugin_analysis_complete",
    "data": {
      "toolName": "analysis-tool",
      "findings": [...]
    }
  },
  "id": 2
}

/**
 * Get current conversation context
 */
{
  "jsonrpc": "2.0",
  "method": "get_context",
  "params": {},
  "id": 3
}
```

### 4.3 Implementation Steps

**Phase 1: Core Infrastructure**
1. Create PluginMessageBus class
2. Add new ActivityEventTypes
3. Expose Agent.addMessage() publicly or create agent accessor
4. Create PluginContextAccessor for read-only context

**Phase 2: Reverse Communication**
1. Enhance SocketClient to support bidirectional requests
2. Update EventSubscriptionManager.handlePluginRequest()
3. Create reverse RPC server that listens to plugin requests
4. Add per-plugin request handlers with validation

**Phase 3: Example Plugin**
1. Create enhanced conversation-monitor that emits messages
2. Demonstrate message injection
3. Show event emission from plugin
4. Document the new APIs

**Phase 4: Security & Polish**
1. Add permission checks (plugins can only affect their own context)
2. Rate limiting for message injection
3. Validation of message content
4. Error handling and logging

### 4.4 Security Considerations

**Key Constraints**:
- Plugins should only emit events tagged with their plugin name
- Message injection should be rate-limited
- No direct LLM manipulation
- Context access should be read-only (with explicit mutation APIs)
- Plugins should not be able to read private/sensitive data

**Trust Model**:
```typescript
interface PluginPermission {
  canAddMessages: boolean;
  canEmitEvents: boolean;
  canAccessContext: boolean;
  canTriggerAgentActions: boolean;
  rateLimit: {
    messagesPerMinute: number;
    eventsPerMinute: number;
  }
}
```

---

## 5. ALTERNATIVE DESIGNS CONSIDERED

### 5.1 Webhook-based (Rejected)
- Pros: Stateless, event-driven
- Cons: Requires Ally to open listening port, security complexity

### 5.2 Message Queue (Rejected)
- Pros: Decoupled, scalable
- Cons: Over-engineered, adds persistence layer

### 5.3 Shared Memory/State Store (Rejected)
- Pros: Fast, simple
- Cons: Complex synchronization, thread-safety issues

### 5.4 Proposed: Enhanced Socket RPC (Recommended)
- Pros:
  - Uses existing SocketClient infrastructure
  - Bidirectional (requests + notifications)
  - Supports request/response pattern for plugins
  - Maintains security isolation
  - Easy to rate-limit and validate
  - Extensible for future commands
- Cons:
  - Requires plugins to understand Ally's internal types
  - Documentation-heavy

---

## 6. DELIVERABLE CHECKLIST

- [x] Current plugin → Ally capabilities documented
- [x] Critical gaps identified
- [x] Architecture diagrams provided
- [x] New component designs specified
- [x] RPC method signatures detailed
- [x] Implementation roadmap created
- [x] Security considerations outlined

---

## 7. NEXT STEPS

1. **Decision**: Does Ally want plugins to emit messages/events?
2. **Design Review**: Validate proposed PluginMessageBus architecture
3. **Implementation**: Start with Phase 1 infrastructure
4. **Testing**: Create tests for reverse communication
5. **Documentation**: Update plugin developer guide with examples

---

## Files Analyzed

- `/src/plugins/EventSubscriptionManager.ts` - Event broadcasting
- `/src/services/ActivityStream.ts` - Event system
- `/src/agent/Agent.ts` - Message management (2100+ lines)
- `/src/plugins/BackgroundToolWrapper.ts` - Tool execution
- `/src/plugins/SocketClient.ts` - JSON-RPC communication
- `/src/plugins/BackgroundProcessManager.ts` - Process lifecycle
- `/examples/plugins/conversation-monitor/daemon.py` - Example plugin
- `/src/types/index.ts` - Type definitions

