# CodeAlly Documentation Index

## Overview

This index provides a guide to the comprehensive documentation of CodeAlly's prompting patterns, agent architecture, and tool system. Four detailed reference documents have been created to help understand how the system works.

## Documents

### 1. PROMPTING_PATTERNS_ANALYSIS.md (22 KB)
**Comprehensive technical analysis of prompting patterns and architecture**

- **Best for**: Understanding the complete system
- **Sections**:
  1. Agent Architecture (5 agent types, configurations, pooling)
  2. System Prompts (layered structure, behavioral directives)
  3. Tool Definitions (30+ tools categorized)
  4. Prompting Patterns (tool selection logic, decision flow)
  5. System Prompt Generation (how prompts are built dynamically)
  6. Context Information (what data is injected)
  7. Key Prompting Principles (10 core principles)
  8. Configuration Points (customization options)
  9. Prompting Examples (3 real-world scenarios)
  10. Files and Code Locations (complete file map)
  11. Key Takeaways (10 important insights)

- **Key Content**:
  - Complete definitions of all agent types
  - Behavioral directives with line numbers
  - Tool usage guidance examples
  - System prompt generation flow diagrams
  - Context budget management strategy
  - File locations with line numbers

**Read this when**: You need to understand the entire architecture, implement new prompting patterns, or improve the system.

---

### 2. TOOL_ROUTING_GUIDE.md (9.4 KB)
**Practical decision trees and usage patterns for tools and agents**

- **Best for**: Making decisions about which tool/agent to use
- **Sections**:
  1. Quick Decision Tree (flowchart for tool selection)
  2. Tool Categories (read-only, write, agents, todos)
  3. When to Use Each Pattern (6 practical patterns)
  4. Tool Usage Guidance Summary (specific guidance per tool)
  5. Context Budget Management (usage levels 70%-90%+)
  6. Common Anti-Patterns to Avoid (5 key mistakes)
  7. Tool Selection Checklist (quick reference)

- **Key Content**:
  - ASCII flowchart for tool selection
  - Specific parameters for each tool call
  - Examples of correct vs incorrect usage
  - Context budget thresholds and actions
  - Anti-patterns with explanations

**Read this when**: You're writing prompts, routing tasks, or need a quick decision guide.

---

### 3. KEY_FILES_REFERENCE.md (11 KB)
**Map of source files, their purposes, and navigation guide**

- **Best for**: Finding where specific functionality is implemented
- **Sections**:
  1. System Prompts and Directives (systemMessages.ts)
  2. Agent System (Agent.ts, AgentManager.ts, AgentPoolService.ts)
  3. Tool System (BaseTool.ts, ToolManager.ts, specialized tools)
  4. Tool Execution (ToolOrchestrator.ts)
  5. Configuration (constants.ts, toolDefaults.ts)
  6. CLI Entry Point (cli.ts)
  7. Key Data Flows (prompt generation, tool execution, agent delegation)
  8. Quick Navigation Table (lookup table)
  9. Agent Metadata Format (example configuration)

- **Key Content**:
  - Exact file paths
  - Line number ranges
  - Method names and purposes
  - Data structure definitions
  - Navigation table for quick lookup
  - Complete agent metadata format example

**Read this when**: You need to find where something is implemented or understand file organization.

---

### 4. EXPLORATION_SUMMARY.md (8.4 KB)
**Executive summary of exploration findings and key insights**

- **Best for**: Getting a quick overview or presenting findings
- **Sections**:
  1. Completed Tasks (deliverables)
  2. Key Findings (10 categories of findings)
  3. Most Important Insights (5 deep insights with locations)
  4. Recommendations for Improvement (8 specific recommendations)
  5. Files Created in Repository
  6. How to Use These Documents (role-based reading guide)

- **Key Content**:
  - 10 major findings from the exploration
  - 5 most important insights with locations
  - Specific improvement recommendations
  - Role-based reading guide for different audiences

**Read this when**: You want a quick overview or to understand what was discovered.

---

## How to Use These Documents

### By Role

