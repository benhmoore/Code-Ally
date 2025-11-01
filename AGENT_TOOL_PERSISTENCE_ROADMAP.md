# AgentTool Persistence Implementation Roadmap

## Quick Reference: What You Need to Know

### AgentTool Current State (Lines 72-379)
- **Location:** `/Users/benmoore/CodeAlly-TS/src/tools/AgentTool.ts`
- **Persistence:** NONE - creates ephemeral agents each time
- **Agent Source:** Disk via AgentManager (lines 145-174)
- **Cleanup Pattern:** Immediate cleanup in finally block (lines 372-378)
- **No Pool Usage:** Unlike ExploreTool (line 225) and PlanTool (line 281)

### Key Differences from ExploreTool/PlanTool

```
ExploreTool/PlanTool:
  - Hardcoded system prompts (constants)
  - Pool key: just isSpecializedAgent flag
  - Same agent type every call
  - Works with current AgentPoolService.findAvailableAgent()

AgentTool:
  - Dynamic system prompts (loaded from disk)
  - Variable agent_name parameter (different agents!)
  - Variable tool restrictions per agent
  - Needs ENHANCED pool matching logic
```

---

## Architecture Deep Dive

### 1. Full Agent Lifecycle in AgentTool (Lines 72-379)

**Lines 72-107: Parameter Validation & Entry**
```typescript
protected async executeImpl(args: any): Promise<ToolResult> {
  const agentName = args.agent_name || 'general';  // User-provided or default
  const taskPrompt = args.task_prompt;              // User's task
  
  // No persist parameter exists yet
  // Always creates ephemeral agent
  
  return await this.executeSingleAgentWrapper(agentName, taskPrompt, callId);
}
```

**Lines 145-218: Agent Loading & Delegation**
```typescript
private async executeSingleAgent(agentName, taskPrompt, callId) {
  // 1. Get AgentManager (lazy init at line 442-447)
  const agentManager = this.getAgentManager();
  
  // 2. Load agent from disk
  const agentData = await agentManager.loadAgent(agentName);
  // Returns: { name, description, system_prompt, tools?, ... }
  
  // 3. Emit AGENT_START event
  
  // 4. Execute task
  const result = await this.executeAgentTask(agentData, taskPrompt, callId);
  
  // 5. Emit AGENT_END event
  
  return { success: true, result, agent_used: agentName, ... };
}
```

**Lines 223-379: Task Execution with Sub-Agent**
```typescript
private async executeAgentTask(agentData, taskPrompt, callId) {
  // Get services from registry
  const mainModelClient = registry.get<ModelClient>('model_client');
  const toolManager = registry.get<ToolManager>('tool_manager');
  // ... etc
  
  // Generate specialized prompt (combines base + task)
  const specializedPrompt = await this.createAgentSystemPrompt(
    agentData.system_prompt,
    taskPrompt
  );
  
  // Filter tools if agent has restrictions
  let filteredToolManager = toolManager;
  if (agentData.tools) {
    filteredToolManager = new ToolManager(
      allTools.filter(tool => allowedToolNames.has(tool.name)),
      this.activityStream
    );
  }
  
  // Create ephemeral sub-agent
  const agentConfig: AgentConfig = {
    isSpecializedAgent: true,
    verbose: false,
    systemPrompt: specializedPrompt,           // Generated
    baseAgentPrompt: agentData.system_prompt,  // From disk
    taskPrompt: taskPrompt,                    // User input
    config: config,
    parentCallId: callId,
  };
  
  const subAgent = new Agent(
    mainModelClient,
    filteredToolManager,
    this.activityStream,
    agentConfig,
    configManager,
    permissionManager
  );
  
  // Track for interrupt handling
  this.activeDelegations.set(callId, { subAgent, agentName, taskPrompt, startTime });
  
  try {
    // Execute conversation
    const response = await subAgent.sendMessage(`Execute this task: ${taskPrompt}`);
    
    // Handle empty/interrupted responses
    if (!response || response.includes('[Request interrupted')) {
      // Attempt to extract summary from conversation
    }
    
    return finalResponse;
  } finally {
    // CLEANUP: Always destroy agent
    this.activeDelegations.delete(callId);
    await subAgent.cleanup();
  }
}
```

### 2. Agent Creation Flow - Visual

```
User calls: agent(agent_name="analyzer", task_prompt="Analyze X")
                ↓
        executeImpl(args)
                ↓
        executeSingleAgentWrapper()
                ↓
        executeSingleAgent()
          ├─ getAgentManager()
          │  └─ Creates if needed (singleton-ish)
          │
          ├─ agentManager.ensureDefaultAgent()
          │  └─ Creates "general" agent if doesn't exist
          │
          ├─ agentManager.loadAgent("analyzer")
          │  └─ File: ~/.code_ally/agents/analyzer.md
          │  └─ Returns: AgentData { name, system_prompt, tools: [...], ... }
          │
          └─ executeAgentTask(agentData, taskPrompt, callId)
             ├─ createAgentSystemPrompt(system_prompt, taskPrompt)
             │  └─ Combines: base prompt + task context
             │
             ├─ [FILTER] If agentData.tools exists:
             │  └─ Create ToolManager with only allowed tools
             │
             ├─ [CREATE] new Agent()
             │  ├─ Creates ephemeral instance
             │  ├─ Initializes with specializedPrompt
             │  └─ Ready for sendMessage()
             │
             ├─ subAgent.sendMessage("Execute this task: ...")
             │  └─ Full conversation loop with LLM
             │
             └─ finally: await subAgent.cleanup()
                └─ Stops watchdog, destroys instance
```

