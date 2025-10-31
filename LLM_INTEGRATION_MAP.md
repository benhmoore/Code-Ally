# Code Ally LLM Integration Points - Complete Map

## Executive Summary

Code Ally has **multiple distinct LLM request/response flows** with different error handling patterns. There are at least **7 major integration points** where model responses are received, processed, and validated:

1. **Main Agent Flow** - Primary conversation loop
2. **Subagent Flows** (3 types) - Specialized agents for delegation, exploration, and planning
3. **Service LLM Calls** (2 types) - Background operations like session title generation and idle messages
4. **AskSessionTool** - LLM queries for session analysis

---

## 1. MAIN AGENT FLOW (Primary)

### Overview
The main conversation loop that processes user input and generates responses.

### Key Files
- **`/Users/bhm128/code-ally/src/agent/Agent.ts`** - Lines 173-638
- **`/Users/bhm128/code-ally/src/llm/OllamaClient.ts`** - Lines 52-781 (full client)
- **`/Users/bhm128/code-ally/src/agent/ToolOrchestrator.ts`** - Lines 62-655

### Request Flow

```
User Input
  ↓
cli.ts:291 → agent.sendMessage(message)
  ↓
Agent.ts:286 → sendMessage()
  ↓
Agent.ts:376 → getLLMResponse()
  ↓
OllamaClient.ts:173 → send(messages, options)
  ↓
[RETRY LOOP] (0 to maxRetries=3)
  ├─ OllamaClient.ts:190 → executeRequestWithCancellation()
  ├─ OllamaClient.ts:333-356 → fetch() with timeout & abort signal
  ├─ OllamaClient.ts:352-357 → processStreamingResponse() OR parseNonStreamingResponse()
  └─ OllamaClient.ts:193-223 → Tool call validation & repair
  ↓
Agent.ts:384 → processLLMResponse()
  ├─ If tool calls: Agent.ts:676 → processToolResponse()
  │   └─ Agent.ts:762 → toolOrchestrator.executeToolCalls()
  │       └─ [Adds tool results to conversation]
  │       └─ Recursively calls getLLMResponse() for follow-up
  └─ If text only: Agent.ts:679 → processTextResponse()
      └─ Checks for "no final response" (Agent.ts:797-827)
      └─ Returns content to user
```

### Response Processing Chain

#### 1. LLM Response Validation (OllamaClient.ts:173-267)
```typescript
- Line 190: executeRequestWithCancellation() with AbortController
- Line 193-223: Tool call validation and repair
  - Handles format issues
  - Converts legacy function_call to tool_calls
  - Validates JSON arguments
  - Repairs malformed calls
- Line 196-217: Retry validation errors for non-streaming
- Line 210-216: Return error response if validation fails
```

**Error Handling:**
- Line 226-254: Catch block with specific error types
- Line 228-235: AbortError → return interrupted response
- Line 238-241: Network errors → retry with exponential backoff (2^attempt seconds)
- Line 245-249: JSON errors → retry with linear backoff ((1+attempt) seconds)
- Line 252: Other errors → handleRequestError()

#### 2. Tool Call Extraction (OllamaClient.ts:498-545)
```typescript
- Line 510-511: Extract tool_calls array
- Line 514-517: Convert legacy function_call format
- Line 550-579: normalizeToolCallsInMessage() - validate and repair
```

#### 3. Processing Tool Calls (Agent.ts:670-788)
```typescript
- Line 658-668: Log tool calls extracted
- Line 670-676: Route to processToolResponse()
- Line 701-727: Add assistant message with tool calls to history
- Line 762: Execute via ToolOrchestrator.executeToolCalls()
- Line 784: Get follow-up response (recursive)
```

#### 4. "No Final Response" Detection (Agent.ts:797-854)
**Critical Path** for handling Ollama 500 errors that return no content:

```typescript
Line 802-823: Check for empty content after tool execution
  - Detect: !content.trim() && !isRetry && isAfterToolExecution
  - Action: Add continuation prompt, retry LLM
  - Prevent infinite loop: isRetry=true parameter

Line 828-853: Still empty after retry
  - Use fallback message
  - Emit completion event
  - Return fallback
```

### Error Handling Pattern

The main agent has **three-tier error handling**:

1. **Transport Level** (OllamaClient.ts:226-254)
   - Network errors → exponential backoff retry
   - JSON parse errors → linear backoff retry
   - Timeout errors → return error response with suggestions

