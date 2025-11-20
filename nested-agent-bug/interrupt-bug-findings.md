# Interrupt Bug Investigation - Findings Report

## Executive Summary

**Problem**: Nested agents are receiving the user-facing message "Interrupted. Tell Ally what to do instead." in their conversation history, treating it as actual context from a parent agent.

**Root Cause Identified (Symptom)**: User-facing interruption messages leak into parent agent conversation history through tool results.

**Architectural Issue (Underlying)**: Unknown - why are nested agents hitting unrecoverable interrupts in the first place? The continuation/nudging system should prevent this.

---

## Part 1: Message Leak Path (SOLVED)

### How USER_FACING_INTERRUPTION Reaches Agents

1. **Nested agent interrupted/times out** → `Agent.sendMessage()` returns `"Interrupted. Tell Ally what to do instead."`
   - Sources: `Agent.ts:1277`, `Agent.ts:854`, `ResponseProcessor.ts:199,253,317,337,439,488,533,591,656,693`

2. **AgentTool receives string** → `AgentTool.ts:726` - `response = "Interrupted. Tell Ally..."`

3. **AgentTool fails to recognize interruption** → `AgentTool.ts:756`
   - Check only looks for `'[Request interrupted'`
   - Does NOT match `'Interrupted. Tell Ally what to do instead.'`
   - Falls through to line 765: `finalResponse = response`

4. **AgentTool returns as tool result** → `AgentTool.ts:770-777`
   ```typescript
   const result = finalResponse + '\n\nIMPORTANT: The user CANNOT see this summary...'
   return { result }
   ```

5. **Parent agent receives as tool result message** → `ToolOrchestrator.ts:818-835`
   - Creates message with `role: 'tool'`, `content: "Interrupted. Tell Ally..."`
   - Added to parent's conversation via `agent.addMessage()`

6. **Parent agent reads it as context** → Next LLM turn includes this in message history

### The Leak

**USER_FACING_INTERRUPTION is meant for UI display only**, but it flows through the tool result pipeline and enters agent conversation history.

**Fix Location**: `AgentTool.ts:756` - Detection logic must recognize ALL interruption messages, not just `'[Request interrupted'`.

---

## Part 2: Why Interrupts Occur (PARTIALLY SOLVED)

###  Critical Discovery: Double SendMessage Pattern

**Root cause path identified:**

1. **AgentTool.ts:726** - First `sendMessage()` call executes agent task
2. **Agent returns empty response** - Makes tool calls but provides no text response
3. **AgentTool.ts:732-734** - Detects empty, tries `extractSummaryFromConversation()` - fails
4. **AgentTool.ts:741-742** - Makes **SECOND `sendMessage()` call** to request explicit summary
5. **IF second call gets interrupted** → Returns `"Interrupted. Tell Ally what to do instead."`
6. **AgentTool.ts:744-745** - `finalResponse = "Interrupted. Tell Ally..."`
7. **AgentTool.ts:770** - Wraps and returns as tool result to parent agent

**The bug:** Line 756 only checks for `'[Request interrupted'` but NOT `'Interrupted. Tell Ally what to do instead.'`, so the USER_FACING_INTERRUPTION string passes through as valid content.

### The Real Question

Why does the **second `sendMessage()` call** get interrupted persistently?

### What Should Happen (Continuation System)

The system has robust continuation/nudging for:

1. **Activity Timeouts** (`ActivityMonitor.ts`)
   - Detects agent stuck generating tokens without tool calls
   - Sets `canContinueAfterTimeout: true` flag (`Agent.ts:529`)
   - Should add continuation prompt and retry (`Agent.ts:1193-1230`)
   - **No limit on continuation attempts** (`Agent.ts:525` - removed max retry enforcement)

2. **HTTP Errors (GAP 2)** (`ResponseProcessor.ts:159-211`)
   - Detects partial response with 500/503 errors
   - Adds `createHttpErrorReminder()` to conversation
   - Requests continuation recursively
   - **Should never surface to user**

3. **Validation Errors (GAP 3)** (`ResponseProcessor.ts:214-264`)
   - Detects malformed tool calls
   - Adds validation error reminder
   - Requests continuation with fixed structure
   - **Should never surface to user**

4. **Empty Responses (GAP 1)** (`ResponseProcessor.ts:285-315`)
   - Detects truly empty responses (no content, no tool calls)
   - Adds empty response reminder
   - Requests continuation
   - **Should never surface to user**

