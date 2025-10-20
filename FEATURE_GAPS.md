# Feature Gaps: TypeScript vs Python Code Ally

This document summarizes all missing features and implementation differences between the TypeScript/Ink and Python/Rich versions of Code Ally, based on comprehensive agent analysis.

**Last Updated:** 2025-10-20
**Analysis Date:** 2025-10-20

---

## Executive Summary

**Overall Status:** TypeScript implementation has ~65% feature parity with Python

**Critical Gaps:** 7 major systems remaining (2 completed: TokenManager, ToolResultManager)
**High Priority Gaps:** 15+ features
**Medium Priority Gaps:** 20+ features

**Recent Progress:**
- ✅ TokenManager integration with tool result truncation
- ✅ ToolResultManager service with context-aware truncation
- ✅ Progressive truncation levels (normal/moderate/aggressive/critical)
- ✅ Tool usage statistics and remaining call estimation

---

## 1. Input Handling Issues (CRITICAL - IN PROGRESS)

### ✅ FIXED
- **Ctrl+C Interception**: Added `exitOnCtrlC: false` to render options (src/cli.ts:477)
- **Word Movement Fallback**: Added Ctrl+Left/Right as fallback for Option/Alt issues (InputPrompt.tsx:400-408)
- **Block Cursor**: Implemented block caret instead of underscore (InputPrompt.tsx:494-496)
- **Command Mode Visual**: Dynamic prompt styling for /, !, @ prefixes (InputPrompt.tsx:436-453)
- **History Persistence**: Auto-save history after each submit (InputPrompt.tsx:184-188)

### ⚠️ KNOWN ISSUES
- **Option/Alt Keys**: Ink parses `\u001b\u001b[D` as TWO events (escape + arrow) instead of Option+Left
  - **Workaround**: Use Ctrl+Left/Right instead of Option+Left/Right
  - **Root Cause**: Ink's parse-keypress.js doesn't properly handle double-escape sequences for meta keys

### ❌ STILL MISSING
- **Prompt History Selector**: Escape key on empty prompt should show conversation history browser
- **Enhanced Key Bindings**:
  - Ctrl+J / Ctrl+O for newline without submit
  - Smart Enter (completion selection vs submit)

---

## 2. Command Handler Gaps (CRITICAL)

### Incomplete Commands (4 TODOs in CommandHandler.ts)

| Command | Status | Lines | What's Missing |
|---------|---------|-------|----------------|
| `/compact` | ✅ **DONE** | 393-545 | LLM-based conversation summarization (COMPLETED) |
| `/debug system` | ✅ **DONE** | 375-418 | Show system prompt and tool definitions (COMPLETED) |
| `/debug tokens` | ✅ **DONE** | 425-491 | Token usage and memory stats (COMPLETED) |
| `/debug context` | ✅ **DONE** | 498-525 | JSON-formatted context display (COMPLETED) |
| `/agent create` | TODO | 459 | AgentWizard integration, LLM generation |
| `/agent use` | TODO | 513 | Agent delegation workflow |
| `/project init` | TODO | 808 | ALLY.md creation wizard |
| `/project edit` | TODO | 816 | Editor detection and file opening |

### ❌ Completely Missing Commands (9)

| Command | Purpose | Priority |
|---------|---------|----------|
| `/clear` | Clear conversation history | High |
| `/refresh` or `/index` | Rebuild path completion cache | Medium |
| `/init` | Interactive setup wizard | Low |
| `/m` | Shortcut alias for `/model` | Low |
| `/todo ls` | List todo items | Medium |
| `/todo add` | Add task | Medium |
| `/todo complete <N>` | Complete task by index | Medium |
| `/todo rm <N>` | Remove task | Medium |
| `/todo clear` | Clear all todos | Medium |

### 📝 Missing Command Features
- **Model Command**: Missing interactive selector with Rich table (`/model ls`)
- **Config Command**: No runtime instance updates (Python updates agent/trust/token managers live)
- **Memory Command**: Python has ALLY.md parsing logic, TypeScript uses service abstraction

---

## 3. Agent & Conversation Flow Gaps (CRITICAL)

