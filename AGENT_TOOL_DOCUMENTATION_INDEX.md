# AgentTool Persistence Documentation Index

## Overview

This directory contains a comprehensive analysis of the AgentTool implementation and a detailed plan for adding persistence support via AgentPoolService. Three complementary documents provide different levels of detail for different purposes.

## Document Guide

### 1. AGENT_TOOL_QUICK_REFERENCE.md
**Best for:** Getting started, quick understanding, implementation checklists
**Length:** 282 lines
**Contains:**
- TL;DR problem statement
- 3-part solution overview
- Current vs proposed flow diagrams
- Code structure cheat sheet
- Key line references (easy to find what to change)
- Pool key implementation details
- Testing strategy
- Debug checklist

**Start here if you:** Want to understand the problem quickly and see what needs to change

---

### 2. AGENT_TOOL_PERSISTENCE_ROADMAP.md
**Best for:** Implementation planning, architectural decisions, phases
**Length:** 475 lines
**Contains:**
- Quick reference on current state
- Full architecture deep dive with code examples
- Visual agent lifecycle flow
- AgentManager and cleanup details
- Critical problem identification and solution
- Proposed pool key algorithm
- 3-phase implementation plan with priorities
- Code location reference table (what to change where)
- Key insights for avoiding pitfalls
- Migration notes and backwards compatibility

**Start here if you:** Are ready to implement and need a roadmap

---

### 3. AGENT_TOOL_ANALYSIS.md
**Best for:** Deep understanding, reference material, design decisions
**Length:** 697 lines
**Contains:**
- Executive summary
- Complete lifecycle breakdown with line numbers
- AgentManager service analysis
- AgentConfig structure and matching analysis
- Pool matching problem detailed explanation
- Agent configuration metadata requirements
- Integration points for persistence
- Full code snippets for proposed implementation
- Summary table: current vs proposed
- Remaining questions and design decisions

**Start here if you:** Need deep technical details, writing code, or designing the system

---

## Quick Navigation

### If you want to understand...

| Question | Document | Section |
|----------|----------|---------|
| "What's the problem?" | QUICK_REFERENCE | TL;DR |
| "How does AgentTool work?" | QUICK_REFERENCE | Code Structure Cheat Sheet |
| "What needs to change?" | QUICK_REFERENCE | Files to Change |
| "How do I implement this?" | PERSISTENCE_ROADMAP | Implementation Plan |
| "What's the pool key algorithm?" | PERSISTENCE_ROADMAP | Proposed Solution |
| "Deep technical details?" | ANALYSIS | Section 1-9 |
| "Where exactly in code?" | PERSISTENCE_ROADMAP | Code Location Reference |
| "How to test this?" | QUICK_REFERENCE | Testing Strategy |
| "Integration points?" | ANALYSIS | Section 5 |
| "What makes configs different?" | ANALYSIS | Section 4 |

---

## Key Findings Summary

### The Problem
AgentTool creates new Agent instances every execution and destroys them immediately, unlike ExploreTool/PlanTool which persist agents in a pool for reuse.

### Why This Matters
- Inefficient resource usage (recreate agent on each task)
- No agent state preservation
- Inconsistent with ExploreTool/PlanTool behavior

### The Solution
Add AgentPoolService integration with strict pool key matching:
1. Add `persist` parameter to AgentTool
2. Create pool key based on agent_name + prompt hash + tools hash
3. Update pool matching to check pool key instead of just isSpecialized flag
4. Make cleanup conditional (release for pooled, cleanup for ephemeral)

### The Challenge
AgentTool differs fundamentally from ExploreTool/PlanTool:
- Different agent sources (disk vs hardcoded)
- Variable configurations (agent_name varies)
- Different tool restrictions per agent
- Requires specialized pool key, not just isSpecialized flag

---

## Implementation Roadmap

### Phase 1: Update AgentTool (HIGH PRIORITY)
**File:** `/src/tools/AgentTool.ts`

- Add `persist` parameter to function definition
- Create `createAgentPoolKey()` helper
- Implement `executeWithPooling()` method
- Modify `executeAgentTask()` for conditional cleanup
- Store pool key in AgentConfig._poolKey

**Impact:** Enables agent reuse via pool

### Phase 2: Update AgentPoolService (MEDIUM PRIORITY)
**File:** `/src/services/AgentPoolService.ts`

- Update `findAvailableAgent()` to check _poolKey for AgentTool agents
- Keep existing matching logic for ExploreTool/PlanTool

**Impact:** Ensures strict matching prevents cross-contamination

### Phase 3: Optional Improvements (LOW PRIORITY)
**Files:** `/src/services/AgentManager.ts`, `/src/agent/Agent.ts`

- Add caching to AgentManager.loadAgent()
- Add _poolKey fields to AgentConfig interface

**Impact:** Performance optimization

---

## Critical Code Locations

### Must Change
```
AgentTool.ts:72-107        Parameter validation
AgentTool.ts:145-174       Agent loading
AgentTool.ts:223-310       Sub-agent creation
AgentTool.ts:372-378       Cleanup pattern
AgentPoolService.ts:278-292 Pool matching
```

### Should Change
```
Agent.ts:32-51             AgentConfig interface
```

### Could Change
```
AgentManager.ts:71-81      Agent loading (add caching)
```

---

## Design Decisions

### Decision 1: Pool Key Design
**Decision:** Use `agent-{name}@{promptHash}@{toolsHash}`
**Rationale:** 
- agent_name distinguishes different agent types
- promptHash ensures content changes invalidate
- toolsHash ensures tool restrictions honored

