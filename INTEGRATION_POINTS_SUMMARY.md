# Code Ally LLM Integration Points - Quick Reference

## Files Generated
1. **LLM_INTEGRATION_MAP.md** (638 lines) - Comprehensive documentation of all integration points
2. **LLM_FLOWS_DIAGRAM.txt** - ASCII diagrams of request/response flows
3. **INTEGRATION_POINTS_SUMMARY.md** - This file (quick reference)

## 7 Major Integration Points

### 1. Main Agent Flow
- **Entry:** `cli.ts:291` → `Agent.sendMessage()`
- **LLM Client:** `OllamaClient` (shared, created at `cli.ts:390`)
- **Key Files:** 
  - `src/agent/Agent.ts:173-638` (main loop)
  - `src/llm/OllamaClient.ts:52-781` (client with retries)
  - `src/agent/ToolOrchestrator.ts:62-655` (tool execution)
- **Error Handling:** 3-tier (transport, validation, response)
- **Retries:** 3 attempts with exponential backoff

### 2. AgentTool (Task Delegation)
- **Entry:** `src/tools/AgentTool.ts:72-107`
- **Creates:** Specialized agent with filtered tools
- **LLM Client:** Shared from main agent
- **Error Recovery:** Extract summary from conversation + fallback
- **Special:** Activity timeout monitoring, tool filtering

### 3. ExploreTool (Read-Only Exploration)
- **Entry:** `src/tools/ExploreTool.ts:111-134`
- **Creates:** Read-only agent (hardcoded tool list)
- **LLM Client:** Shared from main agent
- **Tools:** read, glob, grep, ls, tree, batch only
- **Error Recovery:** Same as AgentTool

### 4. PlanTool (Implementation Planning)
- **Entry:** `src/tools/PlanTool.ts:171-194`
- **Creates:** Planning agent with explore access
- **LLM Client:** Shared from main agent
- **Special:** Required tool calls (todo_add must be called)
- **Error Recovery:** Auto-accepts proposed todos

### 5. SessionTitleGenerator (Background Service)
- **Entry:** `src/services/SessionTitleGenerator.ts`
- **LLM Client:** `service_model_client` (separate, created at `cli.ts:404`)
- **Pattern:** Fire-and-forget, non-blocking
- **Error Handling:** Silent failure + fallback title

### 6. IdleMessageGenerator (Background Service)
- **Entry:** `src/services/IdleMessageGenerator.ts`
- **LLM Client:** `service_model_client` (same as SessionTitleGenerator)
- **Trigger:** 10-second idle timeout
- **Error Handling:** Silent failure + log

### 7. AskSessionTool (Direct Query)
- **Entry:** `src/tools/AskSessionTool.ts:52-145`
- **LLM Client:** `service_model_client`
- **Pattern:** Direct `send()` call (no Agent wrapper)
- **Request:** No tool calls allowed
- **Error Handling:** Try/catch + formatError

---

## Error Handling by Layer

### Layer 1: Transport (OllamaClient.ts:226-254)
```
ECONNREFUSED → Exponential backoff (2^attempt)
ETIMEDOUT    → Exponential backoff (2^attempt)
TypeError    → Exponential backoff (2^attempt)
SyntaxError  → Linear backoff (1+attempt)
Other        → handleRequestError() + suggestions
Abort        → Return interrupted response
```

### Layer 2: HTTP (OllamaClient.ts:346-349)
```
404 → "Model not found" (with suggestions)
500 → "Server error" (with suggestions)
Non-ok → Include response text
```

### Layer 3: Tool Validation (OllamaClient.ts:550-639)
```
Invalid ID      → Generate repaired ID
Missing type    → Set to 'function'
Bad function    → Return error
Bad JSON args   → Return error or repair
```

### Layer 4: Empty Response (Agent.ts:797-827)
```
Empty after tools        → Retry with continuation prompt
Still empty after retry  → Use fallback message
```

### Layer 5: Activity (Agent.ts:220-260)
```
No tool calls for 60s    → Interrupt (subagents only)
```

### Layer 6: Context (Agent.ts:728-754)
```
≥90% context usage       → Skip tools, request summary
```

### Layer 7: Required Tools (Agent.ts:856-912)
```
Missing required tools   → Re-prompt (max 5 times)
Exceeded max warnings    → FAIL with error
```

---

## Critical Request/Response Paths

### Path A: Main Agent with Tool Execution
```
1. User input
2. getLLMResponse() → OllamaClient.send() with retries
3. Detect tool calls
4. Execute via ToolOrchestrator
5. Add tool results to conversation
6. Get follow-up response (recursive to step 2)
7. No more tool calls → return text response
```

### Path B: Subagent (AgentTool/ExploreTool/PlanTool)
```
1. Tool triggered (agent/explore/plan)
2. Create filtered Agent instance
3. subAgent.sendMessage()
4. [Same as Path A with subagent instance]
5. Check for empty response
6. Extract summary if needed
7. Return to parent as tool result
```

### Path C: Service LLM Call
```
1. Background trigger (session creation, idle timer, query)
2. service_model_client.send(messages, {stream: false})
3. [Standard retry logic in OllamaClient]
4. Non-blocking error handling
5. Fallback or silent failure
```

