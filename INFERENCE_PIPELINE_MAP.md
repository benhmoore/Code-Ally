# Ally Inference Pipeline Mapping

## Executive Summary

Ally's inference pipeline consists of two major flows:
1. **User Input → LLM Flow** (User message → Model request)
2. **LLM → User Response Flow** (Model response → Final output)

The system uses an **event-driven architecture** with an ActivityStream for hooking into the pipeline, and a plugin system that can subscribe to approved events. Below is a detailed map of where plugins can inject logic.

---

## 1. USER INPUT → LLM FLOW

### A. User Message Entry Point

**File:** `src/agent/Agent.ts:366-513`

```
User calls: agent.sendMessage(message: string)
    ↓
Line 390-395: Create user message object with role, content, timestamp
    ↓
Line 395: this.messages.push(userMessage)
    ↓
Line 412: this.autoSaveSession()  [AUTO-SAVE HOOK]
```

**Hook Point 1: PRE-USER-MESSAGE-ADD**
- **Location:** Before line 395 (`this.messages.push(userMessage)`)
- **Data Available:** User message content, timestamp, conversation history
- **Safe Modifications:** Message content (filter/transform), add metadata
- **Dangerous Modifications:** Replacing entire message, corrupting role field
- **Plugin Opportunity:** Message filtering, sentiment analysis, privacy redaction

---

### B. System Reminders Injection

**File:** `src/agent/Agent.ts:397-452`

The agent injects THREE system reminder messages before sending to LLM:

#### Reminder 1: Interruption Context (Line 397-408)
```typescript
if (this.interruptionManager.wasRequestInterrupted()) {
  // Injects: "<system-reminder>\nUser interrupted..."
  this.messages.push(systemReminder);
}
```

#### Reminder 2: Todo List Context (Line 414-451)
```typescript
if (!this.config.isSpecializedAgent) {
  // Builds reminder from TodoManager.getTodos()
  // Injects: "<system-reminder>\nCurrent todos:..."
  this.messages.push(systemReminder);
}
```

#### Reminder 3: Time Constraint (If maxDuration set)
- Added during tool execution phase
- Injected by ToolOrchestrator based on elapsed time

**Hook Point 2: PRE-SYSTEM-REMINDER-ADD**
- **Location:** Before line 404 or 449 (before `this.messages.push(systemReminder)`)
- **Data Available:** Reminder type, context (todos, interruption reason, elapsed time)
- **Safe Modifications:** Reminder content/formatting, metadata
- **Dangerous Modifications:** Removing critical reminders
- **Plugin Opportunity:** Custom context injection, task-aware suggestions

---

### C. Focus Setup (For Specialized Agents)

**File:** `src/agent/Agent.ts:207-213`

```
if (config.focusDirectory) {
  this.focusReady = setupFocus(focusDirectory)
}
```

**Hook Point 3: POST-FOCUS-SET**
- **Location:** After line 213 (focus setup completes)
- **Data Available:** Focus directory, success/failure status
- **Plugin Opportunity:** Monitor directory changes, provide context

---

### D. System Prompt Assembly

**File:** `src/agent/Agent.ts:663-691` (Regeneration before LLM call)
**File:** `src/prompts/systemMessages.ts:342-449` (Generation functions)

#### Main Agent System Prompt

```typescript
// Agent.ts:680-686
const { getMainSystemPrompt } = await import('../prompts/systemMessages.js');
updatedSystemPrompt = await getMainSystemPrompt(
  this.tokenManager,
  this.toolResultManager,
  false,
  this.config.config.reasoning_effort
);
this.messages[0].content = updatedSystemPrompt;
```

**getMainSystemPrompt Assembly (systemMessages.ts:342-409):**

```
1. CORE_DIRECTIVES (fixed)
   - ALLY_IDENTITY: "You are Ally, an AI pair programming..."
   - BEHAVIORAL_DIRECTIVES: Tool usage, error handling
   - AGENT_DELEGATION_GUIDELINES: When to use plan/explore/agent
   - GENERAL_GUIDELINES: Code conventions, file operations
   
2. ONCE_MODE_INSTRUCTIONS (if applicable)
   - "IMPORTANT - Single Response Mode..."
   
3. TOOL_GUIDANCE_CONTEXT (from ToolManager)
   - getToolUsageGuidance()
   - Tool descriptions and selection rules
   
4. CONTEXT_BUDGET_REMINDER (if context > 75%)
   - Warning about approaching limits
   - Suggestions to compact
   
5. CONTEXT_INFO (dynamic)
   - getContextInfo() with:
     • Current date/time
     • Working directory (git branch)
     • OS and Node version
     • Project context (languages, frameworks)
     • ALLY.md file contents (if exists)
     • Available agents list
     • Context usage percentage
     
6. TODO_CONTEXT (dynamic)
   - TodoManager.generateActiveContext()
   - Current todo list with status
```

**Hook Point 4: PRE-SYSTEM-PROMPT-GENERATION**
- **Location:** Before line 671 in Agent.ts or line 342 in systemMessages.ts
- **Data Available:** Token manager, tool manager, todos
- **Safe Modifications:** Adding extra guidance sections, metadata about tools
- **Dangerous Modifications:** Removing identity/directives, conflicting instructions
- **Plugin Opportunity:** Inject project-specific rules, dynamic tool guidance, context-aware behavior