### Decision 2: Should agents be reused across tasks?
**Decision:** YES - same agent_name + tools reuses
**Rationale:**
- Reduces resource usage
- systemPrompt regenerated on each use
- baseAgentPrompt stays constant
- taskPrompt just changes generation context

### Decision 3: Cleanup strategy
**Decision:** 
- persist=true: pooledAgent.release() → reuse
- persist=false: await subAgent.cleanup() → destroy
**Rationale:**
- Backwards compatible
- Flexible for different use cases
- Clean resource management

### Decision 4: Return agent_id
**Decision:** YES, when persist=true
**Rationale:**
- Consistency with ExploreTool/PlanTool
- Enables future tool chaining
- Helps debugging

---

## Testing Checklist

Before implementing, ensure you can test:

- [ ] Basic pooling: same agent reuses across calls
- [ ] No cross-contamination: different agents don't mix
- [ ] Pool key stability: same inputs produce same key
- [ ] Fallback works: persist=false creates ephemeral
- [ ] Error handling: pool unavailable falls back gracefully
- [ ] systemPrompt regeneration: updated on each use
- [ ] Different tool restrictions: properly enforced
- [ ] Interrupt handling: still works with pooled agents
- [ ] agent_id in response: only when persist=true

---

## FAQ

### Q: Will this break existing code?
**A:** No, this is backwards-compatible. persist defaults to true (new behavior), but persist=false gives old behavior.

### Q: Can I use pool without updating everything?
**A:** Yes, phase 1 can work alone. Phase 2 and 3 improve but aren't required.

### Q: What if agent file changes while pooled?
**A:** Potential stale data. Mitigations: file watchers, version numbers, or cache invalidation.

### Q: Should I implement all 3 phases at once?
**A:** No, do Phase 1 first (core functionality), then Phase 2 (correctness), then Phase 3 (optimization).

### Q: Where do I add the persist parameter?
**A:** In getFunctionDefinition() around line 48-70 of AgentTool.ts

---

## File Locations Summary

```
/Users/benmoore/CodeAlly-TS/
├── AGENT_TOOL_QUICK_REFERENCE.md           ← Start here
├── AGENT_TOOL_PERSISTENCE_ROADMAP.md       ← Implementation guide
├── AGENT_TOOL_ANALYSIS.md                  ← Deep reference
├── AGENT_TOOL_DOCUMENTATION_INDEX.md       ← This file
│
└── src/
    ├── tools/
    │   ├── AgentTool.ts                    ← PRIMARY: Add pooling
    │   ├── ExploreTool.ts                  ← REFERENCE: Working pooling
    │   └── PlanTool.ts                     ← REFERENCE: Working pooling
    │
    ├── services/
    │   ├── AgentPoolService.ts             ← SECONDARY: Update matching
    │   ├── AgentManager.ts                 ← OPTIONAL: Add caching
    │   └── ServiceRegistry.ts              ← Reference
    │
    └── agent/
        ├── Agent.ts                        ← SECONDARY: Add _poolKey fields
        └── ToolOrchestrator.ts             ← Reference
```

---

## Implementation Checklist

Use this when implementing:

- [ ] Read QUICK_REFERENCE.md (15 min)
- [ ] Understand current flow (study AgentTool.ts)
- [ ] Read PERSISTENCE_ROADMAP.md (30 min)
- [ ] Design pool key algorithm
- [ ] Implement Phase 1 (AgentTool)
  - [ ] Add persist parameter
  - [ ] Create createAgentPoolKey()
  - [ ] Create executeWithPooling()
  - [ ] Update executeAgentTask()
  - [ ] Test basic pooling
- [ ] Implement Phase 2 (AgentPoolService)
  - [ ] Update findAvailableAgent()
  - [ ] Test cross-contamination prevention
- [ ] Implement Phase 3 (Caching)
  - [ ] Add AgentManager caching
  - [ ] Add cache invalidation
- [ ] Run full test suite

---

## Cross-References

### Key Files Referenced

**AgentTool.ts**
- Main tool: lines 24-502
- executeImpl: lines 72-107
- executeSingleAgent: lines 145-218
- executeAgentTask: lines 223-379
- Cleanup: lines 372-378

**Agent.ts**
- AgentConfig: lines 32-51
- Constructor: lines 109-173
- cleanup: lines 1710-1723

**AgentPoolService.ts**
- Pool matching: lines 278-292
- Agent acquisition: lines 183-247
- Cleanup: lines 149-172

**AgentManager.ts**
- loadAgent: lines 71-81
- parseAgentFile: lines 221-275

**ExploreTool.ts** (reference - working pooling)
- Pool usage: lines 225, 241, 323

**PlanTool.ts** (reference - working pooling)
- Pool usage: lines 281, 297, 388

---

## Next Steps

1. **Read:** Start with QUICK_REFERENCE.md (20 minutes)
2. **Understand:** Study AgentTool.ts lines 72-379 (30 minutes)
3. **Plan:** Read PERSISTENCE_ROADMAP.md (30 minutes)
4. **Design:** Sketch implementation approach (15 minutes)
5. **Implement:** Phase 1 in AgentTool.ts (2 hours)
6. **Test:** Verify pooling works (1 hour)
7. **Improve:** Phase 2 and 3 (1 hour each)

**Total estimated time:** 5-6 hours for complete implementation

---

## Contact & Questions

For questions about:
- **Architecture:** See AGENT_TOOL_ANALYSIS.md
- **Implementation:** See AGENT_TOOL_PERSISTENCE_ROADMAP.md
- **Quick answers:** See AGENT_TOOL_QUICK_REFERENCE.md

All documents are in `/Users/benmoore/CodeAlly-TS/`