---

## Key Constants

| Constant | Value | Location |
|----------|-------|----------|
| Retry attempts | 3 | OllamaClient.send() default |
| Base timeout | 30s | API_TIMEOUTS.LLM_REQUEST_BASE |
| Timeout increment | 10s | API_TIMEOUTS.LLM_REQUEST_RETRY_INCREMENT |
| Exp backoff | 2^attempt | OllamaClient.ts:239 |
| Linear backoff | (1+attempt)s | OllamaClient.ts:246 |
| Activity timeout | 60s | config.tool_call_activity_timeout |
| Context warning | 90% | CONTEXT_THRESHOLDS.WARNING |
| Max tool warnings | 5 | BUFFER_SIZES.AGENT_REQUIRED_TOOL_MAX_WARNINGS |

---

## Shared vs. Isolated Resources

### Model Clients
- **Main agent:** `modelClient` (created once at cli.ts:390)
- **All subagents:** Share same `modelClient` reference (NOT isolated)
- **Background services:** `service_model_client` (created separately at cli.ts:404)

**Impact:** If main agent cancels, all subagents are affected

### Tool Manager
- **Main agent:** Full tool access
- **AgentTool subagents:** Filtered (specified in agent config)
- **ExploreTool:** Read-only hardcoded (read, glob, grep, ls, tree, batch)
- **PlanTool:** Planning tools (read, glob, grep, ls, tree, batch, explore, todo_add)

### Token Manager
- **Per agent instance:** Each Agent creates its own TokenManager
- **Shared via registry:** Main agent's TokenManager registered in ServiceRegistry
- **No sharing:** Subagents have isolated token tracking

---

## Known Issues & Gaps

1. **Empty response before tools not detected**
   - Only detected after tool execution (Agent.ts:797)
   - Should detect at main response level (Agent.ts:376)

2. **Streaming validation errors not retried**
   - Non-streaming: Retries on validation errors
   - Streaming: Just logs warning

3. **No HTTP 503 retry**
   - Should retry on "Service Unavailable"
   - Currently returns error immediately

4. **Service model client errors silent**
   - SessionTitleGenerator/IdleMessageGenerator fail without notice
   - No higher-level retry logic

5. **Subagent model client not isolated**
   - All subagents share main agent's client
   - Cancellation affects all

6. **Activity timeout only for subagents**
   - Main agent could get stuck in infinite loop
   - Should be optional for main agent too

---

## Testing the Integration Points

### To test Main Agent Flow:
```
1. Start Code Ally
2. Type: "help" or any command
3. Monitor: Agent.ts logging for getLLMResponse() calls
4. Check: OllamaClient.ts retry loops in console
```

### To test AgentTool Flow:
```
1. In conversation: agent(task_prompt="test task")
2. Monitor: Agent.ts with isSpecializedAgent=true
3. Check: Activity timeout and empty response handling
```

### To test ExploreTool Flow:
```
1. In conversation: explore(task_description="find X")
2. Monitor: Tool filtering (read-only only)
3. Check: Summary extraction on response
```

### To test Empty Response Recovery:
```
1. Simulate empty response in OllamaClient.ts:499
2. Change: response.content = ''
3. Expected: Agent.ts:810-823 continuation prompt
4. Verify: Retry happens with isRetry=true
```

---

## Recommendations for Improvement

### 1. Unified Retry Framework
- Create `RetryPolicy` interface
- Implement: exponential, linear, immediate
- Apply consistently across all 7 integration points

### 2. Error Classification
- Categorize: retriable vs. fatal
- Retriable: network, timeout, transient 500s, 503
- Fatal: validation, missing params, auth

### 3. Better Logging
- Log all retry attempts
- Track failure rates per error type
- Surface patterns to users

### 4. User Feedback
- Show retry attempts and wait time
- Explain why retrying
- Offer manual retry/cancel

### 5. Configuration
- Make retry policies user-configurable
- Provide presets: aggressive, balanced, conservative
- Allow per-tool retry overrides

### 6. Model Client Isolation
- Create separate client for each Agent (or request-level isolation)
- Prevent cross-cancellation issues

### 7. Service Model Client Monitoring
- Add error reporting hooks
- Implement fallback retry logic
- Log failures prominently

---

## How to Use These Documents

1. **LLM_INTEGRATION_MAP.md** - Deep dive into each integration point
   - Complete code references and line numbers
   - Detailed error handling patterns
   - Retry opportunities

2. **LLM_FLOWS_DIAGRAM.txt** - Visual understanding
   - ASCII flowcharts of request/response paths
   - Error detection and handling layers
   - Clear success/failure paths

3. **INTEGRATION_POINTS_SUMMARY.md** - Quick lookup (this file)
   - At-a-glance reference
   - Key constants and configuration
   - Known issues and gaps

---

## Statistics

- **Total integration points identified:** 7 major flows
- **LLM client implementations:** 1 (OllamaClient)
- **Model client instances:** 2 (main + service)
- **Error handling layers:** 7
- **Lines of source code:** ~30,574
- **Lines of documentation:** 638 (map) + 400+ (diagram)
