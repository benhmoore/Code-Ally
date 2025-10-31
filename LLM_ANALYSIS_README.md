# Code Ally LLM Integration Points Analysis

## Quick Start

**Start here:** Read `/Users/bhm128/code-ally/LLM_INTEGRATION_ANALYSIS.md` for orientation and overview.

## Generated Documents

This analysis generated 4 comprehensive documents totaling 1,600+ lines of documentation with 500+ code references:

### 1. **LLM_INTEGRATION_ANALYSIS.md** (START HERE)
   - **Purpose:** Overview and index
   - **Use for:** Understanding the big picture, how to use other documents
   - **Contains:** Summary of 7 integration points, layers of error handling, gaps, statistics

### 2. **LLM_INTEGRATION_MAP.md** (DEEPEST REFERENCE)
   - **Purpose:** Technical reference with code
   - **Use for:** Understanding detailed implementation, finding code locations, identifying retry opportunities
   - **Contains:** 
     - Detailed breakdown of all 7 integration points
     - Request/response flow with line numbers
     - Complete error handling patterns
     - Tool call validation and repair logic
     - 5 critical issues and retry opportunities
     - Recommendations for improvements

### 3. **LLM_FLOWS_DIAGRAM.txt** (VISUAL GUIDE)
   - **Purpose:** ASCII flowcharts and diagrams
   - **Use for:** Understanding request paths visually, tracing execution flow
   - **Contains:**
     - Main agent flow with retry loop
     - Subagent delegation flows
     - Service background flows
     - Error detection and handling layers
     - Unimplemented retry opportunities

### 4. **INTEGRATION_POINTS_SUMMARY.md** (QUICK REFERENCE)
   - **Purpose:** Quick lookup and testing guide
   - **Use for:** Fast reference, testing, configuration
   - **Contains:**
     - 7-point integration overview
     - Error handling by layer (short form)
     - Key constants and configuration
     - Critical request/response paths
     - Testing strategies

---

## The 7 LLM Integration Points

| # | Flow | Entry Point | Location | Client | Recovery |
|---|------|-------------|----------|--------|----------|
| 1 | Main Agent | `sendMessage()` | Agent.ts:286 | modelClient | Follow-up response |
| 2 | AgentTool | Tool trigger | AgentTool.ts:72 | modelClient (shared) | Summary extraction |
| 3 | ExploreTool | Tool trigger | ExploreTool.ts:111 | modelClient (shared) | Summary extraction |
| 4 | PlanTool | Tool trigger | PlanTool.ts:171 | modelClient (shared) | Auto-accept todos |
| 5 | SessionTitle | Session creation | SessionTitleGenerator.ts | service_model_client | Fallback title |
| 6 | IdleMessage | Idle timeout | IdleMessageGenerator.ts | service_model_client | Silent failure |
| 7 | AskSession | Tool call | AskSessionTool.ts:52 | service_model_client | Error response |

---

## Error Handling - 7 Layers

Each integration point goes through up to 7 layers of error handling:

| Layer | When | Error Types | Recovery |
|-------|------|-------------|----------|
| 1 | Transport | ECONNREFUSED, ETIMEDOUT, TypeError | Exponential backoff (2^n) |
| 2 | JSON Parse | SyntaxError | Linear backoff (1+n) |
| 3 | HTTP | 404, 500, non-ok | Return error with suggestions |
| 4 | Tool Validation | Malformed calls | Repair if possible, else error |
| 5 | Empty Response | No content returned | Retry with continuation prompt |
| 6 | Activity Timeout | No tool calls 60s+ | Interrupt (subagents only) |
| 7 | Context Limits | ≥90% context used | Skip tools, request summary |

---

## How to Use This Analysis

### If you want to understand the complete flow:
1. Read **LLM_INTEGRATION_ANALYSIS.md** (5 min)
2. Review **LLM_FLOWS_DIAGRAM.txt** (10 min)
3. Skim **INTEGRATION_POINTS_SUMMARY.md** (5 min)
4. Deep dive **LLM_INTEGRATION_MAP.md** as needed (30+ min)

### If you want to implement retry logic:
1. Open **INTEGRATION_POINTS_SUMMARY.md**
2. Find your target integration point in the table
3. Check "Error Handling by Layer"
4. Reference line numbers in **LLM_INTEGRATION_MAP.md**
5. Use code snippets provided as templates

