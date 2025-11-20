# Double sendMessage() State Trace

## Scenario: AgentTool calls sendMessage() twice on same agent instance

### Initial State
```
childAgent.activityMonitor.isRunning = false
childAgent.activityMonitor.pauseCount = 0
childAgent.activityMonitor.lastActivityTime = undefined

parentAgent.activityMonitor.isRunning = true
parentAgent.activityMonitor.pauseCount = 0
parentAgent.activityMonitor.watchdogInterval = <active>
```

---

## First sendMessage() Call (AgentTool.ts:726)

### Entry (Agent.ts:550-577)
```typescript
// Line 559-570: Detect sub-agent, get parent reference
isSubAgent = true
parentAgent = <parent agent instance>

// Line 574-577: Pause parent's activity monitoring
parentAgent.activityMonitor.pause()
  → parentAgent.pauseCount++ (0 → 1)
  → clearInterval(parentAgent.watchdogInterval)
  → parentAgent.isRunning = false
  → Log: "Paused (pauseCount: 1)"

// Line 580: Start child's activity monitoring
childAgent.activityMonitor.start()
  → isRunning check: false, so proceed
  → childAgent.lastActivityTime = Date.now()  // T0
  → childAgent.isRunning = true
  → childAgent.watchdogInterval = setInterval(checkTimeout, 10000ms)
  → Log: "Started - timeout: Xms, check interval: 10000ms"
```

### Child Executes Task
- Makes tool calls → updates `lastActivityTime`
- Returns empty response (no text, only tool calls)

### Cleanup (Agent.ts:832, finally block)
```typescript
// Line 832: cleanupRequestState()
childAgent.activityMonitor.stop()
  → clearInterval(childAgent.watchdogInterval)
  → childAgent.watchdogInterval = null
  → childAgent.isRunning = false
  → childAgent.pauseCount = 0  // RESET!
  → Log: "Stopped"

// Line 837-839: Resume parent's activity monitoring
parentAgent.activityMonitor.resume()
  → parentAgent.pauseCount-- (1 → 0)
  → parentAgent.pauseCount === 0, so restart:
    → parentAgent.watchdogInterval = setInterval(checkTimeout, 10000ms)
    → parentAgent.isRunning = true
    → Log: "Resumed (pauseCount: 0)"
```

### State After First Call
```
childAgent.activityMonitor.isRunning = false
childAgent.activityMonitor.pauseCount = 0
childAgent.activityMonitor.lastActivityTime = T0  // STILL SET FROM T0!
childAgent.activityMonitor.watchdogInterval = null

parentAgent.activityMonitor.isRunning = true
parentAgent.activityMonitor.pauseCount = 0
```

---

## Second sendMessage() Call (AgentTool.ts:741)

### Entry (Agent.ts:550-577)
```typescript
// Line 574-577: Pause parent's activity monitoring AGAIN
parentAgent.activityMonitor.pause()
  → parentAgent.pauseCount++ (0 → 1)
  → clearInterval(parentAgent.watchdogInterval)
  → parentAgent.isRunning = false
  → Log: "Paused (pauseCount: 1)"

// Line 580: Start child's activity monitoring AGAIN
childAgent.activityMonitor.start()
  → isRunning check: false (was stopped), so proceed
  → childAgent.lastActivityTime = Date.now()  // T1 (RESETS!)
  → childAgent.isRunning = true
  → childAgent.watchdogInterval = setInterval(checkTimeout, 10000ms)
  → Log: "Started - timeout: Xms, check interval: 10000ms"
```

**KEY**: Line 107 DOES reset `lastActivityTime` to `Date.now()`, so this is NOT the bug.

### What Happens Next?

The second `sendMessage()` prompt is: "Please provide a concise summary of what you accomplished, found, or determined while working on this task."

This is asking the agent to reflect on work it JUST did. The agent's conversation history contains:
- All the tool calls from the first execution
- All the tool results from those calls
- The new user message asking for a summary

**Hypothesis: The agent gets stuck thinking/generating without making tool calls**

If the agent tries to generate a long summary by thinking/writing text without making any tool calls, the ActivityMonitor's watchdog will fire after `timeoutMs` expires with no calls to `recordActivity()`.

---

## Activity Timeout Scenario

### During Second sendMessage() Execution
```typescript
// Child agent is generating text response (no tool calls)
// Time passes... watchdog checks every 10s

// ActivityMonitor.ts:243-254: checkTimeout() fires
const elapsed = Date.now() - this.lastActivityTime
if (elapsed > this.config.timeoutMs) {
  // Timeout detected!
  callback(elapsed / 1000)  // Calls handleActivityTimeout()
}
```

### handleActivityTimeout() (Agent.ts:521-536)
```typescript
// Line 526-529: Set interruption context
this.interruptionManager.setInterruptionContext({
  reason: "Activity timeout: no tool calls for X seconds",
  isTimeout: true,
  canContinueAfterTimeout: true,  // ← SHOULD ALLOW CONTINUATION!
})

// Line 533: Interrupt the current request
this.interruptionManager.interrupt('timeout')  // Sets interrupted = true
```

### Back in processLLMResponse() (Agent.ts:1193-1235)
```typescript
// Line 1194-1195: Check for continuation-eligible timeout
const context = this.interruptionManager.getInterruptionContext()
const canContinueAfterTimeout = context.canContinueAfterTimeout === true

if (canContinueAfterTimeout) {
  // Lines 1197-1229: SHOULD CONTINUE
  // Add continuation prompt
  // Reset interruption
  // Request new LLM response
  // Recursively process
  return await this.processLLMResponse(continuationResponse)
}

// Line 1234: Only reached if canContinueAfterTimeout is false
return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION
```

**So if activity timeout fires, it SHOULD continue automatically!**

The question is: **Why would canContinueAfterTimeout be false?**

---

## Alternative Hypothesis: Non-Timeout Interruption

What else could set `interrupted = true` WITHOUT setting `canContinueAfterTimeout = true`?

### Possible Sources of 'cancel' Type Interruptions:

1. **User pressing ESC** (via DelegationContextManager routing)
   - But should only route to deepest 'executing' delegation
   - Second `sendMessage()` should be 'executing'

2. **HTTP Error during LLM call**
   - If `getLLMResponse()` throws or returns error
   - But this should be handled by GAP 2 continuation logic

3. **Permission Denial**
   - Not relevant here - no user permissions involved

4. **Explicit `interrupt('cancel')` call**
   - Where else is this called?

5. **State inheritance bug**
   - Could `interruptionManager.reset()` at line 729 fail to clear something?
   - Could interruption state leak from first call to second?

---

## Key Questions to Investigate:

1. What is the `timeoutMs` value for specialized agents?
   - If it's too short, second `sendMessage()` might legitimately timeout
   - But timeout should trigger continuation, not USER_FACING_INTERRUPTION

2. Does continuation logic work correctly when recursively called?
   - First sendMessage() → returns empty
   - Second sendMessage() → timeout → continuation → timeout → continuation...
   - Could deep recursion cause issues?

3. Is there a path where timeout occurs but `canContinueAfterTimeout` is NOT set?
   - Check all places that call `interrupt()`
   - Check all places that set interruption context

4. Could the parent agent's monitor interfere?
   - Parent is paused during child execution
   - But what if pause/resume gets out of sync?
   - Could parent timeout fire and propagate to child?

5. Is the second `sendMessage()` actually getting a chance to run?
   - Or is it interrupted immediately before LLM call?
   - Check log sequence: does "Started activity monitoring" appear for second call?
