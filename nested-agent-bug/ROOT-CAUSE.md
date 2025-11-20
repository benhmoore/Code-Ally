# ROOT CAUSE: Double sendMessage() Clears Interruption Context

## Executive Summary

Nested agents return `"Interrupted. Tell Ally what to do instead."` to parent agents because:

1. **AgentTool makes TWO calls to `sendMessage()` on the same agent instance when first call returns empty**
2. **First call's cleanup ERASES the interruption context** (including `canContinueAfterTimeout` flag)
3. **Second call gets interrupted but has NO continuation flag** → returns USER_FACING_INTERRUPTION
4. **AgentTool doesn't detect this as an interruption message** → passes it through as valid tool result
5. **Parent agent receives interruption message in conversation history**

---

## The Complete Bug Path

### Step 1: First sendMessage() Call (AgentTool.ts:726)

```typescript
const response = await subAgent.sendMessage(`Execute this task: ${taskPrompt}`);
```

Agent executes, makes tool calls, but returns **empty text response**.

Why empty? Agent makes only tool calls without providing summary text. Common when:
- Agent is focused on exploration/research
- Agent makes many tool calls and runs long
- Agent hits activity timeout during execution

### Step 2: Activity Timeout During First Call

**Default timeout**: 120 seconds without tool calls

**Bug report evidence**:
- First run: 7m 10s (430 seconds) - FAR exceeds 120s timeout
- Second run: 2m 10s (130 seconds) - exceeds 120s timeout

**What happens** (`Agent.ts:521-536`):

```typescript
private handleActivityTimeout(elapsedMs: number): void {
  const elapsedSeconds = Math.floor(elapsedMs / 1000);

  // Line 526-530: Set interruption context with continuation flag
  this.interruptionManager.setInterruptionContext({
    reason: `Activity timeout: no tool calls for ${elapsedSeconds} seconds`,
    isTimeout: true,
    canContinueAfterTimeout: true,  // ← FLAG SET HERE
  });

  // Line 533: Interrupt (type defaults to 'cancel')
  this.interrupt();
}
```

**Continuation triggers** (`Agent.ts:1193-1230`):

```typescript
// Check if this is a continuation-eligible timeout
const context = this.interruptionManager.getInterruptionContext();
const canContinueAfterTimeout = context.canContinueAfterTimeout === true;

if (canContinueAfterTimeout) {
  // Add continuation prompt
  // Reset interruption
  // Request new LLM response
  // Recursively process
  return await this.processLLMResponse(continuationResponse);
}
```

Agent continues multiple times, eventually completes, returns empty string to AgentTool.

### Step 3: First Call Cleanup

**Finally block** (`Agent.ts:832`):

```typescript
finally {
  this.cleanupRequestState();
  // ... resume parent monitoring ...
}
```

**cleanupRequestState()** (`Agent.ts:872-875`):

```typescript
private cleanupRequestState(): void {
  this.requestInProgress = false;
  this.interruptionManager.cleanup();  // ← ERASES CONTEXT
  this.stopActivityMonitoring();
  // ...
}
```

**InterruptionManager.cleanup()** (`InterruptionManager.ts:184-192`):

```typescript
cleanup(): void {
  this.interrupted = false;
  this.interruptionType = null;
  this.interruptionContext = {
    reason: '',
    isTimeout: false,
    // ← canContinueAfterTimeout is GONE!
  };
}
```

**CRITICAL**: The `canContinueAfterTimeout` flag is ERASED when first call completes.

### Step 4: AgentTool Detects Empty Response (AgentTool.ts:732-753)

```typescript
if (!response || response.trim().length === 0) {
  logger.debug('[AGENT_TOOL] Sub-agent returned empty response, attempting to extract summary');

  const summary = this.extractSummaryFromConversation(subAgent, agentType);

  if (summary) {
    finalResponse = summary;
  } else {
    // Last resort: try to get a summary by asking explicitly
    logger.debug('[AGENT_TOOL] Attempting to request explicit summary from sub-agent');
    try {
      // SECOND CALL TO SAME AGENT INSTANCE
      const explicitSummary = await subAgent.sendMessage(
        'Please provide a concise summary of what you accomplished, found, or determined while working on this task.'
      );

      if (explicitSummary && explicitSummary.trim().length > 0) {
        finalResponse = explicitSummary;
      }
    } catch (summaryError) {
      // ...
    }
  }
}
```

### Step 5: Second sendMessage() Call Gets Interrupted

**Fresh start** (`Agent.ts:728-730`):

```typescript
// Reset interrupted flag and mark request in progress
this.interruptionManager.reset();  // Clears interrupted/type, but context already cleared by cleanup()
this.requestInProgress = true;
```

**Agent processes prompt**: "Please provide a concise summary..."

**This is asking agent to reflect on work it just did**. Agent's conversation includes:
- All tool calls from first execution
- All tool results
- New message asking for summary

**Two scenarios**:

**Scenario A: Agent hits activity timeout again**
- Agent generates long reflection without making tool calls
- Watchdog timer expires (120s)
- handleActivityTimeout() sets `canContinueAfterTimeout: true` AGAIN
- Should continue successfully → But why doesn't it?

