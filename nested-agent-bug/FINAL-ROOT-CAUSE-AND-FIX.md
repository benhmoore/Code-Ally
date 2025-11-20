# Final Root Cause Analysis and Fix

## Executive Summary

**The Bug:** Nested agents return `"Interrupted. Tell Ally what to do instead."` to parent agents as tool result content.

**Root Cause:** Agent.ts retrieves the wrong parent agent when attempting to pause activity monitors. It always gets the Main agent from ServiceRegistry instead of the immediate parent, causing nested agents' monitors to timeout spuriously.

**Impact:** In nested scenarios (depth > 1), activity monitors are not properly paused, leading to cascade timeouts and interruption messages leaking into parent conversations.

---

## Complete Bug Path (Confirmed by Logs)

### Scenario: Main → Task1 → Task2 → Explore

1. **Main agent** calls Task1 (depth 1)
   - Task1 correctly pauses Main's monitor (Main is retrieved from registry ✓)
   - Task1's monitor starts

2. **Task1** calls Task2 (depth 2)
   - Task2 tries to pause parent's monitor
   - `registry.get('agent')` returns **Main** instead of Task1 ✗
   - Task2 pauses Main's monitor (already paused, no effect)
   - **Task1's monitor keeps running** ✗
   - Task2's monitor starts

3. **Task2** calls Explore (depth 3)
   - Explore tries to pause parent's monitor
   - `registry.get('agent')` returns **Main** instead of Task2 ✗
   - Explore pauses Main's monitor (already paused, no effect)
   - **Task2's monitor keeps running** ✗
   - Explore's monitor starts

4. **Explore makes tool calls** (tree, read, read, read...)
   - Takes time to execute
   - After 120 seconds, **Task1's monitor fires timeout** ✗
   - Task1 sets interrupted flag, stops
   - Task1 logs: "Timeout detected: 120s since last activity"

5. **Explore returns empty response**
   - LLM request was aborted by parent timeout
   - Empty response triggers GAP 1 continuation logic
   - Continuation attempt also gets aborted
   - Explore returns empty to Task2

6. **Task2 receives empty from Explore**
   - After 126 seconds total, **Task2's monitor also fires timeout** ✗
   - Task2 sets interrupted flag
   - Task2 checks: "Agent interrupted during tool execution - stopping follow-up"
   - Task2 returns empty string from sendMessage()

7. **AgentTool (in Task1) receives empty from Task2**
   - Detects empty response (line 732)
   - Tries to extract summary from conversation - fails
   - Makes **second sendMessage() call** to request summary (line 741)
   - Second call starts but Task1 is ALREADY interrupted
   - Second call immediately hits interrupt check
   - Returns `"Interrupted. Tell Ally what to do instead."` (line 1234)

8. **AgentTool receives interruption message**
   - Length: 42 characters
   - Detection check at line 756: `response.includes('[Request interrupted')` - **FAILS** ✗
   - Does NOT match `"Interrupted. Tell Ally what to do instead."`
   - Message passes through as finalResponse (line 762/765)
   - Wrapped and returned as tool result to parent

9. **Task1 returns interruption message to Main**
   - Same double-sendMessage pattern
   - Same detection failure
   - Interruption message propagates up

10. **Main agent receives interruption as tool result**
    - Message appears in conversation history as tool result content
    - Main agent reads it, interprets as context
    - Main agent decides to retry with "quick" thoroughness

---

## The Root Cause: Wrong Parent Agent Retrieved

### The Broken Code

**File:** `/Users/bhm128/CodeAlly/src/agent/Agent.ts:557-570`

```typescript
// Detect if this is a sub-agent and get parent agent reference for pause/resume
const isSubAgent = this.config.isSpecializedAgent && this.config.parentCallId;
let parentAgent: any = null;

if (isSubAgent) {
  try {
    const registry = ServiceRegistry.getInstance();
    parentAgent = registry.get<any>('agent');  // ← BUG: Always returns Main agent
  } catch (error) {
    logger.debug('[AGENT]', this.instanceId, 'Could not get parent agent from registry:', error);
  }
}
```

### Why This is Wrong

**The 'agent' key in ServiceRegistry is set ONCE at startup:**

**File:** `/Users/bhm128/CodeAlly/src/cli.ts:1061`
```typescript
registry.registerInstance('agent', agent);  // Main agent registered once
```

**It never changes.** Every sub-agent that calls `registry.get('agent')` gets the Main agent, regardless of actual nesting depth.

### What Should Happen

Each sub-agent should retrieve its **immediate parent** agent to pause the correct monitor.

