# Expected Cause: Interruption Context Cleared Between Double sendMessage() Calls

## The Problem

Nested agents return `"Interrupted. Tell Ally what to do instead."` which leaks into parent agent conversation history, causing parent agents to interpret user-facing error messages as actual context.

---

## Root Cause

**AgentTool calls `sendMessage()` twice on the same agent instance, and the first call's cleanup erases critical interruption state needed by the second call.**

### The Sequence

1. **First `sendMessage()` call** (AgentTool.ts:726)
   - Agent executes task, makes tool calls, runs for 7+ minutes
   - Exceeds 120-second activity timeout threshold (defaults.ts:38)
   - Activity timeout handler sets `canContinueAfterTimeout: true` (Agent.ts:529)
   - Continuation logic activates, agent eventually completes
   - Returns empty string (no text response, only tool calls)

2. **First call cleanup** (Agent.ts:832 → 874)
   - `cleanupRequestState()` calls `interruptionManager.cleanup()`
   - `cleanup()` resets `interruptionContext` to fresh object (InterruptionManager.ts:187-190)
   - **`canContinueAfterTimeout` flag is ERASED**

3. **AgentTool detects empty response** (AgentTool.ts:732-734)
   - `extractSummaryFromConversation()` fails to find content
   - Falls through to "last resort" logic (AgentTool.ts:738-741)

4. **Second `sendMessage()` call on same agent** (AgentTool.ts:741-742)
   - Calls: `subAgent.sendMessage("Please provide a concise summary...")`
   - Agent starts fresh with `reset()` (Agent.ts:729), but context already cleared
   - Agent processes prompt, gets interrupted (timeout/error/etc.)
   - **No `canContinueAfterTimeout` flag present in context**

5. **Interrupt without continuation flag** (Agent.ts:1194-1195, 1232-1234)
   ```typescript
   const canContinueAfterTimeout = context.canContinueAfterTimeout === true;
   if (canContinueAfterTimeout) {
     // Continue...
   }
   // Flag is undefined/false, falls through to:
   return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
   ```

6. **AgentTool receives and fails to detect** (AgentTool.ts:744-745, 756)
   - `explicitSummary = "Interrupted. Tell Ally what to do instead."`
   - Detection only checks `response.includes('[Request interrupted')`
   - Does NOT match `"Interrupted. Tell Ally what to do instead."`
   - Message passes through as valid content

7. **Tool result contains user-facing message** (AgentTool.ts:770-777)
   - Wrapped and returned to parent: `{ result: "Interrupted. Tell Ally..." }`
   - ToolOrchestrator creates tool result message with `role: 'tool'`
   - Added to parent agent's conversation history
   - Parent reads it as context in next turn

---

## Evidence

### 1. Double sendMessage Pattern Exists

**AgentTool.ts:726** - First call:
```typescript
const response = await subAgent.sendMessage(`Execute this task: ${taskPrompt}`);
```

**AgentTool.ts:732-742** - Second call when empty:
```typescript
if (!response || response.trim().length === 0) {
  const summary = this.extractSummaryFromConversation(subAgent, agentType);
  if (summary) {
    finalResponse = summary;
  } else {
    // Last resort: try to get a summary by asking explicitly
    const explicitSummary = await subAgent.sendMessage(
      'Please provide a concise summary of what you accomplished, found, or determined while working on this task.'
    );
```

### 2. Cleanup Erases Interruption Context

**Agent.ts:832** - Cleanup called in finally block:
```typescript
finally {
  this.cleanupRequestState();
```

**Agent.ts:872-874** - Cleanup calls InterruptionManager.cleanup():
```typescript
private cleanupRequestState(): void {
  this.requestInProgress = false;
  this.interruptionManager.cleanup();
```