### 3. Agent.cleanup() Implementation (Agent.ts:1710-1723)

```typescript
async cleanup(): Promise<void> {
  // 1. Stop activity watchdog (only if specialized agent)
  this.stopActivityWatchdog();
  
  // 2. Close model client ONLY if NOT specialized agent
  // Specialized agents share parent's client - don't close it
  if (!this.config.isSpecializedAgent && this.modelClient.close) {
    await this.modelClient.close();
  }
}
```

**Why cleanup is minimal:**
- Sub-agents don't own resources (share parent's model client)
- Just need to stop monitoring (watchdog)
- Message history discarded (no persistence)

### 4. AgentManager Service (AgentManager.ts)

**loadAgent() Flow:**
```
File: ~/.code_ally/agents/{name}.md
Format: Markdown with YAML frontmatter
  ---
  name: "agent_name"
  description: "..."
  tools: ["tool1", "tool2"]  // Optional array
  temperature: 0.7            // Optional
  model: "claude-3-sonnet"    // Optional
  ---
  
  System prompt body (markdown)
  ...

loadAgent(name):
  1. Read file from ~/.code_ally/agents/{name}.md
  2. Parse YAML frontmatter
  3. Extract system_prompt body
  4. Return AgentData object
  5. On error: return null
  
Characteristics:
  - NO CACHING (loads fresh each time)
  - NO VALIDATION of loaded data
  - Tool array optional (undefined = all tools)
```

### 5. AgentConfig Structure & Matching

**AgentConfig for AgentTool sub-agents:**
```typescript
{
  isSpecializedAgent: true,        // Always true for subagents
  systemPrompt: "...",             // Generated: combines base + task
  baseAgentPrompt: "...",          // From disk: agentData.system_prompt
  taskPrompt: "...",               // User input: from parameter
  config: appConfig,               // Shared app configuration
  parentCallId: "...",             // Links tools back to this call
}
```

**What makes configs different:**
1. **agent_name** - Not in AgentConfig, but loaded via agentManager
   - Different .md files = different system_prompt
   - This is PRIMARY pool key
   
2. **baseAgentPrompt** - In AgentConfig
   - Directly depends on agent_name
   - Should be part of pool key
   
3. **tools** - Not in AgentConfig, but in agentData
   - Affects ToolManager filtering
   - Different tools = different behavior
   - Must be part of pool key
   
4. **taskPrompt** - In AgentConfig
   - Changes every call (user task varies)
   - NOT part of pool key (agents can be reused)
   - But systemPrompt regenerated on each use

---

## Critical Problem: Current Pool Matching Too Loose

### AgentPoolService.findAvailableAgent() (Lines 278-292)

```typescript
private findAvailableAgent(agentConfig: AgentConfig): AgentMetadata | null {
  for (const metadata of this.pool.values()) {
    if (metadata.inUse) continue;
    
    // PROBLEM: Only checks isSpecializedAgent flag!
    if (metadata.config.isSpecializedAgent === agentConfig.isSpecializedAgent) {
      return metadata;  // ANY available specialized agent accepted
    }
  }
  return null;
}
```

**Why this fails for AgentTool:**

```
Scenario:
1. Call: agent(agent_name="analyzer", task_prompt="Analyze X")
   └─ Creates Agent for "analyzer" with tools=[read, grep]
   └─ Pools as: { isSpecialized: true }

2. Call: agent(agent_name="coder", task_prompt="Write code")
   └─ Tries to match
   └─ Finds pooled "analyzer" agent (specialized flag matches!)
   └─ REUSES "analyzer" agent for "coder" task
   └─ WRONG: Different agents, different tools, different prompts!

Result: Coder task executed with analyzer's tools and prompts
```

---

## Proposed Solution: Pool Key for AgentTool

### 1. Add _poolKey to AgentConfig

```typescript
export interface AgentConfig {
  // ... existing fields
  
  // NEW: Optional pool matching metadata
  _poolKey?: string;          // Stable key for pool matching
  _agentName?: string;        // For debugging
  _toolsHash?: string;        // Hash of allowed tools array
}
```

### 2. Create Pool Key Function

```typescript
function createAgentToolPoolKey(agentData: AgentData): string {
  // Combine agent identifier + content hashes
  // Format: agent-{name}@{promptHash}@{toolsHash}
  
  const name = agentData.name;
  const promptHash = hashString(agentData.system_prompt);
  const toolsStr = (agentData.tools || []).sort().join('|');
  const toolsHash = hashString(toolsStr);
  
  return `agent-${name}@${promptHash}@${toolsHash}`;
}

function hashString(s: string): string {
  return crypto
    .createHash('sha256')
    .update(s)
    .digest('hex')
    .substring(0, 8);  // Use first 8 chars
}
```

