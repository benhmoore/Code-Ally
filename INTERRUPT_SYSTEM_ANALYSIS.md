# Interrupt/Escape System Analysis - Code Ally

## Executive Summary

The interrupt system has a **critical cascading failure** where interrupts don't properly prevent parent agents from requesting follow-up LLM responses after child agent execution. When a user presses Escape during nested agent execution, the interrupt propagates to the child agent but the **parent agent continues with `getLLMResponse()` after tool execution completes**, potentially creating new tool calls instead of respecting the interruption.

---

## 1. INTERRUPT DETECTION: Where Escape is Detected

### Entry Point: InputPrompt.tsx (Lines 920-992)

**File:** `/Users/bhm128/code-ally/src/ui/components/InputPrompt.tsx:920-992`

```typescript
// ===== Escape - Dismiss Completions, Interrupt Agent, or Double-Escape for Rewind =====
if (key.escape) {
  // Prevent infinite loop from re-entry during state updates
  if (processingEscapeRef.current) return;

  // First priority: dismiss completions if showing
  if (showCompletions) {
    processingEscapeRef.current = true;
    setShowCompletions(false);
    setCompletions([]);
    queueMicrotask(() => {
      processingEscapeRef.current = false;
    });
    return;
  }

  // Second priority: Interrupt agent if processing (single escape)
  if (agent && agent.isProcessing()) {
    logger.debug('[INPUT] Escape - interrupting main agent');
    
    // Emit immediate visual feedback before interrupting
    if (activityStream) {
      activityStream.emit({
        id: `user-interrupt-${Date.now()}`,
        type: ActivityEventType.USER_INTERRUPT_INITIATED,
        timestamp: Date.now(),
        data: {},
      });
    }

    // Interrupt the agent (will cancel LLM request immediately)
    agent.interrupt();  // <-- Sets interruptionManager.interrupted = true

    // Also interrupt all subagents through AgentTool
    if (activityStream) {
      activityStream.emit({
        id: `interrupt-${Date.now()}`,
        type: ActivityEventType.INTERRUPT_ALL,
        timestamp: Date.now(),
        data: {},
      });
    }
    return;
  }
}
```

**Key Points:**
- Escape is only detected when NOT in a modal/selector
- Calls `agent.interrupt()` which sets `interruptionManager.interrupted = true`
- Emits both `USER_INTERRUPT_INITIATED` and `INTERRUPT_ALL` events
- Does NOT check if interruption was already set
- Does NOT block the completion of tools that are already executing

---

## 2. INTERRUPT PROPAGATION: ActivityStream Event System

### Agent Tool Subscription: AgentTool.ts (Lines 42-45)

**File:** `/Users/bhm128/code-ally/src/tools/AgentTool.ts:42-45`

```typescript
constructor(activityStream: ActivityStream) {
  super(activityStream);

  // Listen for global interrupt events
  this.activityStream.subscribe(ActivityEventType.INTERRUPT_ALL, () => {
    this.interruptAll();
  });
}
```

### Interrupt All Method: AgentTool.ts (Lines 715-724)

**File:** `/Users/bhm128/code-ally/src/tools/AgentTool.ts:715-724`

```typescript
/**
 * Interrupt all active sub-agents
 * Called when user presses Ctrl+C
 */
interruptAll(): void {
  logger.debug('[AGENT_TOOL] Interrupting', this.activeDelegations.size, 'active sub-agents');
  for (const [callId, delegation] of this.activeDelegations.entries()) {
    const subAgent = delegation.subAgent;
    if (subAgent && typeof subAgent.interrupt === 'function') {
      logger.debug('[AGENT_TOOL] Interrupting sub-agent:', callId);
      subAgent.interrupt();  // <-- Calls interrupt on nested agents
    }
  }
}
```

**Key Points:**
- Loops through all active delegations and calls `subAgent.interrupt()`
- This is ASYNC propagation via event subscription
- Similar subscriptions exist in PlanTool.ts, ExploreTool.ts, SessionsTool.ts

---

## 3. INTERRUPT MANAGER: State Tracking

### InterruptionManager.ts (Lines 1-193)

**File:** `/Users/bhm128/code-ally/src/agent/InterruptionManager.ts`