2. **Validation Level** (OllamaClient.ts:193-223)
   - Tool call format validation
   - Automatic repair of malformed calls
   - Returns error if non-streaming and validation fails

3. **Response Level** (Agent.ts:647-854)
   - Empty content after tools → retry with prompt
   - Still empty after retry → fallback message
   - Missing required tool calls → re-prompt agent

### Shared Model Client

- **Created at:** `cli.ts:390-398`
- **Type:** OllamaClient instance
- **Used by:** Main agent only (NOT shared with subagents - subagents get their own reference)
- **Registered as:** `model_client` in ServiceRegistry

---

## 2. SUBAGENT FLOW #1: AgentTool (Task Delegation)

### Overview
Delegates tasks to specialized agents with filtered tool access.

### Key Files
- **`/Users/bhm128/code-ally/src/tools/AgentTool.ts`** - Lines 24-506
- **`/Users/bhm128/code-ally/src/services/AgentManager.ts`** (loads agent configs)

### Request Flow

```
ModelClient.send() in subagent
  ↓
[SAME as Main Agent Flow - uses shared modelClient]
  ↓
AgentTool.ts:322 → subAgent.sendMessage()
  ↓
[Reuses main LLM request flow]
```

### Key Differences from Main Agent

1. **Separate Agent Instance** (AgentTool.ts:303-310)
   - Created per delegation
   - `isSpecializedAgent: true`
   - Shares model client with main agent (AgentTool.ts:233)

2. **Tool Restrictions** (AgentTool.ts:273-285)
   - Agent has specific tool whitelist
   - Creates filtered ToolManager
   - Tools passed via AgentTool.ts:275

3. **Error Handling** (AgentTool.ts:328-364)
   - Detects empty response (line 329)
   - Attempts to extract summary from conversation (line 331)
   - Falls back to explicit summary request (line 338-349)
   - Returns error if all attempts fail

4. **Activity Timeout** (Agent.ts:220-260)
   - Specialized agents only
   - Monitors tool call activity
   - Interrupts if no tool calls for configured timeout
   - Triggers `handleActivityTimeout()` → interrupts agent

### Response Processing

Uses inherited Agent.processLLMResponse() but with:
- Lines 731-753: Context usage check blocks tool execution if too high
- Lines 853-912: Required tool calls enforcement (for planning agent)

### Model Client Sharing

- **Shares:** Main model client from ServiceRegistry (AgentTool.ts:233)
- **NOT closed by subagent** - cleanup only cancels ongoing requests (Agent.ts:1391-1392)

---

## 3. SUBAGENT FLOW #2: ExploreTool (Read-Only Exploration)

### Overview
Dedicated read-only exploration agent for codebase analysis.

### Key Files
- **`/Users/bhm128/code-ally/src/tools/ExploreTool.ts`** - Lines 55-375

### Request Flow

```
ExploreTool.ts:227 → explorationAgent.sendMessage()
  ↓
[SAME as Main Agent Flow - uses shared modelClient]
```

### Key Characteristics

1. **Tool Restrictions** (ExploreTool.ts:175-180)
   - Hardcoded read-only tools: read, glob, grep, ls, tree, batch
   - Read-only guarantee (cannot modify files)

2. **Error Handling** (ExploreTool.ts:232-265)
   - Similar to AgentTool (empty response detection)
   - Extracts summary from conversation (line 239)
   - Has fallback message (line 236)

3. **System Prompt** (ExploreTool.ts:29-53)
   - Hardcoded EXPLORATION_SYSTEM_PROMPT
   - Specializes agent for exploration tasks

### Response Processing

Same as AgentTool - uses Agent.processLLMResponse() with:
- Activity timeout monitoring
- Empty response detection
- Conversation history summary extraction

---

## 4. SUBAGENT FLOW #3: PlanTool (Implementation Planning)

### Overview
Specialized planning agent that creates implementation plans and proposed todos.

### Key Files
- **`/Users/bhm128/code-ally/src/tools/PlanTool.ts`** - Lines 109-491

### Request Flow

```
PlanTool.ts:289 → planningAgent.sendMessage()
  ↓
[SAME as Main Agent Flow - uses shared modelClient]
```

### Key Characteristics

