# AgentTool Architecture Analysis

## Executive Summary

AgentTool is a sophisticated delegation system that creates **ephemeral sub-agents** for each execution. Unlike ExploreTool and PlanTool which use AgentPoolService for persistence, AgentTool currently creates new agents every time and discards them immediately after cleanup.

**Key Finding:** AgentTool has **NO persistence support yet** - it loads agents fresh from disk (via AgentManager) each time, executes them, and cleans up immediately. This is the opposite of ExploreTool/PlanTool which persist agents in a pool for reuse.

---

## 1. AgentTool Structure & Key Differences

### 1.1 AgentTool Architecture
**Location:** `/Users/benmoore/CodeAlly-TS/src/tools/AgentTool.ts`

```
AgentTool (BaseTool)
├── Uses: AgentManager (for custom agent loading)
├── Creates: Ephemeral sub-agents (one per execution)
└── Cleanup: Immediate cleanup after each use
```

### 1.2 Critical Differences from ExploreTool/PlanTool

| Aspect | AgentTool | ExploreTool/PlanTool |
|--------|-----------|----------------------|
| **Agent Source** | Loads from disk via AgentManager | Hardcoded system prompts |
| **Tool Filtering** | Configurable per agent (agent.tools field) | Hardcoded read-only tools |
| **Persistence** | NONE - creates new agent each time | AgentPoolService for reuse |
| **Configuration** | AgentData with custom prompts | Fixed system prompts |
| **Pool Matching** | N/A (no pool) | Simple isSpecializedAgent check |
| **Parameter Diversity** | High (agent_name varies, different prompts) | Low (same tools/prompts) |

### 1.3 Why AgentTool Doesn't Currently Use Pooling

From lines 72-106 of AgentTool.ts:
- **No `persist` parameter** - always ephemeral
- **No AgentManager injection** - created fresh via `getAgentManager()` 
- **Direct creation** - creates new Agent instance directly (line 303)
- **No AgentPoolService usage** - unlike ExploreTool (line 225) and PlanTool (line 281)

---

## 2. Agent Creation Flow in AgentTool

### 2.1 Complete Lifecycle (Lines 72-379)

```typescript
// Step 1: Execute Entry Point (lines 72-107)
executeImpl(args) 
  → captures agent_name and task_prompt
  → validates parameters
  → calls executeSingleAgentWrapper()

// Step 2: Agent Loading (lines 145-174)
executeSingleAgent()
  → getAgentManager() [lazy initialized at line 442-447]
  → agentManager.ensureDefaultAgent()
  → agentManager.loadAgent(agentName)  // LOADS FROM DISK
  → returns AgentData { name, description, system_prompt, tools, ... }

// Step 3: System Prompt Creation (lines 260-271)
createAgentSystemPrompt(agentData.system_prompt, taskPrompt)
  → calls getAgentSystemPrompt() from systemMessages.js
  → COMBINES base prompt + task context

// Step 4: Tool Filtering (lines 273-285)
if (agentData.tools) {
  → creates filtered ToolManager with only allowed tools
} else {
  → uses full tool manager (unrestricted access)
}

// Step 5: Sub-Agent Creation (lines 290-310)
new Agent(
  mainModelClient,
  filteredToolManager,
  activityStream,
  agentConfig,  // Contains systemPrompt, baseAgentPrompt, taskPrompt
  configManager,
  permissionManager
)

// Step 6: Execution (lines 320-367)
subAgent.sendMessage(`Execute this task: ${taskPrompt}`)
  → full agent conversation loop
  → with interrupt support

// Step 7: Cleanup (lines 372-378 finally block)
activeDelegations.delete(callId)
subAgent.cleanup()  // DESTROYS agent instance
```

### 2.2 AgentManager.loadAgent() Details

**Location:** `/Users/benmoore/CodeAlly-TS/src/services/AgentManager.ts:71-81`

