# Test Coverage Gaps - Phase 3.9

This document identifies areas requiring additional test coverage following the implementation of multiple bug fixes and features across Code Ally. The gaps are prioritized based on risk, complexity, and integration points.

## High Priority

### 1. Session Cleanup Race Conditions

**Area:** SessionManager cleanup with concurrent operations

**Current Coverage:** Basic cleanup tests exist but don't cover concurrent scenarios

**Gap:** The session cleanup exclusion logic (Phase 1.3) prevents deletion of currentSession during cleanup. This has a critical race window:
- Session created and set as current
- Multiple instances or rapid operations could trigger cleanup
- currentSession exclusion depends on timing of `setCurrentSession()` vs `cleanupOldSessions()`

**What Should Be Tested:**
- Concurrent session creation hitting maxSessions limit
- Rapid session switches during cleanup
- Multiple agent instances cleaning up simultaneously
- Cleanup triggered immediately after session creation

**Why Important:** Race conditions could delete active sessions or exceed maxSessions limit. Data loss potential.

**Suggested Approach:**
```typescript
// Integration test with concurrent operations
describe('SessionManager - Concurrent Cleanup', () => {
  it('should not delete currentSession during concurrent cleanup', async () => {
    // Create maxSessions + 1 sessions rapidly
    // Verify currentSession survives
  });

  it('should handle rapid session switches during cleanup', async () => {
    // Switch sessions while cleanup runs
    // Verify no corruption or missing sessions
  });
});
```

---

### 2. WriteQueue Serialization Under Load

**Area:** SessionManager atomic writes with high contention

**Current Coverage:** Basic write queue tests, but no stress testing

**Gap:** The write queue implementation (Phase 2.5 fix) uses promise chaining to serialize writes. Under high load:
- Multiple autoSave calls competing
- Rapid message additions during tool execution
- Session updates from different sources (todos, idle messages, patches)

**What Should Be Tested:**
- 100+ concurrent writes to same session
- Interleaved reads during write queue processing
- Write failures mid-queue (verify cleanup)
- Promise rejection handling in chain
- Memory leaks from uncleaned promises

**Why Important:** Write queue bugs could cause session corruption, data loss, or memory leaks. The promise chaining is subtle and error-prone under stress.

**Suggested Approach:**
```typescript
describe('SessionManager - Write Queue Under Load', () => {
  it('should serialize 100 concurrent writes correctly', async () => {
    // Fire 100 autoSave calls rapidly
    // Verify final state matches all writes applied in order
  });

  it('should handle write failures gracefully', async () => {
    // Inject write failure mid-queue
    // Verify queue continues and cleans up properly
  });
});
```

---

### 3. Orphaned Patch Directory Cleanup Edge Cases

**Area:** SessionManager orphaned patch cleanup (Phase 1.4)

**Current Coverage:** No tests for orphaned patch cleanup

**Gap:** Cleanup runs on startup and has several edge cases:
- Patches directory exists but session JSON is corrupted
- Session creation fails after patches directory created
- Manual filesystem operations (user deletes files)
- Symlinks or unusual directory structures
- Permission errors on directory deletion

**What Should Be Tested:**
- Orphaned directories with various contents
- Directories without patches subdirectory (false positives)
- Permission errors during cleanup
- Cleanup interleaved with session creation
- .quarantine and other dot-directories correctly excluded

**Why Important:** Incorrect cleanup could delete valid session data or leave orphaned directories forever. Silent failures could accumulate disk usage.

**Suggested Approach:**
```typescript
describe('SessionManager - Orphaned Patch Cleanup', () => {
  it('should delete orphaned patch directories', async () => {
    // Create session directory without JSON file
    // Run cleanup, verify deletion
  });

  it('should not delete directories without patches subdirectory', async () => {
    // Create non-session directory
    // Verify it survives cleanup
  });

  it('should handle permission errors gracefully', async () => {
    // Create directory with restricted permissions
    // Verify cleanup logs error but continues
  });
});
```

---

### 4. Patch Integrity Validation on Session Switch

**Area:** PatchManager integrity validation (Phase 2.7)

**Current Coverage:** No tests for validatePatchIntegrity() flow

**Gap:** Validation runs on every session switch and has complex quarantine logic:
- Missing patch files referenced in index
- Orphaned .diff files not in index
- Corrupted patch files (invalid format)
- Concurrent session switches during validation
- Quarantine directory creation failures

**What Should Be Tested:**
- Index with missing patch files triggers quarantine
- Orphaned diff files moved to quarantine
- Validation during concurrent session operations
- Quarantine failures (disk full, permissions)
- Multiple corrupted patches in one session
- Recovery after partial quarantine

**Why Important:** Validation bugs could delete valid patches, leak disk space, or corrupt the patch index. Quarantine failures could block session switches.