**New Team Member**
1. Read: `EXPLORATION_SUMMARY.md` (5 min overview)
2. Read: `KEY_FILES_REFERENCE.md` (understand file organization)
3. Read: `TOOL_ROUTING_GUIDE.md` (understand tool selection)
4. Explore: `PROMPTING_PATTERNS_ANALYSIS.md` (detailed reference)

**Prompt Engineer**
1. Read: `PROMPTING_PATTERNS_ANALYSIS.md` sections 2-7 (core system)
2. Use: `TOOL_ROUTING_GUIDE.md` (decision making)
3. Reference: `KEY_FILES_REFERENCE.md` (find implementations)
4. Check: Specific tool files in `/src/tools/`

**Tool Developer**
1. Read: `KEY_FILES_REFERENCE.md` section "Tool System"
2. Reference: `/src/tools/BaseTool.ts` (base class)
3. Reference: `/src/tools/ToolManager.ts` (registration)
4. Study: Existing tool implementation (e.g., `ReadTool.ts`)

**Agent Specialist**
1. Read: `KEY_FILES_REFERENCE.md` section "Agent System"
2. Reference: `/src/agent/Agent.ts` (main orchestrator)
3. Reference: `/src/services/AgentManager.ts` (agent management)
4. Study: `PROMPTING_PATTERNS_ANALYSIS.md` section 1 (agent types)

**System Architect**
1. Read: `PROMPTING_PATTERNS_ANALYSIS.md` (complete overview)
2. Read: `KEY_FILES_REFERENCE.md` section "Key Data Flows"
3. Reference: Configuration files (constants.ts, toolDefaults.ts)
4. Plan: Improvements based on `EXPLORATION_SUMMARY.md` recommendations

**Quick Lookup**
- Use: `TOOL_ROUTING_GUIDE.md` decision tree
- Use: `KEY_FILES_REFERENCE.md` quick navigation table
- Use: `KEY_FILES_REFERENCE.md` search for specific pattern

### By Task

**Implementing a New Tool**
1. Read: `KEY_FILES_REFERENCE.md` section "Tool System"
2. Study: `/src/tools/BaseTool.ts` (inherit from this)
3. Copy: Similar tool as template (e.g., `ReadTool.ts`)
4. Follow: Tool registration in `/src/cli.ts:469-496`

**Creating a Custom Agent**
1. Read: `PROMPTING_PATTERNS_ANALYSIS.md` section 1 (agent types)
2. Reference: `KEY_FILES_REFERENCE.md` section "Agent Metadata Format"
3. Create: File in `~/.code_ally/agents/{name}.md`
4. Test: Via `agent(task_prompt="...", agent_name="{name}")`

**Improving Prompting**
1. Read: `PROMPTING_PATTERNS_ANALYSIS.md` section 7 (principles)
2. Reference: `/src/prompts/systemMessages.ts` (edit prompts)
3. Check: `TOOL_ROUTING_GUIDE.md` (understand impact)
4. Test: New prompts with `--once` flag

**Debugging LLM Behavior**
1. Check: `TOOL_ROUTING_GUIDE.md` anti-patterns (common mistakes)
2. Check: `PROMPTING_PATTERNS_ANALYSIS.md` section 4 (tool selection)
3. Check: System prompt in `/src/prompts/systemMessages.ts`
4. Trace: Tool decision logic in `/src/agent/ToolOrchestrator.ts`

**Understanding Tool Execution**
1. Read: `PROMPTING_PATTERNS_ANALYSIS.md` section 5 (prompt generation)
2. Read: `KEY_FILES_REFERENCE.md` section "Key Data Flows"
3. Reference: `/src/agent/Agent.ts` (main execution)
4. Reference: `/src/agent/ToolOrchestrator.ts` (tool coordination)

---

## Key Concepts at a Glance

### Agents
- **Main**: Full capability
- **Explore**: Read-only investigation
- **Plan**: Planning/architecture
- **General**: Customizable
- **Custom**: User-defined

### Tool Categories
- **Read-Only**: Parallel safe (read, glob, grep, ls, tree, batch)
- **Write**: Sequential (write, edit, line_edit, bash, lint, format)
- **Agents**: Delegation (agent, explore, plan, agent_ask)
- **Tasks**: Todo management
- **Sessions**: Previous session access