```typescript
async loadAgent(agentName: string): Promise<AgentData | null> {
  const filePath = join(this.agentsDir, `${agentName}.md`);
  try {
    const content = await readFile(filePath, 'utf-8');
    return this.parseAgentFile(content, agentName);
  } catch (error) {
    logger.debug(`Failed to load agent '${agentName}':`, formatError(error));
    return null;
  }
}
```

**File Format:** Markdown frontmatter in `~/.code_ally/agents/{agent_name}.md`
```
---
name: "agent_name"
description: "Agent description"
tools: ["tool1", "tool2"]  // Optional: tool restrictions
temperature: 0.7  // Optional
model: "claude-3-sonnet"  // Optional
created_at: "2024-01-01T..."
updated_at: "2024-01-01T..."
---

[System prompt body in markdown]
```

### 2.3 Cleanup Pattern (Lines 372-378)

```typescript
finally {
  logger.debug('[AGENT_TOOL] Cleaning up sub-agent...');
  this.activeDelegations.delete(callId);  // Remove from tracking
  
  // Clean up sub-agent
  await subAgent.cleanup();  // DESTROYS instance
}
```

**Agent.cleanup()** (Agent.ts:1710-1723):
```typescript
async cleanup(): Promise<void> {
  logger.debug('[AGENT_CLEANUP]', this.instanceId, 'Cleanup started');
  
  // Stop activity watchdog
  this.stopActivityWatchdog();
  
  // Only close the model client if NOT a specialized subagent
  if (!this.config.isSpecializedAgent && this.modelClient.close) {
    await this.modelClient.close();
  }
  
  logger.debug('[AGENT_CLEANUP]', this.instanceId, 'Cleanup completed');
}
```

