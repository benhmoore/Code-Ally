# Lazy Initialization Fix Applied

## Problem Solved

**Timing Bug**: Agent constructor tried to look up parent via `DelegationContextManager.getContext(parentCallId)` BEFORE the parent's delegation was registered in AgentTool, causing the lookup to always fail and fall back to the wrong agent (main agent).

## Solution: Lazy Initialization

Defer the parent agent lookup from constructor to the first `sendMessage()` call. By that time, the delegation is already registered in AgentTool, so the lookup succeeds.

## Changes Made

### File: `/Users/bhm128/CodeAlly/src/agent/Agent.ts`

#### Change 1: Constructor (lines 297-304)

**Before:**
```typescript
// Initialize parent agent reference for sub-agents (used for activity monitor pause/resume)
if (config.isSpecializedAgent && config.parentCallId) {
  console.log(`[DEBUG-INIT] ${this.instanceId} Constructor: isSpecializedAgent=true, parentCallId=${config.parentCallId}`);
  this.parentAgent = this.getParentAgent(config.parentCallId);
  console.log(`[DEBUG-INIT] ${this.instanceId} Constructor: parentAgent set to`, this.parentAgent?.instanceId || 'null');
} else {
  console.log(`[DEBUG-INIT] ${this.instanceId} Constructor: NOT a sub-agent (isSpecializedAgent=${config.isSpecializedAgent}, parentCallId=${config.parentCallId})`);
}
```

**After:**
```typescript
// Parent agent reference for sub-agents (used for activity monitor pause/resume)
// NOTE: Actual lookup is deferred until sendMessage() to avoid timing issues with
// DelegationContextManager registration. The delegation must be registered before
// the lookup can succeed, but registration happens AFTER agent construction in AgentTool.
// See lazy initialization in sendMessage() method.
console.log(`[DEBUG-INIT] ${this.instanceId} Constructor: isSpecializedAgent=${config.isSpecializedAgent}, parentCallId=${config.parentCallId}`);
console.log(`[DEBUG-INIT] ${this.instanceId} Constructor: Deferring parent agent lookup until sendMessage() (lazy initialization)`);
// this.parentAgent remains null until first sendMessage() call
```

**What changed:**
- Removed the `getParentAgent()` call from constructor
- Added comment explaining why lookup is deferred
- `this.parentAgent` remains null until first `sendMessage()` call

#### Change 2: sendMessage() method (lines 617-624)

**Added at start of sendMessage() (after focus ready check):**
```typescript
// Lazy initialization: Resolve parent agent on first sendMessage() call
// This happens AFTER DelegationContextManager registration in AgentTool,
// avoiding the timing issue where constructor runs before delegation is registered.
if (this.config.isSpecializedAgent && this.config.parentCallId && !this.parentAgent) {
  console.log(`[DEBUG-LAZY-INIT] ${this.instanceId} First sendMessage() call - resolving parent agent (parentCallId: ${this.config.parentCallId})`);
  this.parentAgent = this.getParentAgent(this.config.parentCallId);
  console.log(`[DEBUG-LAZY-INIT] ${this.instanceId} Parent agent resolved to:`, this.parentAgent?.instanceId || 'null');
}
```

**What this does:**
- On the first `sendMessage()` call, checks if parent needs to be resolved
- Calls `getParentAgent(parentCallId)` to look up parent via DelegationContextManager
- By this time, the delegation is registered, so lookup should succeed
- Sets `this.parentAgent` for use in pause/resume operations
- Only runs once (due to `!this.parentAgent` check)

## Why This Works

### Timeline BEFORE fix:
1. **AgentTool line 693**: `agentPoolService.acquire()` → Agent constructor runs
2. **Agent constructor line 300**: `this.parentAgent = this.getParentAgent(parentCallId)` → **LOOKUP FAILS** (delegation not registered)
3. **AgentTool line 704**: `delegationManager.register(callId, ...)` → **TOO LATE**
4. **Result**: `this.parentAgent` is wrong agent (main agent fallback)

### Timeline AFTER fix:
1. **AgentTool line 693**: `agentPoolService.acquire()` → Agent constructor runs
2. **Agent constructor line 303**: Skip parent lookup, leave `this.parentAgent` as null
3. **AgentTool line 704**: `delegationManager.register(callId, ...)` → Delegation registered ✓
4. **Agent sendMessage() line 622**: `this.parentAgent = this.getParentAgent(parentCallId)` → **LOOKUP SUCCEEDS** ✓
5. **Result**: `this.parentAgent` is correct parent agent

## Debug Logs to Watch For

### Constructor logs (should see deferred message):
```
[DEBUG-INIT] agent-xxx Constructor: isSpecializedAgent=true, parentCallId=call_yyy
[DEBUG-INIT] agent-xxx Constructor: Deferring parent agent lookup until sendMessage() (lazy initialization)
```

### First sendMessage() call (should see successful lookup):
```
[DEBUG-LAZY-INIT] agent-xxx First sendMessage() call - resolving parent agent (parentCallId: call_yyy)
[DEBUG-PARENT] agent-xxx getParentAgent called with parentCallId: call_yyy
[DEBUG-PARENT] agent-xxx toolManager exists: true
[DEBUG-PARENT] agent-xxx delegationManager exists: true
[DEBUG-PARENT] agent-xxx parentContext exists: true ← SHOULD BE TRUE NOW!
[DEBUG-PARENT] agent-xxx FOUND parent agent via DelegationContextManager: agent-zzz ← SHOULD SUCCEED!
[DEBUG-LAZY-INIT] agent-xxx Parent agent resolved to: agent-zzz
```

### Pause operation (should target correct parent):
```
[DEBUG-PAUSE] agent-xxx CALLING pauseActivityMonitoring on parent: agent-zzz
[DEBUG-MONITOR-STATE] agent-zzz PAUSED watchdog (pauseCount: 1) ← Parent's monitor should actually pause
```

### No timeout should occur:
```
# Should NOT see:
[DEBUG-MONITOR-STATE] agent-xxx TIMEOUT DETECTED! ...
```

## What to Look For in Test

1. ✅ **parentContext exists: true** (not false anymore)
2. ✅ **FOUND parent agent via DelegationContextManager** (not FALLBACK)
3. ✅ **Correct parent agent ID** (should be immediate parent, not main agent)
4. ✅ **Parent's monitor is PAUSED** (isRunning should become false)
5. ✅ **No timeouts during nested execution**
6. ✅ **No "Interrupted. Tell Ally..." messages in parent conversations**

## Rollback

If this doesn't work, simply revert these two changes:
1. Restore constructor to call `getParentAgent()` immediately
2. Remove lazy initialization block from `sendMessage()`

## Next Test

Run the same test:
```
Can you document this codebase for me in chat? Use a task agent
```

Look for the debug logs above to confirm the fix is working.