### ❌ Missing Core Systems

**3.1 ConversationManager** (Python: conversation_manager.py)
- Full interactive loop with:
  - Context management before each input
  - Slash command routing
  - Bash mode support (`!command`)
  - Agent delegation routing (`@agent`)
  - Permission denial recovery
  - Auto-save session after each turn
  - Conversation reset/branching
- **TypeScript**: Only has basic `sendMessage()` method in Agent

**3.2 TokenManager** (Python: token_manager.py) - ✅ **COMPLETED**
- ✅ File content deduplication
- ✅ Token counting with truncateContentToTokens() method
- ✅ Tool result truncation levels:
  - Normal: 1000 tokens
  - Moderate (70-85%): 750 tokens
  - Aggressive (85-95%): 500 tokens
  - Critical (95%+): 200 tokens
- ✅ Graduated context warnings (70%, 85%, 90%, 95%)
- ✅ Integrated with ToolOrchestrator via ToolResultManager
- ⚠️ Auto-compaction at threshold (not yet implemented)
- **TypeScript**: Has TokenManager integrated with tools via ToolResultManager service

**3.3 ToolResultManager** (Python: tool_result_manager.py) - ✅ **COMPLETED**
- ✅ Context-aware result truncation
- ✅ Progressive truncation levels based on context usage
- ✅ Tool usage statistics tracking
- ✅ Remaining tool call estimation
- ✅ Context status messages for the model
- ⚠️ Unhelpful result detection (not yet implemented)
- ⚠️ Suggestion generation (not yet implemented)
- **TypeScript**: Fully implemented as ToolResultManager service

**3.4 ThinkingModelManager** (Python: thinking.py)
- Native thinking support
- Embedded thinking parsing (`<think>` tags)
- Streaming thinking display
- Combined thinking output
- **TypeScript**: Basic thinking events only

**3.5 InterruptCoordinator** (Python: interrupt_coordinator.py)
- State machine for Ctrl+C handling
- Different behavior based on state (IDLE, THINKING, TOOL_EXECUTING)
- Safe interrupt points
- **TypeScript**: Simple Ctrl+C handling only

**3.6 UsagePatternAnalyzer** (Python: usage_pattern_analyzer.py)
- Track tool usage patterns
- Suggest optimizations
- **TypeScript**: Missing

---

## 4. Tool System Gaps (HIGH PRIORITY)

### ❌ Missing Tools (3)

| Tool | Purpose | Lines | Priority |
|------|---------|-------|----------|
| `LintTool` | Syntax checking (Python, TS, JS, PHP, JSON, YAML) | ~300 | **CRITICAL** |
| `FormatTool` | Auto-formatting (black, prettier, eslint, etc.) | ~400 | **CRITICAL** |
| `CleanupToolCallTool` | Context management - retroactive cleanup | ~150 | High |
| `AllyWriteTool` | Append to ALLY.md project notes | ~80 | Low |

### Input Shortcuts

**✅ Bash Shortcuts** (`!` prefix) - **COMPLETED**
- Direct bash command execution without LLM
- User types: `!ls -la`
- System executes immediately
- Saves tokens and inference time
- **Python Location**: conversation_manager.py:334-339
- **TypeScript Location**: src/ui/App.tsx:144-209

**Agent Shortcuts** (`@` prefix) - **LOW PRIORITY**
- Quick agent delegation syntax
- Delegates back to LLM for parsing
- **Location**: Python conversation_manager.py:342

### 📝 Tool Behavior Differences

**BashTool**:
- ❌ Missing: Real-time output streaming with UI integration
- ❌ Missing: Interactive command detection with suggestions
- ❌ Missing: Advanced cancellation via InterruptCoordinator
- ❌ Missing: Detailed timeout handling

**AgentTool**:
- ❌ Missing: Scoped service registry for sub-agents
- ❌ Missing: Trust manager configuration inheritance
- ❌ Missing: Delegation UI manager with suppressed output
- ❌ Missing: Tool wrapping for error context
- ❌ Missing: Custom model/temperature per agent