1. **Tool Restrictions** (PlanTool.ts:235-240)
   - Hardcoded planning tools: read, glob, grep, ls, tree, batch, explore, todo_add
   - Has access to explore tool for nested research

2. **Required Tool Calls** (PlanTool.ts:267)
   - Planning agent MUST call todo_add before exiting
   - Enforced by Agent.ts:857-912 logic
   - Up to 5 warnings (BUFFER_SIZES.AGENT_REQUIRED_TOOL_MAX_WARNINGS)

3. **Error Handling** (PlanTool.ts:293-305)
   - Detects empty response (line 295)
   - Extracts summary from conversation (line 301)
   - Auto-accepts proposed todos (line 322)

4. **Todo Management** (PlanTool.ts:419-463)
   - Auto-accepts proposed todos
   - Converts status: proposed → pending/in_progress
   - Logs conversions for tracking

### Response Processing

Uses Agent.processLLMResponse() with:
- Required tool calls enforcement
- Context usage warnings (line 731-754 in Agent.ts)
- Activity timeout for infinite loop detection

---

## 5. SERVICE LLM CALL #1: SessionTitleGenerator

### Overview
Generates titles for sessions in background (non-blocking).

### Key Files
- **`/Users/bhm128/code-ally/src/services/SessionTitleGenerator.ts`**
- Uses `service_model_client` from registry

### Request Flow

```
SessionManager → SessionTitleGenerator.generateTitle()
  ↓
service_model_client.send(messages, { stream: false })
  ↓
OllamaClient.ts:173 → [Standard retry and validation]
```

### Key Characteristics

1. **Model Client** (SessionTitleGenerator.ts)
   - Uses separate `service_model_client`
   - Created at cli.ts:404-412
   - Defaults to same model as main agent if not configured

2. **Error Handling**
   - Non-blocking (fire-and-forget)
   - Logs errors but doesn't throw
   - Fallback to default title on error

3. **No Retry Logic at Tool Level**
   - Relies on OllamaClient.ts built-in retries
   - If all retries fail, returns error response
   - SessionManager handles error gracefully

---

## 6. SERVICE LLM CALL #2: IdleMessageGenerator

### Overview
Generates idle messages when conversation is inactive.

### Key Files
- **`/Users/bhm128/code-ally/src/services/IdleMessageGenerator.ts`**
- Uses `service_model_client` from registry

### Request Flow

```
Idle timeout triggered
  ↓
IdleMessageGenerator.generateMessage()
  ↓
service_model_client.send(messages, { stream: false })
  ↓
OllamaClient.ts:173 → [Standard retry and validation]
```

### Key Characteristics

1. **Same as SessionTitleGenerator**
   - Uses service_model_client
   - Fire-and-forget pattern
   - Logs errors, doesn't crash

2. **Queue Management**
   - Appends to queue on success
   - Triggers auto-save on queue update (cli.ts:560-573)

---

## 7. DIRECT TOOL LLM CALL: AskSessionTool

### Overview
Direct LLM call for session analysis (reads past sessions and answers questions).

### Key Files
- **`/Users/bhm128/code-ally/src/tools/AskSessionTool.ts`** - Lines 52-145

### Request Flow

```
AskSessionTool.executeImpl()
  ↓
AskSessionTool.ts:121 → serviceModelClient.send(messages, { stream: false })
  ↓
OllamaClient.ts:173 → [Standard retry and validation]
  ↓
AskSessionTool.ts:125-137 → Check response and format result
```

### Key Characteristics

1. **Direct send() Call** (AskSessionTool.ts:121)
   - No Agent wrapper
   - Single request (no loops)
   - Uses service_model_client

2. **Error Handling** (AskSessionTool.ts:139-144)
   - Try/catch with formatError
   - Returns error response to user
   - No retry logic at tool level

3. **No Tool Calls in Response**
   - Doesn't pass functions parameter
   - LLM can't request tools
   - Simple text response expected

---

## COMPREHENSIVE ERROR HANDLING MAP

### 1. Network/Transport Errors (OllamaClient.ts:238-249)

**Caught Errors:**
- `ECONNREFUSED` - Ollama not running
- `ETIMEDOUT` - Connection timeout
- Any `TypeError` with "fetch" in message

**Handling:**
- Exponential backoff: 2^attempt seconds
- Linear backoff for JSON errors: (1+attempt) seconds
- Max 3 retries by default
- Adaptive timeout: BASE + attempt*INCREMENT