**Available but unused data:**
- `config.parentCallId` contains the call ID that spawned this agent
- `DelegationContextManager` tracks all active delegations by callId
- Each delegation context contains the `pooledAgent` with the actual agent instance

---

## The Fix

### Primary Fix: Use DelegationContextManager to Get Parent

**File:** `/Users/bhm128/CodeAlly/src/agent/Agent.ts:557-577`

Replace the broken parent retrieval:

```typescript
// CURRENT (BROKEN):
if (isSubAgent) {
  try {
    const registry = ServiceRegistry.getInstance();
    parentAgent = registry.get<any>('agent');
  } catch (error) {
    logger.debug('[AGENT]', this.instanceId, 'Could not get parent agent from registry:', error);
  }
}

if (parentAgent && typeof parentAgent.pauseActivityMonitoring === 'function') {
  parentAgent.pauseActivityMonitoring();
  logger.debug('[AGENT]', this.instanceId, 'Pausing parent agent activity monitoring (sub-agent starting)');
}
```

With correct parent lookup:

```typescript
// FIXED:
if (isSubAgent) {
  try {
    const registry = ServiceRegistry.getInstance();

    // Try to get parent from DelegationContextManager using parentCallId
    const toolManager = registry.get<any>('tool_manager');
    const delegationManager = toolManager?.getDelegationContextManager();

    if (delegationManager && this.config.parentCallId) {
      const parentContext = delegationManager.getContext(this.config.parentCallId);
      if (parentContext?.pooledAgent?.agent) {
        parentAgent = parentContext.pooledAgent.agent;
        logger.debug('[AGENT]', this.instanceId,
          `Found parent agent via DelegationContextManager (parentCallId: ${this.config.parentCallId})`);
      } else {
        logger.debug('[AGENT]', this.instanceId,
          `Parent context not found for parentCallId: ${this.config.parentCallId}`);
      }
    }

    // Fallback: Use main agent from registry
    // This handles cases where:
    // - DelegationContextManager lookup fails
    // - Agent is direct child of Main (depth 1)
    if (!parentAgent) {
      parentAgent = registry.get<any>('agent');
      logger.debug('[AGENT]', this.instanceId, 'Using main agent from registry as parent');
    }
  } catch (error) {
    logger.debug('[AGENT]', this.instanceId, 'Could not get parent agent:', error);
  }
}

// Pause parent's monitor if found
if (parentAgent && typeof parentAgent.pauseActivityMonitoring === 'function') {
  parentAgent.pauseActivityMonitoring();
  logger.debug('[AGENT]', this.instanceId,
    `Pausing parent agent activity monitoring (parent: ${parentAgent.instanceId || 'unknown'})`);
}
```

### Same Fix Needed in Finally Block

**File:** `/Users/bhm128/CodeAlly/src/agent/Agent.ts:834-840`

The resume logic has the same bug:

```typescript
// CURRENT (BROKEN):
if (parentAgent && typeof parentAgent.resumeActivityMonitoring === 'function') {
  parentAgent.resumeActivityMonitoring();
  logger.debug('[AGENT]', this.instanceId, 'Resuming parent agent activity monitoring (sub-agent completed)');
}
```

Should use the same parentAgent retrieved at the start of sendMessage(). This requires moving the parentAgent variable to a class property or closure variable so it persists to the finally block.

**Recommended approach:** Make `parentAgent` a property on the Agent class that gets set once during construction:

```typescript
// In Agent constructor:
if (config.isSpecializedAgent && config.parentCallId) {
  this.parentAgent = this.getParentAgent(config.parentCallId);
}

// New method:
private getParentAgent(parentCallId: string): any {
  try {
    const registry = ServiceRegistry.getInstance();
    const toolManager = registry.get<any>('tool_manager');
    const delegationManager = toolManager?.getDelegationContextManager();

    if (delegationManager) {
      const parentContext = delegationManager.getContext(parentCallId);
      if (parentContext?.pooledAgent?.agent) {
        return parentContext.pooledAgent.agent;
      }
    }

    // Fallback to main agent
    return registry.get<any>('agent');
  } catch (error) {
    logger.debug('[AGENT]', this.instanceId, 'Could not get parent agent:', error);
    return null;
  }
}

// Then in sendMessage:
if (this.parentAgent && typeof this.parentAgent.pauseActivityMonitoring === 'function') {
  this.parentAgent.pauseActivityMonitoring();
}

// And in finally block:
if (this.parentAgent && typeof this.parentAgent.resumeActivityMonitoring === 'function') {
  this.parentAgent.resumeActivityMonitoring();
}
```