**Edit/Write Tools**:
- ❌ Missing: File activity tracking
- ❌ Missing: Patch capture for undo
- ❌ Missing: Post-modification file checking
- ❌ Missing: Recent files context

---

## 5. UI Feature Gaps (MEDIUM PRIORITY)

### ❌ Missing Animation Systems

**5.1 Streaming Response Animation**
- Live markdown rendering during streaming
- Thinking content parsing and display
- Todo list display during streaming
- **Python**: animation_manager.py:452-509

**5.2 Tagline Status Animation**
- Custom status line for agent delegation
- Elapsed time display
- Pause/resume during prompts
- **Python**: animation_manager.py:510-566

**5.3 Animation State Machine**
- States: IDLE, THINKING, STREAMING, TOOL_EXECUTING, TOOL_OUTPUT_STREAMING, TAGLINE_STATUS
- Thread-safe state management
- Central animation loop (12 FPS)
- State-specific renderables
- **Python**: animation_manager.py:28-37, 54-59

### ❌ Missing Display Features

**5.4 Context Usage in Prompt**
- Shows remaining context percentage
- Color-coded by severity (green → yellow → red)
- Format: `"(30% remaining) >"`
- **Python**: input_manager.py:222-260

**5.5 Todo Toolbar**
- Bottom toolbar showing next 1-2 tasks
- Smart truncation: `"▶ First task (+2 more)"`
- Context-aware display
- **Python**: input_manager.py:262-307

**5.6 Focus Status Display**
- Shows current focus directory during operations
- Format: `"(focused on: ./src/)"`
- **Python**: animation_manager.py:96-108

**5.7 Model Name in Animations**
- Truncated model name during thinking
- Format: `"qwen2 Thinking (15 tokens) [3s]"`
- **Python**: animation_manager.py:90-94

**5.8 Tool Result Preview**
- Shows first 3 lines of tool results
- Adds "..." for truncation
- Indented with 5 spaces
- **Python**: display_manager.py:97-117

**5.9 Startup Banner**
- ASCII art robot: `[o_o] \_/`
- Version and model display
- **Python**: display_manager.py:136-158

**5.10 Help Display**
- Comprehensive markdown-formatted help
- Organized by sections
- Key binding documentation
- **Python**: display_manager.py:160-211

---

## 6. Permission & Security Gaps (CRITICAL)

### ❌ Missing Systems

**6.1 TrustManager** (Python: trust.py)
- Session-based permission tracking
- Batch operation permissions
- File modification previews before prompts
- Permission denial handling with recovery
- Trusted command patterns
- **TypeScript**: Has basic TrustManager but NOT integrated with ToolOrchestrator

**6.2 PermissionManager** (Python: agent/permission_manager.py)
- Batch permission prompts
- File modification preview system
- Interactive confirmation
- **TypeScript**: Missing entirely

**6.3 DiffDisplayManager** (Python: ui/diff_display.py)
- Color-coded diff preview for file modifications
- Shows changes before confirmation
- **TypeScript**: Has DiffDisplay component but not integrated with permissions

---

## 7. Session Management Gaps (HIGH PRIORITY)

### ⚠️ Incomplete Implementation

**Current State**: Basic infrastructure exists but not fully integrated

**Missing**:
- Auto-save after every conversation turn
- Session reset/resume capability
- Conversation branching (reset to index)
- `--once` mode session integration (lines 258-270 in cli.ts marked with TODO)

**Python**: Full session lifecycle integrated with Agent, auto-saves after each turn

---

## 8. Syntax Checkers (HIGH PRIORITY)

### ❌ Missing Checkers (7)

Python has a full checker registry system:

| Checker | Purpose | Status |
|---------|---------|--------|
| PythonChecker | AST parsing for Python | Missing |
| TypeScriptChecker | tsc for TypeScript | Missing |
| JavaScriptChecker | eslint for JS | Missing |
| PHPChecker | php -l for PHP | Missing |
| JSONChecker | JSON parsing | Missing |
| YAMLChecker | YAML parsing | Missing |
| ShellChecker | shellcheck for bash | Missing |
| PowerShellChecker | PSScriptAnalyzer | Missing |

