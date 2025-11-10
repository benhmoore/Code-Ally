# Plugin Architecture Analysis - Documentation Index

## Overview

This analysis explores Ally's plugin architecture, specifically the current plugin-to-Ally communication patterns and what's needed to enable plugins to actively emit events and create messages.

## Documents

### 1. PLUGIN_ARCHITECTURE_ANALYSIS.md (20KB, 631 lines)
**Comprehensive deep-dive analysis**

Contents:
- Executive summary
- Current plugin capabilities (event subscription, RPC tools, configuration)
- Critical gaps identified (5 major gaps)
- Current architecture patterns with diagrams
- Design principles and class responsibilities
- **Detailed design proposal** with PluginMessageBus architecture
- Security considerations and trust model
- Alternative designs considered
- 4-phase implementation roadmap
- Complete file listing

**Read this for**: Complete understanding of the system and design decisions

### 2. PLUGIN_GAPS_SUMMARY.md (6KB, 187 lines)
**Quick reference guide**

Contents:
- Visual diagram of current state
- What works (table format)
- Critical gaps (5 items with impact analysis)
- Proposed solution at a glance
- 4-phase implementation timeline
- Risk assessment matrix
- Files that need changes
- Open questions
- Success criteria

**Read this for**: Quick overview and decision-making

## Key Findings

### What Exists
1. **Event Broadcasting (Ally → Plugin)**
   - 12 approved event types
   - Fire-and-forget delivery via JSON-RPC notifications
   - Implemented in EventSubscriptionManager

2. **RPC Tool Execution (Ally ↔ Plugin)**
   - Plugins provide tools via background_rpc type
   - Agent calls tools, gets responses
   - Implemented in BackgroundToolWrapper + SocketClient

3. **Process Management**
   - Start, stop, health check background daemons
   - Auto-restart on failure
   - Graceful shutdown with SIGTERM/SIGKILL

### Critical Gaps
1. **No Plugin Message Emission** - Agent.addMessage() is private
2. **No Plugin Event Emission** - EventSubscriptionManager is one-way
3. **No Request Channel** - Plugins cannot call back to Ally
4. **No Context Access** - Plugins cannot read conversation state
5. **No Task Registration** - Plugins cannot initiate actions

## Proposed Architecture

### New Component: PluginMessageBus
```typescript
class PluginMessageBus {
  acceptMessage(pluginName, {role, content})
  emitEvent(pluginName, event)
  getContext(pluginName): AgentContext
}
```

### New RPC Methods
- `add_message(role, content)` - Plugin adds to conversation
- `emit_event(type, data)` - Plugin signals UI
- `get_context()` - Plugin reads conversation state

### New Event Types
- `PLUGIN_MESSAGE_RECEIVED`
- `PLUGIN_EVENT_EMITTED`
- `PLUGIN_ACTION_REQUESTED`

## Implementation Timeline
- Phase 1: Infrastructure (1-2 weeks)
- Phase 2: Reverse Communication (2-3 weeks)
- Phase 3: Example & Documentation (1 week)
- Phase 4: Security & Polish (1-2 weeks)
- **Total: 4-8 weeks**

## Next Steps

1. **Review** these documents
2. **Decide** if bidirectional plugin communication is desired
3. **Approve** the PluginMessageBus design
4. **Start** Phase 1 implementation
5. **Iterate** based on team feedback

## Files Analyzed

**Core Plugin Architecture**
- `/src/plugins/EventSubscriptionManager.ts` (398 lines)
- `/src/plugins/BackgroundProcessManager.ts` (727 lines)
- `/src/plugins/BackgroundToolWrapper.ts` (100+ lines analyzed)
- `/src/plugins/SocketClient.ts` (619 lines)
- `/src/plugins/PluginLoader.ts` (150+ lines analyzed)

**Agent & Activity System**
- `/src/agent/Agent.ts` (2170 lines analyzed)
- `/src/services/ActivityStream.ts` (247 lines)
- `/src/types/index.ts` (200+ lines analyzed)

**Example Plugin**
- `/examples/plugins/conversation-monitor/daemon.py` (335 lines)
- `/examples/plugins/conversation-monitor/plugin.json`

## Key Insights

1. **Current Design is Intentional**
   - One-way events for security
   - Tool-based extension model
   - Passive plugin observation
   - Stateless notifications

2. **Clear Path to Enhancement**
   - Use existing SocketClient infrastructure
   - Add PluginMessageBus intermediary
   - Leverage JSON-RPC bidirectional capability
   - Maintain security isolation

3. **Risk Mitigation is Achievable**
   - Permission system per plugin
   - Rate limiting message injection
   - Input validation for content
   - Clear audit trail in metadata

4. **Backwards Compatible**
   - Existing plugins continue to work
   - New features are opt-in
   - No breaking changes proposed
   - Graceful degradation possible

## Document Status

- [x] Architecture analysis complete
- [x] Current state documented
- [x] Gaps identified and explained
- [x] Design proposal created
- [x] Implementation roadmap provided
- [x] Security analysis included
- [x] Alternative designs evaluated
- [x] Files indexed and cross-referenced

**Created**: 2025-11-10  
**Analysis Scope**: Plugin communication infrastructure  
**Codebase Analyzed**: 4000+ lines  
**Time Spent**: ~2 hours  

---

## How to Use These Documents

**For Architects/Leads**:
1. Read PLUGIN_GAPS_SUMMARY.md (5-10 min)
2. Review the diagram in PLUGIN_ARCHITECTURE_ANALYSIS.md (Section 3.1)
3. Check implementation timeline and risk assessment

**For Developers**:
1. Start with Section 4 of PLUGIN_ARCHITECTURE_ANALYSIS.md (Design Proposal)
2. Reference the proposed PluginMessageBus code samples
3. Check Phase 1 tasks for immediate next steps

**For Product Managers**:
1. Read executive summary in both documents
2. Review success criteria
3. Check estimated timeline and effort

---

**Questions?** See the "Open Questions" section in PLUGIN_GAPS_SUMMARY.md