### If you want to understand a specific error:
1. Look up error type in **INTEGRATION_POINTS_SUMMARY.md** "Error Handling by Layer"
2. Find the layer number
3. Go to that section in **LLM_INTEGRATION_MAP.md**
4. See examples and current handling
5. Check "CRITICAL ISSUES & RETRY OPPORTUNITIES" for gaps

### If you want to test the integration points:
1. See **INTEGRATION_POINTS_SUMMARY.md** "Testing the Integration Points"
2. Follow provided test scenarios
3. Monitor logging output
4. Check error messages in error response

---

## Key Findings

### What's Already Implemented
- **3-tier error handling** in main agent (transport, validation, response)
- **Exponential backoff** for network errors (2^attempt seconds, max 3 retries)
- **Linear backoff** for JSON errors ((1+attempt) seconds, max 3 retries)
- **Tool call validation and repair** for non-streaming responses
- **Empty response detection** after tool execution
- **Activity timeout** for specialized agents (60 seconds)
- **Context limit enforcement** at 90% usage
- **Required tool calls** enforcement (PlanTool)

### Critical Gaps (Retry Opportunities)
1. **Empty response BEFORE tools** - Only detected after tool execution
2. **Streaming validation errors** - Only non-streaming retries on validation
3. **HTTP 503 errors** - No retry on Service Unavailable
4. **Service model errors** - Silent failure (no higher-level retry)
5. **Model client isolation** - All subagents share main client

---

## Integration Points Detailed Summary

### 1. Main Agent Flow (Primary)
- **What:** Main conversation loop
- **Where:** Agent.ts:286-395
- **How:** User input → getLLMResponse() → modelClient.send() → processResponse
- **Error handling:** Transport, JSON, HTTP, validation, empty response, activity, context
- **Retry:** Exponential for network (3x), linear for JSON (3x)

### 2. AgentTool (Task Delegation)
- **What:** Delegate tasks to specialized agents
- **Where:** AgentTool.ts:72-379
- **How:** Creates filtered Agent instance, reuses main client, extracts summary on empty
- **Special:** Activity timeout, tool whitelist, summary extraction fallback
- **Shared:** Model client (not isolated)

### 3. ExploreTool (Read-Only Analysis)
- **What:** Analyze codebase with read-only access
- **Where:** ExploreTool.ts:111-277
- **How:** Creates read-only Agent, hardcoded tools (read, glob, grep, ls, tree, batch)
- **Special:** Guaranteed read-only, activity timeout, summary extraction
- **Shared:** Model client (not isolated)

### 4. PlanTool (Implementation Planning)
- **What:** Create implementation plans with exploration
- **Where:** PlanTool.ts:171-344
- **How:** Creates planning Agent, enforces todo_add call, auto-accepts todos
- **Special:** Required tool calls, context limit enforcement, todo activation
- **Shared:** Model client (not isolated)

### 5. SessionTitleGenerator (Background Service)
- **What:** Generate session titles
- **Where:** SessionTitleGenerator.ts
- **How:** Fire-and-forget call to service_model_client
- **Pattern:** Non-blocking, fails silently, uses fallback title
- **Client:** service_model_client (separate from main)

### 6. IdleMessageGenerator (Background Service)
- **What:** Generate idle messages
- **Where:** IdleMessageGenerator.ts
- **How:** Fire-and-forget call on idle timeout (10s)
- **Pattern:** Non-blocking, logs errors, adds to queue
- **Client:** service_model_client (same as SessionTitleGenerator)

### 7. AskSessionTool (Direct Query)
- **What:** Query past sessions with LLM
- **Where:** AskSessionTool.ts:52-145
- **How:** Direct send() call with session content and question
- **Pattern:** Single request, no tool calls, immediate return
- **Client:** service_model_client

---

## Configuration and Constants

### Timeouts
- `API_TIMEOUTS.LLM_REQUEST_BASE = 30000ms` (30 seconds)
- `API_TIMEOUTS.LLM_REQUEST_RETRY_INCREMENT = 10000ms` (per attempt)
- `tool_call_activity_timeout = 60 seconds` (specialized agents only)

### Context Thresholds
- `CONTEXT_THRESHOLDS.WARNING = 90%` (specialized agents trigger summary)
- `CONTEXT_THRESHOLDS.CRITICAL = 95%` (main agent triggers auto-compact)

### Retry Limits
- `OllamaClient.send() maxRetries = 3` (default)
- Tool call validation retries = 2 (non-streaming only)
- Required tool call warnings = 5 (max before failure)

