# ReadTool Improvements - Implementation Plan

## Executive Summary

This document provides a comprehensive plan for implementing two critical improvements to the ReadTool:
1. **Out-of-bounds read feedback** - Provide helpful feedback when offset exceeds file size
2. **Ephemeral large file reading** - Allow temporary large file reads that don't affect context management

## Current Implementation Analysis

### ReadTool.ts - Current Behavior

**File Path:** `/Users/benmoore/CodeAlly-TS/src/tools/ReadTool.ts`

#### Key Components:

1. **readFile() method (lines 182-219)**
   - Reads file content and splits into lines
   - Applies offset and limit using `Array.slice()`
   - Current offset logic: `startLine = offset > 0 ? offset - 1 : 0`
   - Current limit logic: `endLine = limit > 0 ? startLine + limit : lines.length`
   - **Issue:** When offset exceeds file length, `slice()` returns empty array with no feedback

2. **Token limiting (lines 37-45, 96-111)**
   - `getMaxTokens()`: Returns minimum of configured max and 20% of context size
   - Pre-execution estimation to prevent oversized reads
   - Current limits: `read_max_tokens: 3000` (default), capped at `contextSize * 0.2`

3. **estimateTokens() method (lines 154-177)**
   - Pre-estimates tokens before reading
   - If `limit > 0`: reads file and counts actual tokens
   - Otherwise: uses file size / 3.5 heuristic

### Related Systems

#### 1. **Message History Management** (`/Users/benmoore/CodeAlly-TS/src/agent/Agent.ts`)

- **addMessage() (lines 1211-1242)**: Adds messages to conversation history
- Messages are stored in `this.messages: Message[]`
- Auto-saves session after each message addition
- Updates TokenManager with new token counts
- **Key insight:** Messages persist in conversation until manually removed or auto-compacted

#### 2. **Tool Result Processing** (`/Users/benmoore/CodeAlly-TS/src/agent/ToolOrchestrator.ts`)

- **processToolResult() (lines 535-567)**: Formats and adds tool results to conversation
- Checks for duplicate content using TokenManager
- Adds tool result as a message with role='tool'
- **Integration point:** This is where we'd need to mark ephemeral content

#### 3. **Duplicate Content Detection** (`/Users/benmoore/CodeAlly-TS/src/agent/TokenManager.ts`)

- **trackToolResult() (lines 177-198)**: Tracks content hashes for deduplication
- Uses MD5 hashing to detect identical tool results
- Returns previous call ID if duplicate found
- **Key insight:** Ephemeral reads should NOT participate in duplicate detection (would cause false positives)

#### 4. **Edit Tool Validation** (`/Users/benmoore/CodeAlly-TS/src/tools/EditTool.ts`)

- **No explicit "prior read" validation found**
- Edit tool doesn't check if file was previously read
- Just reads file content directly before editing (lines 146)
- **Implication:** Ephemeral reads won't affect edit operations (no validation to break)

#### 5. **Message Types** (`/Users/benmoore/CodeAlly-TS/src/types/index.ts`)

```typescript
export interface Message {
  role: MessageRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  thinking?: string;
  timestamp?: number;
  metadata?: MessageMetadata; // EXISTING metadata field!
}

export interface MessageMetadata {
  isCommandResponse?: boolean;
  // Future: Add more presentation hints as needed
}
```

**Key discovery:** `MessageMetadata` already exists for presentation hints!

#### 6. **Auto-Compaction System** (`/Users/benmoore/CodeAlly-TS/src/agent/Agent.ts`)

- **checkAutoCompaction() (lines 1327-1386)**: Triggers when context exceeds threshold
- **performCompaction() (lines 1392-1475)**: Summarizes old messages
- Preserves system message and last user message
- **Integration point:** Need to remove ephemeral messages before compaction

---

## Issue 1: Out-of-Bounds Read Feedback

### Problem Statement

When `offset` exceeds the file's line count, the ReadTool returns empty content with no explanation. This leaves the model confused about what went wrong.

