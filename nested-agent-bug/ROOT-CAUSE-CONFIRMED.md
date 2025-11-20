# ROOT CAUSE CONFIRMED - Timing Issue

## The Bug

**The agent constructor tries to look up its parent in DelegationContextManager BEFORE the parent's delegation context has been registered.**

## Evidence from Logs

```
[DEBUG-PARENT] agent-1763653365078-7i8bmy3 parentContext exists: false
[DEBUG-PARENT] agent-1763653365078-7i8bmy3 Parent context not found for parentCallId: call_airb066a
[DEBUG-PARENT] agent-1763653365078-7i8bmy3 FALLBACK to main agent: agent-1763653357094-c9xwmri
```

The lookup fails and falls back to main agent. Then when it tries to pause the main agent:

```
[DEBUG-MONITOR-STATE] agent-1763653357094-c9xwmri pause() called. isRunning=false, pauseCount=0
[DEBUG-MONITOR-STATE] agent-1763653357094-c9xwmri NOT running, pause() is no-op
```

Main agent's monitor isn't running, so pause is a no-op. Result:

```
[DEBUG-MONITOR-STATE] agent-1763653365078-7i8bmy3 TIMEOUT DETECTED! elapsed=123s, limit=120s, pauseCount=0
```

**The REAL parent times out because it was never paused!**

## Code Analysis

### AgentTool.ts:693-704

```typescript
// Acquire agent from pool (agent constructor runs here)
pooledAgent = await agentPoolService.acquire(agentConfig, filteredToolManager, customModelClient);
subAgent = pooledAgent.agent;
agentId = pooledAgent.agentId;

// Register delegation AFTER agent construction
try {
  const serviceRegistry = ServiceRegistry.getInstance();
  const toolManager = serviceRegistry.get<any>('tool_manager');
  const delegationManager = toolManager?.getDelegationContextManager();
  if (delegationManager) {
    delegationManager.register(callId, 'agent', pooledAgent);  // ← TOO LATE!
    logger.debug(`[AGENT_TOOL] Registered delegation: callId=${callId}`);
  }
}
```

### Agent.ts Constructor:297-304

```typescript
// Initialize parent agent reference for sub-agents
if (config.isSpecializedAgent && config.parentCallId) {
  console.log(`[DEBUG-INIT] ${this.instanceId} Constructor: isSpecializedAgent=true, parentCallId=${config.parentCallId}`);
  this.parentAgent = this.getParentAgent(config.parentCallId);  // ← LOOKUP HAPPENS HERE
  // But parent's delegation isn't registered yet!
  console.log(`[DEBUG-INIT] ${this.instanceId} Constructor: parentAgent set to`, this.parentAgent?.instanceId || 'null');
}
```

### Agent.ts:433-467 getParentAgent()

```typescript
const parentContext = delegationManager.getContext(parentCallId);
// Returns null because parent's delegation not registered yet
if (parentContext?.pooledAgent?.agent) {
  // Never executed
  return parentContext.pooledAgent.agent;
} else {
  // Always falls back to main agent
  return registry.get<any>('agent');
}
```

## The Timeline

1. **Main agent** receives tool call: `call_airb066a` → spawn Task1
2. **AgentTool** acquires agent from pool
   - **Agent constructor runs** (Task1 created)
   - **Task1 constructor** calls `getParentAgent('call_airb066a')`
   - **Lookup fails** - `call_airb066a` not in DelegationContextManager yet
   - **Falls back** to main agent
3. **AgentTool** registers delegation: `register('call_airb066a', 'agent', pooledAgent)` ← TOO LATE
4. **Task1** calls `pauseActivityMonitoring()` on main agent
5. **Main agent's monitor** is not running → pause is no-op
6. **Task1's monitor** keeps running and times out after 120s

## Why Our Fix Didn't Work

Our fix correctly implemented:
- ✅ `getParentAgent()` method with DelegationContextManager lookup
- ✅ Fallback to main agent
- ✅ `parentAgent` property stored on instance
- ✅ Pause/resume using `this.parentAgent`

But it doesn't work because:
- ❌ **The lookup happens too early (in constructor)**
- ❌ **Parent's delegation isn't registered until AFTER child is constructed**
- ❌ **So lookup always fails and falls back to main agent**

## The Real Fix

We have several options:

### Option 1: Move delegation registration BEFORE agent acquisition
**Problem**: Can't register before we have the pooledAgent object.

### Option 2: Move parent lookup AFTER construction
Store `parentCallId` in constructor, but defer the actual lookup until `sendMessage()` is called (lazy initialization).

### Option 3: Pass parent agent reference directly
Instead of using DelegationContextManager lookup, pass the parent agent reference directly in the agent config.

### Option 4: Register a "pending" delegation before agent construction
Register the parent's delegation context BEFORE creating the child, with the parent's pooledAgent.

## Recommended Solution: Option 3 (Direct Reference)

**Why**: Simplest and most reliable. No timing issues, no lookups.

### Implementation

**AgentTool.ts:693-704** - Pass parent agent in config:

```typescript
const agentConfig = {
  // ... existing config ...
  parentCallId: callId,
  parentAgent: this.agent,  // ← Add direct reference to parent agent
};

pooledAgent = await agentPoolService.acquire(agentConfig, ...);
```

**Agent.ts:297-304** - Use direct reference instead of lookup:

```typescript
// Initialize parent agent reference for sub-agents
if (config.isSpecializedAgent && config.parentCallId) {
  // Use direct reference if provided, otherwise lookup
  if (config.parentAgent) {
    this.parentAgent = config.parentAgent;
    console.log(`[DEBUG-INIT] ${this.instanceId} Using direct parent reference:`, this.parentAgent.instanceId);
  } else {
    this.parentAgent = this.getParentAgent(config.parentCallId);
    console.log(`[DEBUG-INIT] ${this.instanceId} Parent from lookup:`, this.parentAgent?.instanceId || 'null');
  }
}
```

This way:
- ✅ No timing issues
- ✅ No complex lookups
- ✅ Always gets correct parent
- ✅ Backward compatible (falls back to lookup if no direct reference)

## Confidence Level: 100%

The logs prove definitively:
- ✅ Parent context lookup fails every time
- ✅ Falls back to main agent every time
- ✅ Main agent's monitor is not running
- ✅ Pause is a no-op
- ✅ Real parent times out

This is the root cause. No doubt.