---

## Known Issues & Gaps

### Issue 1: Empty Response Before Tools
- **Location:** Agent.ts:376
- **Problem:** Only detects empty content AFTER tool execution
- **Impact:** Ollama 500 errors on initial response won't retry
- **Fix:** Add empty detection at main response level

### Issue 2: Streaming Validation Errors
- **Location:** OllamaClient.ts:219-223
- **Problem:** Streaming responses log but don't retry validation errors
- **Impact:** Streaming with bad tool calls can't recover
- **Fix:** Add post-validation retry for streaming

### Issue 3: No HTTP 503 Retry
- **Location:** OllamaClient.ts:346-349
- **Problem:** Service Unavailable (503) returns immediately
- **Impact:** Transient Ollama outages fail
- **Fix:** Add 503 to retriable error list with backoff

### Issue 4: Service Model Errors Silent
- **Location:** SessionTitleGenerator, IdleMessageGenerator
- **Problem:** Background services fail without visibility
- **Impact:** No way to monitor service failures
- **Fix:** Add error hooks and higher-level retry logic

### Issue 5: Model Client Not Isolated
- **Location:** AgentTool.ts:233
- **Problem:** All subagents share main agent's model client
- **Impact:** Cancelling main agent affects all subagents
- **Fix:** Create per-agent or request-isolated clients

---

## Recommendations for Improvement

### 1. Unified Retry Framework
Create a `RetryPolicy` interface with implementations:
- Exponential backoff
- Linear backoff
- Immediate retry
- No retry

Apply consistently across all 7 integration points.

### 2. Error Classification
Distinguish between retriable and fatal errors:
- **Retriable:** Network, timeout, transient 500s, 503
- **Fatal:** Validation, missing params, auth errors

### 3. Better Logging & Monitoring
- Log all retry attempts with context
- Track failure rates per error type
- Surface patterns to users
- Alert on high failure rates

### 4. User Feedback
- Show retry attempts and wait time
- Explain why retrying
- Offer manual retry/cancel options

### 5. Configuration
- Make retry policies user-configurable
- Provide presets: aggressive, balanced, conservative
- Allow per-tool/per-integration overrides

### 6. Model Client Isolation
- Create separate client for each Agent
- Or implement request-level isolation
- Prevent cross-cancellation effects

### 7. Service Model Monitoring
- Add error reporting hooks
- Implement fallback retry logic
- Log failures prominently

---

## Statistics

- **Total integration points:** 7 major flows
- **LLM client implementations:** 1 (OllamaClient)
- **Model client instances:** 2 (main + service)
- **Error handling layers:** 7 distinct layers
- **Lines of TypeScript code:** ~30,574
- **Documentation generated:** 1,600+ lines
- **Code references:** 500+ with line numbers

---

## File Locations in Project

All analysis documents are in the project root:
```
/Users/bhm128/code-ally/
├── LLM_ANALYSIS_README.md (this file)
├── LLM_INTEGRATION_ANALYSIS.md (start here)
├── LLM_INTEGRATION_MAP.md (detailed reference)
├── LLM_FLOWS_DIAGRAM.txt (visual guide)
└── INTEGRATION_POINTS_SUMMARY.md (quick reference)
```

Source code analyzed:
```
src/
├── agent/Agent.ts (main conversation loop)
├── agent/ToolOrchestrator.ts (tool execution)
├── agent/TokenManager.ts (context tracking)
├── llm/OllamaClient.ts (LLM client - MAIN INTEGRATION POINT)
├── llm/ModelClient.ts (abstract interface)
├── tools/AgentTool.ts (delegation)
├── tools/ExploreTool.ts (exploration)
├── tools/PlanTool.ts (planning)
├── tools/AskSessionTool.ts (queries)
├── services/SessionTitleGenerator.ts (background)
├── services/IdleMessageGenerator.ts (background)
└── cli.ts (entry point, client creation)
```

---

## Questions to Consider

1. Which integration point is your priority?
2. What error conditions are you most concerned about?
3. How important is user feedback during retries?
4. Do you want retry policies configurable by users?
5. Should subagents have isolated model clients?
6. How should background service failures be handled?

See the detailed documents for answers and implementation guidance.

---

**Generated:** October 31, 2025
**Analysis Scope:** Code Ally TypeScript codebase (~30,574 lines)
**Documentation:** 4 files, 1,600+ lines, 500+ code references