**State Variables:**
- `interrupted`: Current interruption state (true = currently interrupted)
- `wasInterrupted`: Flag indicating previous request was interrupted (persists for next request)
- `interruptionType`: Either 'cancel' or 'interjection'
- `interruptionContext`: Reason, timeout status, continuation eligibility
- `toolAbortController`: Controls tool execution abort signal

**Critical Methods:**
- `interrupt(type)`: Sets `interrupted = true`, aborts tool execution if cancel type
- `isInterrupted()`: Checks if currently interrupted
- `wasRequestInterrupted()`: Checks persistent flag from previous request
- `reset()`: Clears `interrupted` flag but NOT `wasInterrupted`
- `markRequestAsInterrupted()`: Sets `wasInterrupted = true` for next request

**Issue:** The interruption state is only checked at specific points in the agent execution flow, NOT continuously.

---

## 4. AGENT INTERRUPT HANDLING: Core Flow

### Agent.ts: Interrupt Method (Lines 588-611)

**File:** `/Users/bhm128/code-ally/src/agent/Agent.ts:588-611`

```typescript
/**
 * Interrupt the current request
 *
 * Called when user presses Ctrl+C or submits a message during an ongoing request.
 * Immediately cancels the LLM request and sets interrupt flag for graceful cleanup.
 *
 * @param type - Type of interruption: 'cancel' (default) or 'interjection'
 */
interrupt(type: 'cancel' | 'interjection' = 'cancel'): void {
  if (this.requestInProgress) {
    // Set interruption state via InterruptionManager (handles abort controller)
    this.interruptionManager.interrupt(type);

    // Cancel ongoing LLM request immediately
    this.cancel();  // <-- Cancels ModelClient

    // Stop activity monitoring
    this.stopActivityMonitoring();

    this.emitEvent({
      id: this.generateId(),
      type: ActivityEventType.AGENT_END,
      timestamp: Date.now(),
      data: {
        interrupted: true,
        isSpecializedAgent: this.config.isSpecializedAgent || false,
        instanceId: this.instanceId,
        agentName: this.config.baseAgentPrompt ? 'specialized' : 'main',
      },
    });
  }
}
```

**Key Points:**
- Only works if `requestInProgress === true`
- Sets interrupt flag AND cancels LLM streaming
- Does NOT check if agent is in middle of tool execution
- Does NOT propagate to parent agent

---

## 5. LLM RESPONSE PROCESSING: Where Interrupts Are Checked

### Agent.ts: processLLMResponse (Lines 791-989)

**File:** `/Users/bhm128/code-ally/src/agent/Agent.ts:791-989`

**Interrupt Check #1 - Lines 792-827:**
```typescript
// Check for interruption
if (this.interruptionManager.isInterrupted() || response.interrupted) {
  // Handle interjection vs cancellation
  if (this.interruptionManager.getInterruptionType() === 'interjection') {
    // Preserve partial response if we have content
    if (response.content || response.tool_calls) {
      // ... save partial response and resume ...
      return await this.processLLMResponse(continuationResponse);
    }
  } else {
    // Regular cancel - mark as interrupted for next request
    this.interruptionManager.markRequestAsInterrupted();
    return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
  }
}
```

**Interrupt Check #2 - Lines 976-978:**
```typescript
if (toolCalls.length > 0) {
  // Check for interruption before processing tools
  if (this.interruptionManager.isInterrupted()) {
    return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
  }
  // ...
}
```

**Key Points:**
- Checks `isInterrupted()` AFTER receiving LLM response
- Checks AGAIN before executing tools
- Does NOT check AFTER tool execution completes (CRITICAL GAP)
- Does NOT check before requesting follow-up LLM response

---

## 6. TOOL EXECUTION INTERRUPTS: The Critical Failure Point

### Agent.ts: processToolResponse (Lines 998-1136)

**File:** `/Users/bhm128/code-ally/src/agent/Agent.ts:998-1136`