**Hook Point 5: POST-SYSTEM-PROMPT-GENERATION**
- **Location:** After line 690 in Agent.ts (after `this.messages[0].content = updatedSystemPrompt`)
- **Data Available:** Complete system prompt, message array
- **Safe Modifications:** Validate prompt quality, log statistics
- **Plugin Opportunity:** Monitor prompt changes, validate instructions

**Hook Point 6: PRE-SYSTEM-PROMPT-ASSIGNMENT**
- **Location:** Line 690 - before assignment to messages[0]
- **Data Available:** Generated prompt text, context managers
- **Safe Modifications:** Transform prompt text, add sections
- **Dangerous Modifications:** Breaking prompt structure
- **Plugin Opportunity:** Dynamic prompt modification based on plugin state

---

### E. Function Definitions Assembly

**File:** `src/agent/Agent.ts:656-661`

```typescript
const allowTodoManagement = this.config.allowTodoManagement ?? !this.config.isSpecializedAgent;
const excludeTools = allowTodoManagement ? undefined : [...TOOL_NAMES.TODO_MANAGEMENT_TOOLS];
const functions = this.toolManager.getFunctionDefinitions(excludeTools);
```

**Hook Point 7: PRE-FUNCTION-DEFINITIONS-FETCH**
- **Location:** Before line 661
- **Data Available:** Tool manager, config, excluded tool names
- **Safe Modifications:** Filter/modify tool definitions, reorder
- **Dangerous Modifications:** Breaking function schema, removing required parameters
- **Plugin Opportunity:** Inject custom tools, modify tool descriptions dynamically

---

### F. LLM Request Preparation

**File:** `src/llm/OllamaClient.ts:174-221`

**Hook Point 8: PRE-LLM-SEND**
- **Location:** Before line 717 in Agent.ts (`const response = await this.modelClient.send(...)`)
- **Data Available:** Complete messages array, functions array, send options
- **Safe Modifications:** Message logging, statistics gathering
- **Dangerous Modifications:** Modifying message content, function definitions
- **Plugin Opportunity:** Request validation, compliance checking

---

### G. Thinking Indicator Emission

**File:** `src/agent/Agent.ts:707-713`

```typescript
this.emitEvent({
  id: this.generateId(),
  type: ActivityEventType.THOUGHT_CHUNK,
  timestamp: Date.now(),
  data: { text: 'Thinking...', thinking: true },
});
```

**Hook Point 9: POST-THINKING-INDICATOR-EMIT**
- **Location:** After line 713
- **Event:** `ActivityEventType.THOUGHT_CHUNK`
- **Plugin Opportunity:** UI update, progress tracking

---

## 2. LLM → USER RESPONSE FLOW

### A. LLM Response Reception

**File:** `src/llm/OllamaClient.ts:174-271` (Streaming & non-streaming)

#### Streaming Response Processing (Lines 378-540)
```
Response arrives in chunks
    ↓
For each chunk:
  - Parse JSON
  - Accumulate content/thinking
  - Emit ASSISTANT_CHUNK event (Line 434-439)
  - Emit THOUGHT_CHUNK event (Line 452-457)
  - Handle tool_calls
    ↓
After all chunks:
  - Return aggregated LLMResponse
```

#### Non-Streaming Response (Lines 545-567)
```
Response arrives complete
    ↓
Parse JSON
    ↓
Return LLMResponse with content + tool_calls
```

**Hook Point 10: POST-LLM-RESPONSE-RECEIVED**
- **Location:** After line 721 in Agent.ts (response received from modelClient.send)
- **Data Available:** LLMResponse object with content, tool_calls, thinking
- **Event:** (No built-in event yet) - Could be added
- **Plugin Opportunity:** Response validation, content analysis, thinking pattern monitoring

---

### B. System Reminder Cleanup

**File:** `src/agent/Agent.ts:723-731`

```typescript
// Remove system-reminder messages after receiving response
const originalLength = this.messages.length;
this.messages = this.messages.filter(msg =>
  !(msg.role === 'system' && msg.content.includes('<system-reminder>'))
);
```

**Hook Point 11: POST-REMINDER-CLEANUP**
- **Location:** After line 731
- **Data Available:** Cleaned message array, removed reminders
- **Plugin Opportunity:** Track what reminders were used, analyze effectiveness

---

### C. Tool Call Validation

**File:** `src/llm/OllamaClient.ts:193-216` (OllamaClient.send)

```typescript
if (result.tool_calls && result.tool_calls.length > 0) {
  const validationResult = this.normalizeToolCallsInMessage(result);
  
  if (!validationResult.valid) {
    // Return error response with malformed tool calls
    return {
      role: 'assistant',
      content: result.content || '',
      tool_calls: result.tool_calls,
      error: true,
      tool_call_validation_failed: true,
      validation_errors: validationResult.errors,
    };
  }
}
```

**Hook Point 12: PRE-TOOL-CALL-VALIDATION**
- **Location:** Before line 195 in OllamaClient
- **Data Available:** Raw tool calls from LLM
- **Plugin Opportunity:** Pre-validation analysis, logging

**Hook Point 13: POST-TOOL-CALL-VALIDATION**
- **Location:** After line 216 (validation complete, error response returned)
- **Data Available:** Validation errors, malformed tool calls
- **Plugin Opportunity:** Monitor validation failures, suggest fixes

---

### D. Response Processing Pipeline

**File:** `src/agent/Agent.ts:760-991`

The agent processes LLM response through multiple checks:

#### Step 1: Interruption Check (Lines 761-828)
```typescript
if (this.interruptionManager.isInterrupted() || response.interrupted) {
  // Handle interjection vs cancellation
  // Return or continue
}
```

**Hook Point 14: POST-INTERRUPTION-CHECK**
- **Location:** After line 828
- **Data Available:** Interruption type, reason, partial response
- **Plugin Opportunity:** Custom interruption handling, recovery suggestions

---

#### Step 2: Partial Response Check (Lines 831-875)
```typescript
if (response.error && response.partial && !isRetry) {
  // If we have partial content/tool_calls, continue from where we left off
  // Add assistant message + continuation prompt
}
```

**Hook Point 15: POST-PARTIAL-RESPONSE-HANDLING**
- **Location:** After line 875
- **Data Available:** Partial content, continuation attempt
- **Plugin Opportunity:** Monitor partial responses, analyze recovery rate

---

#### Step 3: Tool Call Validation Error Check (Lines 877-922)
```typescript
const validationResult = this.messageValidator.validate(response, isRetry);

if (!validationResult.isValid && !isRetry) {
  // Add assistant message with malformed calls
  // Request continuation with error details
}
```

**Hook Point 16: POST-VALIDATION-ERROR-CHECK**
- **Location:** After line 922
- **Data Available:** Validation errors, retry count
- **Plugin Opportunity:** Track validation error patterns, suggest model changes

---

#### Step 4: Extract Tool Calls (Lines 929-940)
```typescript
const toolCalls = response.tool_calls || [];
const content = response.content || '';
```

**Hook Point 17: POST-TOOL-CALL-EXTRACTION**
- **Location:** After line 940
- **Data Available:** Extracted tool calls array, content
- **Plugin Opportunity:** Analyze tool selection patterns, validate requests

---

#### Step 5: Empty Response Check (Lines 942-974)
```typescript
if (!content.trim() && toolCalls.length === 0 && !isRetry) {
  // Truly empty response - attempt continuation
}
```

**Hook Point 18: POST-EMPTY-RESPONSE-DETECTION**
- **Location:** After line 974
- **Data Available:** Detection result, continuation attempt
- **Plugin Opportunity:** Monitor empty response frequency, suggest prompt adjustments

---

### E. Tool Call Processing

**File:** `src/agent/Agent.ts:1000-1152`

```
if (toolCalls.length > 0) {
    ↓
    Unwrap batch calls (Line 1012)
        ↓
    Check context usage (Line 1041)
        ↓
    Detect cycles (Line 1068)
        ↓
    Execute tools (Line 1080) via ToolOrchestrator
        ↓
    Add tool calls to history (Line 1119)
        ↓
    Track required tools (Line 1125)
        ↓
    Get follow-up response (Line 1148)
        ↓
    Recursively process follow-up
```

**Hook Point 19: PRE-BATCH-UNWRAP**
- **Location:** Before line 1012
- **Data Available:** Raw tool calls with batch structure
- **Plugin Opportunity:** Analyze batch patterns, modify batch behavior

**Hook Point 20: POST-BATCH-UNWRAP**
- **Location:** After line 1012
- **Data Available:** Unwrapped tool calls
- **Plugin Opportunity:** Log unwrapped structure, validate expansion

**Hook Point 21: PRE-CYCLE-DETECTION**
- **Location:** Before line 1068
- **Data Available:** Tool calls to check
- **Plugin Opportunity:** Custom cycle detection logic

**Hook Point 22: POST-CYCLE-DETECTION**
- **Location:** After line 1068
- **Data Available:** Detected cycles, tool call signatures
- **Plugin Opportunity:** Monitor cycle patterns, suggest alternatives

**Hook Point 23: PRE-TOOL-EXECUTION**
- **Location:** Before line 1080 (`await this.toolOrchestrator.executeToolCalls(...)`)
- **Data Available:** Tool calls, cycles, execution mode
- **Event:** `ActivityEventType.TOOL_CALL_START` (emitted by ToolOrchestrator)
- **Plugin Opportunity:** Tool execution validation, pre-execution analysis

**Hook Point 24: POST-TOOL-EXECUTION**
- **Location:** After line 1080 (tool execution completes)
- **Data Available:** Tool results, execution status
- **Event:** `ActivityEventType.TOOL_CALL_END` (emitted by ToolOrchestrator)
- **Plugin Opportunity:** Analyze tool results, performance metrics

---

### F. Text-Only Response Processing

**File:** `src/agent/Agent.ts:1192-1350`

```
if (toolCalls.length === 0) {
    ↓
    Check required tools (Line 1198)
        ↓
    Check for empty content (Line 1260)
        ↓
    Add assistant message (Line 1327)
        ↓
    Clean ephemeral messages (Line 1331)
        ↓
    Emit AGENT_END event (Line 1337)
        ↓
    Return content
```

**Hook Point 25: PRE-REQUIRED-TOOLS-CHECK**
- **Location:** Before line 1198
- **Data Available:** Conversation state, required tools
- **Plugin Opportunity:** Modify required tools list, update task status

**Hook Point 26: POST-REQUIRED-TOOLS-CHECK**
- **Location:** After line 1257 (all checks complete)
- **Data Available:** Check result, missing tools, warnings
- **Plugin Opportunity:** Custom required tools handling, task completion validation

