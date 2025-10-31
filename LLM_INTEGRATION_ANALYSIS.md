# Code Ally LLM Integration Analysis - Complete Overview

## Analysis Summary

This analysis identifies **all integration points** where model responses are received, processed, and validated in the Code Ally codebase. The investigation covers 30,574 lines of TypeScript code and maps 7 major LLM request/response flows with 7 layers of error handling.

## Generated Documentation

Three detailed documents have been created to map the LLM architecture:

### 1. LLM_INTEGRATION_MAP.md (20 KB, 638 lines)
**Most comprehensive reference**
- Detailed breakdown of each of the 7 integration points
- Request/response flow diagrams with line numbers
- Complete error handling patterns for each layer
- Tool call validation and repair logic
- Model client sharing and isolation analysis
- Critical issues and retry opportunities
- Recommendations for comprehensive retry system

### 2. LLM_FLOWS_DIAGRAM.txt (15 KB)
**Visual and structural understanding**
- ASCII flowcharts of all request paths
- Main agent flow with retry loop visualization
- Subagent delegation flows
- Service background flows
- Error detection summary by layer
- Unimplemented retry opportunities

### 3. INTEGRATION_POINTS_SUMMARY.md (9.3 KB)
**Quick reference guide**
- At-a-glance overview of 7 integration points
- Error handling by layer (short form)
- Key constants and configuration
- Critical paths (3 main patterns)
- Known issues and gaps
- Testing strategies
- Improvement recommendations

---

## The 7 LLM Integration Points

### 1. **Main Agent Flow** (Primary Conversation)
- **File:** `src/agent/Agent.ts:286-395`
- **LLM Client:** OllamaClient (shared, created at cli.ts:390)
- **Entry:** User input → `agent.sendMessage()`
- **Error Handling:** 3-tier (transport, validation, response)
- **Retries:** 3 attempts with exponential/linear backoff
- **Special:** Tool execution and follow-up loop

### 2. **AgentTool** (Task Delegation)
- **File:** `src/tools/AgentTool.ts:72-379`
- **Creates:** Specialized Agent with filtered tools
- **LLM Client:** Shared from main agent
- **Error Recovery:** Summary extraction + fallback
- **Special:** Activity timeout, tool whitelist, required tools

### 3. **ExploreTool** (Read-Only Analysis)
- **File:** `src/tools/ExploreTool.ts:111-277`
- **Creates:** Read-only Agent (hardcoded tools)
- **Tools:** read, glob, grep, ls, tree, batch
- **LLM Client:** Shared from main agent
- **Error Recovery:** Summary extraction + fallback

### 4. **PlanTool** (Implementation Planning)
- **File:** `src/tools/PlanTool.ts:171-344`
- **Creates:** Planning Agent with explore access
- **Special:** Required tool calls (todo_add must be called)
- **LLM Client:** Shared from main agent
- **Error Recovery:** Auto-accepts proposed todos

### 5. **SessionTitleGenerator** (Background Service)
- **File:** `src/services/SessionTitleGenerator.ts`
- **LLM Client:** service_model_client (separate)
- **Pattern:** Fire-and-forget, non-blocking
- **Error:** Silent failure with fallback

### 6. **IdleMessageGenerator** (Background Service)
- **File:** `src/services/IdleMessageGenerator.ts`
- **LLM Client:** service_model_client (same)
- **Trigger:** 10-second idle timeout
- **Error:** Silent failure with logging

### 7. **AskSessionTool** (Direct Query)
- **File:** `src/tools/AskSessionTool.ts:52-145`
- **LLM Client:** service_model_client
- **Pattern:** Direct send() call (no tool calls)
- **Error:** Try/catch with error response

---

## LLM Client Layer Architecture

### OllamaClient (Only Implementation)
- **Location:** `src/llm/OllamaClient.ts:52-781`
- **Method:** `send(messages, options)` - Line 173
- **Features:**
  - Streaming and non-streaming support
  - Function calling (tool use)
  - Automatic tool call repair
  - AbortController cancellation
  - Timeout management
  - Retry with exponential/linear backoff

### Model Client Instances
```
1. Main modelClient
   - Created: cli.ts:390-398
   - Used by: Main agent + all subagents
   - Type: OllamaClient

2. service_model_client
   - Created: cli.ts:404-412
   - Used by: Background services + AskSessionTool
   - Type: OllamaClient
```