**Suggested Approach:**
```typescript
describe('PatchManager - Integrity Validation', () => {
  it('should quarantine patches with missing files', async () => {
    // Create index with patches
    // Delete some .diff files
    // Switch session, verify quarantine
  });

  it('should move orphaned diff files to quarantine', async () => {
    // Create .diff files not in index
    // Validate, verify files quarantined
  });

  it('should handle validation during concurrent operations', async () => {
    // Switch sessions while patches are being captured
    // Verify no corruption or race conditions
  });
});
```

---

### 5. User Interrupts vs Interjections

**Area:** InterruptionManager and Agent interaction handling

**Current Coverage:** Basic interrupt tests in Agent.test.ts, but no interjection flow tests

**Gap:** Two interruption types with different behaviors:
- Cancel (Ctrl+C): Abort everything, clean up
- Interjection (new message): Continue gracefully, handle in-flight tools
- Interaction with tool execution state
- Race between interrupt and tool completion
- Nested agent interrupts (agent-ask, explore, plan)

**What Should Be Tested:**
- Interjection during tool execution
- Interjection vs cancel behavior differences
- Multiple interjections queued
- Interrupt while waiting for permission
- Nested agent interrupt propagation
- Tool cleanup after interrupt

**Why Important:** Incorrect interrupt handling could leave tools running, corrupt state, or lose user messages. Interjection handling is critical for responsive UX.

**Suggested Approach:**
```typescript
describe('Agent - Interruption Flows', () => {
  it('should handle interjection during tool execution', async () => {
    // Start long-running tool
    // Send interjection
    // Verify tool completes, message queued
  });

  it('should abort tools on cancel interrupt', async () => {
    // Start tool
    // Send cancel
    // Verify tool aborted, cleanup ran
  });

  it('should propagate interrupts to nested agents', async () => {
    // Start agent-ask
    // Interrupt main agent
    // Verify nested agent interrupted
  });
});
```

---

## Medium Priority

### 6. Tool Metadata Storage and Retrieval

**Area:** ToolResultManager metadata tracking (Phase 2.6)

**Current Coverage:** Basic ToolResultManager tests exist but no metadata-specific tests

**Gap:** Tool metadata affects result processing:
- Metadata looked up per tool call
- Caching behavior for metadata
- Missing metadata fallback
- Metadata updates during execution
- Custom vs default metadata

**What Should Be Tested:**
- Metadata lookup for various tool types
- Fallback when tool has no metadata
- Metadata affects truncation correctly
- Performance with many tools

**Why Important:** Incorrect metadata handling could cause over-truncation or context bloat. Moderate impact but affects user experience.

**Suggested Approach:**
```typescript
describe('ToolResultManager - Metadata Integration', () => {
  it('should use tool metadata for result processing', async () => {
    // Register tool with custom metadata
    // Process result, verify metadata applied
  });

  it('should fallback to defaults when metadata missing', async () => {
    // Process result for tool without metadata
    // Verify default behavior
  });
});
```

---

### 7. AgentAskTool Silent Mode Integration

**Area:** agent-ask tool with visibleInChat=false (Phase 3.8)

**Current Coverage:** AgentTool tests exist but no agent-ask specific tests

**Gap:** Silent tool behavior has UI and logging implications:
- Tool call not shown in UI
- Events still emitted for tracking
- Results returned to main agent but hidden from user
- Integration with tool call display logic
- Activity stream event filtering

**What Should Be Tested:**
- agent-ask tool calls not displayed in UI
- Events still emitted for internal tracking
- Results correctly returned to agent
- No duplicate messaging in UI
- Silent tool behavior with errors

**Why Important:** UI bugs could confuse users or leak internal details. Medium priority because visible in production immediately.

**Suggested Approach:**
```typescript
describe('AgentAskTool - Silent Mode', () => {
  it('should not display tool calls in UI', async () => {
    // Execute agent-ask
    // Verify no UI events for tool call display
  });

  it('should still emit tracking events', async () => {
    // Execute agent-ask
    // Verify internal events emitted
  });
});
```

---

### 8. Session Resume with Multiple State Components

**Area:** Session resumption with todos, patches, idle messages

**Current Coverage:** Basic session resume tests, no integration tests

**Gap:** Session resume loads multiple state components:
- Messages, todos, idle messages, project context
- Patch history restoration
- Plugin activation state
- Agent pool state
- All must be consistent

**What Should Be Tested:**
- Resume session with all state components
- Resume with missing/corrupted components
- Resume with patches from different working directory
- Resume with deactivated plugins referenced
- Resume with stale agent pool references

**Why Important:** Incomplete or corrupted resume could confuse users or lose work. Medium priority but high user visibility.

