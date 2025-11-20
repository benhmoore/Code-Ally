# Investigation Summary - What We Know For Certain

## ✓ Confirmed Facts

### 1. The Symptom (How message leaks)
- **Location**: `AgentTool.ts:756`
- **Issue**: Only checks for `'[Request interrupted'`, NOT `'Interrupted. Tell Ally what to do instead.'`
- **Result**: USER_FACING_INTERRUPTION passes through as valid tool result content
- **Path**: nested agent → returns USER_FACING_INTERRUPTION → AgentTool doesn't detect it → wraps as tool result → parent agent receives in conversation history

### 2. The Double sendMessage Pattern
- **Location**: `AgentTool.ts:726` (first call) and `AgentTool.ts:741` (second call)
- **Trigger**: First call returns empty response
- **Sequence**:
  1. First `sendMessage("Execute this task...")` → agent returns empty string
  2. `extractSummaryFromConversation()` fails
  3. Second `sendMessage("Please provide a concise summary...")` → IF THIS RETURNS USER_FACING_INTERRUPTION, bug occurs

### 3. Activity Timeout Configuration
- **Default**: 120 seconds (2 minutes) without tool calls
- **Bug report timing**: Agents ran 7m 10s and 2m 10s - BOTH exceed timeout threshold
- **Expected behavior**: Timeouts should trigger continuation via `canContinueAfterTimeout: true` flag

### 4. Continuation Logic Exists
- **Location**: `Agent.ts:1193-1230`
- **Mechanism**:
  - Activity timeout sets `canContinueAfterTimeout: true`
  - Should add continuation reminder and recursively retry
  - No maximum retry limit
- **Critical**: This SHOULD prevent USER_FACING_INTERRUPTION from being returned on activity timeouts

### 5. Return Paths for USER_FACING_INTERRUPTION
From `Agent.sendMessage()`:
- `Agent.ts:854` via `handleInterruption()` - for non-timeout cancel interruptions
- `Agent.ts:1234` in `processLLMResponse()` - when `canContinueAfterTimeout` is false

From `ResponseProcessor`:
- Multiple locations (199, 253, 317, 337, 439, 488, 533, 591, 656, 693) - all when interruption type is 'cancel'

---

## ❓ Key Unknowns

### The Central Question
**Why does the second `sendMessage()` call return USER_FACING_INTERRUPTION instead of using continuation logic?**

### CRITICAL FINDING: Activity Timeout Uses 'cancel' Type

**Location**: `Agent.ts:521-536`

```typescript
// Line 526-530: Sets interruption context with canContinueAfterTimeout flag
this.interruptionManager.setInterruptionContext({
  reason: `Activity timeout: no tool calls for ${elapsedSeconds} seconds`,
  isTimeout: true,
  canContinueAfterTimeout: true,  // ← SETS FLAG
});

// Line 533: Interrupts with DEFAULT type 'cancel'
this.interrupt();  // ← Calls interrupt() with no args → defaults to 'cancel'
```

**The disconnect**:
- Interruption TYPE is set to 'cancel' (not a special 'timeout' type)
- Interruption CONTEXT has `canContinueAfterTimeout: true`
- These are separate pieces of state
- Continuation logic checks the CONTEXT, not the TYPE
- So theoretically this should still work...

### Possible Answers

**Theory A: Context doesn't persist to second sendMessage()**
- First `sendMessage()` completes, calls `cleanup()` which might clear context
- Second `sendMessage()` starts fresh, but inherits stale interrupt state?

**Theory B: Continuation logic fails**
- `getLLMResponse()` at line 1226 could throw an error
- Error might bypass continuation and reach line 1234
- Need to check error handling in continuation path

**Theory C: Not an activity timeout at all**
- Could be a different type of interrupt (e.g., 'cancel')
- Need to identify what else could interrupt nested agent
- User ESC should only route to deepest 'executing' delegation

**Theory D: State corruption between calls**
- First `sendMessage()` leaves bad state
- Second `sendMessage()` inherits corrupted interruption context
- `interruptionManager.reset()` at line 729 should prevent this

**Theory E: Parent-child timing issue**
- Parent agent's activity monitor interferes with child
- Pause/resume coordination breaks down
- Parent timeout propagates to child incorrectly

---

## 🎯 Next Steps

### Immediate Focus
**Find the specific code path that leads to USER_FACING_INTERRUPTION in the second sendMessage() call**

### Approach
1. **Trace interrupt sources**: Find every call to `interrupt()` method - what sets interruption type to something OTHER than timeout?
2. **Check continuation error handling**: What happens if `getLLMResponse()` throws during continuation?
3. **Verify context propagation**: Does interruption context persist incorrectly between calls?
4. **Test ResponseProcessor paths**: Could ResponseProcessor return USER_FACING_INTERRUPTION before processLLMResponse checks continuation?

### Critical Code Locations to Examine
- `InterruptionManager.interrupt()` - all call sites
- `Agent.getLLMResponse()` - error handling
- Error handling around line 1226 continuation call
- ResponseProcessor early return paths (lines 199, 253, etc.)