**Example:**
```typescript
// File has 500 lines
read(file_path="example.ts", offset=12000, limit=100)
// Returns: === example.ts === [empty content]
```

### Desired Behavior

```typescript
// File has 500 lines
read(file_path="example.ts", offset=12000, limit=100)
// Returns:
// === example.ts ===
// [Cannot read from offset 12000: file only has 500 lines.
//  Use offset=1 to start from the beginning, or offset=450 to read the last 50 lines.]
```

### Solution Design

#### Changes to ReadTool.ts

**Location:** `readFile()` method (lines 182-219)

**After splitting into lines (after line 205):**

```typescript
// Split into lines
const lines = content.split('\n');
const totalLines = lines.length;

// Validate offset against file size
if (offset > 0 && offset > totalLines) {
  // Calculate helpful suggestions
  const lastPageStart = Math.max(1, totalLines - (limit || 50));

  return `=== ${absolutePath} ===\n` +
    `[Cannot read from offset ${offset}: file only has ${totalLines} line${totalLines !== 1 ? 's' : ''}. ` +
    `Use offset=1 to start from the beginning` +
    (limit ? `, or offset=${lastPageStart} to read the last ${Math.min(limit, totalLines)} lines.` : '.') +
    `]`;
}

// Apply offset and limit (existing logic)
const startLine = offset > 0 ? offset - 1 : 0;
const endLine = limit > 0 ? startLine + limit : lines.length;
const selectedLines = lines.slice(startLine, endLine);

// Add informational header if only showing a slice
let header = `=== ${absolutePath} ===`;
if (offset > 1 || (limit > 0 && endLine < totalLines)) {
  header += `\n[Showing lines ${startLine + 1}-${Math.min(endLine, totalLines)} of ${totalLines} total lines]`;
}

// Format with line numbers
const formattedLines = selectedLines.map((line, index) => {
  const lineNum = startLine + index + 1;
  return `${String(lineNum).padStart(FORMATTING.LINE_NUMBER_WIDTH)}\t${line}`;
});

return `${header}\n${formattedLines.join('\n')}`;
```

#### Benefits:
- Provides clear, actionable feedback
- Suggests concrete offset values the model can use
- Shows total line count for context
- Adds informational headers when reading slices

#### Edge Cases Handled:
- Single-line files (plural vs singular)
- Files with no content (0 lines)
- Limit parameter present/absent
- Offset exactly at boundary (offset === totalLines + 1)

---

## Issue 2: Ephemeral Large File Reading

### Problem Statement

Sometimes the model needs to read a large file temporarily (e.g., to understand overall structure), but current token limits prevent this. The content is only needed for the current turn and shouldn't:
- Count against context limits long-term
- Participate in duplicate detection
- Affect subsequent edit operations
- Persist in conversation history

### Desired Behavior

```typescript
// Normal read - persists in history, subject to duplicate detection
read(file_path="large_file.ts", limit=100)

// Ephemeral read - removed after current turn, no duplicate tracking
read(file_path="large_file.ts", ephemeral=true)
// Can read up to (context_size * 0.9) tokens temporarily
```

### Solution Design

#### 1. Add `ephemeral` Parameter to ReadTool

**File:** `/Users/benmoore/CodeAlly-TS/src/tools/ReadTool.ts`

**Function definition (lines 50-79):**

```typescript
getFunctionDefinition(): FunctionDefinition {
  return {
    type: 'function',
    function: {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          file_paths: {
            type: 'array',
            description: 'Array of file paths to read',
            items: {
              type: 'string',
            },
          },
          limit: {
            type: 'integer',
            description: 'Maximum lines to read per file (0 = all lines)',
          },
          offset: {
            type: 'integer',
            description: 'Start reading from this line number (1-based)',
          },
          ephemeral: {  // NEW PARAMETER
            type: 'boolean',
            description: 'If true, reads up to 90% of context size temporarily. ' +
                        'Content is removed from conversation after current turn. ' +
                        'Use for one-time large file analysis. Default: false',
          },
        },
        required: ['file_paths'],
      },
    },
  };
}
```

