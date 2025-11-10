# Ally Plugin Hooks - Quick Reference Guide

## At-a-Glance Summary

Ally's inference pipeline has **39 distinct insertion points** where plugins can hook into the system:

- **23 Hook Points** for synchronous intervention (pre/post operations)
- **12 Event Subscription Points** for asynchronous monitoring
- **4 Prompt Assembly Points** for dynamic instruction injection

---

## 🎯 Most Important Hooks for Plugins

### Tier 1: High Impact, Safe to Use

| Hook | Purpose | Location | Use Case |
|------|---------|----------|----------|
| **Hook 4** | Pre-system prompt generation | `systemMessages.ts:342` | Inject project rules, custom directives |
| **Hook 8** | Pre-LLM send | `Agent.ts:717` | Request validation, compliance checks |
| **Hook 23** | Pre-tool execution | `Agent.ts:1080` | Tool validation, pre-execution filtering |
| **Hook 36** | Event subscription | `EventSubscriptionManager.ts` | Background monitoring (12 event types) |

### Tier 2: Specific Use Cases

| Hook | Purpose | Location | Use Case |
|------|---------|----------|----------|
| **Hook 32** | Pre-idle message generation | `IdleMessageGenerator.ts:173` | Context-aware suggestions |
| **Hook 10** | Post-LLM response | `Agent.ts:721` | Response analysis, validation |
| **Hook 24** | Post-tool execution | `Agent.ts:1080` | Analyze tool results, performance |
| **Hook 37** | Pre-context info fetch | `systemMessages.ts:344` | Add custom context providers |

---

## 📊 Hook Categories

### Input Phase (Hooks 1-9)
User message → System prompt → LLM request

**Key Hooks:**
- Hook 1: Pre-user message add
- Hook 4: Pre-system prompt generation
- Hook 7: Pre-function definitions fetch
- Hook 8: Pre-LLM send

**Best For:** Message filtering, prompt customization, tool modification

---

### Output Phase (Hooks 10-18)
LLM response → Validation → Analysis

**Key Hooks:**
- Hook 10: Post-LLM response received
- Hook 12-13: Tool call validation
- Hook 17: Post-tool call extraction
- Hook 18: Post-empty response detection

**Best For:** Response validation, error tracking, pattern analysis

---

### Execution Phase (Hooks 19-24)
Tool preparation → Execution → Result handling

**Key Hooks:**
- Hook 21-22: Cycle detection
- Hook 23-24: Tool execution monitoring
- Hook 19-20: Batch call handling

**Best For:** Tool execution analysis, cycle detection, performance metrics

---

### Response Phase (Hooks 25-31)
Message finalization → Persistence → Completion

**Key Hooks:**
- Hook 25-26: Required tools checking
- Hook 29-30: Session persistence
- Hook 31: Agent end event

**Best For:** Task completion tracking, session management

---

### Background Phase (Hooks 32-35)
Idle message generation (non-blocking)

**Key Hooks:**
- Hook 32: Pre-idle message generation
- Hook 34: Pre-queue update
- Hook 35: Post-queue update (callback)

**Best For:** Contextual suggestions, message filtering

---

### Prompt Assembly Phase (Hooks 37-39)
Dynamic system prompt components

**Key Hooks:**
- Hook 37: Pre-context info fetch
- Hook 38: Pre-todo context fetch
- Hook 39: Pre-tool guidance fetch

**Best For:** Adding project-specific context, tool descriptions

---

### Event Subscription Phase (Hook 36)
Asynchronous event monitoring

**Available Events:**
- `TOOL_CALL_START` / `TOOL_CALL_END`
- `AGENT_START` / `AGENT_END`
- `PERMISSION_REQUEST` / `PERMISSION_RESPONSE`
- `COMPACTION_START` / `COMPACTION_COMPLETE`
- `CONTEXT_USAGE_UPDATE`
- `TODO_UPDATE`
- `THOUGHT_COMPLETE`
- `DIFF_PREVIEW`

**Best For:** Background monitoring, analytics, UI sync

---

## 🔑 Critical Files for Hook Implementation

```
src/agent/Agent.ts (Primary)
├── Line 366-513: sendMessage() - Entry point
├── Line 663-691: System prompt assembly
├── Line 760-991: Response processing
├── Line 1000-1152: Tool processing
└── Line 1192-1350: Text response handling

src/prompts/systemMessages.ts (Prompt Generation)
├── Line 342-409: getMainSystemPrompt()
├── Line 414-449: getAgentSystemPrompt()
└── Line 240-337: getContextInfo()

src/llm/OllamaClient.ts (LLM Communication)
├── Line 174-271: send() request
├── Line 378-540: Streaming response
└── Line 545-567: Non-streaming response

src/services/IdleMessageGenerator.ts (Background)
├── Line 168-389: generateMessageBatch()
└── Line 293-389: buildBatchMessagePrompt()

src/services/ActivityStream.ts (Events)
├── Line 32-98: emit() and event routing
└── Line 81-98: mapToPluginEventType()

src/plugins/EventSubscriptionManager.ts (Plugin Interface)
├── Line 67-80: APPROVED_EVENTS
└── Line 100+: dispatch() to plugins
```

---

## 🛡️ Safety Guidelines

### Safe Operations (No Risk of Breaking Anything)