**Suggested Approach:**
```typescript
describe('Session Resume - Integration', () => {
  it('should resume session with all state components', async () => {
    // Create session with messages, todos, patches, idle messages
    // Resume, verify all components restored
  });

  it('should handle missing state components gracefully', async () => {
    // Resume session with missing todos
    // Verify session still works with defaults
  });
});
```

---

### 9. Patch Timestamp-Based Operations

**Area:** PatchManager getPatchesSinceTimestamp and undoOperationsSinceTimestamp

**Current Coverage:** Basic patch operations tested, no timestamp-specific tests

**Gap:** Timestamp operations have boundary conditions:
- Patches exactly at timestamp boundary
- Multiple patches with same timestamp
- Timestamp in future (invalid)
- Timestamp before all patches
- Clock skew across sessions

**What Should Be Tested:**
- Boundary conditions (exactly at timestamp)
- Multiple patches with identical timestamps
- Invalid timestamp values
- Empty result cases
- Large time ranges

**Why Important:** Incorrect timestamp handling could skip patches or undo wrong operations. Medium risk for user-facing feature.

**Suggested Approach:**
```typescript
describe('PatchManager - Timestamp Operations', () => {
  it('should include patches at exact timestamp boundary', async () => {
    // Create patches at t, t+1, t+2
    // Query at t+1, verify correct patches returned
  });

  it('should handle multiple patches at same timestamp', async () => {
    // Create patches with same timestamp
    // Query and undo, verify correct behavior
  });
});
```

---

### 10. Concurrent Tool Execution with Shared Resources

**Area:** ToolOrchestrator parallel tool execution

**Current Coverage:** Basic parallel execution tests exist

**Gap:** Tools accessing shared resources concurrently:
- Multiple tools writing to same file
- Multiple bash tools in same directory
- Shared session state updates
- Patch capture during concurrent operations
- Tool result processing order

**What Should Be Tested:**
- Concurrent writes to same file
- Patch capture race conditions
- Tool result order preservation
- Concurrent session updates
- Resource cleanup after failures

**Why Important:** Race conditions could corrupt files or state. Medium priority because parallel execution is optional.

**Suggested Approach:**
```typescript
describe('ToolOrchestrator - Concurrent Shared Resources', () => {
  it('should handle concurrent writes to same file', async () => {
    // Execute multiple Write tools targeting same file
    // Verify final state is consistent
  });

  it('should capture patches correctly during concurrent operations', async () => {
    // Execute concurrent file operations
    // Verify all patches captured in correct order
  });
});
```

---

## Low Priority

### 11. Plugin Activation with Session State

**Area:** Plugin activation/deactivation during active session

**Current Coverage:** Basic plugin activation tests

**Gap:** Plugin state changes during session:
- Deactivate plugin with active tools in history
- Reactivate plugin, restore tool access
- Session resume with different plugin state
- Plugin crash during session

**What Should Be Tested:**
- Plugin deactivation with tools in history
- Reactivation behavior
- Session consistency across plugin changes

**Why Important:** Edge case with low likelihood but potential for confusion. Low priority.

**Suggested Approach:**
```typescript
describe('Plugin Activation - Session Integration', () => {
  it('should handle plugin deactivation during session', async () => {
    // Use plugin tool
    // Deactivate plugin
    // Verify history intact but tool unavailable
  });
});
```

---

### 12. Quarantine Recovery Workflows

**Area:** Manual recovery from quarantined sessions/patches

**Current Coverage:** Quarantine creation tested, no recovery tests

**Gap:** Quarantine files are created but no recovery mechanism tested:
- Inspect quarantine directory
- Restore quarantined session
- Restore quarantined patches
- Clean up old quarantine data

**What Should Be Tested:**
- Quarantine file format validation
- Manual recovery procedures
- Quarantine cleanup after time

**Why Important:** Recovery is manual admin task, low priority for automated tests. More suited for documentation.

**Suggested Approach:**
- Document manual recovery procedures
- Create recovery scripts in tools/
- Add basic format validation tests

---

### 13. Memory Leaks in Long-Running Sessions

**Area:** All managers, particularly with promise chains and event listeners

**Current Coverage:** No memory leak testing

**Gap:** Long-running sessions could accumulate:
- Event listeners not cleaned up
- Promise references in write queue
- Cached tool results
- Activity stream subscribers

**What Should Be Tested:**
- Memory usage over time
- Event listener accumulation
- Cache size growth
- Promise chain cleanup

**Why Important:** Real concern for long sessions but difficult to test. Low priority due to testing complexity.

**Suggested Approach:**
```typescript
describe('Memory Leaks - Long Session', () => {
  it('should not leak memory over 1000 operations', async () => {
    // Run 1000 operations
    // Force GC
    // Verify memory usage reasonable
  });
});
```

---

### 14. Error Recovery After Partial Operations

