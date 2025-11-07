# Interrupt System - Quick Reference Guide

## Critical Cascading Failure

**Problem:** After tools finish executing, parent agent calls `getLLMResponse()` without checking if interrupted, causing new tool calls instead of stopping.

## 5 Root Causes

### 1. No Interrupt Check After Tool Execution (PRIMARY)
- **File:** `src/agent/Agent.ts`
- **Line:** After 1107 (in `processToolResponse()`)
- **Issue:** Missing check after `toolOrchestrator.executeToolCalls()`
- **Impact:** HIGH - Main bug

### 2. No Interrupt Check Before Follow-up LLM Call (PRIMARY)
- **File:** `src/agent/Agent.ts`
- **Line:** 1132 (in `processToolResponse()`)
- **Issue:** `getLLMResponse()` called without checking `isInterrupted()`
- **Impact:** HIGH - Generates new responses after interrupt

### 3. Nested Agent Interruption Doesn't Notify Parent (MEDIUM)
- **Files:** Multiple agent/tool classes
- **Issue:** Child interruption sets child's flag, but parent doesn't know
- **Impact:** MEDIUM - Affects agent chains

### 4. Tools May Not Respect Abort Signal (MEDIUM)
- **File:** `src/agent/ToolOrchestrator.ts:546-553`
- **Issue:** Abort signal passed but tools may not check it
- **Impact:** MEDIUM - Tool execution continues

### 5. Unclear Interruption User Message (LOW)
- **File:** Constants (PERMISSION_MESSAGES)
- **Issue:** User sees interruption but doesn't know what to do
- **Impact:** LOW - UX only

## Interrupt Flow Chain

```
User presses Escape
    ↓
InputPrompt.tsx:921 detects key.escape
    ↓
agent.interrupt() called
    ↓
InterruptionManager.interrupted = true ✓
ModelClient.cancel() called ✓
    ↓
INTERRUPT_ALL event emitted ✓
    ↓
AgentTool.interruptAll() called ✓
Nested agents interrupted ✓
    ↓
processLLMResponse() checks ✓ (lines 792-827, 976-978)
    ↓
processToolResponse() EXECUTES TOOLS
    ↓
Tools complete ← BROKEN HERE
    ↓
NO CHECK FOR INTERRUPT ✗ ← BUG #1
    ↓
getLLMResponse() called ✗ ← BUG #2
    ↓
New LLM response generated ✗
New tool calls executed ✗
```

## Existing Interrupt Checks (Working)

- **Line 792-827:** Interrupt check after LLM response received
- **Line 976-978:** Interrupt check before tool execution
- **Line 588-611:** agent.interrupt() method (sets flag + cancels LLM)

## Missing Interrupt Checks (Broken)

- **After line 1107:** Should check after `executeToolCalls()` completes
- **Before line 1132:** Should check before `getLLMResponse()` called

## Code References

| Location | Type | Line(s) | Status |
|----------|------|---------|--------|
| InputPrompt.tsx | Detection | 921 | Works ✓ |
| Agent.ts:interrupt() | Entry | 588 | Works ✓ |
| Agent.ts:processLLMResponse() | Check #1 | 792 | Works ✓ |
| Agent.ts:processLLMResponse() | Check #2 | 976 | Works ✓ |
| Agent.ts:processToolResponse() | Execute | 1078 | Works ✓ |
| Agent.ts:processToolResponse() | Check #3 | MISSING | Broken ✗ |
| Agent.ts:processToolResponse() | Follow-up | 1132 | Broken ✗ |
| AgentTool.ts:interruptAll() | Propagate | 715 | Works ✓ |

## QuickFix Template

```typescript
// In src/agent/Agent.ts, in processToolResponse() method

// After line 1107 (catch block), ADD:
if (this.interruptionManager.isInterrupted()) {
  logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Agent interrupted during tool execution - stopping follow-up');
  this.interruptionManager.markRequestAsInterrupted();
  return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
}

// Before line 1132, REPLACE:
// Old (broken):
const followUpResponse = await this.getLLMResponse();
return await this.processLLMResponse(followUpResponse);

// New (fixed):
if (!this.interruptionManager.isInterrupted()) {
  const followUpResponse = await this.getLLMResponse();
  return await this.processLLMResponse(followUpResponse);
} else {
  this.interruptionManager.markRequestAsInterrupted();
  return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
}
```

## Testing Checklist

- [ ] Press Escape during main agent execution → stops immediately
- [ ] Press Escape during nested agent (via agent() tool) → nested stops, parent stops
- [ ] Press Escape after tool completes → no follow-up LLM call
- [ ] Press Escape mid-tool-execution → tools stop, no follow-up
- [ ] Message shown: "Interrupted. Tell Ally what to do instead."
- [ ] User can submit new message after interrupt (works normally)
- [ ] Multiple agents in chain all stop when interrupted