**executeImpl() modifications (lines 81-149):**

```typescript
protected async executeImpl(args: any): Promise<ToolResult> {
  this.captureParams(args);

  const filePaths = args.file_paths;
  const limit = args.limit !== undefined ? Number(args.limit) : 0;
  const offset = args.offset !== undefined ? Number(args.offset) : 0;
  const ephemeral = args.ephemeral === true;  // NEW

  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return this.formatErrorResponse(
      'file_paths must be a non-empty array',
      'validation_error',
      'Example: read(file_paths=["src/main.ts", "package.json"])'
    );
  }

  // Calculate token limit based on ephemeral flag
  const maxTokens = ephemeral
    ? this.getEphemeralMaxTokens()  // 90% of context
    : this.getMaxTokens();           // 20% of context (existing)

  const estimatedTokens = await this.estimateTokens(filePaths, limit, offset);

  if (estimatedTokens > maxTokens) {
    const examples = filePaths.length === 1
      ? `read(file_paths=["${filePaths[0]}"], limit=100) or read(file_paths=["${filePaths[0]}"], offset=50, limit=100)`
      : `read(file_paths=["${filePaths[0]}"], limit=100) or read fewer files`;

    const ephemeralHint = !ephemeral
      ? ' Or use ephemeral=true to read larger files temporarily (content removed after current turn).'
      : '';

    return this.formatErrorResponse(
      `File(s) too large: estimated ${estimatedTokens.toFixed(1)} tokens exceeds limit of ${maxTokens}. ` +
      `Use grep/glob to search for specific content, or use limit/offset for targeted reading.${ephemeralHint} ` +
      `Example: ${examples}`,
      'validation_error',
      `Use targeted reading with limit parameter or search within files first using grep`
    );
  }

  // Read files (existing logic)
  const results: string[] = [];
  const errors: string[] = [];
  let filesRead = 0;

  for (const filePath of filePaths) {
    try {
      const content = await this.readFile(filePath, limit, offset);
      results.push(content);
      filesRead++;
    } catch (error) {
      const errorMsg = formatError(error);
      errors.push(`${filePath}: ${errorMsg}`);
      results.push(`=== ${filePath} ===\nError: ${errorMsg}`);
    }
  }

  if (filesRead === 0) {
    return this.formatErrorResponse(
      `Failed to read ${errors.length} file${errors.length !== 1 ? 's' : ''}: ${errors.join(', ')}`,
      'file_error'
    );
  }

  const combinedContent = results.join('\n\n');

  // Mark result as ephemeral if requested
  const result = this.formatSuccessResponse({
    content: combinedContent,
    files_read: filesRead,
    files_failed: errors.length,
    partial_failure: errors.length > 0,
  });

  // Add ephemeral marker to result metadata
  if (ephemeral) {
    result._ephemeral = true;  // Internal marker for ToolOrchestrator
    result._ephemeral_warning =
      '[EPHEMERAL READ: This content will be removed from conversation after current turn. ' +
      'If you need it later, use a regular read or save key information in your response.]';
  }

  return result;
}

/**
 * Get maximum tokens for ephemeral reads (90% of context size)
 */
private getEphemeralMaxTokens(): number {
  const contextSize = this.config?.context_size ?? CONTEXT_SIZES.SMALL;
  return Math.floor(contextSize * 0.9);  // 90% of context
}
```

#### 2. Extend MessageMetadata for Ephemeral Marking

**File:** `/Users/benmoore/CodeAlly-TS/src/types/index.ts`

```typescript
export interface MessageMetadata {
  /** Whether this is a command response that should be styled in yellow */
  isCommandResponse?: boolean;

  /** Whether this message should be removed after the current turn */
  ephemeral?: boolean;  // NEW

  /** Whether this is an ephemeral marker message (cleanup trigger) */
  ephemeralMarker?: boolean;  // NEW
}
```