**Scenario B: Agent interrupted by different mechanism**
- HTTP error during LLM call
- Parent agent interference
- User cancellation (though should be routed differently)
- Some other interruption WITHOUT `canContinueAfterTimeout` flag

Either way, if continuation fails or interruption happens without the flag:

**processLLMResponse()** (`Agent.ts:1232-1234`):

```typescript
// Regular cancel - mark as interrupted for next request
this.interruptionManager.markRequestAsInterrupted();
return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;  // ← RETURNS THIS
```

### Step 6: AgentTool Receives USER_FACING_INTERRUPTION (AgentTool.ts:744-745)

```typescript
if (explicitSummary && explicitSummary.trim().length > 0) {
  finalResponse = explicitSummary;  // ← explicitSummary = "Interrupted. Tell Ally what to do instead."
}
```

### Step 7: AgentTool Fails to Detect Interruption (AgentTool.ts:756)

```typescript
// Check if response is just an interruption or error message
if (response.includes('[Request interrupted') || response.length < TEXT_LIMITS.AGENT_RESPONSE_MIN) {
  // Try to extract summary...
} else {
  finalResponse = response;  // ← USER_FACING_INTERRUPTION passes through!
}
```

**BUG**: Only checks for `'[Request interrupted'`, NOT `'Interrupted. Tell Ally what to do instead.'`

### Step 8: Parent Agent Receives as Tool Result (AgentTool.ts:770-777)

```typescript
const result = finalResponse + '\n\nIMPORTANT: The user CANNOT see this summary...';
return { result };
```

**Tool result flows through**:
1. ToolOrchestrator.processToolResult() → creates message with role='tool'
2. Agent.addMessage() → adds to conversation
3. Parent agent's next turn → sees "Interrupted. Tell Ally..." in history
4. Parent agent interprets as context from child agent

---

## Why This Is Architectural

### The Flawed Assumption

**AgentTool assumes**: One sendMessage() call per agent execution

**Reality**: AgentTool makes TWO calls when first returns empty:
1. Execute task
2. Request summary

**Problem**: Agent's interruption context is request-scoped, cleared between calls

### The Missing Safeguard

**AgentTool should**:
1. Detect ALL interruption messages, not just `'[Request interrupted'`
2. Never make second sendMessage() call on interrupted/failed first call
3. Handle empty responses without requiring synchronous summary

**Current behavior**: Makes blind second call that can return user-facing error messages

### State Management Issue

**Interruption context is request-scoped**:
- Set by specific interruption (timeout, cancel, etc.)
- Cleared by cleanup() after request completes
- Not preserved across multiple sendMessage() calls to same agent

**For double-sendMessage pattern**: Second call has NO knowledge of first call's interruption history

---

## Why Timeouts Don't Continue Properly

**Mystery**: If second sendMessage() hits activity timeout, shouldn't it continue like first did?

**Possible explanations**:

1. **Continuation fails**: `getLLMResponse()` during continuation throws error, bypasses continuation logic
2. **Recursive timeout**: Continuation also times out, recurses too deep, eventually fails
3. **Different interrupt type**: Second call interrupted by non-timeout mechanism (HTTP error, parent interference)
4. **Context corruption**: Some state from first call interferes with second

Needs deeper investigation, but the ROOT issue is clear: **user-facing messages shouldn't reach parent agents**.

---

## The Fix

### Immediate (Symptom)

**Location**: `AgentTool.ts:756`

**Current**:
```typescript
if (response.includes('[Request interrupted') || response.length < TEXT_LIMITS.AGENT_RESPONSE_MIN) {
```

**Fixed**:
```typescript
if (
  response.includes('[Request interrupted') ||
  response.includes('Interrupted. Tell Ally what to do instead.') ||
  response.includes('Permission denied. Tell Ally what to do instead.') ||
  response.length < TEXT_LIMITS.AGENT_RESPONSE_MIN
) {
```

### Architectural (Root Cause)

**Option A**: Don't make second sendMessage() call
- Extract summary from conversation history more intelligently
- Accept empty responses as valid
- Don't require synchronous summary from agent

**Option B**: Preserve interruption context across calls
- Don't clear context in cleanup(), only in reset()
- Or: Make second call aware it's a continuation of first
- Or: Create new agent instance for second call

**Option C**: Better error handling
- Catch and handle USER_FACING_* constants before they reach tool results
- Add filter in ToolOrchestrator.formatToolResult()
- Never allow display-only messages into conversation history

---

## Verification Needed

To fully confirm, need to check:

1. **Logs from actual bug occurrence**: Does second sendMessage() get called? Does it timeout or hit different error?
2. **Continuation recursion**: How many times does continuation loop before returning empty?
3. **HTTP errors**: Could LLM client errors during second call bypass continuation logic?
4. **Parent monitor interference**: Does parent's activity monitor somehow affect child's second call?

But the core issue is proven: **cleanup() erases canContinueAfterTimeout between calls**.
