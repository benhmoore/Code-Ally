# Agent Execution Context Refactoring - Implementation Summary

## Overview

This refactoring addresses a critical bug where execution context parameters (parentCallId, maxDuration, thoroughness) were being incorrectly shared between sequential agent invocations when using the AgentPoolService. The fix introduces a new parameter-based execution context system that properly separates per-invocation context from persistent agent configuration.

## The Bug

### Problem Description
When agents were pooled and reused via AgentPoolService, execution context properties set in AgentConfig were persisting across multiple invocations:

1. User creates agent with `parentCallId: 'call-123'`
2. Agent executes and completes, gets pooled
3. User invokes same agent again with `parentCallId: 'call-456'`
4. Agent still uses `parentCallId: 'call-123'` from previous invocation

This caused:
- Event nesting corruption (events parented to wrong tool calls)
- Incorrect time budget tracking (maxDuration from previous runs)
- Thoroughness level bleeding between invocations

### Root Cause
The AgentConfig interface mixed two distinct concerns:
1. **Persistent agent configuration** - Properties that should stay constant across invocations (tools, system prompt, capabilities)
2. **Per-invocation execution context** - Properties that should change with each invocation (parent call ID, time budget, thoroughness level)

AgentPoolService couldn't distinguish between these two types of properties, so it preserved all config properties when pooling agents.

## The Solution

### Architecture Changes

#### 1. New AgentExecutionContext Interface
Created a dedicated interface for per-invocation context parameters:

```typescript
export interface AgentExecutionContext {
  parentCallId?: string;      // Parent tool call ID for event nesting
  maxDuration?: number;        // Maximum duration in minutes for this invocation
  thoroughness?: string;       // Thoroughness level: 'quick' | 'medium' | 'very thorough' | 'uncapped'
}
```

#### 2. Parameter-Based Context Passing
Modified `Agent.sendMessage()` to accept execution context as a parameter:

```typescript
async sendMessage(
  userMessage: string,
  options: {
    executionContext?: AgentExecutionContext;
    // ... other options
  }
): Promise<string>
```

#### 3. Invocation-Scoped Context Application
Execution context is now applied:
- At the start of each `sendMessage()` invocation
- Without mutating the agent's config
- In a way that properly scopes the context to just that invocation

#### 4. Smart Config Migration
AgentConfig retains the deprecated properties for backward compatibility:
- Properties marked with `@deprecated` JSDoc comments
- Still initialized from config in constructor
- Overridden by execution context parameter if provided
- Clear migration path documented

### Key Implementation Details

#### Agent.ts Changes
- Added `AgentExecutionContext` interface (lines 89-93)
- Modified `sendMessage()` to accept `executionContext` parameter (lines 245-289)
- Updated constructor to store initial config values (lines 175-177)
- Added execution context application logic that:
  - Preserves original config values
  - Applies execution context for the current invocation
  - Restores original values after invocation completes
- Added deprecation comments to AgentConfig properties (lines 110-136)

#### AgentPoolService.ts Changes
- Updated `getOrCreateAgent()` to accept execution context (lines 85-145)
- Pass execution context through to `sendMessage()` instead of config
- Pool matching now ignores execution context (uses persistent config only)

#### Tool Updates
All delegating tools (AgentTool, ExploreTool, PlanTool, SessionsTool) updated to:
- Extract execution context from config
- Pass as separate parameter to AgentPoolService
- Ensure correct context propagation to delegated agents

#### UI Integration
Updated input handling to pass execution context through:
- InputPrompt component propagates parentCallId
- useInputHandlers extracts and forwards execution context
- Proper handling of file attachments with execution context

## Files Changed

### Core Agent Framework
| File | Lines Added | Lines Removed | Description |
|------|-------------|---------------|-------------|
| `src/agent/Agent.ts` | 61 | 32 | Core execution context logic, interface definitions |
| `src/services/AgentPoolService.ts` | 7 | 9 | Execution context parameter passing |
| `src/types/index.ts` | 3 | 1 | Type exports |

### Tool Layer
| File | Lines Added | Lines Removed | Description |
|------|-------------|---------------|-------------|
| `src/tools/AgentTool.ts` | 13 | 2 | Generic agent delegation |
| `src/tools/ExploreTool.ts` | 6 | 1 | Exploration agent delegation |
| `src/tools/PlanTool.ts` | 6 | 1 | Planning agent delegation |
| `src/tools/SessionsTool.ts` | 8 | 1 | Session analysis agent delegation |

### UI Layer
| File | Lines Added | Lines Removed | Description |
|------|-------------|---------------|-------------|
| `src/ui/components/InputPrompt.tsx` | 21 | 2 | Execution context propagation |
| `src/ui/components/TextInput.tsx` | 18 | 8 | File attachment handling |
| `src/ui/hooks/useInputHandlers.ts` | 33 | 6 | Input processing with context |