**User Suggestions:**
```
ECONNREFUSED: ["Start Ollama service", "Check port 11434"]
Timeout: ["Increase timeout", "Check internet", "Verify server running"]
JSON errors: ["Restart Ollama", "Check model supports function calling"]
```

### 2. HTTP Errors (OllamaClient.ts:346-349)

**Caught Errors:**
- HTTP 404 - Model not found
- HTTP 500 - Server error
- Any non-ok status

**Handling:**
- Not retried at HTTP level
- Thrown to be caught by main retry loop (line 226)
- Error message includes HTTP status and response text

**User Suggestions:**
```
404: ["Check if model available", "ollama list", "ollama pull {model}"]
500: [Generic suggestions]
```

### 3. Tool Call Validation Errors (OllamaClient.ts:550-639)

**Validation Rules:**
- Line 592-593: Must have valid ID (string)
- Line 597-598: Must have type='function'
- Line 612-614: Must have function object
- Line 618-620: Function must have name (string)
- Line 624-630: Arguments must parse as JSON
- Line 634-635: Arguments must be object

**Repair Actions:**
- Missing ID: Generate `repaired-{timestamp}-{index}`
- Missing type: Set to 'function'
- Flat structure (name/args at top): Restructure to nested
- Invalid JSON: Return error

**Retry Logic (OllamaClient.ts:196-217):**
- For non-streaming: Retry with error feedback message
- For streaming: Just log warning (can't retry)
- For subagents: Activity timeout enforcement prevents infinite loops

### 4. Empty Response Handling (Agent.ts:797-854)

**Detection:**
- Empty content.trim()
- Not already a retry (isRetry=false)
- Previous message had tool calls

**Action:**
1. Add continuation prompt
2. Call getLLMResponse() again with isRetry=true
3. If still empty: Use fallback message

**Fallback Messages:**
- Main agent: "I apologize, but I encountered an issue..."
- Subagent: "Task completed. Tool results are available..."

### 5. Interruption/Timeout Handling (Agent.ts:220-260, 437-463)

**Detection Points:**
- User Ctrl+C: Sets interrupted=true
- Activity timeout (subagents only): After TOOL_CALL_ACTIVITY_TIMEOUT
- Request cancelled: AbortError caught

**Handling:**
- Line 388: Check interrupted flag in processLLMResponse
- Line 649-651: Return interrupted message
- Line 388-391: Throw for graceful cleanup
- Line 437-462: Cancel all requests and abort tools

**For Subagents:**
- Timeout treated as tool error (Agent.ts:413-414)
- Parent agent sees "Agent stuck: no tool calls" error

### 6. Specialized Agent Context Limits (Agent.ts:728-754)

**Detection:**
- Context usage >= WARNING threshold (90%)
- Only enforced for specialized agents (isSpecializedAgent=true)

**Action:**
1. Remove assistant message with tool calls
2. Add system reminder to provide summary
3. Call getLLMResponse() for final response
4. Prevent tool execution to preserve context

**Reason:**
- Specialized agents need room for final summary
- Main agent can auto-compact conversation

### 7. Required Tool Calls Enforcement (Agent.ts:856-912)

**Configuration:**
- Set via AgentConfig.requiredToolCalls array
- Used by PlanTool (requires: ['todo_add'])

**Enforcement Logic:**
```
If agent trying to exit without calling required tools:
  ├─ 1st warning: Re-prompt agent to call tools
  ├─ 2nd-4th warnings: Keep re-prompting
  ├─ 5th warning (max): FAIL with error message
  └─ Return error to user
```

**Max Warnings:** BUFFER_SIZES.AGENT_REQUIRED_TOOL_MAX_WARNINGS (5)

---

## KEY CONSTANTS & CONFIGURATION

### Timeouts (config/constants.ts)
```typescript
API_TIMEOUTS.LLM_REQUEST_BASE = 30000ms (30s)
API_TIMEOUTS.LLM_REQUEST_RETRY_INCREMENT = 10000ms
```

### Activity Timeouts (config/defaults.ts)
```typescript
tool_call_activity_timeout = 60 seconds (specialized agents only)
```

### Context Thresholds (config/toolDefaults.ts)
```typescript
CONTEXT_THRESHOLDS.WARNING = 90%
CONTEXT_THRESHOLDS.CRITICAL = 95%
```

### Max Retries
```typescript
OllamaClient.send(): maxRetries = 3 (default)
Tool call validation: maxRetries = 2
Agent required tools: maxWarnings = 5
```

---

## EXECUTION PATHS SUMMARY TABLE

| Path | Entry | Client | Retries | Timeout | Tool Calls | Recovery |
|------|-------|--------|---------|---------|------------|----------|
| Main Agent | Agent.sendMessage() | modelClient | 3 | 30s+retry | Yes | Follow-up response |
| AgentTool | subAgent.sendMessage() | modelClient (shared) | 3 | 30s+retry | Yes | Extract summary |
| ExploreTool | explorationAgent.sendMessage() | modelClient (shared) | 3 | 30s+retry | Yes | Extract summary |
| PlanTool | planningAgent.sendMessage() | modelClient (shared) | 3 | 30s+retry | Yes (todo_add required) | Auto-accept todos |
| SessionTitle | generateTitle() | serviceModelClient | 3 | 30s+retry | No | Fallback title |
| IdleMessage | generateMessage() | serviceModelClient | 3 | 30s+retry | No | Log error |
| AskSession | executeImpl() | serviceModelClient | 3 | 30s+retry | No | Return error |

---

## CRITICAL ISSUES & RETRY OPPORTUNITIES

### Issue #1: Ollama 500 Error with Empty Response
**Current Detection:** Agent.ts:797-827 (after tool execution only)
**Gap:** Only detects empty content after TOOL execution, not after initial LLM response
**Suggestion:** Detect empty responses at Agent.ts:376 level (after getLLMResponse)

### Issue #2: No Retry at Tool Call Level
**Current:** Tool calls extracted, but if LLM returns invalid format, retry only for non-streaming
**Gap:** Streaming responses can have tool call errors with no retry
**Suggestion:** Add post-extraction validation retry for streaming too

### Issue #3: Service Model Client Errors Silent
**Current:** SessionTitleGenerator and IdleMessageGenerator fail silently
**Gap:** No way to know if title generation failed (just uses fallback)
**Suggestion:** Log failures more prominently, add monitoring hooks

### Issue #4: Subagent Model Client Not Isolated
**Current:** All subagents share main agent's model client
**Gap:** If main agent gets cancelled, could affect subagent requests
**Suggestion:** Create separate model client for each Agent, or add request-level isolation

### Issue #5: Activity Timeout Enforcement Uneven
**Current:** Only enforced for isSpecializedAgent=true
**Gap:** Main agent could get stuck in infinite tool loop too
**Suggestion:** Add activity timeout to main agent as optional feature

---

## INTEGRATION POINTS FOR RETRY LOGIC

### Level 1: Transport (OllamaClient.ts:173-267)
- **Already has:** Exponential backoff for network errors
- **Missing:** Retry on specific HTTP codes (e.g., 503 Service Unavailable)

### Level 2: Parsing (OllamaClient.ts:498-545)
- **Already has:** Tool call repair for non-streaming
- **Missing:** Post-validation retry option for streaming

### Level 3: Response Semantics (Agent.ts:376-638)
- **Already has:** Empty response detection + retry after tools
- **Missing:** Empty response detection before tools

### Level 4: Agent Behavior (Agent.ts:220-260)
- **Already has:** Activity timeout for subagents
- **Missing:** Optional timeout for main agent

### Level 5: Tool Results (ToolOrchestrator.ts:499-582)
- **Already has:** Tool execution with error handling
- **Missing:** Retry logic for failed tool calls

---

## RECOMMENDATIONS FOR COMPREHENSIVE RETRY SYSTEM

1. **Unified Retry Framework**
   - Create RetryPolicy interface
   - Implement: exponential backoff, linear backoff, immediate
   - Apply at each integration point

2. **Error Classification**
   - Distinguish: retriable vs. fatal errors
   - Retriable: network, timeout, transient 500s
   - Fatal: validation, missing required params, auth

3. **Logging & Monitoring**
   - Log all retry attempts with context
   - Track failure rates per error type
   - Surface patterns to users

4. **User Feedback**
   - Show retry attempts and wait time
   - Explain why retrying
   - Offer manual retry/cancel options

5. **Configuration**
   - Make retry policies configurable per integration point
   - Allow users to adjust timeout and backoff
   - Provide presets: aggressive, balanced, conservative

