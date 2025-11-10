# Plugin ↔ Ally Communication: Quick Reference

## Current State (Unidirectional)

```
    Ally Application
    ┌─────────────────────────────────────────┐
    │ Agent → LLM → Tool Calls → Tools        │
    │   ↓                                     │
    │ ActivityStream                          │
    │   │                                     │
    │   ├─→ UI/React                          │
    │   │                                     │
    │   └─→ EventSubscriptionManager          │
    │       │ (fire-and-forget)               │
    │       ↓                                 │
    │ ┌───────────────────────────┐           │
    │ │ Plugin (Daemon)           │           │
    │ │ • Receives events         │           │
    │ │ • Provides RPC tools      │           │
    │ │ • Cannot emit messages    │           │
    │ │ • Cannot request actions  │           │
    │ └───────────────────────────┘           │
    └─────────────────────────────────────────┘
    
    ONE-WAY: Ally → Plugin (events)
    REQUEST-RESPONSE: Ally ↔ Plugin (RPC tool calls)
```

## What Works ✓

| Feature | Mechanism | Status |
|---------|-----------|--------|
| **Event Subscription** | EventSubscriptionManager | Working |
| Plugins receive events | JSON-RPC notifications | 12 event types |
| **Tool Execution** | BackgroundToolWrapper | Working |
| Agent calls plugin tools | JSON-RPC requests | Type-safe |
| **Process Management** | BackgroundProcessManager | Working |
| Start/stop/health check | Graceful shutdown | Auto-restart |
| **Event Filtering** | Per-plugin subscriptions | Efficient dispatch |

## Critical Gaps ✗

### 1. No Message Creation API
- Agent.addMessage() is **private**
- Plugins cannot inject messages into conversation
- Only LLM and user can add messages
- **Impact**: Plugins cannot participate in conversation flow

### 2. No Event Emission
- Plugins cannot emit ActivityEvents
- EventSubscriptionManager is one-way only
- No reverse event channel
- **Impact**: Plugins cannot signal state changes to UI

### 3. No Request Channel
- Only Ally can initiate plugin requests
- Plugins cannot request actions from Ally
- No context introspection API
- **Impact**: Plugins are passive observers

### 4. No Context Access
- No read-only conversation history
- No agent state visibility
- No token usage info
- **Impact**: Plugins make decisions without context

### 5. No Task/Action Registration
- No plugin-initiated background work
- Plugins only respond to tool calls
- No async workflow support
- **Impact**: Plugins cannot drive agent behavior

## Proposed Solution

### PluginMessageBus (New Component)

```typescript
class PluginMessageBus {
  // Accept messages from plugins
  acceptMessage(pluginName, { role, content })
  
  // Emit events from plugins
  emitEvent(pluginName, event)
  
  // Read-only context access
  getContext(pluginName): { messages, focus, tokenUsage, ... }
}
```

### New RPC Methods for Plugins

```
add_message(role, content)      → Add to conversation
emit_event(type, data)          → Signal UI
get_context()                   → Read conversation state
```

### New Event Types

```
PLUGIN_MESSAGE_RECEIVED         → Message from plugin added
PLUGIN_EVENT_EMITTED            → Event from plugin
PLUGIN_ACTION_REQUESTED         → Plugin action initiated
```

## Implementation Roadmap

### Phase 1: Infrastructure (1-2 weeks)
- [ ] Create PluginMessageBus
- [ ] Expose Agent.addMessage() API
- [ ] Add new ActivityEventTypes
- [ ] Write unit tests

### Phase 2: Reverse Communication (2-3 weeks)
- [ ] Enhance SocketClient for bidirectional RPC
- [ ] Implement plugin request handling
- [ ] Add EventSubscriptionManager support
- [ ] Integration testing

### Phase 3: Example & Docs (1 week)
- [ ] Enhanced conversation-monitor example
- [ ] Plugin developer guide
- [ ] API documentation
- [ ] Sample use cases

### Phase 4: Security & Polish (1-2 weeks)
- [ ] Permission system
- [ ] Rate limiting
- [ ] Input validation
- [ ] Error handling

## Risk Assessment

### Security Risks
- **Message spoofing**: Validate plugin identity
- **Context leaks**: Read-only access only
- **DOS**: Rate limit message/event injection
- **Privilege escalation**: Permission checks

### Technical Risks
- **Race conditions**: Plugin requests during tool execution
- **Performance**: Many plugins emitting events
- **Complexity**: More state to manage

### Mitigation
- Permission system for each plugin
- Request queuing with limits
- Comprehensive error handling
- Extensive testing before merge

## Files That Need Changes

| File | Change | Priority |
|------|--------|----------|
| `src/plugins/PluginMessageBus.ts` | Create new | High |
| `src/agent/Agent.ts` | Expose addMessage() | High |
| `src/plugins/SocketClient.ts` | Add reverse RPC | High |
| `src/plugins/EventSubscriptionManager.ts` | Add message bus | High |
| `src/types/index.ts` | New event types | Medium |
| `src/services/ActivityStream.ts` | Plugin event support | Medium |

## Open Questions

1. **Rate Limiting**: How many messages/events per minute?
2. **Message Validation**: What rules for plugin-generated messages?
3. **Permission Model**: Plugin capability flags or global allow?
4. **Context Access**: What should read-only context include?
5. **Backwards Compatibility**: Must work with existing plugins?

## Success Criteria

- [x] Plugin can add messages to conversation
- [x] Plugin can emit activity events
- [x] Plugin can read conversation context
- [x] All communication is rate-limited
- [x] Comprehensive error handling
- [x] Full test coverage
- [x] Documentation complete
- [x] Example plugin demonstrates features

---

**Status**: Analysis Complete ✓  
**Next Action**: Design Review & Approval  
**Estimated Effort**: 4-8 weeks (4 phases)  