### Request Path (Standard Flow)
```
Agent.getLLMResponse()
  ↓
modelClient.send(messages, {functions, stream})
  ↓
OllamaClient.send()
  ├─ Retry loop (3 attempts)
  ├─ executeRequestWithCancellation()
  ├─ fetch() with timeout
  ├─ Parse/validate response
  └─ Return LLMResponse or error
  ↓
Agent.processLLMResponse()
  ├─ Process tool calls
  ├─ Execute tools
  ├─ Get follow-up response (recursive)
  └─ OR process text response
```

---

## Error Handling - 7 Layers

### Layer 1: Transport Errors (OllamaClient.ts:226-254)
**When:** Network connectivity issues
**Errors:** ECONNREFUSED, ETIMEDOUT, TypeError with "fetch"
**Action:** Exponential backoff (2^attempt seconds, max 3 retries)
**Code:**
```typescript
if (this.isNetworkError(error) && attempt < maxRetries) {
  const waitTime = Math.pow(2, attempt);
  await this.sleep(waitTime * 1000);
  continue;
}
```

### Layer 2: JSON Parse Errors (OllamaClient.ts:245-249)
**When:** Malformed response JSON
**Errors:** SyntaxError from JSON.parse()
**Action:** Linear backoff ((1+attempt) seconds, max 3 retries)
**Code:**
```typescript
if (error instanceof SyntaxError && attempt < maxRetries) {
  const waitTime = (1 + attempt) * 1000;
  await this.sleep(waitTime);
  continue;
}
```

### Layer 3: HTTP Errors (OllamaClient.ts:346-349)
**When:** Server returns non-ok status
**Errors:** 404 (model not found), 500 (server error)
**Action:** Return error response with suggestions
**Code:**
```typescript
if (!response.ok) {
  const errorText = await response.text();
  throw new Error(`HTTP ${response.status}: ${errorText}`);
}
```

### Layer 4: Tool Call Validation (OllamaClient.ts:550-639)
**When:** LLM returns malformed tool calls
**Validates:**
- ID present and is string
- Type is 'function'
- Function object exists
- Function name present
- Arguments parse as JSON

**Action:** Repair if possible, else return error
**Code:** Lines 584-639

### Layer 5: Empty Response (Agent.ts:797-827)
**When:** LLM returns empty content after tool execution
**Detection:** `!content.trim() && !isRetry && isAfterToolExecution`
**Action:** 
1. Add continuation prompt to conversation
2. Retry with isRetry=true
3. If still empty, use fallback message

**Code:**
```typescript
if (!content.trim() && !isRetry) {
  const continuationPrompt: Message = {
    role: 'user',
    content: 'You just executed tool calls but did not provide any response. Please provide your response now based on the tool results.',
  };
  this.messages.push(continuationPrompt);
  const retryResponse = await this.getLLMResponse();
  return await this.processLLMResponse(retryResponse, true);
}
```

### Layer 6: Activity Timeout (Agent.ts:220-260)
**When:** Specialized agent makes no tool calls for 60+ seconds
**Applies to:** Subagents only (isSpecializedAgent=true)
**Detection:** ActivityWatchdog timer
**Action:** Interrupt agent and return error
**Code:** Lines 229-235

### Layer 7: Context Limits (Agent.ts:728-754)
**When:** Context usage reaches 90%
**Applies to:** Specialized agents only
**Detection:** `contextUsage >= CONTEXT_THRESHOLDS.WARNING`
**Action:** Block tool execution, request final summary instead
**Code:**
```typescript
if (this.config.isSpecializedAgent && contextUsage >= CONTEXT_THRESHOLDS.WARNING) {
  // Remove tool calls message
  // Add system reminder to summarize
  // Call getLLMResponse() for final response
}
```

### Bonus: Required Tool Calls (Agent.ts:856-912)
**When:** Agent configured with required tools (PlanTool)
**Enforced for:** PlanTool (requires: ['todo_add'])
**Detection:** Agent trying to exit without calling required tools
**Action:** 
1. Issue warning (up to 5 times)
2. Re-prompt agent to call missing tools
3. Fail with error if max warnings exceeded

---

## Critical Detection Gaps

### Gap 1: Empty Response Before Tools
**Location:** Agent.ts:376 (getLLMResponse)
**Issue:** Only detects empty content AFTER tool execution
**Missing:** Detection before tools are called
**Impact:** Ollama 500 errors on first response won't trigger retry
**Suggestion:** Add check at main response processing level

### Gap 2: Streaming Validation Errors
**Location:** OllamaClient.ts:219-223
**Issue:** Streaming responses log validation errors but don't retry
**Current:** Only non-streaming retries on validation errors
**Impact:** Streaming with bad tool calls won't recover
**Suggestion:** Add post-validation retry option for streaming