**Hook Point 27: PRE-EPHEMERAL-CLEANUP**
- **Location:** Before line 1331 (cleanupEphemeralMessages call)
- **Data Available:** Current messages, ephemeral messages to remove
- **Plugin Opportunity:** Capture ephemeral content before cleanup

**Hook Point 28: POST-EPHEMERAL-CLEANUP**
- **Location:** After line 1331 (cleanup complete)
- **Data Available:** Final messages array
- **Plugin Opportunity:** Validate cleaned messages, log statistics

---

### G. Session Auto-Save

**File:** `src/agent/Agent.ts:1443-1492`

```typescript
private async autoSaveSession(): Promise<void> {
  // Gets current:
  // - Messages from conversation
  // - Todos from TodoManager
  // - Idle messages from IdleMessageGenerator
  // - Project context from ProjectContextDetector
  
  // Calls sessionManager.autoSave() non-blocking
}
```

**Hook Point 29: PRE-SESSION-SAVE**
- **Location:** Before line 1489 (`sessionManager.autoSave(...)`)
- **Data Available:** Messages, todos, idle messages, project context
- **Plugin Opportunity:** Pre-save validation, selective persistence

**Hook Point 30: POST-SESSION-SAVE**
- **Location:** After line 1489 (save completes or fails)
- **Data Available:** Save status, saved data summary
- **Plugin Opportunity:** Backup triggers, sync operations

---

### H. Final Event Emission

**File:** `src/agent/Agent.ts:1337-1347`

```typescript
this.emitEvent({
  id: this.generateId(),
  type: ActivityEventType.AGENT_END,
  timestamp: Date.now(),
  data: {
    content: content,
    isSpecializedAgent: this.config.isSpecializedAgent || false,
    instanceId: this.instanceId,
    agentName: this.config.baseAgentPrompt ? 'specialized' : 'main',
  },
});
```

**Hook Point 31: POST-AGENT-END-EVENT**
- **Location:** After line 1347
- **Event:** `ActivityEventType.AGENT_END`
- **Data Available:** Final response content, agent metadata
- **Plugin Opportunity:** Response logging, completion tracking

---

## 3. IDLE MESSAGE GENERATION

**File:** `src/services/IdleMessageGenerator.ts:168-389`

### Current Implementation

```typescript
async generateMessageBatch(recentMessages: Message[], context?: IdleContext): Promise<string[]> {
  const messagePrompt = this.buildBatchMessagePrompt(recentMessages, context);
  
  // Calls modelClient.send with:
  // - role: 'user'
  // - content: prompt with instructions
  // - temperature: 1.2 (creative)
  // - stream: false
  
  // Parse response into array of idle messages
}

generateMessageBackground(recentMessages, context, force) {
  if (!force && queue not running low && time not passed) return;
  
  // Run generateAndRefillQueueAsync() in background (fire-and-forget)
}
```

### Idle Context Available

```typescript
interface IdleContext {
  cwd?: string;                 // Working directory
  todos?: Array<...>;           // Active todos
  gitBranch?: string;           // Current branch
  homeDirectory?: string;       // User home dir name
  projectContext?: {            // Project info
    languages: string[];
    frameworks: string[];
    projectName?: string;
    projectType?: string;
    hasGit: boolean;
    packageManager?: string;
    scale: 'small' | 'medium' | 'large';
    hasDocker?: boolean;
    cicd?: string[];
  };
}
```

**Hook Point 32: PRE-IDLE-MESSAGE-GENERATION**
- **Location:** Before line 173 in IdleMessageGenerator (`await this.modelClient.send(...)`)
- **Data Available:** Idle context (todos, project info, git branch)
- **Plugin Opportunity:** Inject suggestions based on context, monitor generation requests

**Hook Point 33: POST-IDLE-MESSAGE-GENERATION**
- **Location:** After line 273 (generateAndRefillQueueAsync completes)
- **Data Available:** Generated messages array, queue update
- **Plugin Opportunity:** Validate message quality, filter messages

**Hook Point 34: PRE-QUEUE-UPDATE**
- **Location:** Before line 277 (this.messageQueue = messages)
- **Data Available:** New messages to be queued
- **Plugin Opportunity:** Filter/modify message queue, add custom messages

**Hook Point 35: POST-QUEUE-UPDATE**
- **Location:** After line 278 (queue updated, onQueueUpdated callback)
- **Data Available:** Updated queue, new messages
- **Event:** `onQueueUpdated()` callback
- **Plugin Opportunity:** Persist queue changes, trigger UI updates

---

## 4. EXISTING EVENT HOOKS

### ActivityStream Event System

**File:** `src/services/ActivityStream.ts:32-98`

Currently emitted events that plugins can subscribe to:

```typescript
emit(event: ActivityEvent) {
  // Emit to direct listeners (by type or wildcard)
  
  // Forward to plugins via EventSubscriptionManager
  // Only if not a scoped stream and event has valid data
}

mapToPluginEventType(activityEventType): string | null {
  // Maps Activity events to plugin events
}
```

**Approved Events for Plugins** (EventSubscriptionManager.ts:67-80):
```
'TOOL_CALL_START'
'TOOL_CALL_END'
'AGENT_START'
'AGENT_END'
'PERMISSION_REQUEST'
'PERMISSION_RESPONSE'
'COMPACTION_START'
'COMPACTION_COMPLETE'
'CONTEXT_USAGE_UPDATE'
'TODO_UPDATE'
'THOUGHT_COMPLETE'
'DIFF_PREVIEW'
```

