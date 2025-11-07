# Interrupt Flow Diagram

## Complete Interrupt Cascade Chain

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER PRESSES ESCAPE                      │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  InputPrompt.tsx:921                                             │
│  if (key.escape && agent.isProcessing())                        │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    │                     │
                    ▼                     ▼
        ✓ Works              ✓ Works
    Emit USER_             Emit INTERRUPT_
    INTERRUPT_              ALL event
    INITIATED               (broadcast)
         │                     │
         │         ┌───────────┴───────────┐
         │         │                       │
         ▼         ▼                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  Agent.interrupt()                    AgentTool.interruptAll()  │
│  [Line 588]                           [Line 715]                │
│  ✓ Sets interrupted = true            ✓ Loops activeDelegations│
│  ✓ Calls cancel()                     ✓ Calls subAgent.interrupt()
│  ✓ Stops LLM streaming                ✓ Propagates to children │
└──────────────────────────────────────────────────────────────────┘
         │                                     │
         ▼                                     ▼
   Main Agent Flow                    Nested Agent Flow
         │                                     │
         ▼                                     ▼
┌──────────────────────────────┐    ┌──────────────────────────┐
│ sendMessage() in progress    │    │ Nested agent also        │
│                              │    │ calls interrupt()        │
└──────────────────────────────┘    │ Sets its interrupted=true│
         │                          │ Cancels its LLM          │
         ▼                          └──────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│  processLLMResponse()                                            │
│  [Line 791]                                                      │
│                                                                  │
│  ✓ Check #1: Lines 792-827 (after LLM response)                │
│    if (isInterrupted || response.interrupted)                  │
│    ✓ CATCHES INTERRUPT                                         │
│                                                                  │
│  ✓ Check #2: Lines 976-978 (before tool execution)             │
│    if (isInterrupted) return INTERRUPTION_MESSAGE               │
│    ✓ CATCHES INTERRUPT                                         │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
                   Tool calls generated?
                    /            \
                   /              \
                  ▼                ▼
               YES              NO
                │                │
                ▼                ▼
         processToolResponse()  processTextResponse()
         [Line 998]             [Line 1176]
             │                      │
             ▼                      ▼
     Unwrap batch calls      Return final text
             │
             ▼
    ┌─────────────────────────┐
    │ Check context usage     │
    │ (may block tools)       │
    │                         │
    │ Detect cycles           │
    │                         │
    │ Execute tools via       │
    │ orchestrator            │
    │ [Line 1078]             │
    │ ✓ TOOLS EXECUTE        │
    │                         │
    └────────────┬────────────┘
                 │
    ┌────────────▼────────────┐
    │ Tools complete          │
    │ [Line 1078-1079]        │
    │                         │
    │ ❌ NO INTERRUPT CHECK   │  ◄── BUG #1
    │    HERE                 │
    └────────────┬────────────┘
                 │
    ┌────────────▼────────────┐
    │ processToolResult()     │
    │ [Line 680-723]          │
    │ Add results to history  │
    └────────────┬────────────┘
                 │
    ┌────────────▼────────────┐
    │ Add to tool history     │
    │ Check cycles            │
    │ Track required tools    │
    │ Clear turn state        │
    │                         │
    │ ❌ NO INTERRUPT CHECK   │  ◄── BUG #2
    │    BEFORE FOLLOW-UP     │
    └────────────┬────────────┘
                 │
                 ▼
    ┌────────────────────────┐
    │ getLLMResponse()        │
    │ [Line 1132]            │
    │                        │
    │ ❌ CALLED WITHOUT      │
    │    CHECKING INTERRUPT  │
    │                        │
    │ Generates new response │
    │ (may have new tools)   │
    └────────┬───────────────┘
             │
             ▼
    Recurse: processLLMResponse()
             │
             ├─→ New tool calls? → Back to processToolResponse()
             └─→ Text only? → Return to user
             
    ❌ INTERRUPT LOST!
       User sees message but agent continues!
```

## The Bug in Context

### Tool Response Handling (Broken)

```typescript
// Agent.ts - processToolResponse() [Lines 1071-1135]

try {
  await this.toolOrchestrator.executeToolCalls(toolCalls, cycles);
  // ✓ Tools have been executed
  // ✓ All results collected
} catch (error) {
  // Handle permission denied
  throw error;
}