**Area:** All file operations (Write, Edit, PatchManager)

**Current Coverage:** Basic error handling tested

**Gap:** Partial failures during multi-step operations:
- Write succeeds but patch capture fails
- Session save succeeds but cleanup fails
- Tool execution succeeds but result processing fails

**What Should Be Tested:**
- Partial failure scenarios
- Rollback behavior
- User notification of partial failures
- State consistency after partial failures

**Why Important:** Rare edge cases but could leave inconsistent state. Low priority due to difficulty in testing.

**Suggested Approach:**
- Mock filesystem operations to inject failures
- Verify state remains consistent
- Check error messages communicate partial state

---

### 15. Performance Benchmarks

**Area:** All hot paths (session save, patch operations, tool execution)

**Current Coverage:** No performance tests

**Gap:** No baseline for performance regression detection:
- Session save time under load
- Patch index lookup performance
- Tool result processing overhead
- Write queue throughput

**What Should Be Tested:**
- Operation latency percentiles
- Throughput under load
- Memory usage patterns
- Regression detection

**Why Important:** Performance issues would be caught in use but no automated detection. Low priority.

**Suggested Approach:**
```typescript
describe('Performance - Session Operations', () => {
  it('should save session in under 50ms (p95)', async () => {
    // Run 100 saves, measure p95 latency
  });
});
```

---

## Cross-Cutting Integration Tests

### 16. End-to-End User Workflows

**Priority:** High

**Gap:** No full workflow tests combining multiple systems:

**Workflows to Test:**
1. **Create, use, and resume session:**
   - Create session
   - Execute tools
   - Save with patches
   - Resume
   - Verify all state restored

2. **Interrupt and recover:**
   - Start long operation
   - Interrupt
   - Send new message
   - Verify clean recovery

3. **Undo with nested operations:**
   - Execute multiple file operations
   - Capture patches
   - Undo
   - Verify rollback correct

4. **Agent delegation flow:**
   - Create explore agent
   - Ask follow-up with agent-ask
   - Interrupt nested agent
   - Verify cleanup

**Why Important:** Unit tests miss integration bugs. These workflows exercise multiple systems together.

**Suggested Approach:**
```typescript
describe('E2E - User Workflows', () => {
  it('should complete full session lifecycle', async () => {
    // Create, use, save, resume session
    // Verify end-to-end correctness
  });
});
```

---

## Testing Strategy Recommendations

### Immediate Actions (High Priority)
1. Add concurrent operation tests for SessionManager cleanup
2. Add stress tests for write queue serialization
3. Add integration tests for patch integrity validation
4. Add interrupt/interjection flow tests
5. Add orphaned patch cleanup tests

### Short Term (Medium Priority)
6. Add session resume integration tests
7. Add timestamp operation boundary tests
8. Add agent-ask silent mode tests
9. Add concurrent tool execution tests
10. Add tool metadata integration tests

### Long Term (Low Priority)
11. Add memory leak detection tests
12. Add performance benchmarks
13. Document quarantine recovery procedures
14. Add plugin activation integration tests
15. Add error recovery tests

### Test Infrastructure Improvements
- Create test fixtures for common session states
- Add helpers for concurrent operation testing
- Create mock filesystem for failure injection
- Add performance test runner with regression detection
- Create integration test suite with real Ollama instance

### Coverage Metrics Goals
- **Unit test coverage:** 80%+ for all new code
- **Integration tests:** All cross-system flows covered
- **E2E tests:** 5-10 critical user workflows
- **Performance tests:** Key operations benchmarked

---

## Notes on Test Complexity

### Why Some Tests Are Missing
1. **Concurrency tests:** Difficult to write reliably, require careful timing
2. **Integration tests:** Require full system setup, slow execution
3. **Performance tests:** Need baselines, flaky CI results
4. **Memory leak tests:** Hard to measure accurately, platform-specific

### Test Maintenance Strategy
- **High priority tests:** Require maintenance on every related change
- **Medium priority tests:** Review during major refactors
- **Low priority tests:** Optional, consider as documentation

### Trade-offs
- Comprehensive testing increases CI time
- Flaky tests worse than no tests
- Focus on high-value, stable tests first
- Integration tests catch most critical bugs
- Unit tests provide fast feedback loop

---

## Conclusion

The highest priority gaps are around concurrent operations, race conditions, and integration points between systems. These areas have the highest risk for data loss or corruption. Medium priority gaps affect user experience but are less likely to cause data loss. Low priority gaps are edge cases or infrastructure improvements.

**Recommended next steps:**
1. Implement high priority tests (items 1-5)
2. Add E2E workflow tests (item 16)
3. Set up CI to run integration tests
4. Iterate on medium priority tests based on bug reports
5. Consider low priority tests as time permits