### Secondary Fix: Detection of Interruption Messages

**File:** `/Users/bhm128/CodeAlly/src/tools/AgentTool.ts:756`

Even with the primary fix, we should add defense-in-depth:

```typescript
// CURRENT:
if (response.includes('[Request interrupted') || response.length < TEXT_LIMITS.AGENT_RESPONSE_MIN) {
```

Should be:

```typescript
// FIXED:
if (
  response.includes('[Request interrupted') ||
  response.includes('Interrupted. Tell Ally what to do instead.') ||
  response.includes('Permission denied. Tell Ally what to do instead.') ||
  response === PERMISSION_MESSAGES.USER_FACING_INTERRUPTION ||
  response === PERMISSION_MESSAGES.USER_FACING_DENIAL ||
  response.length < TEXT_LIMITS.AGENT_RESPONSE_MIN
) {
```

This prevents any interruption message from leaking through as valid content.

---

## Why the Primary Fix Works

1. **DelegationContextManager tracks actual parent-child relationships**
   - When AgentTool spawns a sub-agent, it registers the delegation with callId
   - The delegation context stores the pooledAgent containing the parent agent instance

2. **parentCallId points to the correct parent**
   - Sub-agent's `config.parentCallId` is the tool call ID that spawned it
   - This callId maps to the parent's delegation in DelegationContextManager

3. **Lookup is reliable**
   - `getContext(parentCallId)` returns the DelegationContext
   - `context.pooledAgent.agent` gives us the actual parent Agent instance
   - This works at any nesting depth

4. **Fallback preserves existing behavior**
   - If lookup fails, falls back to main agent from registry
   - Depth-1 agents (direct children of Main) work the same
   - Edge cases are handled gracefully

---

## Testing the Fix

### Test Cases

1. **Depth 1: Main → Task1**
   - Task1 should pause Main's monitor ✓
   - Task1 should resume Main's monitor on completion ✓

2. **Depth 2: Main → Task1 → Task2**
   - Task1 should pause Main's monitor ✓
   - Task2 should pause Task1's monitor ✓ (CURRENTLY BROKEN)
   - Task2 completes → resumes Task1's monitor ✓
   - Task1 completes → resumes Main's monitor ✓

3. **Depth 3: Main → Task1 → Task2 → Explore**
   - Each child should pause its immediate parent ✓
   - No spurious timeouts ✓
   - Completion should properly resume each parent ✓

4. **Long-running nested agents (>120s)**
   - Parent monitors should stay paused ✓
   - No "Timeout detected" logs for paused parents ✓
   - Children can run as long as needed ✓

### Expected Log Output After Fix

```
[AGENT] agent-Task2 Found parent agent via DelegationContextManager (parentCallId: call_task1)
[AGENT] agent-Task2 Pausing parent agent activity monitoring (parent: agent-Task1)
[AGENT] agent-Task2 Resuming parent agent activity monitoring (sub-agent completed)
```

Instead of current (broken):
```
[AGENT] agent-Task2 Pausing parent agent activity monitoring (sub-agent starting)
# No parent ID, pausing wrong agent
```

---

## Impact Assessment

### Before Fix
- Nested agents at depth > 1 fail with spurious timeouts
- Interruption messages leak into parent conversations
- Agents misinterpret error messages as context
- Long-running nested tasks are impossible

### After Fix
- Nested agents can run at any depth
- Activity monitors are properly paused/resumed
- No spurious timeouts
- Clean error handling without message leakage

### Breaking Changes
None. The fix is backward compatible:
- Depth-1 agents continue working as before
- Fallback to main agent preserves existing behavior
- Only fixes broken depth > 1 scenarios

---

## Files to Modify

1. **`/Users/bhm128/CodeAlly/src/agent/Agent.ts`**
   - Add `parentAgent` property to class
   - Add `getParentAgent()` private method
   - Update constructor to set `parentAgent` using DelegationContextManager
   - Update sendMessage() pause call to use `this.parentAgent`
   - Update sendMessage() finally block resume call to use `this.parentAgent`

2. **`/Users/bhm128/CodeAlly/src/tools/AgentTool.ts`** (defensive fix)
   - Update line 756 detection to catch all interruption message formats

---

## Confidence Level

**99%** - This is definitively the root cause:

✅ Confirmed by log analysis showing wrong agents timing out
✅ Confirmed by code analysis showing registry.get('agent') always returns Main
✅ Confirmed by two independent agent investigations
✅ Confirmed by understanding of DelegationContextManager infrastructure
✅ Solution is well-understood and straightforward to implement

The 1% uncertainty is only for potential edge cases in implementation details.