#### 3. Mark Ephemeral Messages in ToolOrchestrator

**File:** `/Users/benmoore/CodeAlly-TS/src/agent/ToolOrchestrator.ts`

**processToolResult() modifications (lines 535-567):**

```typescript
private async processToolResult(
  toolCall: ToolCall,
  result: ToolResult
): Promise<void> {
  // Format result as natural language
  const formattedResult = this.formatToolResult(toolCall.function.name, result, toolCall.id);

  logger.debug('[TOOL_ORCHESTRATOR] processToolResult - tool:', toolCall.function.name, 'id:', toolCall.id, 'success:', result.success, 'resultLength:', formattedResult.length);

  // Check if this is an ephemeral read
  const isEphemeral = (result as any)._ephemeral === true;

  // Skip duplicate detection for ephemeral reads (they're temporary anyway)
  const tokenManager = this.agent.getTokenManager();
  const previousCallId = isEphemeral
    ? null
    : tokenManager.trackToolResult(toolCall.id, formattedResult);

  let finalContent: string;
  if (previousCallId) {
    // Result is identical to a previous call - replace with reference
    finalContent = `[Duplicate result: This ${toolCall.function.name} call returned identical content to call ID ${previousCallId}. Review that result above instead of re-reading. Repeated identical reads waste context space.]`;
    logger.debug('[TOOL_ORCHESTRATOR] Deduplicated result for', toolCall.function.name, '- references call', previousCallId);
  } else {
    // Unique result - use full content
    // Add ephemeral warning if present
    const ephemeralWarning = (result as any)._ephemeral_warning;
    finalContent = ephemeralWarning
      ? `${ephemeralWarning}\n\n${formattedResult}`
      : formattedResult;
  }

  // Add tool result message to conversation with ephemeral metadata
  this.agent.addMessage({
    role: 'tool',
    content: finalContent,
    tool_call_id: toolCall.id,
    name: toolCall.function.name,
    metadata: isEphemeral ? { ephemeral: true } : undefined,  // Mark as ephemeral
  });

  logger.debug('[TOOL_ORCHESTRATOR] processToolResult - tool result added to agent conversation',
    isEphemeral ? '(EPHEMERAL)' : '');
}
```

#### 4. Clean Up Ephemeral Messages After Turn

**File:** `/Users/benmoore/CodeAlly-TS/src/agent/Agent.ts`

**New method to add after processTextResponse() (around line 1062):**

```typescript
/**
 * Clean up ephemeral messages from conversation history
 * Called after assistant provides final text response for a turn
 * Removes all messages marked as ephemeral
 */
private cleanupEphemeralMessages(): void {
  const originalLength = this.messages.length;

  // Filter out ephemeral messages
  this.messages = this.messages.filter(msg => {
    const isEphemeral = msg.metadata?.ephemeral === true;
    if (isEphemeral) {
      logger.debug('[AGENT_EPHEMERAL]', this.instanceId,
        `Removing ephemeral message: role=${msg.role}, tool_call_id=${msg.tool_call_id || 'n/a'}`);
    }
    return !isEphemeral;
  });

  const removedCount = originalLength - this.messages.length;
  if (removedCount > 0) {
    logger.debug('[AGENT_EPHEMERAL]', this.instanceId,
      `Cleaned up ${removedCount} ephemeral message(s)`);

    // Update token count after cleanup
    this.tokenManager.updateTokenCount(this.messages);

    // Auto-save after cleanup
    this.autoSaveSession();
  }
}
```

**Modify processTextResponse() to call cleanup (around line 1061):**

