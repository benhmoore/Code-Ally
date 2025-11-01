# AgentTool Persistence: Quick Reference

## TL;DR - The Problem

**AgentTool** creates a new Agent instance every time it's called, then immediately destroys it.
- No agent reuse (unlike ExploreTool/PlanTool with AgentPoolService)
- No persistence support yet
- Inefficient for repeated tasks with same agent_name

## The Solution in 3 Parts

### 1. AgentTool Gets `persist` Parameter
```typescript
agent(agent_name="analyzer", task_prompt="...", persist=true)
                                                  ↑
                                            NEW parameter
```

### 2. Pool Key for Strict Matching
```
Current (WRONG):     isSpecializedAgent == true  →  match ANY specialized agent
Proposed (RIGHT):    agent-name@prompt-hash@tools-hash  →  exact match
```

### 3. Conditional Cleanup
```
persist=true:   pooledAgent.release()   (returns to pool for reuse)
persist=false:  await subAgent.cleanup()  (destroys immediately)
```

---

## Files to Change

| File | Change | Priority |
|------|--------|----------|
| `/src/tools/AgentTool.ts` | Add persist param + pool integration | HIGH |
| `/src/services/AgentPoolService.ts` | Update findAvailableAgent() matching | MEDIUM |
| `/src/agent/Agent.ts` | Add _poolKey to AgentConfig interface | MEDIUM |
| `/src/services/AgentManager.ts` | Optional: add caching | LOW |

---

## Code Structure Cheat Sheet

### Current AgentTool Flow (Ephemeral)
```
executeImpl()
  ↓ args.agent_name, args.task_prompt
  ↓
executeSingleAgent()
  ↓ getAgentManager().loadAgent(agentName)  ← loads from disk
  ↓
executeAgentTask()
  ↓ new Agent()  ← CREATE fresh agent
  ↓ subAgent.sendMessage()  ← EXECUTE
  ↓ finally: await subAgent.cleanup()  ← DESTROY
```

### Proposed AgentTool Flow (With Pooling)
```
executeImpl()
  ↓ args.agent_name, args.task_prompt, args.persist
  ↓
executeSingleAgent()
  ├─ getAgentManager().loadAgent(agentName)  ← load from disk
  │
  ├─ IF persist && agentPoolService:
  │  │
  │  ├─ createAgentPoolKey(agentData)  ← NEW: agent-name@hash@hash
  │  │
  │  ├─ agentPoolService.acquire(agentConfig)  ← NEW: try pool first
  │  │  ├─ findAvailableAgent()  ← UPDATED: check _poolKey
  │  │  └─ if found: return pooledAgent (no new creation)
  │  │
  │  └─ executeWithPooledAgent()
  │     ├─ regenerate systemPrompt (combines base + task)
  │     ├─ sendMessage()
  │     └─ pooledAgent.release()  ← return to pool
  │
  └─ ELSE (persist=false or no pool):
     ├─ new Agent()  ← CREATE fresh agent
     ├─ sendMessage()
     └─ await subAgent.cleanup()  ← destroy
```

---

## Key Line References

### AgentTool.ts
- **72-107**: Parameter validation (add persist here)
- **145-174**: Agent loading from disk (agentManager.loadAgent)
- **223-310**: Sub-agent creation (new Agent())
- **320-367**: Execution and response handling
- **372-378**: Cleanup pattern (modify for pooling)
- **442-447**: getAgentManager() lazy init

### AgentPoolService.ts
- **278-292**: findAvailableAgent() pool matching (UPDATE THIS)

### Agent.ts
- **32-51**: AgentConfig interface (add _poolKey fields)
- **1710-1723**: Agent.cleanup() implementation

### AgentManager.ts
- **71-81**: loadAgent() from disk (add caching optionally)
- **221-275**: parseAgentFile() YAML parsing

---

## Pool Key Implementation

```typescript
// Create stable, deterministic key for pool matching
function createAgentToolPoolKey(agentData: AgentData): string {
  const name = agentData.name;
  const promptHash = hashString(agentData.system_prompt);
  const toolsStr = (agentData.tools || []).sort().join('|');
  const toolsHash = hashString(toolsStr);
  
  return `agent-${name}@${promptHash}@${toolsHash}`;
  // e.g., "agent-analyzer@a1b2c3d4@x9y8z7w6"
}

function hashString(s: string): string {
  return crypto
    .createHash('sha256')
    .update(s)
    .digest('hex')
    .substring(0, 8);
}
```

Why this works:
- **agent-name**: Different agents have different names
- **prompt-hash**: Loaded from different .md files (different content)
- **tools-hash**: Each agent may have different tool restrictions