### Interruption Types That Return USER_FACING_INTERRUPTION

**From ResponseProcessor.ts** (returns early during continuation checks):
- Lines 197-199: Cancel-type interruption before HTTP error continuation
- Lines 250-253: Cancel-type interruption before validation error continuation
- Other locations: 317, 337, 439, 488, 533, 591, 656, 693

**From Agent.ts**:
- Line 854: `handleInterruption()` for non-timeout cancels
- Line 1277: Cancel-type interruption after ResponseProcessor completes

**Pattern**: All return paths check `interruptionManager.getInterruptionType() === 'cancel'`

**Interjection-type interruptions**: Return empty string `''` to allow graceful continuation (e.g., `ResponseProcessor.ts:201-202, 255-256`)

### Critical Questions

1. **What triggers 'cancel' type interruptions in nested agents?**
   - User pressing ESC should only affect the active delegation (via `DelegationContextManager.getActiveDelegation()`)
   - Are cancel interruptions propagating incorrectly through nested layers?

2. **Are activity timeouts actually continuing?**
   - `Agent.ts:1193-1230` should handle timeouts with `canContinueAfterTimeout`
   - Does this work correctly in nested agent context?
   - Could parent agent's activity monitor be firing during child execution?

3. **Are continuation attempts failing silently?**
   - If continuation LLM calls fail with errors, what happens?
   - Could HTTP errors during continuation cause fallback to USER_FACING_INTERRUPTION?

4. **Is there a race condition?**
   - Parent agent's `ActivityMonitor` should pause during child execution (`Agent.ts:574-577`)
   - Parent resumes after child completes (`Agent.ts:837-839`)
   - Could timing issues cause parent timeouts that abort child agents?

5. **Why is this persistent/architectural?**
   - Bug report shows regular occurrence with nested agents
   - Suggests systematic issue, not random edge case
   - Could be related to specific agent depth levels (1→2→3)?

---

## Architecture Overview

### Timeout/Nudging System
- **ActivityMonitor.ts**: Watchdog timer for stuck agents (10s check interval)
- **Agent.ts:521-536**: Timeout handling with continuation flag
- **ResponseProcessor.ts:159-315**: Three GAP types with automatic continuation
- **No retry limits**: Removed to allow indefinite continuation attempts

### Nested Agent Execution
- **Max depth**: 3 levels (Ally=0 → Agent1=1 → Agent2=2 → Agent3=3)
- **Cycle detection**: Max 2 appearances of same agent in chain
- **AgentPoolService**: All agents persist in pool with unique callId keys
- **DelegationContextManager**: Tracks executing vs completing delegations

### Interrupt Handling
- **Types**: 'cancel' (ESC key), 'interjection' (new user message), timeout (activity monitor)
- **Routing**: `useInputHandlers.ts` finds deepest 'executing' delegation for interjections
- **Lifecycle**: Delegations transition from 'executing' → 'completing' → cleared
- **State**: `InterruptionManager` tracks per-agent interruption state

### Message Flow
- Tool results flow: Tool → ToolManager → ToolOrchestrator → formatToolResult() → createToolResultMessage() → agent.addMessage()
- Ephemeral messages removed after each turn
- System reminders (ephemeral/persistent) added to tool results

---

## Next Investigation Steps

1. **Trace specific interrupt trigger in bug scenario**
   - Why did nested Task agent hit interrupt?
   - Was it activity timeout, HTTP error, or cancel propagation?

2. **Verify continuation logic in nested context**
   - Do continuation attempts work correctly for specialized agents?
   - Test: `Agent.ts:1193-1230` with nested agent having `isSpecializedAgent=true`

3. **Check parent-child activity monitor coordination**
   - Verify pause/resume reference counting works with multiple nesting levels
   - Could pause count get out of sync?

4. **Examine delegation lifecycle timing**
   - When does delegation transition to 'completing'?
   - Could race condition cause child agent to be killed prematurely?

5. **Review specialized agent error handling**
   - `Agent.ts:860-862`: Timeouts on subagents throw errors instead of returning messages
   - Could these thrown errors bypass continuation logic?

6. **Test HTTP error handling in nested agents**
   - If nested agent hits 500/503, does GAP 2 continuation work?
   - Or does error bubble up to parent as USER_FACING_INTERRUPTION?