**Hook Point 36: EVENT SUBSCRIPTION (Built-in)**
- **Location:** EventSubscriptionManager in plugins/EventSubscriptionManager.ts
- **Available Events:** 12 approved event types (read-only observation)
- **Mechanism:** JSON-RPC notifications to plugin sockets
- **Plugin Opportunity:** Background processes monitoring, analytics, UI sync

---

## 5. SYSTEM PROMPT ASSEMBLY DETAILS

### Components Contributing to System Prompt

#### A. Static Directives (systemMessages.ts:20-133)
- ALLY_IDENTITY
- BEHAVIORAL_DIRECTIVES
- AGENT_DELEGATION_GUIDELINES
- GENERAL_GUIDELINES

#### B. Dynamic Components (systemMessages.ts:146-337)
1. **Context Usage Info** (lines 146-192)
   - TokenManager.getContextUsagePercentage()
   - Remaining tokens estimate
   - Tool result manager state

2. **Context Budget Reminder** (lines 198-235)
   - Warnings at 75% and 90%
   - System-level reminder injection

3. **Context Info** (lines 240-337)
   - Date/time, working directory, OS version
   - Git branch info
   - ALLY.md file contents (if exists)
   - Available agents list
   - Project context from detector

4. **Todo Context** (systemMessages.ts:345-368)
   - TodoManager.generateActiveContext()
   - Active todo list with status

5. **Tool Usage Guidance** (systemMessages.ts:370-391)
   - From ToolManager.getToolUsageGuidance()
   - Tool selection rules

**Hook Point 37: PRE-CONTEXT-INFO-FETCH**
- **Location:** Before line 344 in getMainSystemPrompt
- **Data Available:** Service registry, token managers
- **Plugin Opportunity:** Add custom context providers

**Hook Point 38: PRE-TODO-CONTEXT-FETCH**
- **Location:** Before line 353 in getMainSystemPrompt
- **Data Available:** Todo manager
- **Plugin Opportunity:** Modify todo display, add task context

**Hook Point 39: PRE-TOOL-GUIDANCE-FETCH**
- **Location:** Before line 377 in getMainSystemPrompt
- **Data Available:** Tool manager
- **Plugin Opportunity:** Add tool guidance, modify descriptions

---

## 6. CRITICAL INSERTION POINTS SUMMARY TABLE

| # | Hook Point | File:Line | Phase | Safe Actions | Dangerous Actions | Plugin Use Case |
|---|-----------|----------|-------|-------------|------------------|---|
| 1 | PRE-USER-MESSAGE-ADD | Agent.ts:395 | Input | Filter/transform content | Replace message, corrupt role | Privacy redaction |
| 2 | PRE-SYSTEM-REMINDER-ADD | Agent.ts:404, 449 | Input | Modify reminder content | Remove critical reminders | Context injection |
| 3 | POST-FOCUS-SET | Agent.ts:213 | Input | Log focus change | Corrupt focus state | Directory monitoring |
| 4 | PRE-SYSTEM-PROMPT-GEN | systemMessages.ts:342 | Input | Add sections | Remove directives | Project rules |
| 5 | POST-SYSTEM-PROMPT-GEN | Agent.ts:690 | Input | Validate prompt | Break structure | Prompt analysis |
| 6 | PRE-SYSTEM-PROMPT-ASSIGN | Agent.ts:690 | Input | Transform text | Break format | Dynamic modification |
| 7 | PRE-FUNCTION-DEFS-FETCH | Agent.ts:661 | Input | Filter tools | Break schemas | Custom tools |
| 8 | PRE-LLM-SEND | Agent.ts:717 | Input | Log/validate | Modify messages | Request validation |
| 9 | POST-THINKING-EMIT | Agent.ts:713 | Input | Track events | Suppress events | Progress UI |
| 10 | POST-LLM-RESPONSE | Agent.ts:721 | Output | Validate response | Corrupt response | Response analysis |
| 11 | POST-REMINDER-CLEANUP | Agent.ts:731 | Output | Log cleanup | Restore unwanted msgs | Effectiveness tracking |
| 12 | PRE-TOOL-VALIDATION | OllamaClient.ts:195 | Output | Log calls | Modify calls | Pre-validation analysis |
| 13 | POST-TOOL-VALIDATION | OllamaClient.ts:216 | Output | Log errors | Suppress errors | Failure monitoring |
| 14 | POST-INTERRUPTION-CHECK | Agent.ts:828 | Output | Log status | Suppress interrupt | Recovery suggestions |
| 15 | POST-PARTIAL-HANDLING | Agent.ts:875 | Output | Analyze recovery | Break continuation | Recovery rate tracking |
| 16 | POST-VALIDATION-ERROR | Agent.ts:922 | Output | Track patterns | Suppress errors | Error pattern analysis |
| 17 | POST-TOOL-EXTRACTION | Agent.ts:940 | Output | Analyze tools | Modify calls | Tool usage patterns |
| 18 | POST-EMPTY-DETECTION | Agent.ts:974 | Output | Monitor frequency | Suppress detection | Prompt adjustment |
| 19 | PRE-BATCH-UNWRAP | Agent.ts:1012 | Execution | Log patterns | Modify structure | Batch analysis |
| 20 | POST-BATCH-UNWRAP | Agent.ts:1012 | Execution | Validate expansion | Corrupt structure | Structure validation |
| 21 | PRE-CYCLE-DETECT | Agent.ts:1068 | Execution | Custom logic | Break detection | Advanced cycle detection |
| 22 | POST-CYCLE-DETECT | Agent.ts:1068 | Execution | Log cycles | Suppress detection | Cycle pattern analysis |
| 23 | PRE-TOOL-EXEC | Agent.ts:1080 | Execution | Validate calls | Modify arguments | Execution validation |
| 24 | POST-TOOL-EXEC | Agent.ts:1080 | Execution | Analyze results | Modify results | Performance metrics |
| 25 | PRE-REQUIRED-TOOLS | Agent.ts:1198 | Response | Modify list | Break tracking | Dynamic task updates |
| 26 | POST-REQUIRED-TOOLS | Agent.ts:1257 | Response | Validate completion | Hide missing tools | Task completion |
| 27 | PRE-EPHEMERAL-CLEANUP | Agent.ts:1331 | Response | Capture content | Prevent cleanup | Content preservation |
| 28 | POST-EPHEMERAL-CLEANUP | Agent.ts:1331 | Response | Log stats | Restore cleaned msgs | Cleanup verification |
| 29 | PRE-SESSION-SAVE | Agent.ts:1489 | Persistence | Pre-save validation | Corrupt save | Selective persistence |
| 30 | POST-SESSION-SAVE | Agent.ts:1489 | Persistence | Trigger sync | Fail silently | Backup/sync |
| 31 | POST-AGENT-END | Agent.ts:1347 | Completion | Log completion | Suppress event | Response logging |
| 32 | PRE-IDLE-GEN | IdleMessageGenerator.ts:173 | Background | Inject suggestions | Modify context | Context-aware suggestions |
| 33 | POST-IDLE-GEN | IdleMessageGenerator.ts:273 | Background | Validate messages | Corrupt queue | Quality validation |
| 34 | PRE-QUEUE-UPDATE | IdleMessageGenerator.ts:277 | Background | Filter messages | Corrupt messages | Queue filtering |
| 35 | POST-QUEUE-UPDATE | IdleMessageGenerator.ts:278 | Background | Trigger updates | Suppress callback | Queue sync |
| 36 | EVENT-SUBSCRIPTION | EventSubscriptionManager.ts | Async | Subscribe to 12 events | N/A | Background monitoring |
| 37 | PRE-CONTEXT-FETCH | systemMessages.ts:344 | Prompt | Add providers | Remove providers | Custom context |
| 38 | PRE-TODO-FETCH | systemMessages.ts:353 | Prompt | Modify display | Remove todos | Task context |
| 39 | PRE-TOOL-GUIDANCE | systemMessages.ts:377 | Prompt | Add guidance | Modify descriptions | Tool behavior |

