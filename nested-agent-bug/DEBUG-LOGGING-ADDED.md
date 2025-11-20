# Debug Logging Added

## Purpose
To track down why the nested agent interrupt bug is still occurring after the fix was implemented.

## Debug Output Prefixes

All debug statements use `console.log()` with specific prefixes for easy filtering:

- `[DEBUG-PARENT]` - Parent agent lookup via DelegationContextManager
- `[DEBUG-INIT]` - Constructor initialization of parentAgent property
- `[DEBUG-PAUSE]` - Activity monitor pause operations
- `[DEBUG-RESUME]` - Activity monitor resume operations
- `[DEBUG-MONITOR]` - Agent pause/resume method calls
- `[DEBUG-MONITOR-STATE]` - ActivityMonitor internal state (pause/resume/timeout)
- `[DEBUG-DETECTION]` - AgentTool interruption message detection
- `[DEBUG-INTERRUPT]` - Agent returning USER_FACING_INTERRUPTION message

## Locations Added

### 1. Agent.ts - getParentAgent() method (lines 434-467)

**What it logs:**
- When method is called and with what parentCallId
- Whether toolManager exists
- Whether delegationManager exists
- Whether parentContext was found
- **SUCCESS: Parent agent found via DelegationContextManager (with parent ID)**
- **FALLBACK: Using main agent from registry (with agent ID)**
- **ERROR: Any exceptions during lookup**

**Key insights to look for:**
- Is parentContext being found?
- Are we falling back to main agent when we shouldn't?
- Is the parent agent ID what we expect?

### 2. Agent.ts - Constructor initialization (lines 299-304)

**What it logs:**
- Whether agent is a sub-agent (isSpecializedAgent and parentCallId)
- What parentCallId is being used
- What parentAgent was set to (agent ID or null)
- If NOT a sub-agent, why (missing values)

**Key insights to look for:**
- Is parentAgent being set correctly during construction?
- Is it null when it should have a value?

### 3. Agent.ts - sendMessage() pause (lines 617-629)

**What it logs:**
- Whether this.parentAgent exists
- Parent agent ID if it exists
- Whether parent has pauseActivityMonitoring method
- **CALLING: When actually calling pauseActivityMonitoring**
- **NOT CALLING: When skipping pause (and why)**

**Key insights to look for:**
- Is this.parentAgent null when trying to pause?
- Is the pause method actually being called?
- Which agent ID is being paused?

### 4. Agent.ts - sendMessage() resume (lines 889-901)

**What it logs:**
- Whether this.parentAgent exists
- Parent agent ID if it exists
- Whether parent has resumeActivityMonitoring method
- **CALLING: When actually calling resumeActivityMonitoring**
- **NOT CALLING: When skipping resume (and why)**

**Key insights to look for:**
- Is resume being called in the finally block?
- Is it resuming the correct agent?

### 5. Agent.ts - Public pause/resume methods (lines 539, 553)

**What it logs:**
- When pauseActivityMonitoring() is called
- When resumeActivityMonitoring() is called

**Key insights to look for:**
- Are these methods being invoked at all?
- Match these calls to the [DEBUG-PAUSE]/[DEBUG-RESUME] logs

### 6. ActivityMonitor.ts - pause() method (lines 152-175)

**What it logs:**
- Current state: isRunning, pauseCount
- **NO-OP: If not running**
- **PAUSED: When watchdog is stopped (first pause)**
- **INCREMENT: When pause count is incremented (nested pause)**

**Key insights to look for:**
- Is the monitor already paused when pause() is called?
- Is pauseCount increasing as expected?
- Is the watchdog actually being stopped?

### 7. ActivityMonitor.ts - resume() method (lines 191-222)

**What it logs:**
- Current state: enabled, pauseCount
- **NO-OP: If monitoring disabled**
- **NO-OP: If pauseCount is already 0**
- **RESUMED: When watchdog is restarted (pauseCount reaches 0)**
- **DECREMENT: When pause count is decremented (nested resume)**

**Key insights to look for:**
- Is pauseCount reaching 0 when it should?
- Is the watchdog being restarted?
- Are there mismatched pause/resume calls?

### 8. ActivityMonitor.ts - checkTimeout() method (lines 246-267)

**What it logs:**
- **SKIPPED: When paused (with pauseCount)**
- **TIMEOUT DETECTED: When timeout fires (with elapsed time, limit, pauseCount)**

**Key insights to look for:**
- **CRITICAL: Is timeout firing when pauseCount > 0?**
- What is the pauseCount when timeout fires?
- Which agent is timing out?

### 9. AgentTool.ts - Interruption detection (lines 756-787)

**What it logs:**
- Response length and first 100 characters
- Results of ALL detection checks:
  - includes '[Request interrupted'
  - includes 'Interrupted. Tell Ally what to do instead.'
  - includes 'Permission denied. Tell Ally what to do instead.'
  - equals USER_FACING_INTERRUPTION constant
  - equals USER_FACING_DENIAL constant
  - length < minimum threshold
- **DETECTED: When interruption is caught**
- **VALID: When response passes detection**
- Whether summary extraction was used

**Key insights to look for:**
- Is the interruption message being detected?
- Which detection pattern matches (if any)?
- What is the actual message content?

### 10. Agent.ts - Returning USER_FACING_INTERRUPTION (lines 1296-1298, 1340-1342)

**What it logs:**
- **WHERE: Two locations where this message is returned**
  1. After timeout with no canContinueAfterTimeout flag
  2. After ResponseProcessor with no canContinueAfterInterjection flag
- Which agent is returning the message
- Why it's being returned (context)

**Key insights to look for:**
- Which path is triggering the interruption message?
- Which agent is returning it?
- Is it the parent or child agent?

## How to Use the Logs