// ❌ BUG #1: No check here!
// if (this.interruptionManager.isInterrupted()) {
//   this.interruptionManager.markRequestAsInterrupted();
//   return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
// }

this.addToolCallsToHistory(unwrappedToolCalls);
this.clearCycleHistoryIfBroken();

if (this.requiredToolTracker.hasRequiredTools()) {
  // Check required tools...
}

this.toolManager.clearCurrentTurn();

// ❌ BUG #2: Called without checking interrupt!
// Should have guard:
// if (!this.interruptionManager.isInterrupted()) {
logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Getting follow-up response from LLM...');
const followUpResponse = await this.getLLMResponse();

return await this.processLLMResponse(followUpResponse);
// }
```

## What SHOULD Happen

```
┌─────────────────────────────────────────────────────┐
│ Tools complete                                      │
└────────────────────┬────────────────────────────────┘
                     │
    ┌────────────────▼─────────────────┐
    │ ✓ ADD: Check interrupt here      │
    │                                  │
    │ if (isInterrupted()) {           │
    │   markRequestAsInterrupted()     │
    │   return INTERRUPT_MESSAGE       │
    │ }                                │
    └────────────────┬─────────────────┘
                     │
         (No interrupt,
          so continue)
                     │
    ┌────────────────▼──────────────────────┐
    │ ✓ ADD: Guard follow-up LLM call       │
    │                                       │
    │ if (!isInterrupted()) {               │
    │   followUpResponse = getLLMResponse() │
    │   processLLMResponse(followUp)        │
    │ } else {                              │
    │   markRequestAsInterrupted()          │
    │   return INTERRUPT_MESSAGE            │
    │ }                                     │
    └────────────────┬──────────────────────┘
                     │
                     ▼
         ✓ Properly stops!
```

## Interrupt State Transitions

### Current (Broken) State Machine

```
[Interrupted]
    │
    ├─ getLLMResponse() called (despite interrupted=true)
    │
    ├─ LLM returns response
    │
    ├─ processLLMResponse() checks
    │  └─→ Returns because interrupted
    │
    └─ But tool execution already happened before this check!
       Parent doesn't know child was interrupted!
```

### Fixed State Machine

```
[Interrupted]
    │
    ├─ toolOrchestrator.executeToolCalls() completes
    │
    ├─ ✓ CHECK: isInterrupted()? → YES
    │
    ├─ STOP: Return INTERRUPT_MESSAGE
    │
    └─ ✓ No follow-up LLM call!
       ✓ No new tool execution!
       ✓ Parent respects child interruption!
```

## Affected Execution Paths

### Path 1: Main Agent (Broken)
```
Main.sendMessage()
  └─ Main.processLLMResponse()
      └─ Main.processToolResponse()
          ├─ ✓ Tools execute
          ├─ ❌ NO INTERRUPT CHECK
          ├─ ❌ getLLMResponse() called
          └─ BUG: New response generated despite interrupt!
```

### Path 2: Nested Agents (Broken)
```
Main.agent() tool execution
  └─ Nested.sendMessage()
      └─ Nested.processLLMResponse()
          └─ Nested.processToolResponse()
              ├─ ✓ Tools execute
              ├─ Nested interrupted via INTERRUPT_ALL
              ├─ ❌ NO CHECK for interrupt
              ├─ ❌ getLLMResponse() called
              └─ Parent still waiting for nested tool completion
  └─ Main continues with follow-up even though nested failed!
```

### Path 3: Multi-level Chain (Worst Case)
```
Main.agent() → Nested1.agent() → Nested2.agent()
     │             │               │
     │             │         ❌ Interrupted
     │             │         Sets interrupted=true
     │             │         Returns early
     │             │
     │      Parent Nested1 doesn't know Nested2 failed
     │      Calls getLLMResponse() for follow-up
     │      ❌ Generates new response
     │
     Parent Main doesn't know Nested1 continued
     Calls getLLMResponse() for follow-up
     ❌ Generates new response
     ❌ New tool calls!
```

## Summary

The interrupt system is **well-designed but incompletely implemented**. The missing checks at the tool execution boundary (agent.ts:1078-1132) cause the parent-to-child interrupt cascade to break. Adding the two simple checks would fix the critical issue.