```typescript
private async processTextResponse(response: LLMResponse, isRetry: boolean = false): Promise<string> {
  // ... existing validation and continuation logic ...

  // Normal path - we have content and all required tools (if any) have been called
  const assistantMessage: Message = {
    role: 'assistant',
    content: content,
    timestamp: Date.now(),
  };
  this.messages.push(assistantMessage);

  // Clean up ephemeral messages BEFORE auto-save
  // This ensures ephemeral content doesn't persist in session files
  this.cleanupEphemeralMessages();

  // Auto-save after text response
  this.autoSaveSession();

  // Emit completion event
  this.emitEvent({
    id: this.generateId(),
    type: ActivityEventType.AGENT_END,
    timestamp: Date.now(),
    data: {
      content: content,
      isSpecializedAgent: this.config.isSpecializedAgent || false,
    },
  });

  return content;
}
```

#### 5. Exclude Ephemeral Messages from Auto-Compaction

**File:** `/Users/benmoore/CodeAlly-TS/src/agent/Agent.ts`

**Modify performCompaction() (around line 1405):**

```typescript
private async performCompaction(): Promise<Message[]> {
  // Extract system message and other messages
  const systemMessage = this.messages[0]?.role === 'system' ? this.messages[0] : null;
  let otherMessages = systemMessage ? this.messages.slice(1) : this.messages;

  // Filter out ephemeral messages before compaction
  // They should have been cleaned up already, but this is a safety net
  otherMessages = otherMessages.filter(msg => !msg.metadata?.ephemeral);

  // If we have fewer than 2 messages to summarize, nothing to compact
  if (otherMessages.length < BUFFER_SIZES.MIN_MESSAGES_FOR_HISTORY) {
    return this.messages;
  }

  // ... rest of compaction logic unchanged ...
}
```

---

## Integration Points Summary

### 1. ReadTool.ts
- **Add `ephemeral` parameter** to function definition
- **Implement `getEphemeralMaxTokens()`** method
- **Modify `executeImpl()`** to handle ephemeral flag
- **Enhance `readFile()`** with out-of-bounds validation and slice headers
- **Mark results** with `_ephemeral` and `_ephemeral_warning` metadata

### 2. types/index.ts
- **Extend `MessageMetadata`** interface with `ephemeral` and `ephemeralMarker` fields

### 3. ToolOrchestrator.ts
- **Modify `processToolResult()`** to:
  - Check for ephemeral flag
  - Skip duplicate tracking for ephemeral reads
  - Add ephemeral warning to content
  - Mark message with ephemeral metadata

### 4. Agent.ts
- **Add `cleanupEphemeralMessages()`** method
- **Call cleanup in `processTextResponse()`** before auto-save
- **Filter ephemeral messages in `performCompaction()`**

### 5. TokenManager.ts
- **No changes needed** - ephemeral reads skip `trackToolResult()` entirely

---

## Testing Strategy

### Issue 1: Out-of-Bounds Feedback

#### Test Cases:

1. **Offset beyond file size**
   ```typescript
   // File: 500 lines
   read(file_path="test.ts", offset=1000)
   // Expected: Error with suggestions
   ```

2. **Offset at boundary**
   ```typescript
   // File: 100 lines
   read(file_path="test.ts", offset=101)
   // Expected: Error message
   ```

3. **Valid offset with limit**
   ```typescript
   // File: 100 lines
   read(file_path="test.ts", offset=50, limit=25)
   // Expected: Lines 50-74 with header showing slice info
   ```

4. **Reading to end**
   ```typescript
   // File: 100 lines
   read(file_path="test.ts", offset=90)
   // Expected: Lines 90-100 with header
   ```

5. **Edge case: Empty file**
   ```typescript
   read(file_path="empty.ts", offset=1)
   // Expected: Appropriate error for 0-line file
   ```

### Issue 2: Ephemeral Reads

#### Test Cases:

1. **Basic ephemeral read**
   ```typescript
   read(file_path="large.ts", ephemeral=true)
   // Expected:
   // - Content loads up to 90% context
   // - Warning message appears
   // - After turn, message removed from history
   ```

2. **Ephemeral read persistence check**
   ```typescript
   // Turn 1: Ephemeral read
   read(file_path="large.ts", ephemeral=true)
   // [Model responds]

   // Turn 2: Check history
   // Expected: Large file content NOT in history
   // Expected: Model can still reference info from its response
   ```