### 1. Run the test that triggers the bug

```bash
npm start
# Then try a nested agent scenario like:
# "Can you document this codebase for me in chat? Use a task agent"
```

### 2. Filter the console output

```bash
# All debug logs
grep "DEBUG-" output.log

# Just parent lookup
grep "DEBUG-PARENT" output.log

# Just pause/resume operations
grep "DEBUG-PAUSE\|DEBUG-RESUME\|DEBUG-MONITOR" output.log

# Just timeouts
grep "DEBUG-MONITOR-STATE.*TIMEOUT" output.log

# Just interruption detection
grep "DEBUG-DETECTION\|DEBUG-INTERRUPT" output.log
```

### 3. Key Questions to Answer

1. **Is getParentAgent() finding the correct parent?**
   - Look for `[DEBUG-PARENT] FOUND parent agent via DelegationContextManager` vs `[DEBUG-PARENT] FALLBACK to main agent`
   - Check if parent IDs match expectations

2. **Is parentAgent being set correctly in constructor?**
   - Look for `[DEBUG-INIT] Constructor: parentAgent set to`
   - Should not be null for sub-agents

3. **Is pause being called on the right agent?**
   - Look for `[DEBUG-PAUSE] CALLING pauseActivityMonitoring on parent:`
   - Verify agent ID is the immediate parent, not main agent

4. **Is the ActivityMonitor actually being paused?**
   - Look for `[DEBUG-MONITOR-STATE] PAUSED watchdog`
   - Check pauseCount values

5. **Are timeouts firing for paused agents?**
   - **CRITICAL**: Look for `[DEBUG-MONITOR-STATE] TIMEOUT DETECTED!` with `pauseCount > 0`
   - This would prove the ActivityMonitor pause logic is broken

6. **Is resume being called?**
   - Look for `[DEBUG-RESUME] CALLING resumeActivityMonitoring on parent:`
   - Should happen in finally block

7. **Is the interruption message being detected?**
   - Look for `[DEBUG-DETECTION] DETECTED interruption/incomplete response`
   - If missing, the detection is failing

8. **Which agent is returning USER_FACING_INTERRUPTION?**
   - Look for `[DEBUG-INTERRUPT]` messages
   - Track which agent (by instanceId) is returning the message

## Expected Flow (If Working Correctly)

```
1. Main agent creates Task1
   [DEBUG-INIT] Task1: isSpecializedAgent=true, parentCallId=call_xxx
   [DEBUG-PARENT] Task1: getParentAgent called
   [DEBUG-PARENT] Task1: FALLBACK to main agent (depth 1 is expected)

2. Task1 starts execution
   [DEBUG-PAUSE] Task1: CALLING pauseActivityMonitoring on parent: agent-main
   [DEBUG-MONITOR-STATE] agent-main: PAUSED watchdog

3. Task1 creates Task2
   [DEBUG-INIT] Task2: isSpecializedAgent=true, parentCallId=call_yyy
   [DEBUG-PARENT] Task2: getParentAgent called
   [DEBUG-PARENT] Task2: FOUND parent agent via DelegationContextManager: agent-Task1

4. Task2 starts execution
   [DEBUG-PAUSE] Task2: CALLING pauseActivityMonitoring on parent: agent-Task1
   [DEBUG-MONITOR-STATE] agent-Task1: PAUSED watchdog

5. Task2 completes
   [DEBUG-RESUME] Task2: CALLING resumeActivityMonitoring on parent: agent-Task1
   [DEBUG-MONITOR-STATE] agent-Task1: RESUMED watchdog

6. Task1 completes
   [DEBUG-RESUME] Task1: CALLING resumeActivityMonitoring on parent: agent-main
   [DEBUG-MONITOR-STATE] agent-main: RESUMED watchdog
```

## What We're Looking For (Bug Symptoms)

**Symptom 1: Parent lookup failing**
```
[DEBUG-PARENT] Task2: Parent context not found for parentCallId: call_yyy
[DEBUG-PARENT] Task2: FALLBACK to main agent: agent-main
```
This would mean DelegationContextManager lookup is broken.

**Symptom 2: Pause not being called**
```
[DEBUG-PAUSE] Task2: NOT pausing (no parent or no method)
```
This would mean this.parentAgent is null or missing method.

**Symptom 3: Timeout firing while paused**
```
[DEBUG-MONITOR-STATE] agent-Task1: checkTimeout() skipped (paused, pauseCount=1)
[DEBUG-MONITOR-STATE] agent-Task1: checkTimeout() skipped (paused, pauseCount=1)
[DEBUG-MONITOR-STATE] agent-Task1: TIMEOUT DETECTED! elapsed=120s, pauseCount=1
```
This would mean ActivityMonitor pause logic is broken (checkTimeout should skip when paused).

**Symptom 4: Resume not being called**
```
# Task2 completes but no:
[DEBUG-RESUME] Task2: CALLING resumeActivityMonitoring
```
This would mean finally block isn't executing or this.parentAgent is null.

**Symptom 5: Detection failing**
```
[DEBUG-DETECTION] Response length: 42, first 100 chars: "Interrupted. Tell Ally what to do instead."
[DEBUG-DETECTION]   - includes 'Interrupted. Tell Ally': true
[DEBUG-DETECTION] DETECTED interruption/incomplete response
```
If we see `true` but NOT `DETECTED`, the detection logic is broken.

**Symptom 6: Message returned from wrong agent**
```
[DEBUG-INTERRUPT] agent-Task1: Returning USER_FACING_INTERRUPTION
```
Track which agent returns the message and trace back why.

## Next Steps

1. Run the test
2. Grep the output for the debug prefixes
3. Compare actual flow to expected flow above
4. Identify which symptom is occurring
5. Report findings with specific log excerpts