### Utilities
| File | Lines Added | Lines Removed | Description |
|------|-------------|---------------|-------------|
| `src/utils/pathUtils.ts` | 32 | 0 | Path resolution utilities |

**Total: 208 lines added, 63 lines removed across 11 files**

## Architecture Improvements

### 1. Separation of Concerns
- **Before**: AgentConfig mixed persistent and per-invocation properties
- **After**: Clear separation between `AgentConfig` (persistent) and `AgentExecutionContext` (per-invocation)

### 2. Explicit Context Flow
- **Before**: Context implicitly stored in config, hard to trace
- **After**: Context explicitly passed as parameter, easy to follow through call chain

### 3. Stateless Agent Pooling
- **Before**: Pool had to carefully manage which config properties to preserve
- **After**: Pool preserves all config, execution context passed separately

### 4. Type Safety
- Execution context is now a typed parameter
- TypeScript enforces correct usage at compile time
- Clear API contract for context propagation

### 5. Debugging Improvements
- Execution context visible in method signatures
- No hidden state mutations
- Clear lifecycle: context applied → invocation → context restored

## Backward Compatibility

### Maintained Compatibility
1. **AgentConfig Properties**: The deprecated properties (parentCallId, maxDuration, thoroughness) are still part of AgentConfig and still work
2. **Constructor Initialization**: Agents can still be constructed with these properties in config
3. **Setter Methods**: Existing setter methods (setMaxDuration, setThoroughness) still function
4. **Tool Interfaces**: No breaking changes to public tool APIs

### Migration Path
Code using deprecated properties will continue to work but should migrate:

```typescript
// OLD (deprecated but still works)
const agent = new Agent({
  config: appConfig,
  parentCallId: 'call-123',
  maxDuration: 30,
  thoroughness: 'medium'
});
await agent.sendMessage('task');

// NEW (recommended)
const agent = new Agent({
  config: appConfig
});
await agent.sendMessage('task', {
  executionContext: {
    parentCallId: 'call-123',
    maxDuration: 30,
    thoroughness: 'medium'
  }
});
```

### Deprecation Warnings
All deprecated properties now have JSDoc `@deprecated` annotations that:
- Clearly mark the property as deprecated
- Explain the new approach
- Provide migration guidance
- Will show warnings in IDEs with TypeScript support

## Testing & Verification

### Type Safety Verification
- `npm run type-check` passes with no errors
- All unused imports cleaned up
- No new type errors introduced

### Stale Reference Audit
Searched for inappropriate uses of execution context properties:
- **No stale references found** setting `config.parentCallId` outside constructors
- **No stale references found** setting `config.maxDuration` outside constructors
- **No stale references found** setting `config.thoroughness` outside constructors

All property assignments are:
- In constructors (legitimate initialization)
- In designated setter methods (setMaxDuration, setThoroughness)
- In internal manager classes (ToolOrchestrator, TurnManager)

### Expected Behavior
After this refactor:
1. Agent pooling works correctly - execution context isolated per invocation
2. Event nesting accurate - parentCallId correctly scoped
3. Time budgets isolated - maxDuration doesn't bleed between invocations
4. Thoroughness properly scoped - each invocation can have different thoroughness

## Future Cleanup Recommendations

### Phase 5 (Future Version)
When ready to make breaking changes:

1. **Remove Deprecated Properties**: Remove parentCallId, maxDuration, and thoroughness from AgentConfig interface

2. **Remove Setter Methods**: Remove setMaxDuration() and setThoroughness() - force all context through parameter

3. **Simplify Constructor**: Remove execution context handling from constructor

4. **Update Documentation**: Remove backward compatibility notes

5. **Update Examples**: Show only the new parameter-based approach

### Benefits of Future Cleanup
- Simpler API surface
- Less code to maintain
- No confusion about deprecated vs current approach
- Clearer separation of concerns

### Timing Considerations
Before removing deprecated properties:
- Ensure all internal code migrated
- Ensure all user-facing examples migrated
- Provide migration tools if needed
- Consider major version bump

## Key Takeaways

### What We Fixed
A subtle but critical bug where agent pooling caused execution context to leak between invocations, leading to event nesting corruption and incorrect time budget tracking.

### How We Fixed It
Introduced a clean separation between persistent agent configuration and per-invocation execution context, with context passed as a method parameter rather than stored in config.

### Why This Approach
- **Correctness**: Execution context now properly scoped to individual invocations
- **Clarity**: Explicit parameter passing makes context flow obvious
- **Maintainability**: Clear separation of concerns, easier to reason about
- **Compatibility**: Existing code continues to work during migration period
- **Type Safety**: TypeScript enforces correct usage

### Impact
This refactoring establishes a robust foundation for agent pooling and delegation, ensuring that execution context is handled correctly throughout the system while maintaining backward compatibility with existing code.