3. **Duplicate detection bypass**
   ```typescript
   // Turn 1: Normal read
   read(file_path="test.ts")

   // Turn 2: Ephemeral read of same file
   read(file_path="test.ts", ephemeral=true)

   // Expected: NOT deduplicated (ephemeral skips tracking)
   ```

4. **Token limit validation**
   ```typescript
   // Context: 16K tokens, file: 15K tokens
   read(file_path="huge.ts", ephemeral=false)
   // Expected: Error (exceeds 20% = 3.2K)

   read(file_path="huge.ts", ephemeral=true)
   // Expected: Success (within 90% = 14.4K)
   ```

5. **Session save validation**
   ```typescript
   // Ephemeral read + save session
   read(file_path="large.ts", ephemeral=true)
   // [Model responds]
   // Check: Session file should NOT contain ephemeral content
   ```

6. **Auto-compaction safety**
   ```typescript
   // Fill context, trigger auto-compact with ephemeral messages present
   // Expected: Ephemeral messages filtered out before summarization
   ```

---

## Implementation Risks & Mitigations

### Risk 1: Ephemeral Messages Not Cleaned Up

**Scenario:** Cleanup fails or is skipped, ephemeral content persists

**Impact:** Context bloat, wasted tokens, session file pollution

**Mitigation:**
- Add cleanup in multiple locations (processTextResponse, performCompaction)
- Add debug logging for all cleanup operations
- Add assertion tests to verify cleanup
- Safety filter in compaction as fallback

### Risk 2: Edit Operations After Ephemeral Read

**Scenario:** Model tries to edit file after ephemeral read

**Impact:** Edit might fail if it expects specific line numbers from ephemeral read

**Likelihood:** LOW - Edit tool doesn't validate prior reads

**Mitigation:**
- Document clearly in ephemeral warning
- Model prompt should emphasize temporary nature
- No code changes needed (Edit reads file fresh anyway)

### Risk 3: Duplicate Detection False Negatives

**Scenario:** Ephemeral read followed by normal read of same file

**Impact:** Content appears twice (ephemeral + normal)

**Likelihood:** LOW - ephemeral cleanup happens before next turn

**Mitigation:**
- Cleanup happens immediately after assistant response
- Normal read on next turn won't see ephemeral version
- No special handling needed

### Risk 4: Token Estimation Inaccuracy

**Scenario:** Ephemeral read underestimates size, overflows context

**Impact:** Model receives truncated/corrupted content

**Likelihood:** LOW - uses same estimation as normal reads