**Required For**: LintTool and FormatTool implementations

---

## 9. Undo System Gaps (MEDIUM PRIORITY)

### ❌ Missing Components

**9.1 PatchManager** (Python: undo/patch_manager.py)
- Captures file modification patches
- Stores undo history
- Applies reverse patches
- **TypeScript**: Has UndoManager service but integration unclear

**9.2 FileActivityTracker** (Python: services/file_activity_tracker.py)
- Tracks all file modifications
- Maintains recent files list
- Provides context to tools
- **TypeScript**: Missing entirely

---

## 10. Completion System Gaps (LOW PRIORITY)

### ⚠️ Partial Implementation

**Current State**: Has CommandHistory and CompletionProvider

**Missing**:
- Path indexing system (PathIndexer)
- Composite completer integration
- Agent name completion caching
- Command completer for slash commands
- Refresh/rebuild functionality

**Python**: Full completion system with path indexing, caching, multi-source completion

---

## Implementation Priority Matrix

### Priority 1: Core Functionality (CRITICAL)

**Blocking Basic Usage:**
1. ✅ Fix Ctrl+C interception (DONE)
2. ✅ Fix word movement (DONE with Ctrl fallback)
3. ✅ Implement bash shortcuts (`!command`) (DONE)
4. ✅ Implement `/compact` command (DONE)
5. ✅ Implement `/debug` commands (DONE)
6. ✅ Integrate TokenManager with tool execution (DONE)
7. ✅ Implement tool result truncation based on context (DONE)
8. ❌ Add LintTool (essential for code quality workflows)
9. ❌ Add FormatTool (essential for formatting workflows)

### Priority 2: Enhanced UX (HIGH)

**Improving User Experience:**
10. ❌ Implement streaming response animation
11. ❌ Add context usage display in prompt
12. ❌ Add todo toolbar display
13. ❌ Implement `/clear` command
14. ❌ Complete session integration
15. ❌ Add file activity tracking for undo
16. ❌ Implement CleanupToolCallTool for context management
17. ❌ Add tool result preview system
18. ❌ Implement thinking content parsing

### Priority 3: Feature Completion (MEDIUM)

**Achieving Full Parity:**
19. ❌ Implement agent creation wizard (`/agent create`)
20. ❌ Implement agent delegation (`/agent use`, `@` shortcut)
21. ❌ Implement project initialization (`/project init`)
22. ❌ Implement project editing (`/project edit`)
23. ❌ Add todo management commands (`/todo ls/add/complete/rm/clear`)
24. ❌ Add startup banner and help display
25. ❌ Implement prompt history selector (Escape key)
26. ❌ Add focus status display in animations
27. ❌ Add model name display in animations

### Priority 4: Polish & Advanced Features (LOW)

**Nice to Have:**
28. ❌ Add AllyWriteTool for project notes
29. ❌ Implement usage pattern analyzer
30. ❌ Add non-interactive UI mode for `--once`
31. ❌ Implement InterruptCoordinator state machine
32. ❌ Add advanced BashTool streaming
33. ❌ Implement scoped service registries for sub-agents
34. ❌ Add trust manager inheritance for delegated agents

---

## Architectural Notes

### Python Strengths
- Monolithic agent with integrated UI
- Direct UI manager reference
- Synchronous key bindings with prompt_toolkit
- Mature tool ecosystem
- Sophisticated context management

### TypeScript Strengths
- Cleaner separation of concerns
- Event-driven architecture (ActivityStream)
- React-based UI with Ink
- Better testability
- Modern async/await patterns

### Recommendation

The TypeScript implementation has a **better architectural foundation** but is **missing ~40% of Python's features**. Focus should be on:
1. Filling critical gaps (tools, commands, context management)
2. Maintaining the clean architecture
3. Not blindly copying Python's monolithic design
4. Leveraging TypeScript's type safety and modern patterns

---

## File References

All gaps documented with exact file locations for easy reference:

**Python Codebase Root:** `/Users/bhm128/CodeAlly/code_ally/`
**TypeScript Codebase Root:** `/Users/bhm128/code-ally/src/`

See individual sections above for specific file paths.