**Key Insight:** Cleanup is **minimal** because sub-agents:
- Share the modelClient with parent (don't close it)
- Only stop the activity watchdog
- Messages/state are discarded (not persisted)

---

## 3. Agent Configuration & Matching

### 3.1 AgentConfig Structure

**Location:** `/Users/benmoore/CodeAlly-TS/src/agent/Agent.ts:32-51`

```typescript
export interface AgentConfig {
  isSpecializedAgent?: boolean;      // Flag: true for sub-agents
  allowTodoManagement?: boolean;     // Flag: can manage todos
  verbose?: boolean;                 // Flag: verbose logging
  systemPrompt?: string;             // CURRENT: full specialized prompt
  baseAgentPrompt?: string;          // BASE: original prompt template
  taskPrompt?: string;               // TASK: user's task input
  config: Config;                    // App configuration
  parentCallId?: string;             // Link to parent tool call
  requiredToolCalls?: string[];      // Tools that MUST be called
}
```

### 3.2 How AgentTool Configures Sub-Agents (Lines 293-310)

```typescript
const agentConfig: AgentConfig = {
  isSpecializedAgent: true,
  verbose: false,
  systemPrompt: specializedPrompt,        // Result of prompt generation
  baseAgentPrompt: agentData.system_prompt,  // Original from MD file
  taskPrompt: taskPrompt,                    // User's task_prompt param
  config: config,
  parentCallId: callId,                   // Important for nested tools
};

const subAgent = new Agent(
  mainModelClient,
  filteredToolManager,
  this.activityStream,
  agentConfig,
  configManager,
  permissionManager
);
```

### 3.3 Key Differences vs ExploreTool/PlanTool

**ExploreTool/PlanTool:**
```typescript
const agentConfig: AgentConfig = {
  isSpecializedAgent: true,
  systemPrompt: specializedPrompt,        // Hardcoded prompt + task
  baseAgentPrompt: EXPLORATION_SYSTEM_PROMPT,  // Hardcoded constant
  taskPrompt: taskDescription,
  config: config,
  parentCallId: callId,
};
```

**AgentTool:**
```typescript
const agentConfig: AgentConfig = {
  isSpecializedAgent: true,
  systemPrompt: specializedPrompt,        // Generated from agent.md + task
  baseAgentPrompt: agentData.system_prompt,  // FROM DISK (varies)
  taskPrompt: taskPrompt,                 // FROM PARAM (varies)
  config: config,
  parentCallId: callId,
};
```

**Critical Difference:**
- ExploreTool/PlanTool: Hardcoded prompts → **same config every time**
- AgentTool: Loads from disk → **different config for each agent_name**

### 3.4 Pool Matching Analysis

**Current AgentPoolService.findAvailableAgent()** (Lines 278-292):
```typescript
private findAvailableAgent(agentConfig: AgentConfig): AgentMetadata | null {
  for (const metadata of this.pool.values()) {
    if (metadata.inUse) continue;
    
    // Check configuration compatibility
    // For now, only check if specialized flag matches
    if (metadata.config.isSpecializedAgent === agentConfig.isSpecializedAgent) {
      return metadata;
    }
  }
  return null;
}
```

**Problem for AgentTool:** This is **too loose** - it returns ANY available specialized agent regardless of:
- agent_name (different agents in AgentTool!)
- baseAgentPrompt (different for each agent_name)
- taskPrompt (always different)
- tools (varies per agent)

---

## 4. Agent Configuration Metadata for Pool Matching

### 4.1 What Makes One Agent Config Different?

For **AgentTool persistence**, we need to match based on:

1. **agent_name** (NEW - CRITICAL)
   - Maps to different system prompts in disk files
   - Determines tool restrictions
   - No two different agents should share state

2. **baseAgentPrompt** (CURRENT - exists but unused)
   - The loaded system prompt from agentData.system_prompt
   - Different for each agent_name
   - Should be part of matching key

3. **tools** (NEW - CRITICAL)
   - `agentData.tools` array specifies allowed tools
   - Directly impacts Agent behavior
   - Cannot reuse agent with different tool set

4. **taskPrompt** (CURRENT - problematic)
   - User's specific task input
   - Could be identical for "explore" tasks, different for custom agents
   - Question: Should agents be reusable across different tasks?

5. **allowTodoManagement** (CURRENT - unused in AgentTool)
   - Flag for whether agent can modify todos
   - AgentTool doesn't set this

### 4.2 Proposed Pool Key for AgentTool

```typescript
// Current (ExploreTool/PlanTool) - TOO LOOSE for AgentTool
isSpecializedAgent flag only

// Proposed for AgentTool - STRICT MATCHING
{
  agent_name: string;           // "general", "analyzer", etc.
  baseAgentPrompt: string;      // hash of system prompt from file
  tools_hash: string;           // hash of allowed tools array
  isSpecializedAgent: boolean;  // Always true for AgentTool
}
```

**Implementation:**
```typescript
function createAgentToolPoolKey(agentData: AgentData, tools?: string[]): string {
  const toolsStr = (tools || []).sort().join('|');
  const promptHash = hashString(agentData.system_prompt);
  const toolsHash = hashString(toolsStr);
  return `agent-${agentData.name}-${promptHash}-${toolsHash}`;
}
```

### 4.3 Should taskPrompt Affect Matching?

**Analysis:**
- For ExploreTool/PlanTool: taskPrompt is COMBINED into systemPrompt before creating AgentConfig
  - But AgentPoolService ignores taskPrompt entirely
  - Two explore() calls with different tasks reuse the SAME agent
  - Agent's systemPrompt was regenerated (line 212 in ExploreTool) but same base

- For AgentTool: taskPrompt is stored separately
  - baseAgentPrompt = agentData.system_prompt (constant)
  - taskPrompt = user's task (varies)
  - systemPrompt = combined result (varies)

**Recommendation:** 
- **DO NOT** include taskPrompt in pool key
- Agents CAN be reused for different tasks with same agent_name
- This allows exploration(task1) → reuse agent for exploration(task2) if same agent_name
- But MUST regenerate systemPrompt on each acquisition (line 504 of Agent.ts shows this happens)

---

## 5. Integration Points for Persistence Support

### 5.1 Current AgentTool Execution Flow with Persistence Points

```
executeImpl()
  ↓
executeSingleAgentWrapper()
  ↓
executeSingleAgent()
  ├─ [CHECKPOINT 1] Try to load agent from pool
  │                  (based on agent_name + tools)
  ├─ agentManager.ensureDefaultAgent()
  ├─ agentManager.loadAgent(agentName) ← FRESH LOAD
  │
  ├─ [CHECKPOINT 2] Check if pooled agent or create new
  │
  ├─ createAgentSystemPrompt()
  ├─ Create filtered ToolManager
  │
  ├─ new Agent() ← DIRECT CREATION
  └─ trackInActiveDelegations()
      ↓
  executeAgentTask()
    ├─ Create specializedPrompt
    ├─ subAgent.sendMessage() ← FULL EXECUTION
    └─ finally: cleanup() ← IMMEDIATE CLEANUP
```

### 5.2 Where Persistence Logic Should Fit

**OPTION A: Pre-Agent Creation (Recommended)**
```typescript
private async executeSingleAgent(agentName, taskPrompt, callId) {
  // [NEW] Try to acquire from pool FIRST
  const agentPoolService = registry.get<AgentPoolService>('agent_pool');
  
  if (agentPoolService) {
    // Load agent data for pool key creation
    const agentData = await agentManager.loadAgent(agentName);
    const poolKey = createAgentToolPoolKey(agentData);
    
    // Try to find existing agent in pool
    const pooledAgent = await agentPoolService.acquire({
      ...agentConfig,
      // Pool key fields
    });
    
    if (pooledAgent) {
      // Reuse: SKIP new Agent creation
      // Just need to regenerate systemPrompt
      return await executeWithPooledAgent(pooledAgent, agentData);
    }
  }
  
  // [EXISTING] Fall back to ephemeral agent
  const subAgent = new Agent(...);
  return await executeEphemeralAgent(subAgent);
}
```

**OPTION B: Post-Agent Creation (Not Recommended)**
- Too late: Agent already created with new message history
- Would need to clear messages on reuse (complex)

### 5.3 Unique Challenges vs ExploreTool/PlanTool

**Challenge 1: Variable agent_name Parameter**
- ExploreTool: Always uses 'explore' agent (hardcoded)
- PlanTool: Always uses 'plan' agent (hardcoded)
- AgentTool: User provides agent_name → multiple different agent types in pool

**Challenge 2: Tool Restrictions**
- ExploreTool: Fixed READ_ONLY_TOOLS constant
- PlanTool: Fixed PLANNING_TOOLS constant
- AgentTool: Each agent_name may have different tool restrictions

**Challenge 3: System Prompt Regeneration**
- ExploreTool: Prompt regeneration based on taskPrompt only
- PlanTool: Prompt regeneration based on requirements only
- AgentTool: Prompt regeneration uses BOTH baseAgentPrompt (from file) + taskPrompt

**Challenge 4: No Caching of Agent Files**
- AgentManager loads from disk every time (line 71-81)
- Should we cache AgentData? Or skip loading if pooled agent exists?

---

## 6. AgentManager Service Analysis

### 6.1 AgentManager.loadAgent() Behavior

**Current Implementation:**
```typescript
async loadAgent(agentName: string): Promise<AgentData | null> {
  const filePath = join(this.agentsDir, `${agentName}.md`);
  try {
    const content = await readFile(filePath, 'utf-8');
    return this.parseAgentFile(content, agentName);
  } catch (error) {
    logger.debug(`Failed to load agent '${agentName}':`, formatError(error));
    return null;
  }
}
```

**Characteristics:**
- **No caching** - loads from disk every time
- **Blocking operation** - uses fs.readFile (actually async, but doesn't cache)
- **Fresh every time** - parseAgentFile() called each invocation
- **Error handling** - returns null on failure (file not found)

### 6.2 Caching Strategy Recommendations

**Option 1: Cache in AgentManager** (Recommended)
```typescript
private agentCache: Map<string, AgentData> = new Map();

async loadAgent(agentName: string): Promise<AgentData | null> {
  // Check cache first
  if (this.agentCache.has(agentName)) {
    return this.agentCache.get(agentName)!;
  }
  
  // Load from disk
  const filePath = join(this.agentsDir, `${agentName}.md`);
  const content = await readFile(filePath, 'utf-8');
  const agentData = this.parseAgentFile(content, agentName);
  
  // Cache for future use
  if (agentData) {
    this.agentCache.set(agentName, agentData);
  }
  
  return agentData;
}
```

**Option 2: Skip load if Pooled Agent Exists**
```typescript
// In AgentTool.executeSingleAgent():
// If pooled agent exists, don't call agentManager.loadAgent()
// Get agentData from pooledAgent.config instead
```

**Option 3: Hybrid - Load for validation, pool has the data**
```typescript
// Load minimal file metadata (just name/description)
// Pool stores full AgentData for agents it manages
```

### 6.3 Does AgentManager Relate to AgentPoolService?

**Current Relationship: NONE**
- AgentManager: Manages persistent storage (disk files)
- AgentPoolService: Manages runtime instances (in-memory)
- No interaction between them

**Proposed Relationship:**
- AgentManager stays unchanged (storage layer)
- AgentPoolService acquires agents using AgentManager as source
- AgentTool coordinates between the two

---

## 7. Key Code Snippets for Implementation

### 7.1 Agent Creation with Persistence (Proposed)

```typescript
// File: src/tools/AgentTool.ts (new lines ~144-250)

private async executeSingleAgent(
  agentName: string,
  taskPrompt: string,
  callId: string
): Promise<any> {
  const startTime = Date.now();
  
  try {
    // 1. Get services
    const registry = ServiceRegistry.getInstance();
    const agentManager = this.getAgentManager();
    const agentPoolService = registry.get<AgentPoolService>('agent_pool');
    
    // 2. Ensure default agent exists
    await agentManager.ensureDefaultAgent();
    
    // 3. Load agent definition from disk
    const agentData = await agentManager.loadAgent(agentName);
    if (!agentData) {
      return {
        success: false,
        error: `Agent '${agentName}' not found`,
      };
    }
    
    // 4. Emit start event
    this.emitEvent({
      id: callId,
      type: ActivityEventType.AGENT_START,
      data: { agentName, taskPrompt },
    });
    
    // 5. Determine if using pool or ephemeral
    const result = await (agentPoolService
      ? this.executeWithPooling(agentData, taskPrompt, callId)
      : this.executeEphemeral(agentData, taskPrompt, callId)
    );
    
    // 6. Emit end event
    this.emitEvent({
      id: callId,
      type: ActivityEventType.AGENT_END,
      data: result,
    });
    
    return result;
  } catch (error) {
    return {
      success: false,
      error: `Error executing agent task: ${formatError(error)}`,
    };
  }
}

private async executeWithPooling(
  agentData: AgentData,
  taskPrompt: string,
  callId: string
): Promise<any> {
  const registry = ServiceRegistry.getInstance();
  const agentPoolService = registry.get<AgentPoolService>('agent_pool');
  
  if (!agentPoolService) return this.executeEphemeral(agentData, taskPrompt, callId);
  
  // Create pool key based on agent config
  const poolKey = this.createAgentPoolKey(agentData);
  
  // Create agent config for pooling
  const agentConfig: AgentConfig = {
    isSpecializedAgent: true,
    systemPrompt: '(will regenerate on acquire)',
    baseAgentPrompt: agentData.system_prompt,
    taskPrompt: taskPrompt,
    config: config,
    parentCallId: callId,
    // ... other fields
    // CUSTOM: Store agent metadata for matching
    _poolKey: poolKey,
    _agentName: agentData.name,
    _tools: agentData.tools,
  };
  
  // Acquire from pool
  const pooledAgent = await agentPoolService.acquire(agentConfig);
  
  try {
    // Regenerate system prompt for current task
    const specializedPrompt = await this.createAgentSystemPrompt(
      agentData.system_prompt,
      taskPrompt
    );
    
    // Update system message if needed
    const messages = pooledAgent.agent.getMessages();
    if (messages.length > 0 && messages[0].role === 'system') {
      messages[0].content = specializedPrompt;
    }
    
    // Execute task
    const result = await this.executeAgentTask(agentData, taskPrompt, callId, pooledAgent.agent);
    
    return {
      success: true,
      result,
      agent_used: agentData.name,
      agent_id: pooledAgent.agentId,
    };
  } finally {
    // Release back to pool (don't destroy)
    pooledAgent.release();
  }
}

private createAgentPoolKey(agentData: AgentData): string {
  // Create stable key based on agent configuration
  const toolsStr = (agentData.tools || []).sort().join('|');
  const key = `agent-tool-${agentData.name}@${hashString(agentData.system_prompt)}@${hashString(toolsStr)}`;
  return key;
}
```

### 7.2 Updated Pool Matching for AgentTool

```typescript
// File: src/services/AgentPoolService.ts (modify ~278-292)

private findAvailableAgent(agentConfig: AgentConfig): AgentMetadata | null {
  for (const metadata of this.pool.values()) {
    if (metadata.inUse) continue;
    
    // Specialized matching for AgentTool agents
    if (agentConfig._poolKey && metadata.config._poolKey) {
      // AgentTool: strict pool key matching
      if (metadata.config._poolKey === agentConfig._poolKey) {
        return metadata;
      }
    } else {
      // ExploreTool/PlanTool: simple isSpecialized check
      if (metadata.config.isSpecializedAgent === agentConfig.isSpecializedAgent) {
        return metadata;
      }
    }
  }
  
  return null;
}
```

---

## 8. Summary Table: Current vs Proposed State

| Aspect | Current AgentTool | Proposed with Persistence |
|--------|-------------------|--------------------------|
| **Agent Source** | Fresh load from disk each time | Pool first, then disk load |
| **Agent Lifecycle** | Create → Use → Destroy | Acquire → Use → Release (reuse) |
| **Pool Support** | NONE | Full AgentPoolService integration |
| **Persist Param** | N/A | Add `persist` parameter (default true) |
| **Cleanup** | Immediate cleanup() | defer cleanup() via pool.release() |
| **Pool Key** | N/A | agent_name + baseAgentPrompt + tools |
| **Message History** | Discarded | Preserved in pool |
| **System Prompt** | Generated once | Regenerated on each use |
| **AgentManager Caching** | No | Recommended: add cache |
| **Tool Filtering** | Per-agent restrictions | Preserved through reuse |

---

## 9. Remaining Questions & Decisions

1. **Should AgentTool agents be reused across different taskPrompts?**
   - Recommendation: YES - agent_name + tools should be key, not task
   - Task just changes systemPrompt regeneration

2. **Should we cache AgentData in AgentManager?**
   - Recommendation: YES - avoid repeated disk loads
   - Add cache invalidation on save()

3. **What if agent file is modified while agent in pool?**
   - Risk: Pool has stale AgentData
   - Mitigation: File watch + invalidate pool entries OR version numbers

4. **Should AgentTool return agent_id like ExploreTool?**
   - Recommendation: YES - for consistency and future tool chaining
   - Add agent_id to response when persist=true (default)

5. **How to handle tool restriction changes?**
   - Pool key must include tools hash
   - Different tool set = different pool key = new agent instance