### Prompting Principles
1. Post-tool response required
2. Direct tool usage
3. Conciseness
4. Error recovery
5. Loop avoidance
6. Task structuring
7. Agent delegation
8. Tool selection specificity
9. Trust delegation
10. Behavioral directives

### System Prompt Structure
```
CORE_DIRECTIVES
├── Identity
├── Behavioral directives
├── Delegation guidelines
├── General guidelines
└── Dynamic context (injected per request)
```

### Tool Selection Logic
```
Exploration? → explore
Planning? → plan
Complex? → agent
Follow-up? → agent_ask
Direct? → read/grep/glob/write/edit/bash
```

---

## File Organization

```
/Users/bhm128/code-ally/
├── PROMPTING_PATTERNS_ANALYSIS.md ← Detailed technical analysis
├── TOOL_ROUTING_GUIDE.md ← Practical decision trees
├── KEY_FILES_REFERENCE.md ← File locations and navigation
├── EXPLORATION_SUMMARY.md ← Executive summary
│
├── src/
│   ├── prompts/
│   │   └── systemMessages.ts ← All prompts and directives
│   │
│   ├── agent/
│   │   ├── Agent.ts ← Main orchestrator
│   │   ├── ToolOrchestrator.ts ← Tool execution
│   │   └── ...
│   │
│   ├── tools/
│   │   ├── BaseTool.ts ← Base class
│   │   ├── ToolManager.ts ← Tool registration
│   │   ├── ExploreTool.ts ← Explore agent
│   │   ├── PlanTool.ts ← Plan agent
│   │   ├── AgentTool.ts ← Agent delegation
│   │   ├── AgentAskTool.ts ← Agent follow-up
│   │   └── ... (30+ tools total)
│   │
│   ├── services/
│   │   ├── AgentManager.ts ← Agent loading/saving
│   │   ├── AgentPoolService.ts ← Pool management
│   │   └── ...
│   │
│   └── config/
│       ├── constants.ts ← Application constants
│       └── toolDefaults.ts ← Tool limits
│
└── ~/.code_ally/agents/ ← Custom agent definitions
    ├── general.md ← Default agent
    └── {custom_agents}.md ← User-defined agents
```

---

## Quick Start for Different Audiences

### "Show me how tool routing works"
→ Read: `TOOL_ROUTING_GUIDE.md` (entire document, 10 minutes)

### "I need to understand agent specialization"
→ Read: `PROMPTING_PATTERNS_ANALYSIS.md` section 1 + section 3.3 (20 minutes)

### "Where is the system prompt defined?"
→ Read: `KEY_FILES_REFERENCE.md` section "Primary System Message File" (5 minutes)

### "I want to create a custom agent"
→ Read: `KEY_FILES_REFERENCE.md` section "Agent Metadata Format" + create file (10 minutes)

### "How does context budget management work?"
→ Read: `PROMPTING_PATTERNS_ANALYSIS.md` section 6 + `TOOL_ROUTING_GUIDE.md` section "Context Budget Management" (15 minutes)

### "What are the key principles I should follow?"
→ Read: `PROMPTING_PATTERNS_ANALYSIS.md` section 7 (15 minutes)

### "Show me examples of tool usage"
→ Read: `PROMPTING_PATTERNS_ANALYSIS.md` section 9 + `TOOL_ROUTING_GUIDE.md` section "When to Use Each Pattern" (20 minutes)

---

## Contact Points

For each document:
- **PROMPTING_PATTERNS_ANALYSIS.md**: Detailed reference, preserved as-is for archival
- **TOOL_ROUTING_GUIDE.md**: Quick reference, safe to print or bookmark
- **KEY_FILES_REFERENCE.md**: Navigation guide, use for finding implementations
- **EXPLORATION_SUMMARY.md**: Executive brief, use for presentations or onboarding

All documents are in Markdown format and can be viewed in any text editor or Markdown viewer.

---

**Documentation created**: November 5, 2025  
**Source**: Complete analysis of CodeAlly codebase  
**Status**: Ready for use and reference