### Gap 3: HTTP 503 Service Unavailable
**Location:** OllamaClient.ts:346-349
**Issue:** 503 returns immediately, no retry
**Impact:** Transient Ollama outages fail the whole request
**Suggestion:** Add 503 to retriable error list with backoff

### Gap 4: Service Model Client Errors
**Location:** SessionTitleGenerator, IdleMessageGenerator
**Issue:** Fail silently with only fallback
**Impact:** No visibility into background service failures
**Suggestion:** Add error hooks and monitoring

### Gap 5: Model Client Not Isolated
**Location:** AgentTool.ts:233
**Issue:** All subagents share main agent's model client
**Impact:** Cancelling main agent affects all subagents
**Suggestion:** Create per-agent or request-isolated clients

---

## Retry Logic Summary

### Current Retry Implementation
```
Transport Errors:     Exponential: 2^0=1s, 2^1=2s, 2^2=4s (3 attempts total)
JSON Errors:          Linear: 1s, 2s, 3s (3 attempts total)
Tool Validation:      For non-streaming: Retry with error feedback (max 2)
Empty Response:       After tools only: Retry with prompt (1 retry)
Activity Timeout:     Interrupt immediately (no retry)
Context Limit:        Block tools, request summary (no retry)
Required Tools:       Re-prompt up to 5 times
```

### Retry Opportunities (Not Yet Implemented)
1. Empty response before tool execution
2. Streaming validation errors
3. HTTP 503 transient errors
4. Tool execution failures
5. Service background failures

---

## Configuration Points

### Timeouts
- `API_TIMEOUTS.LLM_REQUEST_BASE = 30000ms` (config/constants.ts)
- `API_TIMEOUTS.LLM_REQUEST_RETRY_INCREMENT = 10000ms` (config/constants.ts)
- `tool_call_activity_timeout = 60 seconds` (config/defaults.ts)

### Thresholds
- `CONTEXT_THRESHOLDS.WARNING = 90%` (config/toolDefaults.ts)
- `CONTEXT_THRESHOLDS.CRITICAL = 95%` (config/toolDefaults.ts)

### Limits
- `BUFFER_SIZES.AGENT_REQUIRED_TOOL_MAX_WARNINGS = 5`
- `maxRetries = 3` (default in OllamaClient.send)

---

## How to Use This Analysis

### For Implementing Comprehensive Retry Logic
1. Read **LLM_INTEGRATION_MAP.md** sections:
   - "Response Processing Chain" (to understand current flow)
   - "COMPREHENSIVE ERROR HANDLING MAP" (error types and current handling)
   - "CRITICAL ISSUES & RETRY OPPORTUNITIES" (gaps to fill)

2. Identify your target integration point (7 options)

3. Implement retry logic at appropriate layer:
   - Layer 1 (transport): OllamaClient.ts:226-254
   - Layer 2 (parsing): OllamaClient.ts:498-545
   - Layer 3 (validation): OllamaClient.ts:550-639
   - Layer 4 (response): Agent.ts:647-854
   - Layer 5+ (agent-specific): Add as needed

### For Understanding the Request Flow
1. Start with **LLM_FLOWS_DIAGRAM.txt**
2. Look at the relevant diagram (main agent, subagent, or service)
3. Follow the ASCII flowchart through retry loops and error handling
4. Check the error detection summary table

### For Quick Lookups
1. Use **INTEGRATION_POINTS_SUMMARY.md**
2. Find your integration point in the 7-point list
3. Look at the "Error Handling by Layer" section
4. Check "Critical Request/Response Paths" for your scenario

---

## Key Statistics

- **LLM Client Implementations:** 1 (OllamaClient)
- **Integration Points:** 7 major flows
- **Error Handling Layers:** 7 distinct layers
- **Model Client Instances:** 2 (main + service)
- **Retry Backoff Strategies:** 2 (exponential + linear)
- **Default Retry Attempts:** 3
- **Max Re-prompts (Required Tools):** 5
- **Service Flows:** 2 (SessionTitle, IdleMessage)
- **Direct Tool LLM Calls:** 1 (AskSessionTool)

---

## Next Steps

1. **Review the integration points** using the 3 documents
2. **Identify your priority gaps** from the "Critical Issues" section
3. **Choose implementation targets** (which integration points need retry logic)
4. **Design a unified retry framework** (see recommendations section)
5. **Implement and test** at each layer

For detailed code references and line numbers, see **LLM_INTEGRATION_MAP.md**.

---

Generated: October 31, 2025
Analysis Scope: Code Ally TypeScript codebase (~30,574 lines)
Documentation Pages: 3 (638 + 400+ + 300+ lines)