---

## 7. DATA FLOW DIAGRAM

### High-Level Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     USER INPUT PHASE                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  User Message (String)                                          │
│      ↓                                                           │
│  [Hook 1: PRE-USER-MESSAGE-ADD]                                 │
│      ↓                                                           │
│  Create Message Object                                          │
│      ↓                                                           │
│  Add to this.messages[]                                         │
│      ↓                                                           │
│  [Hook 2: PRE-SYSTEM-REMINDER-ADD] × 2-3                        │
│      ↓                                                           │
│  Add system reminders (interruption, todos, etc.)              │
│      ↓                                                           │
│  [Hook 3: POST-FOCUS-SET]                                       │
│      ↓                                                           │
│  Auto-save session                                              │
│      ↓                                                           │
│  Emit AGENT_START event                                         │
│      ↓                                                           │
└─────────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────────┐
│                  SYSTEM PROMPT PHASE                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  [Hook 4: PRE-SYSTEM-PROMPT-GEN]                                │
│      ↓                                                           │
│  Assemble prompt components:                                    │
│    - CORE_DIRECTIVES (static)                                   │
│    - [Hook 37: PRE-CONTEXT-FETCH]                              │
│    - Context info (date, git, project)                         │
│    - [Hook 38: PRE-TODO-FETCH]                                  │
│    - Todo context                                               │
│    - [Hook 39: PRE-TOOL-GUIDANCE]                               │
│    - Tool guidance                                              │
│      ↓                                                           │
│  [Hook 5: POST-SYSTEM-PROMPT-GEN]                               │
│      ↓                                                           │
│  [Hook 6: PRE-SYSTEM-PROMPT-ASSIGN]                             │
│      ↓                                                           │
│  Assign to this.messages[0].content                             │
│      ↓                                                           │
└─────────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────────┐
│                  LLM EXECUTION PHASE                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  [Hook 7: PRE-FUNCTION-DEFS-FETCH]                              │
│      ↓                                                           │
│  Get function definitions from ToolManager                      │
│      ↓                                                           │
│  [Hook 8: PRE-LLM-SEND]                                         │
│      ↓                                                           │
│  Emit THOUGHT_CHUNK (Thinking indicator)                        │
│      ↓                                                           │
│  [Hook 9: POST-THINKING-EMIT]                                   │
│      ↓                                                           │
│  Send to LLM (OllamaClient.send)                                │
│      ├─ Streaming response handling                             │
│      │   - Accumulate content/thinking                          │
│      │   - Emit ASSISTANT_CHUNK events                          │
│      │   - Emit THOUGHT_CHUNK events                            │
│      │                                                          │
│      └─ Non-streaming response handling                         │
│          - Return complete response                             │
│      ↓                                                           │
│  [Hook 10: POST-LLM-RESPONSE]                                   │
│      ↓                                                           │
│  Remove system-reminder messages                                │
│      ↓                                                           │
│  [Hook 11: POST-REMINDER-CLEANUP]                               │
│      ↓                                                           │
└─────────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────────┐
│                  RESPONSE VALIDATION PHASE                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  [Hook 12: PRE-TOOL-VALIDATION]                                 │
│      ↓                                                           │
│  Validate tool calls (OllamaClient)                             │
│      ↓                                                           │
│  [Hook 13: POST-TOOL-VALIDATION]                                │
│      ↓                                                           │
│  [Hook 14: POST-INTERRUPTION-CHECK]                             │
│      ↓                                                           │
│  [Hook 15: POST-PARTIAL-HANDLING]                               │
│      ↓                                                           │
│  [Hook 16: POST-VALIDATION-ERROR-CHECK]                         │
│      ↓                                                           │
│  [Hook 17: POST-TOOL-CALL-EXTRACTION]                           │
│      ↓                                                           │
│  [Hook 18: POST-EMPTY-DETECTION]                                │
│      ↓                                                           │
└─────────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────────┐
│          TOOL EXECUTION PHASE (if toolCalls.length > 0)        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  [Hook 19: PRE-BATCH-UNWRAP]                                    │
│      ↓                                                           │
│  Unwrap batch tool calls                                        │
│      ↓                                                           │
│  [Hook 20: POST-BATCH-UNWRAP]                                   │
│      ↓                                                           │
│  Add assistant message with tool calls to conversation          │
│      ↓                                                           │
│  [Hook 21: PRE-CYCLE-DETECT]                                    │
│      ↓                                                           │
│  Detect tool call cycles                                        │
│      ↓                                                           │
│  [Hook 22: POST-CYCLE-DETECT]                                   │
│      ↓                                                           │
│  [Hook 23: PRE-TOOL-EXEC]                                       │
│      ↓ (Emit TOOL_CALL_START event)                             │
│  Execute tools (ToolOrchestrator)                               │
│      ├─ Concurrent execution (safe read-only tools)             │
│      └─ Sequential execution (destructive tools)                │
│      ↓ (Emit TOOL_CALL_END event)                               │
│  [Hook 24: POST-TOOL-EXEC]                                      │
│      ↓                                                           │
│  Add tool results to conversation                               │
│      ↓                                                           │
│  Auto-save session                                              │
│      ↓                                                           │
│  Request follow-up from LLM                                     │
│      ↓                                                           │
│  Recursively process response                                   │
│      ↓                                                           │
└─────────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────────┐
│      TEXT RESPONSE PHASE (if no toolCalls or follow-up)        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  [Hook 25: PRE-REQUIRED-TOOLS-CHECK]                            │
│      ↓                                                           │
│  Check if all required tools have been called                   │
│      ↓                                                           │
│  [Hook 26: POST-REQUIRED-TOOLS-CHECK]                           │
│      ↓                                                           │
│  Add assistant message with text content                        │
│      ↓                                                           │
│  [Hook 27: PRE-EPHEMERAL-CLEANUP]                               │
│      ↓                                                           │
│  Clean up ephemeral messages from conversation                  │
│      ↓                                                           │
│  [Hook 28: POST-EPHEMERAL-CLEANUP]                              │
│      ↓                                                           │
│  [Hook 29: PRE-SESSION-SAVE]                                    │
│      ↓                                                           │
│  Auto-save session with final state                             │
│      ↓                                                           │
│  [Hook 30: POST-SESSION-SAVE]                                   │
│      ↓                                                           │
│  Emit AGENT_END event                                           │
│      ↓                                                           │
│  [Hook 31: POST-AGENT-END]                                      │
│      ↓                                                           │
│  Return final content to user                                   │
│      ↓                                                           │
└─────────────────────────────────────────────────────────────────┘