### 3. Update Pool Matching Logic

```typescript
private findAvailableAgent(agentConfig: AgentConfig): AgentMetadata | null {
  for (const metadata of this.pool.values()) {
    if (metadata.inUse) continue;
    
    // AgentTool agents: strict matching via pool key
    if (agentConfig._poolKey && metadata.config._poolKey) {
      if (metadata.config._poolKey === agentConfig._poolKey) {
        return metadata;  // EXACT match
      }
    }
    // ExploreTool/PlanTool: simple flag matching (unchanged)
    else if (metadata.config.isSpecializedAgent === agentConfig.isSpecializedAgent) {
      return metadata;  // Compatible flag
    }
  }
  
  return null;
}
```

---

## Implementation Plan

### Phase 1: Update AgentTool (CORE)

**File:** `/Users/benmoore/CodeAlly-TS/src/tools/AgentTool.ts`

**Changes needed:**
1. Add `persist` parameter to getFunctionDefinition() [lines 48-70]
   - Optional boolean, default true
   
2. Update executeImpl() [lines 72-107]
   - Extract persist parameter
   - Validate it
   
3. Create executeWithPooling() method
   - Check if AgentPoolService available
   - Create pool key
   - Acquire from pool
   - Regenerate systemPrompt
   - Execute with pooled agent
   - Release (don't cleanup)
   
4. Refactor executeAgentTask() [lines 223-379]
   - Accept both pooled and ephemeral agents
   - Modify cleanup logic (conditional based on pooled/ephemeral)

5. Add createAgentPoolKey() helper method

### Phase 2: Update AgentPoolService (MATCHING)

**File:** `/Users/benmoore/CodeAlly-TS/src/services/AgentPoolService.ts`

**Changes needed:**
1. Update findAvailableAgent() [lines 278-292]
   - Add _poolKey matching for AgentTool
   - Keep simple matching for ExploreTool/PlanTool

### Phase 3: Optional Improvements

**AgentManager Caching:**
```typescript
// Add to AgentManager
private agentCache: Map<string, AgentData> = new Map();

async loadAgent(agentName): AgentData | null {
  // Check cache
  if (this.agentCache.has(agentName)) {
    return this.agentCache.get(agentName)!;
  }
  
  // Load and cache
  const agentData = await loadFromDisk(agentName);
  if (agentData) {
    this.agentCache.set(agentName, agentData);
  }
  return agentData;
}

// Invalidate on save
async saveAgent(agent): void {
  // ... save to disk
  this.agentCache.delete(agent.name);  // Invalidate cache
}
```

---

## Code Locations Reference

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| AgentTool | `/src/tools/AgentTool.ts` | 72-379 | Main tool, creates sub-agents |
| Agent Loading | `/src/tools/AgentTool.ts` | 145-174 | Loads from AgentManager |
| Cleanup | `/src/tools/AgentTool.ts` | 372-378 | Immediate cleanup pattern |
| Sub-Agent Creation | `/src/tools/AgentTool.ts` | 290-310 | Creates Agent instance |
| AgentManager | `/src/services/AgentManager.ts` | 33-331 | Loads agents from disk |
| AgentManager.loadAgent | `/src/services/AgentManager.ts` | 71-81 | Disk load (no cache) |
| Agent Class | `/src/agent/Agent.ts` | 32-51 | AgentConfig interface |
| Agent.cleanup | `/src/agent/Agent.ts` | 1710-1723 | Cleanup implementation |
| AgentPoolService | `/src/services/AgentPoolService.ts` | 78-519 | Pool management |
| findAvailableAgent | `/src/services/AgentPoolService.ts` | 278-292 | Pool matching (too loose) |
| ExploreTool | `/src/tools/ExploreTool.ts` | 107-337 | Reference: working persistence |
| PlanTool | `/src/tools/PlanTool.ts` | 161-403 | Reference: working persistence |

---

## Key Insights for Implementation

1. **AgentTool ≠ ExploreTool/PlanTool**
   - Different agent sources (disk vs hardcoded)
   - Different pool key requirements
   - Need specialized matching logic

2. **No persist parameter yet**
   - Add it to FunctionDefinition
   - Default to true (for consistency)
   - Implement graceful fallback to ephemeral

3. **Pool key must include agent_name + tools**
   - Can't use simple isSpecialized check
   - Must distinguish "analyzer" from "coder" agent
   - Tools array impacts behavior

4. **systemPrompt regeneration is critical**
   - baseAgentPrompt stays constant (from file)
   - taskPrompt changes (user input)
   - systemPrompt regenerated on each use (line 504 in Agent.ts shows example)
   - This is why agents CAN be reused for different tasks

5. **Cleanup must be conditional**
   - Pooled agents: release() back to pool
   - Ephemeral agents: await cleanup()
   - Different error handling paths

6. **AgentManager doesn't need to change**
   - Just add optional caching
   - Storage layer stays independent
   - AgentTool coordinates between Manager + Pool