**Mitigation:**
- Existing token counter is accurate (Anthropic's official tokenizer)
- 90% limit leaves 10% buffer for safety
- Same pre-validation logic as normal reads

### Risk 5: Session Loading with Stale Ephemeral Messages

**Scenario:** Old session file has ephemeral messages (pre-cleanup bug)

**Impact:** Ephemeral content reappears on session load

**Likelihood:** LOW after initial testing

**Mitigation:**
- Filter ephemeral messages in session load logic
- Add migration code to clean old sessions
- Version session file format to detect old files

---

## Performance Considerations

### Token Counting Performance

**Current:** Pre-estimates using file size heuristic (fast) or actual tokenization (slower)

**Impact of Changes:**
- Out-of-bounds check: Negligible (one array length check)
- Ephemeral reads: No performance impact (same tokenization)

### Memory Usage

**Current:** Messages stored in memory, auto-compaction when needed

**Impact of Changes:**
- Ephemeral reads temporarily increase memory (up to 90% context)
- Cleanup reduces memory after turn
- Net impact: Neutral (same as before, just different lifecycle)

### Session File Size

**Current:** All messages saved to session files

**Impact of Changes:**
- Cleanup before save prevents ephemeral content from persisting
- Session files should be smaller (less duplicate large content)
- Net impact: Positive (smaller session files)

---

## Configuration Changes

### New Config Option (Optional Enhancement)

**File:** `/Users/benmoore/CodeAlly-TS/src/config/defaults.ts`

```typescript
export const DEFAULT_CONFIG: Config = {
  // ... existing config ...

  // Ephemeral read settings
  ephemeral_read_max_percent: 0.9,  // Maximum context % for ephemeral reads (90%)
  ephemeral_read_enabled: true,     // Enable/disable ephemeral reads globally
};
```

This allows users to:
- Adjust ephemeral limit (e.g., 0.8 for 80%)
- Disable feature entirely if problematic
- Fine-tune based on model/context size

**Implementation:** Add `getEphemeralMaxTokens()` config check:

```typescript
private getEphemeralMaxTokens(): number {
  const contextSize = this.config?.context_size ?? CONTEXT_SIZES.SMALL;
  const maxPercent = this.config?.ephemeral_read_max_percent ?? 0.9;
  return Math.floor(contextSize * maxPercent);
}
```

---

## Estimated Complexity

### Issue 1: Out-of-Bounds Feedback
- **Lines of Code:** ~30 lines
- **Files Modified:** 1 (ReadTool.ts)
- **Complexity:** LOW
- **Risk:** VERY LOW
- **Estimated Time:** 1-2 hours (including tests)

### Issue 2: Ephemeral Large File Reading
- **Lines of Code:** ~100-150 lines
- **Files Modified:** 4 (ReadTool.ts, types/index.ts, ToolOrchestrator.ts, Agent.ts)
- **Complexity:** MEDIUM
- **Risk:** MEDIUM (affects message lifecycle)
- **Estimated Time:** 4-6 hours (including tests)

### Total Estimated Time: 5-8 hours

---

## Rollout Strategy

### Phase 1: Issue 1 Only (Quick Win)
1. Implement out-of-bounds validation
2. Test with edge cases
3. Deploy independently
4. Gather feedback

### Phase 2: Issue 2 (Full Feature)
1. Implement ephemeral parameter
2. Implement cleanup logic
3. Test thoroughly (especially edge cases)
4. Add configuration options
5. Update documentation
6. Deploy with monitoring

### Phase 3: Post-Deploy
1. Monitor session file sizes (should decrease)
2. Monitor context usage patterns
3. Gather user feedback on ephemeral reads
4. Tune default limits if needed

---

## Documentation Updates Needed

### 1. ReadTool Function Description
Update to mention:
- `offset` validation and helpful errors
- `ephemeral` parameter and its use cases
- Informational headers when reading slices

### 2. Model Prompt (System Message)
Add guidance:
- When to use ephemeral reads (one-time large file analysis)
- Warning that ephemeral content disappears
- Suggestion to save key info in response

### 3. User Documentation
- Explain ephemeral reads feature
- Show example use cases
- Document limitations and trade-offs

---

## Success Criteria

### Issue 1: Out-of-Bounds Feedback
✅ Out-of-bounds reads return helpful error messages
✅ Error messages suggest concrete offset values
✅ Informational headers show slice ranges
✅ Model stops making invalid offset requests

### Issue 2: Ephemeral Large File Reading
✅ Model can read files up to 90% context size with `ephemeral=true`
✅ Ephemeral content removed after turn (verified in session files)
✅ Duplicate detection not triggered by ephemeral reads
✅ Edit operations work normally after ephemeral reads
✅ Context usage drops after ephemeral cleanup
✅ No memory leaks or orphaned messages

---

## Conclusion

Both improvements are well-scoped and implementable with minimal risk:

1. **Out-of-bounds feedback** is a simple enhancement with immediate value
2. **Ephemeral reads** is more complex but leverages existing infrastructure (MessageMetadata, message filtering)

The key insight is that ephemeral messages can be marked using the existing `metadata` field and filtered at strategic points (after response, before compaction, before save). This avoids invasive changes to the message lifecycle while providing the needed functionality.

The implementation preserves all existing behavior for non-ephemeral reads and adds opt-in functionality for ephemeral reads, minimizing risk of regression.