Parallel/Background:
┌─────────────────────────────────────────────────────────────────┐
│              BACKGROUND IDLE MESSAGE GENERATION                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Check if queue needs refilling                                 │
│      ↓                                                           │
│  [Hook 32: PRE-IDLE-GEN]                                        │
│      ↓                                                           │
│  Send generation request to LLM (fire-and-forget)               │
│      ↓                                                           │
│  Parse response into message array                              │
│      ↓                                                           │
│  [Hook 33: POST-IDLE-GEN]                                       │
│      ↓                                                           │
│  [Hook 34: PRE-QUEUE-UPDATE]                                    │
│      ↓                                                           │
│  Update message queue                                           │
│      ↓                                                           │
│  [Hook 35: POST-QUEUE-UPDATE] (onQueueUpdated callback)         │
│      ↓                                                           │
│  Session manager auto-saves queue                               │
│      ↓                                                           │
└─────────────────────────────────────────────────────────────────┘

Async Events:
┌─────────────────────────────────────────────────────────────────┐
│           PLUGIN EVENT SUBSCRIPTION (Throughout)                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  [Hook 36: EVENT-SUBSCRIPTION]                                  │
│      ↓                                                           │
│  Activities.emit(...) → EventSubscriptionManager.dispatch()    │
│      ↓                                                           │
│  For each subscribed plugin, send JSON-RPC notification        │
│      ↓                                                           │
│  Approved events:                                               │
│    TOOL_CALL_START, TOOL_CALL_END                               │
│    AGENT_START, AGENT_END                                       │
│    PERMISSION_REQUEST, PERMISSION_RESPONSE                      │
│    COMPACTION_START, COMPACTION_COMPLETE                        │
│    CONTEXT_USAGE_UPDATE, TODO_UPDATE                            │
│    THOUGHT_COMPLETE, DIFF_PREVIEW                               │
│      ↓                                                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## 8. IMPLEMENTATION GUIDELINES FOR PLUGINS