**Critical Section - Lines 1071-1135:**
```typescript
// Execute tool calls via orchestrator (pass original calls for unwrapping)
logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Executing tool calls via orchestrator...');

// Start tool execution and create abort controller
this.startToolExecution();

try {
  await this.toolOrchestrator.executeToolCalls(toolCalls, cycles);
  logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Tool calls completed. Total messages now:', this.messages.length);
} catch (error) {
  // Handle permission denied...
  throw error;
}

// Add tool calls to history for cycle detection (AFTER execution)
this.addToolCallsToHistory(unwrappedToolCalls);

// Check if cycle pattern is broken (3 consecutive different calls)
this.clearCycleHistoryIfBroken();

// Track required tool calls
if (this.requiredToolTracker.hasRequiredTools()) {
  // ... tracking logic ...
}

// Clear current turn (for redundancy detection)
this.toolManager.clearCurrentTurn();

// *** CRITICAL: Get follow-up response from LLM ***
// NO INTERRUPT CHECK BETWEEN TOOL EXECUTION AND THIS CALL
logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Getting follow-up response from LLM...');
const followUpResponse = await this.getLLMResponse();

// Recursively process the follow-up (it might contain more tool calls)
return await this.processLLMResponse(followUpResponse);
```

**THE CRITICAL GAP:**
After `toolOrchestrator.executeToolCalls()` completes, the code immediately calls `getLLMResponse()` WITHOUT checking if the agent was interrupted during tool execution. This means:

1. User presses Escape while nested agent is executing tools
2. Escape propagates to all agents via `INTERRUPT_ALL` event
3. Nested agent is interrupted (sets `interrupted = true`)
4. Nested agent may throw error or handle gracefully
5. Parent agent's `processToolResponse()` continues execution
6. Parent agent calls `getLLMResponse()` UNAWARE that child was interrupted
7. LLM generates new tool calls or response
8. Interrupt is "lost" - parent proceeds as if nothing happened

---

## 7. TOOL ORCHESTRATOR: Execution and Propagation

### ToolOrchestrator.ts: executeToolCalls (Lines 117-142)

**File:** `/Users/bhm128/code-ally/src/agent/ToolOrchestrator.ts:117-142`

```typescript
/**
 * Execute tool calls (concurrent or sequential based on tool types)
 *
 * @param toolCalls - Array of tool calls from LLM
 * @param cycles - Optional map of tool call ID to cycle detection info
 */
async executeToolCalls(
  toolCalls: ToolCall[],
  cycles?: Map<string, { toolName: string; count: number; isValidRepeat: boolean }>
): Promise<void> {
  logger.debug('[TOOL_ORCHESTRATOR] executeToolCalls called with', toolCalls.length, 'tool calls');

  if (toolCalls.length === 0) {
    return;
  }

  // Store cycles for later use in result formatting
  this.cycleDetectionResults = cycles || new Map();

  // Unwrap batch tool calls into individual tool calls
  const unwrappedCalls = this.unwrapBatchCalls(toolCalls);
  logger.debug('[TOOL_ORCHESTRATOR] After unwrapping batch calls:', unwrappedCalls.length, 'tool calls');

  // Determine execution mode
  const canRunConcurrently = this.canRunConcurrently(unwrappedCalls);

  if (canRunConcurrently && this.config.config.parallel_tools) {
    await this.executeConcurrent(unwrappedCalls);
  } else {
    await this.executeSequential(unwrappedCalls);
  }
}
```

**Issue:** No interrupt state checking. Executes all tools regardless of parent agent's interruption state.

### ToolOrchestrator.ts: executeSingleTool (Lines 437-672)

**File:** `/Users/bhm128/code-ally/src/agent/ToolOrchestrator.ts:437-672`

**Tool Execution with Abort Signal - Lines 546-553:**
```typescript
// Execute tool via tool manager (pass ID for streaming output)
result = await this.toolManager.executeTool(
  toolName,
  args,
  id,
  false,
  this.agent.getToolAbortSignal()  // <-- Passes abort signal
);
```

**Key Points:**
- Passes abort signal from agent's InterruptionManager
- Tools can respond to abort signal (but not all do)
- Tool completion does NOT automatically stop parent from continuing

---

## 8. NESTED AGENTS: AgentTool Delegation

### AgentTool.ts: executeSingleAgent (Lines 291-383)

**File:** `/Users/bhm128/code-ally/src/tools/AgentTool.ts:291-383`

The nested agent executes via:
1. `executeImpl()` validates arguments
2. `executeSingleAgentWrapper()` executes the agent
3. Agent runs its own `sendMessage()` loop
4. Agent has its own `InterruptionManager` (separate from parent)
5. Interrupt event (`INTERRUPT_ALL`) is received and handled via subscription

**The Problem:**
When a nested agent (subagent) is interrupted:
- The subagent sets its own `interrupted = true`
- The subagent may return early or error
- The PARENT agent's tool execution completes
- The PARENT agent is NOT notified of child interruption
- The PARENT agent proceeds with `getLLMResponse()`