**InterruptionManager.ts:184-190** - Context reset without preserving flags:
```typescript
cleanup(): void {
  this.interrupted = false;
  this.interruptionType = null;
  this.interruptionContext = {
    reason: '',
    isTimeout: false,
    // canContinueAfterTimeout is NOT preserved
  };
```

### 3. Activity Timeout Sets Flag That Gets Cleared

**Agent.ts:521-533** - Timeout handler sets context then interrupts:
```typescript
private handleActivityTimeout(elapsedMs: number): void {
  const elapsedSeconds = Math.floor(elapsedMs / 1000);

  this.interruptionManager.setInterruptionContext({
    reason: `Activity timeout: no tool calls for ${elapsedSeconds} seconds`,
    isTimeout: true,
    canContinueAfterTimeout: true,  // ← SET HERE
  });

  this.interrupt();  // Interrupts current request
```

**defaults.ts:38** - Default timeout is 120 seconds:
```typescript
tool_call_activity_timeout: 120, // Timeout for agents without tool call activity (seconds)
```

**Bug report evidence** - Agents ran far longer than timeout:
- First run: 7m 10s (430 seconds) >> 120s
- Second run: 2m 10s (130 seconds) >> 120s

### 4. Continuation Requires Flag

**Agent.ts:1193-1234** - Checks flag, returns error if missing:
```typescript
// Check if this is a continuation-eligible timeout
const context = this.interruptionManager.getInterruptionContext();
const canContinueAfterTimeout = (context as any).canContinueAfterTimeout === true;

if (canContinueAfterTimeout) {
  // Add continuation prompt and retry...
  return await this.processLLMResponse(continuationResponse);
}

// Regular cancel - mark as interrupted for next request
this.interruptionManager.markRequestAsInterrupted();
return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;  // ← RETURNS THIS
```

### 5. Detection Doesn't Match Message

**AgentTool.ts:756** - Only checks for different format:
```typescript
if (response.includes('[Request interrupted') || response.length < TEXT_LIMITS.AGENT_RESPONSE_MIN) {
```

**constants.ts:850** - Actual message:
```typescript
USER_FACING_INTERRUPTION: 'Interrupted. Tell Ally what to do instead.',
```

These don't match, so detection fails.

---

## Why It's Persistent

This is an architectural flaw, not a random edge case:

1. **Agents often make only tool calls without text** - especially exploratory/research agents
2. **Long-running agents will timeout** - 120s is short for complex tasks
3. **AgentTool always makes second call on empty** - by design
4. **Context clearing is by design** - cleanup between requests
5. **Second call likely to fail** - asking for summary of work that may have been incomplete

The bug triggers whenever:
- Agent execution exceeds 120s (common for "medium" thoroughness tasks)
- AND agent returns empty text response (common for tool-focused work)
- AND second sendMessage() gets interrupted for any reason

---

## The Fix

### Immediate (Symptom)

**AgentTool.ts:756** - Detect ALL interruption messages:
```typescript
if (
  response.includes('[Request interrupted') ||
  response.includes('Interrupted. Tell Ally what to do instead.') ||
  response.includes('Permission denied. Tell Ally what to do instead.') ||
  response.length < TEXT_LIMITS.AGENT_RESPONSE_MIN
) {
```

### Architectural (Root Cause)

**Option A: Don't make second sendMessage() call**
- Accept empty responses as valid completion
- Improve `extractSummaryFromConversation()` to handle tool-only executions
- Report to parent: "Agent completed task with N tool calls, no summary provided"

**Option B: Preserve context across calls on same agent**
- Modify `cleanup()` to preserve certain context flags
- Or: don't call `cleanup()` until agent fully released by AgentTool
- Or: introduce request-level vs agent-level context separation

**Option C: Create new agent instance for second call**
- First call completes and agent released to pool
- Get fresh agent from pool for summary request
- Each agent instance handles exactly one request

**Recommendation**: Option A - The second call is a workaround for empty responses. Better to handle empty responses gracefully than risk propagating error messages.