### General Rules

1. **Safe Hooks (Most Recommended)**
   - Hooks after operations complete (POST-*)
   - Hooks that observe state (events)
   - Hooks that validate without modifying
   
2. **Caution Hooks**
   - PRE-* hooks that modify content
   - Must validate modifications thoroughly
   - Must not corrupt data structures
   
3. **Avoid These Unless Necessary**
   - Modifying tool calls or function definitions
   - Removing critical reminders
   - Suppressing important events

### Plugin Registration Strategy

```typescript
// Best Practice: Subscribe to events for background monitoring
const eventManager = serviceRegistry.get('event_subscription_manager');
eventManager.subscribe('my-plugin', {
  events: ['TOOL_CALL_START', 'TOOL_CALL_END', 'AGENT_END'],
  socketPath: '/tmp/my-plugin.sock'
});

// Alternative: Hook into specific phases
// (Would require future API development)
const hookManager = serviceRegistry.get('hook_manager');
hookManager.before('llm.send', async (context) => {
  // Validate request before sending to LLM
  return context; // or throw to cancel
});
```

### Context-Aware Insertion Points

**For Todo-based Suggestions:**
- Hook 2 (system reminder injection) or Hook 32 (idle generation)
- Access: todos array from TodoManager
- Safe: Can add/modify messages before LLM receives

**For Response Analysis:**
- Hook 10 (post-LLM response) or Hook 36 (event subscription)
- Access: LLMResponse object or ActivityEvent
- Safe: Read-only observation, no modification needed

**For Model Switching/Configuration:**
- Hook 4 (pre-system-prompt-gen) or Hook 8 (pre-LLM-send)
- Access: System prompt content, function definitions
- Caution: Ensure modifications are valid

**For Context Enhancement:**
- Hook 37/38/39 (context/todo/tool guidance fetch)
- Access: Service registry, context managers
- Safe: Adding new context providers, modifying display

---

## 9. FILE LOCATION QUICK REFERENCE

| Component | File | Key Lines |
|-----------|------|-----------|
| Main inference loop | `src/agent/Agent.ts` | 366-513 (sendMessage) |
| System prompt assembly | `src/prompts/systemMessages.ts` | 342-449 |
| Response processing | `src/agent/Agent.ts` | 760-991 (processLLMResponse) |
| Tool execution | `src/agent/ToolOrchestrator.ts` | 117-142 |
| LLM communication | `src/llm/OllamaClient.ts` | 174-271 (send) |
| Idle message generation | `src/services/IdleMessageGenerator.ts` | 168-389 |
| Event system | `src/services/ActivityStream.ts` | 32-98 (emit) |
| Plugin event subscriptions | `src/plugins/EventSubscriptionManager.ts` | 40-100 |

---

## 10. KEY INSIGHTS FOR PLUGIN DEVELOPMENT

1. **Message Flow is NOT Synchronous Throughout**
   - Auto-saves are fire-and-forget (non-blocking)
   - Idle generation runs in background
   - Plugin events dispatched asynchronously

2. **System Prompt is Regenerated EVERY LLM CALL**
   - Allows dynamic context updates (todos, git branch)
   - Opportunity for plugins to inject contextual guidance
   - Previous state may be stale if long-running operations occurred

3. **Tool Calls Go Through Multiple Validation Stages**
   - OllamaClient validates structure
   - Agent validates semantics
   - ToolOrchestrator validates execution
   - Plugins can hook each stage

4. **Two Types of Hooks Needed**
   - **Synchronous Hooks:** For validation/modification before critical operations
   - **Event Subscriptions:** For background monitoring (currently only option)

5. **Cycle Detection is Sophisticated**
   - Tracks file content hashes for read operations
   - Distinguishes valid repeats (file changed) vs actual cycles
   - Plugins could enhance with domain-specific logic

6. **Session Persistence is Automatic**
   - Happens after every message
   - Includes todos, idle messages, project context
   - Plugins can hook pre-save for selective persistence

7. **Ephemeral Messages Enable Temporary Context**
   - Tool results can be marked ephemeral
   - Cleaned up before final save
   - Allows rich information flow without polluting session

8. **Specialized Agents Have Resource Constraints**
   - Activity timeout prevents infinite loops
   - Context threshold enforces summary before tool execution runs out of space
   - Max duration enforces time limits
   - Plugins could monitor and optimize subagent behavior

---

## Conclusion

Ally's inference pipeline has **31 distinct hook points** and **12 event-based observation points** where plugins can inject logic. The system is designed for:

1. **Observability:** Event subscriptions for monitoring
2. **Extensibility:** Pre/post hooks for intervention
3. **Customization:** Dynamic system prompt injection
4. **Persistence:** Automatic session management with plugin integration

Most critical for plugins:
- **Hook 4-6:** System prompt customization
- **Hook 8:** Request validation before LLM
- **Hook 10, 13, 17:** Response analysis
- **Hook 23-24:** Tool execution monitoring
- **Hook 32-35:** Idle message customization
- **Hook 36:** Event-based background monitoring