1. **Reading data** (Hook 10, 17, 24, 36)
2. **Logging/monitoring** (Any Hook after operation completes)
3. **Adding content** (Hook 4, 37-39 - add new sections)
4. **Event subscription** (Hook 36 - read-only observation)

### Caution Required (Validate Thoroughly)

1. **Modifying messages** (Hook 1, 2, 6)
   - Ensure role field remains unchanged
   - Validate message structure
   - Test with various message types

2. **Modifying tool definitions** (Hook 7)
   - Don't break function schema
   - Keep required parameters
   - Validate against LLM expectations

3. **Filtering content** (Hook 34)
   - Don't remove critical data
   - Preserve queue integrity
   - Test with edge cases

### Avoid These (High Risk)

1. **Removing reminders** (Hook 2)
2. **Breaking prompt structure** (Hook 4, 5, 6)
3. **Suppressing events** (Hook 36)
4. **Modifying tool results** (Hook 24)

---

## 📋 Plugin Development Checklist

- [ ] Identify which hook(s) your plugin needs
- [ ] Understand what data is available at that hook
- [ ] Verify what modifications are safe
- [ ] Add proper error handling
- [ ] Test with various inputs
- [ ] Document your hook usage
- [ ] Consider performance impact
- [ ] Handle cancellation/cleanup gracefully

---

## 💡 Plugin Pattern Examples

### Pattern 1: Context-Aware Suggestions (Hook 32)
```
Detect: IdleMessageGenerator triggers
Action: Inject task-specific messages based on todo context
Result: Users see relevant suggestions while idle
```

### Pattern 2: Request Validation (Hook 8)
```
Detect: Before LLM send
Action: Validate message array, function definitions
Result: Catch errors early, prevent API failures
```

### Pattern 3: Tool Execution Monitoring (Hook 23-24)
```
Detect: Tool execution pre/post
Action: Track metrics, log performance, detect anomalies
Result: Analytics on tool usage and performance
```

### Pattern 4: Response Analysis (Hook 10)
```
Detect: LLM response received
Action: Analyze content, extract patterns, validate
Result: Monitor response quality, detect issues
```

### Pattern 5: System Prompt Enhancement (Hook 4)
```
Detect: Before system prompt generation
Action: Add project-specific rules, context, directives
Result: Ally behaves according to project guidelines
```

### Pattern 6: Session Persistence (Hook 29)
```
Detect: Before session save
Action: Validate/filter data before persistence
Result: Selective data retention, cleanup
```

### Pattern 7: Background Monitoring (Hook 36)
```
Detect: All major events (async)
Action: Subscribe to events, trigger side effects
Result: Background processes, analytics, UI sync
```

---

## 🔄 Hook Execution Order

```
1. User Message Entry (Hooks 1-3)
2. System Prompt Generation (Hooks 4-6, 37-39)
3. Function Definitions (Hook 7)
4. LLM Execution (Hooks 8-9)
5. Response Reception (Hooks 10-11)
6. Tool Call Validation (Hooks 12-13)
7. Response Processing (Hooks 14-18)
8. Tool Batch Handling (Hooks 19-20)
9. Cycle Detection (Hooks 21-22)
10. Tool Execution (Hooks 23-24)
11. Text Response (Hooks 25-28)
12. Session Save (Hooks 29-30)
13. Completion (Hook 31)

Parallel/Background:
- Idle Message Generation (Hooks 32-35)
- Event Subscription (Hook 36)
```

---

## 🚀 Quick Start for Plugin Developers

### Step 1: Choose Your Hook Type

```
Do you need to...
- Modify input before LLM? → Use Hook 1, 4, 7, 8
- Analyze output after LLM? → Use Hook 10, 13, 17
- Monitor tool execution? → Use Hook 23-24, 36
- Run in background? → Use Hook 32-35, 36
- Inject context? → Use Hook 2, 4, 37-39
```

### Step 2: Understand Data Available

```
At your chosen hook:
- What objects are in scope?
- What fields can you safely modify?
- What side effects are acceptable?
- When will this hook be called?
```

### Step 3: Implement with Safety

```
- Add error handling
- Validate modifications
- Test with edge cases
- Document your hooks
- Consider performance
```

### Step 4: Register/Subscribe

```
For synchronous hooks:
  (API to be developed - framework not yet in place)

For event subscription (Hook 36):
  eventManager.subscribe('my-plugin', {
    events: ['TOOL_CALL_START', 'AGENT_END'],
    socketPath: '/tmp/my-plugin.sock'
  });
```

---

## 📞 When to Use Each Hook

| Goal | Best Hook(s) |
|------|-------------|
| Add project rules to prompt | Hook 4 or 37 |
| Validate tool calls | Hook 7 or 23 |
| Filter/clean messages | Hook 1 or 2 |
| Monitor tool results | Hook 24 or 36 |
| Track response quality | Hook 10 |
| Inject task context | Hook 2 or 38 |
| Analyze patterns | Hook 17 or 36 |
| Save custom data | Hook 29 |
| Generate suggestions | Hook 32 or 34 |
| Background monitoring | Hook 36 |

---

## 📖 Full Documentation

For complete details on all 39 hooks, see: `INFERENCE_PIPELINE_MAP.md`

Key sections:
- Section 6: Complete hook reference table
- Section 7: Data flow diagram
- Section 8: Implementation guidelines
- Section 9: File location reference
- Section 10: Key insights for developers