---

## What Changes vs What Doesn't

### What CHANGES (AgentTool specific)
- Add persist parameter
- Pool key creation based on agent_name + tools + prompt
- Conditional cleanup (release vs cleanup)
- System prompt regeneration on reuse

### What DOESN'T CHANGE
- Agent loading from disk (still via AgentManager)
- Tool filtering logic
- System prompt generation algorithm
- Sub-agent execution flow (sendMessage)
- Interrupt handling

---

## Why Current Pool Matching Fails

```typescript
// AgentPoolService.findAvailableAgent() (CURRENT - TOO LOOSE)
if (metadata.config.isSpecializedAgent === agentConfig.isSpecializedAgent) {
  return metadata;  // Returns ANY specialized agent!
}

// Problem:
agent(agent_name="analyzer", ...)  → Creates Agent with tools=[read, grep]
agent(agent_name="coder", ...)     → Finds pooled "analyzer" agent
                                   → REUSES it (WRONG!)
                                   → Runs coder task with analyzer tools
```

### The Fix
```typescript
// AgentPoolService.findAvailableAgent() (PROPOSED - STRICT)
if (agentConfig._poolKey && metadata.config._poolKey) {
  if (metadata.config._poolKey === agentConfig._poolKey) {
    return metadata;  // EXACT match only!
  }
}
// Different pool keys = different agents = no match = create new
```

---

## Testing Strategy

### Test 1: Basic Pooling
```
1. agent(agent_name="test", task_prompt="task1", persist=true)
   → Creates new agent, pools as test-pool-key
   
2. agent(agent_name="test", task_prompt="task2", persist=true)
   → Finds pooled agent with same test-pool-key
   → Reuses it (systemPrompt regenerated)
   
3. Check agent_id same in both responses
   → If persist=true, response includes agent_id
```

### Test 2: No Cross-Contamination
```
1. agent(agent_name="analyzer", task_prompt="...", persist=true)
   → Creates analyzer agent
   
2. agent(agent_name="coder", task_prompt="...", persist=true)
   → Should NOT reuse analyzer agent
   → Different pool keys
   → Creates new coder agent
   
3. Verify different agent_id values
```

### Test 3: Fallback to Ephemeral
```
1. agent(agent_name="test", task_prompt="...", persist=false)
   → Does NOT use pool
   → Creates ephemeral agent
   → Destroys after use
   
2. No agent_id in response (or undefined)
```

---

## Questions & Decisions

### Q1: Should agents be reused across different tasks?
**A:** YES - Only agent_name + tools affect pool key
- Task 1: `explore(...)` with agent "analyzer"
- Task 2: `explore(...)` with agent "analyzer" 
- Both reuse the same pooled agent
- systemPrompt regenerated on each use (key is baseAgentPrompt, not systemPrompt)

### Q2: What if agent file is modified while in pool?
**A:** Risk of stale data
- Mitigation 1: File watchers invalidate pool entries
- Mitigation 2: Version numbers in AgentData
- Mitigation 3: Accept stale data (user can restart)
- Recommendation: Start simple, add caching/invalidation later

### Q3: Should we return agent_id for all agents?
**A:** YES - adds consistency with ExploreTool/PlanTool
- Returns only if persist=true
- Allows future tool chaining (ask_agent(agent_id="..."))

### Q4: Should AgentManager cache agent files?
**A:** YES, but optional
- Avoids repeated disk reads
- Cache invalidation on saveAgent()
- Start with this optimization in Phase 3

---

## Debug Checklist

When implementing, verify:

- [ ] persist parameter added to getFunctionDefinition()
- [ ] persist parameter extracted in executeImpl()
- [ ] createAgentPoolKey() produces consistent keys
- [ ] Pool key included in AgentConfig as _poolKey
- [ ] findAvailableAgent() checks _poolKey for AgentTool agents
- [ ] systemPrompt regenerated on pooled agent reuse
- [ ] cleanup conditional: release() for pooled, cleanup() for ephemeral
- [ ] Error handling works for both paths
- [ ] agent_id returned in response when persist=true
- [ ] Different agent_name values produce different pool keys
- [ ] Different tool arrays produce different pool keys
- [ ] Same agent_name + tools reuses pooled agent

---

## Migration Notes

This is a **backwards-compatible change**:
- No API breaks (persist is optional, defaults to true)
- Ephemeral mode still works (persist=false)
- ExploreTool/PlanTool unaffected (different pool key logic)
- gradual rollout: add feature, test, optimize