---

## 9. INTERRUPT STATE LIFECYCLE: What Should Happen vs. What Does

### What SHOULD Happen (Expected Flow):

```
User presses Escape
  ↓
InputPrompt detects escape
  ↓
agent.interrupt('cancel') called
  ↓
interruptionManager.interrupted = true
  ↓
ModelClient.cancel() called (aborts LLM streaming)
  ↓
INTERRUPT_ALL event emitted
  ↓
All nested agents receive and handle interrupt
  ↓
Current LLM request fails/returns
  ↓
Agent's processLLMResponse() checks isInterrupted()
  ↓
Agent returns early with interruption message
  ↓
Parent agent checks interruption state
  ↓
Parent agent does NOT call getLLMResponse()
  ↓
Parent agent returns interruption message
```

### What ACTUALLY Happens (Current Bug):

```
User presses Escape
  ↓
InputPrompt detects escape
  ↓
agent.interrupt('cancel') called on MAIN agent
  ↓
Main agent's interruptionManager.interrupted = true
  ↓
Main agent's ModelClient.cancel() called
  ↓
INTERRUPT_ALL event emitted
  ↓
AgentTool receives event, calls interruptAll()
  ↓
Nested agent's interrupt() called (sets its interrupted = true)
  ↓
BUT: Nested agent may be in middle of tool execution
  ↓
Main agent's getLLMResponse() was already waiting for tool completion
  ↓
Tools keep executing (abort signal passed, but tools may be blocking)
  ↓
After tools complete, main agent calls getLLMResponse() AGAIN
  ↓
*** NO INTERRUPT CHECK ***
  ↓
LLM generates new response
  ↓
Main agent processes response and may execute more tools
  ↓
User sees "Interrupted. Tell Ally what to do instead." 
  BUT THEN main agent continues with new LLM response
```

---

## 10. CRITICAL GAPS: Root Causes

### Gap #1: No Interrupt Check After Tool Execution (PRIMARY)

**Location:** Agent.ts, lines 1078-1131

After `toolOrchestrator.executeToolCalls()` completes, the code should check if the agent was interrupted:

```typescript
// MISSING CODE:
if (this.interruptionManager.isInterrupted()) {
  this.interruptionManager.markRequestAsInterrupted();
  return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
}
```

**Impact:** High - This is the main reason follow-up responses are generated after interruption

### Gap #2: No Interrupt Check Before Follow-up LLM Call

**Location:** Agent.ts, line 1132

The `getLLMResponse()` call after tool execution should be guarded:

```typescript
// MISSING CODE:
if (this.interruptionManager.isInterrupted()) {
  this.interruptionManager.markRequestAsInterrupted();
  return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
}

const followUpResponse = await this.getLLMResponse();
```

**Impact:** High - Prevents new LLM responses from being generated after interruption

### Gap #3: Nested Agent Interruption Doesn't Propagate to Parent

**Location:** Multiple locations

When a nested agent (via AgentTool) is interrupted, there's no mechanism to:
1. Notify the parent agent that the child was interrupted
2. Cause the parent to stop tool execution
3. Prevent the parent from requesting follow-up LLM response

**Impact:** Medium - For complex multi-level agent chains

### Gap #4: Tool Execution May Not Respect Abort Signal

**Location:** Tool implementations

Tools receive an abort signal via `executeSingleTool()` but may not actively check it:

```typescript
result = await this.toolManager.executeTool(
  toolName,
  args,
  id,
  false,
  this.agent.getToolAbortSignal()  // <-- Passed but not always used
);
```

**Impact:** Medium - Tools may continue executing even after interrupt

### Gap #5: "Interrupted. Tell Ally..." Message Not Shown Clearly

**Location:** useInputHandlers.ts, line 493-494

The interruption message is shown but the message about what to do ("Tell Ally what to do instead") is missing:

```typescript
// Current message:
return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;

// Should guide user:
// "Interrupted. Tell Ally what to do instead."
```

**Impact:** Low - UI/UX issue, not functional

---

## 11. CURRENT INTERRUPT FLOW MAP

### Complete Flow Path:

1. **Escape Key Press** → InputPrompt.tsx:921
2. **Check if Processing** → Agent.isProcessing():617
3. **Set Interrupt Flag** → Agent.interrupt():588 → InterruptionManager.interrupt():99
4. **Cancel LLM** → Agent.cancel():1841
5. **Emit Events** → USER_INTERRUPT_INITIATED + INTERRUPT_ALL
6. **Propagate to Tools** → ActivityStream subscriptions:
   - AgentTool.interruptAll():715
   - PlanTool.interruptAll()
   - ExploreTool.interruptAll()
   - SessionsTool.interruptAll()
7. **Tool Interrupts Children** → agent.interrupt() on each subagent
8. **Process LLM Response** → Agent.processLLMResponse():791
   - Check #1: Lines 792-827 (catches if LLM was cancelled)
   - Check #2: Lines 976-978 (before tool execution)
   - ❌ Check #3: MISSING after tool execution
9. **Execute Tools** → Agent.processToolResponse():998
   - Runs tool orchestrator
   - Processes tool results
   - ❌ NO INTERRUPT CHECK AFTER COMPLETION
10. **Follow-up Response** → Agent.getLLMResponse():686
    - ❌ CALLED WITHOUT CHECKING INTERRUPT STATE
    - Generates new tool calls or response
11. **Recursive Processing** → Back to step 8

---

## 12. FILE REFERENCES SUMMARY

| Component | File | Key Lines | Issue |
|-----------|------|-----------|-------|
| Input Detection | `src/ui/components/InputPrompt.tsx` | 920-992 | No checks for prior interrupts |
| Interrupt Propagation | `src/ui/components/InputPrompt.tsx` | 944-962 | Emits correct events |
| Tool Subscriptions | `src/tools/AgentTool.ts` | 42-45 | Correct subscription |
| Interrupt Distribution | `src/tools/AgentTool.ts` | 715-724 | Correctly loops subagents |
| Interrupt Manager | `src/agent/InterruptionManager.ts` | 1-193 | Well-designed state machine |
| Agent Interrupt | `src/agent/Agent.ts` | 588-611 | Correct but limited scope |
| LLM Processing | `src/agent/Agent.ts` | 791-989 | Has checks at lines 792-827, 976-978 |
| **Tool Execution** | **`src/agent/Agent.ts`** | **1078-1079** | **NO CHECK AFTER COMPLETION** |
| **Follow-up Call** | **`src/agent/Agent.ts`** | **1130-1132** | **CALLED WITHOUT CHECKING** |
| Tool Orchestrator | `src/agent/ToolOrchestrator.ts` | 117-142 | No interrupt awareness |
| Single Tool | `src/agent/ToolOrchestrator.ts` | 546-553 | Passes abort signal |

---

## 13. RECOMMENDED FIXES

### Fix #1: Check Interrupt After Tool Execution (CRITICAL)

**File:** `src/agent/Agent.ts`, after line 1107

```typescript
// Add before line 1109:
if (this.interruptionManager.isInterrupted()) {
  logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Agent interrupted during tool execution - stopping follow-up');
  this.interruptionManager.markRequestAsInterrupted();
  return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
}
```

### Fix #2: Guard Follow-up LLM Call (CRITICAL)

**File:** `src/agent/Agent.ts`, before line 1132

```typescript
// Replace the follow-up section (lines 1130-1135) with:
if (!this.interruptionManager.isInterrupted()) {
  // Get follow-up response from LLM
  logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Getting follow-up response from LLM...');
  const followUpResponse = await this.getLLMResponse();

  // Recursively process the follow-up (it might contain more tool calls)
  return await this.processLLMResponse(followUpResponse);
} else {
  this.interruptionManager.markRequestAsInterrupted();
  return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
}
```

### Fix #3: Propagate Child Interruption to Parent (MEDIUM)

Add a method to agent to check if child agents were interrupted, and call from processToolResponse().

### Fix #4: Improve Interruption Message (LOW)

Update `PERMISSION_MESSAGES.USER_FACING_INTERRUPTION` to include guidance:

```typescript
"Interrupted. Tell Ally what to do instead."
```

---

## Conclusion

The interrupt system's core design is sound, but it has a **critical execution gap**: after tools complete execution, the parent agent doesn't check if it was interrupted before requesting a follow-up LLM response. This causes the agent to continue generating new tool calls and responses even after the user pressed Escape, creating the appearance that the interrupt wasn't respected.

The fix is straightforward: add interrupt checks at the boundaries of tool execution and before follow-up LLM calls.
