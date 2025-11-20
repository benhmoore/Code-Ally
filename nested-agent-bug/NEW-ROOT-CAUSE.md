# NEW ROOT CAUSE DISCOVERED

## The Bug

**The `parentCallId` being passed to sub-agents is the CHILD's callId, not the PARENT's.**

## Evidence

```
[DEBUG-PARENT] agent-1763654174371-wbnogle FOUND parent agent via DelegationContextManager: agent-1763654174371-wbnogle
```

**The agent found ITSELF as its own parent!** Same instanceId for both agent and "parent".

## Why This Happens

### AgentTool.ts:678
```typescript
const agentConfig: AgentConfig = {
  // ...
  parentCallId: callId,  // ← BUG: This is the CHILD's callId!
};
```

### AgentTool.ts:704
```typescript
delegationManager.register(callId, 'agent', pooledAgent);  // Registers CHILD
```

### Agent.ts getParentAgent():442
```typescript
const parentContext = delegationManager.getContext(parentCallId);
// parentCallId === callId (the child's own callId)
// So it finds the CHILD's own delegation context!
if (parentContext?.pooledAgent?.agent) {
  return parentContext.pooledAgent.agent;  // Returns itself!
}
```

## The Flow

1. **Main agent** calls AgentTool with `callId = call_abc`
2. **AgentTool** creates child agent with `parentCallId: call_abc`
3. **AgentTool** registers child: `delegationManager.register(call_abc, 'agent', childPooledAgent)`
4. **Child agent** calls `getParentAgent(call_abc)`
5. **DelegationContextManager** returns the context for `call_abc` → **child's own context!**
6. **Child agent** sets `this.parentAgent = itself`
7. **Child tries to pause** "parent" but it's pausing itself
8. **Child's monitor** is not running yet (`isRunning=false`) → pause is no-op
9. **Child's monitor** keeps running and times out

## The Correct Solution

We cannot use `parentCallId` for lookup because:
- The `callId` identifies the **tool call that's being executed**
- That tool call **creates the child agent**
- So `callId` maps to the **child**, not the parent

**We need to pass the parent agent directly**, not try to look it up.

## Implementation: Pass Parent Agent Directly

### AgentTool.ts changes

Add before line 693:
```typescript
// Get parent agent reference (this AgentTool is owned by the parent agent)
const parentAgent = this.getParentAgentInstance();
```

Add method to AgentTool class:
```typescript
private getParentAgentInstance(): any {
  // AgentTool is attached to the parent agent via injection
  // We need to find which agent is currently executing this tool
  try {
    const registry = ServiceRegistry.getInstance();
    const toolManager = registry.get<any>('tool_manager');
    const delegationManager = toolManager?.getDelegationContextManager();

    if (delegationManager) {
      // Find the executing context (the parent agent that called this tool)
      const executingContext = delegationManager.getCurrentExecutingContext();
      if (executingContext?.pooledAgent?.agent) {
        return executingContext.pooledAgent.agent;
      }
    }

    // Fallback: main agent
    return registry.get<any>('agent');
  } catch (error) {
    logger.debug('[AGENT_TOOL] Could not get parent agent:', error);
    return null;
  }
}
```

Update agentConfig at line 672:
```typescript
const agentConfig: AgentConfig = {
  // ... existing fields ...
  parentAgent: parentAgent,  // Add this - direct reference
  parentCallId: callId,      // Keep for backward compat/debugging
};
```

### Agent.ts changes

Add to AgentConfig interface:
```typescript
export interface AgentConfig {
  // ... existing fields ...
  parentAgent?: any;  // Direct reference to parent agent for pause/resume
}
```

Update lazy initialization in sendMessage() line 620:
```typescript
// Lazy initialization: Resolve parent agent on first sendMessage() call
if (this.config.isSpecializedAgent && !this.parentAgent) {
  // Prefer direct reference if provided
  if (this.config.parentAgent) {
    console.log(`[DEBUG-LAZY-INIT] ${this.instanceId} Using direct parent reference`);
    this.parentAgent = this.config.parentAgent;
    console.log(`[DEBUG-LAZY-INIT] ${this.instanceId} Parent agent:`, this.parentAgent?.instanceId || 'null');
  } else if (this.config.parentCallId) {
    // Fallback to lookup (will likely fail as before)
    console.log(`[DEBUG-LAZY-INIT] ${this.instanceId} Falling back to parent lookup (parentCallId: ${this.config.parentCallId})`);
    this.parentAgent = this.getParentAgent(this.config.parentCallId);
    console.log(`[DEBUG-LAZY-INIT] ${this.instanceId} Parent agent resolved to:`, this.parentAgent?.instanceId || 'null');
  }
}
```

## Alternative: Even Simpler

Since AgentTool has access to ServiceRegistry, it can just get the current agent:

```typescript
// In AgentTool.executeAgentTask(), before creating agentConfig:
const parentAgent = registry.get<any>('agent');  // Gets main agent for depth-1
// OR for nested: we need the agent that owns this AgentTool instance
```

Actually, the problem is we don't know which agent instance is executing AgentTool. We need the **executing agent**, not the main agent.

## Real Solution: Track Executing Agent in Tool Context

The ToolOrchestrator needs to pass the executing agent to tools, or tools need access to it via `this.agent` or similar.

Looking at BaseTool and InjectableTool interfaces...
