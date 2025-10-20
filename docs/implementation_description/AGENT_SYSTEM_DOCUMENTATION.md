# CodeAlly Core Agent System Documentation

**Purpose**: Complete architectural documentation for reimplementing CodeAlly's agent system in TypeScript.

**Scope**: `/Users/bhm128/CodeAlly/code_ally/agent/` directory

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Agent Class](#agent-class)
3. [Tool Orchestrator](#tool-orchestrator)
4. [Response Processor](#response-processor)
5. [Interrupt Coordinator](#interrupt-coordinator)
6. [Token Manager](#token-manager)
7. [Supporting Components](#supporting-components)
8. [Data Flow Diagrams](#data-flow-diagrams)
9. [State Machines](#state-machines)
10. [Configuration Points](#configuration-points)

---

## Architecture Overview

### Component Hierarchy

```
Agent (Main Orchestrator)
├── ConversationManager (Conversation loop & I/O)
├── ResponseProcessor (LLM response handling)
├── ToolOrchestrator (Tool execution coordination)
├── SessionManager (Persistence)
├── TokenManager (Context management)
├── ToolManager (Tool registry & execution)
├── CommandHandler (Slash commands)
├── PermissionManager (Security)
├── ThinkingManager (Thinking tag parsing)
└── InterruptCoordinator (Global singleton, Ctrl+C handling)
```

### Dependency Injection

All components use **dependency injection** via `ServiceRegistry`:
- Components receive dependencies through constructor
- No global state except `InterruptCoordinator`
- Enables easy testing and agent delegation

### Key Design Patterns

1. **Single Responsibility**: Each component has one clear purpose
2. **Delegation Pattern**: Agent delegates to specialized managers
3. **Event-Driven**: Interrupt handling via signal-safe coordinator
4. **Context Isolation**: Agent delegations use `ExecutionContext` for proper isolation
5. **Progressive Truncation**: Tool results truncate more aggressively as context fills

---

## Agent Class

**File**: `agent.py`

### Responsibilities

- Main orchestrator for conversation and tool execution
- Manages message history
- Coordinates all sub-components
- System prompt management
- Session auto-save coordination

### Initialization Sequence

```python
def __init__(
    self,
    model_client: ModelClient,
    tools: list[Any],
    client_type: str | None = None,
    system_prompt: str | None = None,
    verbose: bool = False,
    check_context_msg: bool = True,
    service_registry: ServiceRegistry | None = None,
    non_interactive: bool = False,
    is_specialized_agent: bool = False,
) -> None
```

**Parameters**:
- `model_client`: LLM client for sending requests
- `tools`: List of available tool instances
- `client_type`: Client format type (e.g., "ollama")
- `system_prompt`: Optional custom system prompt
- `verbose`: Enable verbose logging
- `check_context_msg`: Whether to encourage LLM to check context
- `service_registry`: Optional registry (creates one if not provided)
- `non_interactive`: Single-message mode (no conversation loop)
- `is_specialized_agent`: Prevents system prompt refresh for agent delegations

**Initialization Steps**:

1. **Service Registry**: Use provided or get singleton instance
2. **Basic Configuration**: Store model client, messages list, flags
3. **Interrupt Coordinator**: Get global singleton reference
4. **Component Creation**:
   - UI Manager (or use existing from registry for delegation)
   - Thinking Manager
   - Config Manager
   - Trust Manager
   - Permission Manager
   - Token Manager
   - Tool Result Manager
   - Tool Manager
   - Diff Display Manager (for file operation previews)
   - Usage Pattern Analyzer
   - Command Handler
5. **Component Coordinators**:
   - Response Processor
   - Tool Orchestrator
   - Conversation Manager
   - Session Manager
6. **Initial System Prompt**: Add to messages if provided

### State Management

**Instance Variables**:

```python
self.messages: list[dict[str, Any]]          # Conversation history
self._messages_lock: asyncio.Lock            # Concurrent append protection
self.request_in_progress: bool               # LLM request active flag
self.non_interactive: bool                   # Single-message mode
self.is_specialized_agent: bool              # Agent delegation flag
self.client_type: str                        # Format type (e.g., "ollama")
self.check_context_msg: bool                 # Context reminder flag
```

### Key Methods

#### System Prompt Management

```python
def _refresh_system_prompt(self) -> None:
    """Refresh system prompt with latest ALLY.md contents."""
```

- **When Called**: Before each LLM request (in `_get_follow_up_response` and `_process_user_message`)
- **Behavior**:
  - Skips if `is_specialized_agent` is True (preserves specialized identity)
  - Gets updated system prompt from `prompts.get_main_system_prompt()`
  - Finds existing system message and updates content
  - Creates new system message if none exists
  - Updates token count after refresh
- **Error Handling**: Logs warning but doesn't fail on errors

#### Session Auto-Save

```python
def _auto_save_session(self) -> None:
    """Auto-save current conversation to active session."""
```

- **When Called**: After every message addition or token count update
- **Behavior**: Delegates to `SessionManager.auto_save_session()`
- **Notes**: Gracefully handles missing session manager (non-interactive agents)

#### Tool Result Cleanup

```python
def cleanup_tool_result(
    self,
    tool_call_id: str,
    summary: str | None = None,
    reason: str = "not relevant to task"
) -> dict[str, Any]:
    """Clean up tool result by replacing content with placeholder."""
```

- **Purpose**: Free context space by removing unhelpful tool results
- **Parameters**:
  - `tool_call_id`: ID of tool call to clean up
  - `summary`: Optional 1-2 sentence summary (truncated if longer)
  - `reason`: Brief reason (e.g., "no results")
- **Behavior**:
  1. Find tool result message by `tool_call_id`
  2. Check if already cleaned up (prevents duplicate cleanup)
  3. Calculate tokens saved
  4. Replace content with placeholder: `[Cleaned up - {reason}]: {summary}`
  5. Mark message with metadata: `cleaned_up`, `cleanup_reason`, `cleanup_summary`, `original_tokens`
  6. Update token count
- **Returns**: `{success, message, original_tool, tokens_saved}` or error dict

#### Diff Display Setup

```python
def _setup_diff_display_manager(self) -> None:
    """Set up diff display for file operation tools."""
```

- **When Called**: During initialization
- **Configuration**:
  - `diff_display_enabled`: Default True
  - `diff_display_max_file_size`: Default 102400 bytes
  - `diff_display_context_lines`: Default 3
  - `diff_display_theme`: Default "auto"
  - `color_removed`: Default "on rgb(60,25,25)"
  - `color_added`: Default "on rgb(25,60,25)"
  - `color_modified`: Default "on rgb(60,60,25)"
- **Tools Configured**: edit, write, line_edit
- **Error Handling**: Gracefully handles missing dependencies or config errors

### Conversation Flow

**Main Entry Points**:

1. **Interactive Mode**: `await run_conversation()`
   - Delegates to `ConversationManager.run_conversation_loop()`
   - Infinite loop with user input prompts

2. **Single Message Mode**: `await run_single_message(message)`
   - Delegates to `ConversationManager.process_single_message(message)`
   - Processes one message and exits

### Component Access Pattern

**Through Service Registry**:
```python
config_manager = self.service_registry.get("config_manager")
trust_manager = self.service_registry.get("trust_manager")
ui_manager = self.service_registry.get("ui_manager")
```

**Direct References**:
```python
self.ui
self.token_manager
self.tool_manager
self.response_processor
self.tool_orchestrator
self.conversation_manager
```

---

## Tool Orchestrator

**File**: `tool_orchestrator.py`

### Responsibilities

- Coordinate tool execution (concurrent vs sequential)
- Monitor context usage during execution
- Process tool results with truncation
- Display agent delegation results
- Handle error retries and permission denials
- Show file modification previews

### Core Methods

#### Main Entry Point

```python
async def execute_tool_calls(self, tool_calls: List[Dict[str, Any]]) -> None:
    """Process tool calls with concurrent execution for safe operations."""
```

**Flow**:
1. Check context before execution (`_check_context_before_execution`)
   - Block execution if context ≥95%
   - Warn if context ≥90%
2. Determine execution mode (`_can_run_concurrently`)
3. Route to concurrent or sequential execution
4. Update token counts and auto-save session

#### Context Monitoring

```python
async def _check_context_before_execution(self, tool_calls: List[Dict[str, Any]]) -> bool:
    """Check if context allows tool execution. Block if critical."""
```

**Thresholds**:
- **95%+ (Critical)**: Block execution, add forceful system message
  ```
  🚨 CRITICAL CONTEXT LIMIT: {pct}% used.
  Tool execution has been BLOCKED to prevent context overflow.
  You MUST provide a summary of work completed so far and conclude your response now.
  Do NOT attempt further tool calls - they will fail.
  ```
- **90%+ (Warning)**: Allow but warn strongly
  ```
  ⚠️ Context at {pct}% - only ~{remaining_calls} tool calls remaining.
  Executing {len(tool_calls)} tool(s)...
  ```

**Returns**: `True` to proceed, `False` to block

#### Concurrent Execution

```python
async def _process_concurrent_tool_calls(self, tool_calls: List[Dict[str, Any]]) -> None:
    """Process tool calls concurrently for safe operations."""
```

**Safe Concurrent Tools**:
```python
safe_concurrent_tools = {
    'file_read', 'grep', 'glob', 'bash_readonly', 'ls',
    'web_fetch', 'git_status', 'git_log', 'git_diff',
    'agent',  # Agent delegations are context-isolated
}
```

**Flow**:
1. Check if any tool is agent tool (for tagline updates)
2. Display "Multiple Operations" header
3. Create async tasks for each tool call
4. `await asyncio.gather(*tasks, return_exceptions=True)`
5. Handle cancellation (`asyncio.CancelledError`)
6. Process results and re-raise permission errors
7. Update final token count and auto-save

**Cancellation Handling**:
- Cancel all remaining tasks
- Wait briefly (0.5s) for cleanup
- Log warning if tasks don't cancel cleanly
- Re-raise `CancelledError`

#### Sequential Execution

```python
async def _process_sequential_tool_calls(self, tool_calls: List[Dict[str, Any]]) -> None:
    """Process tool calls one by one (fallback for unsafe concurrent operations)."""
```

**Flow**:
1. Handle batch permissions upfront (`_handle_batch_permissions`)
2. For each tool call:
   - Execute tool (`_execute_single_tool`)
   - Process result (`_process_tool_result`)
   - Monitor context (`_monitor_context_during_execution`)
3. Handle `PermissionDeniedError` (abort entire process)
4. Final session save

#### Single Tool Execution

```python
async def _execute_single_tool(
    self,
    tool_call: Dict[str, Any],
    executed_tools: List[str],
    successful_tools: List[str],
    requires_multi_permission: bool,
    is_multi_operation: bool
) -> Optional[Dict[str, Any]]:
    """Execute a single tool with retry logic."""
```

**Flow**:
1. Normalize tool call (`_normalize_tool_call`)
2. Track execution in `executed_tools`
3. **Agent Tool Header**: Print header BEFORE execution for agent tools
   - Format: `[cyan]→ {agent_name}[/] [dim]({task_prompt})[/]`
   - Printed with `ui.print_content`
4. Execute tool via `ToolManager.execute_tool`
   - Pass `pre_approved=True` if batch permission granted
5. Display tool call line (for non-agent tools)
6. Show result preview (`_show_tool_result_preview`)
7. Attempt auto-retry for validation errors (`_attempt_auto_retry`)
8. Track success in `successful_tools`

**Agent Tool Display**:
- Header printed BEFORE execution
- Content printed AFTER execution (in `_process_tool_result`)
- Prevents duplicate output

**Returns**: Tool result dict or None if permission denied

#### Tool Result Processing

```python
async def _process_tool_result(self, tool_call: Dict[str, Any], raw_result: Dict[str, Any], call_id: str) -> None:
    """Process tool result using centralized ToolResultManager."""
```

**Flow**:
1. Format result as natural language (`ResponseProcessor.format_tool_result_as_natural_language`)
2. Process through `ToolResultManager.process_tool_result` (context-aware truncation)
3. Add tool result to messages (`_add_tool_result_with_update`)
4. Display agent result content if agent tool (`_display_agent_result_content`)
5. Add context status message (`_add_context_status_with_update`)

#### Adding Tool Results

```python
async def _add_tool_result_with_update(self, processed_result: str, call_id: str, tool_name: str) -> None:
    """Add tool result to messages (token update deferred)."""
```

**Behavior**:
1. Prepend tool_call_id to content: `[tool_call_id: {call_id}]\n{processed_result}`
2. Generate unhelpful suggestion (`_generate_unhelpful_suggestion`)
3. Append suggestion if generated
4. Add message with lock:
   ```python
   async with self.agent._messages_lock:
       self.agent.messages.append({
           "role": "tool",
           "content": content_with_id,
           "tool_call_id": call_id,
           "name": tool_name,
       })
   ```

**Note**: Token update happens later in `_add_context_status_with_update`

#### Unhelpful Result Detection

```python
def _generate_unhelpful_suggestion(self, content: str, call_id: str) -> str | None:
    """Generate suggestion to clean up result if appears unhelpful."""
```

**Indicators**:
```python
unhelpful_indicators = [
    "No matches found",
    "No files found",
    "No items found",
    "Found 0 ",
    "not found",
    "does not exist",
    "No such file",
]
```

**Token Threshold**: >500 tokens considered potentially unhelpful

**Suggestion Format**:
```
💡 If this result isn't helpful, free context space with:
cleanup_tool_call(tool_call_ids="{call_id}", summary="Brief 1-2 sentence description", reason="{reason_hint}")
```

#### Context Status Updates

```python
def _add_context_status_with_update(self) -> None:
    """Add context status message if needed and update token count (single point of update)."""
```

**Behavior**:
1. Determine truncation level from context percentage
2. Skip status message if context is "normal"
3. Only add status message if level changed (deduplication)
4. **Always** update token count (ensures consistency)
5. Track last level in `self._last_context_status_level`

**Status Message**: Generated by `ToolResultManager.get_context_status_message()`

#### Context Monitoring During Execution

```python
async def _monitor_context_during_execution(self, current_index: int, total_tools: int) -> None:
    """Monitor context usage during sequential tool execution."""
```

**When**: After each tool in sequential mode (only if more tools queued)

**Warnings**:
- **90%+**: Print warning with remaining tools
  ```
  ⚠️ Context at {pct}% with {remaining_tools} tool(s) still queued
  ```
- **85%+**: Verbose mode only
  ```
  [dim yellow][Verbose] Context at {pct}% ({remaining_tools} tools remaining)[/]
  ```

#### Batch Permissions

```python
def _handle_batch_permissions(self, tool_calls: List[Dict[str, Any]]) -> bool:
    """Handle multi-tool permission logic and display operations."""
```

**Flow**:
1. Check if any tools require confirmation
2. Display "Multiple Operations" if >1 tool
3. Show file modification previews (`_show_file_modification_previews`)
4. Prompt for batch operations if needed:
   - `trust_manager.prompt_for_batch_operations(tool_calls)`
   - Raise `PermissionDeniedError` if denied
5. Return whether multi-permission was required

#### File Modification Previews

```python
def _show_file_modification_previews(self, tool_calls: List[Dict[str, Any]]) -> None:
    """Show previews for file modification operations when multiple tools used."""
```

**Tools Previewed**: `write`, `edit`

**Flow**:
1. Validate tool arguments
2. Check file read requirements (warn but continue)
3. Show individual preview (`_show_individual_batch_preview`)
4. Track `previews_shown` count
5. Display summary: `📋 Previewed {count} file modification(s) above`

#### Auto-Retry Logic

```python
async def _attempt_auto_retry(
    self,
    tool_name: str,
    arguments: Dict[str, Any],
    error_result: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Attempt to automatically retry tool call with corrected parameters."""
```

**Corrections Attempted**:

1. **Path Validation Errors** (legacy, mostly unused now):
   - Detect: "file_path must be absolute" or "path must be absolute"
   - Fix: Convert relative path to absolute with `os.path.abspath`
   - Example: `src/main.py` → `/cwd/src/main.py`

2. **Missing Required Parameters**:
   - Detect: "parameter is required" in error
   - Fix for `write` tool: Add `content=""` if missing
   - Verbose log: "Auto-correcting missing content parameter"

3. **Non-Unique String Match** (edit tool):
   - Detect: "appears {N} times" and "must be unique"
   - Fix: Add `replace_all=True` to arguments
   - Verbose log: "Auto-correcting with replace_all=True"

**Returns**: Retry result dict or None if no correction possible

#### Agent Delegation Display

```python
def _display_agent_result_content(self, raw_result: dict) -> None:
    """Display agent completion status only (content for LLM context, not user display)."""
```

**Critical Note**: Content is **NOT** displayed to user!
- Content added to conversation for LLM context
- Main agent summarizes result in follow-up response
- Only completion status shown: `_display_completion_status`

**Display**:
```python
def _display_completion_status(self, raw_result: dict) -> None:
    """Display completion status with optional duration."""
```

Format: `[green]Complete[/] [dim]({duration:.1f}s)[/]` or just `[green]Complete[/]`

#### Tool Call Normalization

```python
def _normalize_tool_call(
    self,
    tool_call: Dict[str, Any],
) -> Tuple[str, str, Dict[str, Any]]:
    """Normalize tool call dict to (call_id, tool_name, arguments)."""
```

**Behavior**:
1. Extract `call_id` (or generate: `{auto_id_prefix}-{timestamp}`)
2. Extract `function` dict (or use top-level if `name` present)
3. Extract `tool_name` from `function.name`
4. Parse `arguments`:
   - If dict: use directly
   - If string: `json.loads(arguments_raw)`
   - Try fixing single quotes: `arguments_raw.replace("'", '"')`
   - Fallback: `{"raw_args": arguments_raw}`
5. Log malformed tool calls at warning level

**Returns**: `(call_id, tool_name, arguments)`

#### Agent Tagline Updates

```python
def _start_agent_tagline_updater(self) -> None:
    """Start daemon thread to update agent tagline with active delegations."""
```

**Behavior**:
- Runs in daemon thread
- Updates every 0.5 seconds
- Stops when animation state changes from `TAGLINE_STATUS`
- Generates label: `"{agent_name}: {task_prompt}"` or `"{N} Agents Processing"`

---

## Response Processor

**File**: `response_processor.py`

### Responsibilities

- Process LLM responses (text vs tool calls)
- Extract tool calls from various formats
- Coordinate follow-up responses after tool execution
- Handle interruptions and streaming
- Format tool results as natural language

### Key Methods

#### Main Entry Point

```python
async def process_llm_response(self, response: Dict[str, Any]) -> None:
    """Process LLM response and execute any tool calls if present."""
```

**Flow**:
1. Extract tool calls (`_extract_tool_calls`)
2. Route to appropriate handler:
   - Tool calls: `_process_tool_response`
   - Text only: `_process_text_response`

#### Tool Call Extraction

```python
def _extract_tool_calls(self, response: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Extract tool calls from response in various formats."""
```

**Supported Formats**:

1. **Standard Multi-Call**:
   ```python
   {"tool_calls": [...]}
   ```

2. **Qwen-Agent Style Single Call**:
   ```python
   {"function_call": {...}}
   ```
   Normalized to:
   ```python
   [{
       "id": f"{manual_id_prefix}-{timestamp}",
       "type": "function",
       "function": response["function_call"]
   }]
   ```

**Returns**: List of normalized tool calls (empty if none)

#### Tool Response Processing

```python
async def _process_tool_response(
    self,
    response: Dict[str, Any],
    tool_calls: List[Dict[str, Any]],
) -> None:
    """Process response that contains tool calls."""
```

**Flow**:
1. **Suppress UI animations** (`_suppress_ui_animations`)
2. **Add assistant message** with tool calls to conversation
3. **Update tokens** and auto-save
4. **Execute tools** via `ToolOrchestrator.execute_tool_calls`
   - Catch `PermissionDeniedError` and return (abort)
5. **Re-enable UI output** (`ui.set_top_level_suppression(False)`)
6. **Get follow-up response** (`_get_follow_up_response`)
7. **Handle follow-up** (`_handle_follow_up_response`)
8. **Stop thinking animation** if no follow-up
9. **Re-enable UI output** again (ensure clean state)

#### UI Suppression

```python
def _suppress_ui_animations(self) -> None:
    """Safely suppress UI animations and streaming for tool execution."""
```

**Actions**:
1. Stop thinking animation
2. Set top-level suppression (`ui.set_top_level_suppression(True)`)
3. Stop streaming response if active

**Error Handling**: All actions wrapped in `contextlib.suppress(Exception)`

#### Text Response Processing

```python
def _process_text_response(self, response: Dict[str, Any]) -> None:
    """Process text-only response with no tool calls."""
```

**Flow**:
1. Stop thinking animation
2. Extract content and thinking:
   - `native_thinking = response.get("thinking", "")`
   - `embedded_thinking = thinking_manager.parse_response(content)`
   - Combine: native takes precedence
3. Add response to messages
4. Update tokens and auto-save
5. **Handle streaming vs non-streaming**:

**Streaming Modes**:

1. **Replace Streaming** (`_should_replace_streaming=True`):
   - Content was streamed with thinking shown in real-time
   - Now replace with clean formatted version
   - Skip thinking display (already shown during streaming)
   - Call: `ui.print_assistant_response(content, thinking=None)`

2. **Non-Streaming** (`_content_was_streamed=False`):
   - Regular non-streaming response
   - Show everything normally
   - Call: `ui.print_assistant_response(content, thinking=combined_thinking)`

3. **Streamed but Not Replaced** (neither flag):
   - Content was streamed
   - Don't duplicate output

#### Follow-Up Response

```python
async def _get_follow_up_response(self) -> Optional[Dict[str, Any]]:
    """Get follow-up response from model after tool execution."""
```

**Flow**:
1. Clear current turn tool calls and suggestions
2. Set `request_in_progress = True`
3. Reset interrupt state
4. Set application state to `MODEL_REQUEST_ACTIVE`
5. Start thinking animation (context="processing")
6. **Refresh system prompt** (latest ALLY.md contents)
7. Send request to model:
   ```python
   response = await model_client.send(
       messages,
       functions=tool_manager.get_function_definitions(),
       stream=True,
   )
   ```
8. Check for interruption: `response.get("interrupted", False)`
9. Return response or None

**Error Handling**:
- `ConnectionError`, `TimeoutError`: Log and return None
- Other exceptions: Log with traceback and return None

**Finally Block**: Always reset `request_in_progress` and set state to `IDLE`

#### Follow-Up Handling

```python
async def _handle_follow_up_response(self, follow_up_response: Dict[str, Any]) -> None:
    """Handle follow-up response after tool execution."""
```

**Flow**:
1. Check for interruption:
   - `follow_up_response.get("interrupted", False)`
   - Or content matches interruption markers
2. If interrupted: return immediately
3. Log verbose info if enabled (`_log_follow_up_info`)
4. Stop thinking animation
5. **Recursively process** follow-up response:
   ```python
   await self.process_llm_response(follow_up_response)
   ```

**Interruption Markers**:
```python
_INTERRUPTION_MARKERS = [
    "[Request interrupted by user]",
    "[Request interrupted by user for tool use]",
    "[Request interrupted by user due to permission denial]",
    "[Request cancelled by user]",
]
```

#### Tool Result Formatting

```python
def format_tool_result_as_natural_language(
    self,
    tool_name: str,
    result: Dict[str, Any] | str,
) -> str:
    """Convert tool result dict into user-readable string if appropriate."""
```

**Special Handling**:

1. **Internal-Only Results** (e.g., delegate_task):
   ```python
   if result.get("_internal_only", False):
       return result.get("result", "Internal operation completed")
   ```

2. **String Conversion**:
   - Ensure result is string (JSON dump if dict)
   - Handle non-serializable objects with `str(result)`

3. **Tag Cleanup**:
   - Check for `<tool_response>`, `<search_reminders>`, `<automated_reminder_from_anthropic>`
   - Use client's `_extract_tool_response` if available
   - Fallback: regex removal with `re.sub(..., flags=re.DOTALL)`

**Returns**: Cleaned result string

---

## Interrupt Coordinator

**File**: `interrupt_coordinator.py`

### Responsibilities

- **Global singleton** for centralized interrupt handling
- Signal-safe SIGINT handling
- State-based interrupt routing (cancel request vs clear input vs exit)
- Thread-safe cancellation events
- Graceful shutdown coordination

### Design Principles

1. **Minimal Signal Handlers**: Only set flags, defer work
2. **Thread-Safe Primitives**: Use `threading.Event`, not `asyncio.Event` in handlers
3. **Signal Masking**: Protect critical sections
4. **Exception-Based Flow**: No `sys.exit()` in handlers (except rapid interrupt protection)
5. **Recursion Protection**: Thread-local storage for nested calls

### Enums

```python
class ApplicationState(Enum):
    """Current state of application for interrupt handling."""
    IDLE = "idle"
    USER_INPUT_ACTIVE = "user_input_active"
    MODEL_REQUEST_ACTIVE = "model_request_active"
    TOOL_EXECUTION_ACTIVE = "tool_execution_active"

class InterruptAction(Enum):
    """Actions that can be taken in response to interrupt."""
    CANCEL_REQUEST = "cancel_request"
    CLEAR_INPUT = "clear_input"
    EXIT_APPLICATION = "exit_application"
    NO_ACTION = "no_action"

class GracefulExit(SystemExit):
    """Exception for graceful application exit."""
    pass
```

### Initialization

```python
def __init__(self, agent: Optional['Agent'] = None) -> None:
    """Initialize the interrupt coordinator."""
```

**State Variables**:
```python
self.agent: Optional[Agent]                      # Agent instance (set later)
self.application_state: ApplicationState         # Current app state
self.has_input_content: bool                     # User input buffer state

# Thread-safe synchronization
self._state_lock: threading.RLock                # Reentrant lock
self._cancellation_event_thread: threading.Event # Thread-safe cancellation
self._cancellation_event_async: Optional[asyncio.Event]  # Async cancellation

# Interrupt processing state
self._interrupt_pending: bool                    # Set by signal handler
self._processing_interrupt: bool                 # Prevent concurrent processing
self._last_interrupt_time: float                 # For debouncing
self._interrupt_debounce_seconds: float          # Default 0.5s
self._rapid_interrupt_count: int                 # Force exit threshold
self._rapid_interrupt_threshold: int             # Default 3
self._exit_requested: bool                       # Graceful exit flag
self._signal_count: int                          # For deferred logging
```

**Setup**: Registers signal handler for `SIGINT`

### Signal Handler

```python
def _signal_handler(self, signum: int, frame: types.FrameType | None) -> None:
    """MINIMAL signal handler - only sets flags and schedules deferred work."""
```

**⚠️ CRITICAL**: This runs in signal context - **NO** locks, I/O, or logging!

**Actions**:
1. Get current time (atomic)
2. Check for rapid interrupts:
   - If `time_since_last < debounce_seconds`: increment `_rapid_interrupt_count`
   - If `_rapid_interrupt_count >= threshold`: **Force exit immediately** (only `sys.exit()` call)
   - Else: reset `_rapid_interrupt_count`
3. Update counters: `_signal_count`, `_last_interrupt_time`, `_interrupt_pending`
4. Schedule deferred processing:
   - Try to get event loop
   - If running: `loop.call_soon_threadsafe(self._process_interrupt_deferred)`
   - Else: `self._process_interrupt_minimal()`

### Deferred Processing

```python
def _process_interrupt_deferred(self) -> None:
    """Process interrupt in event loop context (full processing)."""
```

**Flow**:
1. Check `_interrupt_pending` (return if False)
2. Clear pending flag
3. Log deferred interrupt
4. Acquire state lock (1s timeout)
5. Check if already processing (return if True)
6. Set `_processing_interrupt = True`
7. Release lock
8. Determine action (`_determine_action`)
9. Execute action (`_execute_action`)
10. Handle errors (set `_exit_requested` on failure)
11. Finally: reset `_processing_interrupt`

### Minimal Processing

```python
def _process_interrupt_minimal(self) -> None:
    """Minimal synchronous processing (fallback when no event loop)."""
```

**Restrictions**: Only minimal safe actions (no UI operations)

**Flow**:
1. Check `_interrupt_pending`
2. Clear pending flag
3. Try to acquire lock (0.1s timeout)
4. If can't acquire: just set `_exit_requested`
5. Determine action
6. Perform minimal actions:
   - `EXIT_APPLICATION`: Set `_exit_requested`
   - `CANCEL_REQUEST`: Set cancellation flags and `request_in_progress = False`
   - Others: No action

### Action Determination

```python
def _determine_action(self) -> InterruptAction:
    """Determine appropriate action based on current state."""
```

**Logic**:
```python
if state in (MODEL_REQUEST_ACTIVE, TOOL_EXECUTION_ACTIVE):
    return CANCEL_REQUEST
elif state == USER_INPUT_ACTIVE:
    if has_input_content:
        return CLEAR_INPUT
    else:
        return EXIT_APPLICATION
else:
    return EXIT_APPLICATION
```

### Action Execution

#### Cancel Model Request

```python
def _cancel_model_request(self) -> None:
    """Cancel active model request and return to prompt."""
```

**Flow** (with signal masking):
1. Mask SIGINT during critical section
2. Set thread-safe cancellation event
3. Schedule async event set in event loop (thread-safe)
4. Set `agent.request_in_progress = False`
5. Set `model_client._interrupted = True`
6. Cancel all model client tasks (`_cancel_all_model_client_tasks`)
7. Stop all UI animations (`_stop_all_ui_animations`)
8. Set state to IDLE
9. Restore signal mask

#### Cancel Model Client Tasks

```python
def _cancel_all_model_client_tasks(self) -> None:
    """Cancel all active tasks in model client."""
```

**Tasks Cancelled**:
- `model_client._current_streaming_task`
- `model_client._current_request_task`

**Method**: `task.cancel()` if task exists and not done

#### Stop UI Animations

```python
def _stop_all_ui_animations(self) -> None:
    """Stop all UI animations immediately."""
```

**Methods Called**:
- `ui.stop_thinking_animation()`
- `ui.stop_streaming_response()`
- `ui.animation.stop_animation()` (new architecture)
- Force stop `ui.active_live_display` (legacy)

#### Clear Input

```python
def _clear_input(self) -> None:
    """Clear user input buffer."""
```

**Flow**:
1. Call `ui.clear_input()` if available
2. Update state to `USER_INPUT_ACTIVE` with `has_content=False`

#### Request Exit

```python
def _request_exit(self) -> None:
    """Request graceful application exit (exception-based flow)."""
```

**Flow**:
1. Set `_exit_requested = True`
2. Try to stop event loop: `loop.call_soon_threadsafe(loop.stop)`
3. Clean up agent resources:
   - Stop UI animations
   - Cancel model client tasks

### Cancellation Events

```python
def get_cancellation_event_thread(self) -> threading.Event:
    """Get thread-safe cancellation event."""

async def get_cancellation_event_async(self) -> asyncio.Event:
    """Get async-safe cancellation event (created on first call)."""
```

**Usage**: Components wait on these events to detect cancellation

### State Management

```python
def set_state(self, state: ApplicationState, has_content: bool = False) -> None:
    """Update current application state."""

def reset_interrupt_state(self) -> None:
    """Reset interrupt state for new request."""
```

**Reset Actions**:
- Clear both cancellation events
- Reset `_processing_interrupt`, `_interrupt_pending`
- Reset `_rapid_interrupt_count`, `_exit_requested`
- Clear `model_client._interrupted`

### Rapid Interrupt Protection

```python
def _force_exit_immediate(self) -> None:
    """Force immediate exit due to rapid interrupts (last resort)."""
```

**Only `sys.exit()` Call in Signal Handler**:
```python
try:
    Console().print("\n[bold red]Force exiting due to rapid interrupts![/]")
except Exception:
    pass
sys.exit(1)
```

**Threshold**: 3 interrupts within 0.5 seconds = forced exit

### Global Singleton

```python
_coordinator: InterruptCoordinator | None = None

def get_interrupt_coordinator() -> InterruptCoordinator:
    """Get global interrupt coordinator instance."""
    global _coordinator
    if _coordinator is None:
        _coordinator = InterruptCoordinator()
    return _coordinator
```

---

## Token Manager

**File**: `token_manager.py`

### Responsibilities

- Token counting and estimation
- Context percentage calculation
- File content deduplication
- Content truncation
- Compaction urgency detection

### Initialization

```python
def __init__(self, context_size: int) -> None:
    """Initialize token manager."""
```

**Configuration**:
```python
self.context_size: int                         # Max context tokens
self.estimated_tokens: int = 0                 # Current usage
self.token_buffer_ratio: float = 0.90          # Auto-compact at 90%
self.tokens_per_message: int = 4               # Overhead per message
self.tokens_per_name: int = 1                  # Overhead for role
self.chars_per_token: float = 3.8              # Estimation ratio
self.last_compaction_time: float = 0           # Cooldown tracking
self.min_compaction_interval: int = 180        # 3 minutes
self.ui: Optional[UIManager] = None            # For verbose logging

# Tiktoken integration
self._tokenizer: Optional[tiktoken.Encoding] = None
self._file_content_hashes: dict[str, str] = {} # file_path -> content_hash
```

**Tiktoken Setup**:
```python
if TIKTOKEN_AVAILABLE:
    try:
        self._tokenizer = tiktoken.encoding_for_model("gpt-4")
        logger.info("Using tiktoken for accurate token counting")
    except Exception:
        logger.warning("Failed to initialize tiktoken, falling back to estimation")
else:
    logger.info("tiktoken not available, using character-based estimation")
```

### Token Estimation

```python
def estimate_tokens(self, messages: list[dict[str, Any]]) -> int:
    """Estimate token usage for list of messages."""
```

**Flow**:
1. Sum tokens for all messages (`_calculate_message_tokens`)
2. Return `max(1, int(token_count))`

#### Message Token Calculation

```python
def _calculate_message_tokens(self, message: dict[str, Any]) -> int:
    """Calculate tokens for single message."""
```

**Components**:
1. Base overhead: `tokens_per_message`
2. Role overhead: `tokens_per_name` if role present
3. Content: `_count_content_tokens(content)`
4. Function calls (legacy): `_calculate_function_call_tokens(function_call)`
5. Tool calls (modern): Sum of all tool call tokens

#### Content Token Counting

```python
def _count_content_tokens(self, content: str) -> int:
    """Count tokens in content using tiktoken or fallback estimation."""
```

**Methods**:
1. **Tiktoken** (if available):
   ```python
   return len(self._tokenizer.encode(content))
   ```
2. **Fallback Estimation**:
   ```python
   return max(1, int(len(content) / self.chars_per_token))
   ```

#### Function Call Tokens

```python
def _calculate_function_call_tokens(self, function_call: dict[str, Any]) -> int:
    """Calculate tokens for function call."""
```

**Components**:
1. Function name tokens
2. Arguments tokens:
   - String: count directly
   - Dict: `json.dumps(args)` then count

### File Content Deduplication

```python
def register_file_read(self, file_path: str, content: str) -> bool:
    """Register file read and check for content changes."""
```

**Behavior**:
1. Hash content: `hashlib.md5(content.encode("utf-8")).hexdigest()`
2. Compare to previous hash
3. Update stored hash
4. Return `True` if changed, `False` if unchanged

**Usage**: Tools can use this to avoid redundant file reads

```python
def deduplicate_file_content(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Remove duplicate file content, keeping only latest version of each file."""
```

**Flow**:
1. Find all file read messages (role="tool", name in ["read", "file_read"])
2. Extract file path from content (`_extract_file_path_from_content`)
3. Track indices for each file path
4. Identify messages to remove (all but last occurrence)
5. Create new list without duplicates
6. Log deduplication count

**Returns**: Deduplicated message list

### Token Management

```python
def update_token_count(self, messages: list[dict[str, Any]]) -> None:
    """Update token count for current messages."""
```

**Behavior**:
1. Store previous count
2. Estimate new count
3. If verbose and change >100 tokens:
   - Calculate percentage
   - Show diff: `[+/-]{change} tokens`
   - Display: `Token usage: {tokens} ({pct}% of context) [{change} tokens]`

```python
def get_token_percentage(self) -> int:
    """Get percentage of context window used."""
```

**Calculation**: `min(100, int(estimated_tokens / context_size * 100))`

### Compaction Logic

```python
def should_compact(self) -> bool:
    """Check if conversation should be compacted."""
```

**Conditions**:
1. Not within cooldown period (180 seconds)
2. Usage ratio > 90% (`token_buffer_ratio`)

```python
def get_compaction_urgency(self) -> tuple[str, str]:
    """Get urgency level and reason for compaction."""
```

**Levels**:
```python
if usage_ratio > 0.95:
    return ("critical", f"Context at {ratio:.1%} - immediate compaction needed")
elif usage_ratio > 0.90:
    return ("high", f"Context at {ratio:.1%} - compaction recommended soon")
elif usage_ratio > 0.85:
    return ("medium", f"Context at {ratio:.1%} - approaching limit")
elif usage_ratio > 0.70:
    return ("low", f"Context at {ratio:.1%} - consider compaction")
else:
    return ("none", f"Context at {ratio:.1%} - no compaction needed")
```

```python
def mark_compaction_completed(self) -> None:
    """Mark that compaction has been completed."""
```

**Behavior**: Update `last_compaction_time = time.time()`

### Content Truncation

```python
def truncate_content_to_tokens(self, content: str, max_tokens: int) -> str:
    """Truncate content to fit within specified token limit."""
```

**Algorithm**:
1. Quick check if already under limit
2. Calculate character limit: `max_tokens * chars_per_token`
3. Truncate to character limit with "..."
4. Verify token count after truncation
5. If still over, remove more characters iteratively
6. Minimum content: 10 characters + "..."

**Returns**: Truncated content with "..." suffix

---

## Supporting Components

### Conversation Manager

**File**: `conversation_manager.py`

#### Responsibilities

- Main conversation loop
- User input handling
- Context management before input
- Bash mode (! prefix)
- Conversation reset/editing
- Special command routing

#### Main Loop

```python
async def run_conversation_loop(self) -> None:
    """Run interactive conversation loop."""
```

**Flow**:
1. Show startup banner with model name
2. Show help text
3. Infinite loop:
   - Manage context before input (`_manage_context_before_input`)
   - Get and validate user input (`_get_and_validate_user_input`)
   - Route special commands (`_route_special_commands`)
   - Prepare user message (`_prepare_user_message`)
   - Process user message (`_process_user_message`)

#### Context Management

```python
async def _manage_context_before_input(self) -> None:
    """Handle context deduplication, warnings, and auto-compaction before user input."""
```

**Flow**:
1. **Deduplication** (if context >80%):
   - `messages = token_manager.deduplicate_file_content(messages)`
   - Update tokens and auto-save
   - Show verbose message if duplicates removed

2. **Compaction Warnings**:
   - Get urgency from `token_manager.get_compaction_urgency()`
   - If "high" or "critical": show warning
   - If "critical": `ui.print_error`
   - If "high": `ui.print_warning`

3. **Auto-Compaction** (if `should_compact()`):
   - Store old percentage
   - Show urgency-based message
   - Compact: `messages = command_handler.compact_conversation(messages)`
   - Update tokens
   - Show completion with tokens saved

#### User Input Handling

```python
async def _get_and_validate_user_input(self) -> Optional[str]:
    """Get user input and handle EOFError, empty input, and reset commands."""
```

**Flow**:
1. Set application state to `USER_INPUT_ACTIVE`
2. Get input: `await ui.get_user_input()`
3. Set state to `IDLE`
4. Handle EOFError: return "EOF"
5. Skip empty input: return None
6. Handle conversation reset with edit:
   - Format: `__RESET_TO_INDEX_{index}__CONTENT__{content}__`
   - Parse index and content
   - Reset conversation to index (`_reset_conversation_to_index`)
   - Remove selected prompt from messages
   - Prompt for edit with pre-filled content
   - Return edited input

**Returns**: User input, None (empty), or "EOF" (end)

#### Special Command Routing

```python
async def _route_special_commands(self, user_input: str) -> Tuple[bool, bool]:
    """Handle slash commands, bash mode, and @ prefix."""
```

**Routes**:

1. **Slash Commands** (`/cmd [arg]`):
   - Split into command and argument
   - Call `command_handler.handle_command(cmd, arg, messages)`
   - Update tokens and auto-save
   - Return `(True, True)` if handled

2. **Bash Mode** (`!command`):
   - Extract command without `!`
   - Call `_handle_bash_mode(bash_command)`
   - Return `(True, True)` if handled

3. **Agent Prefix** (`@`):
   - No special handling (let Ally handle naturally)
   - Pass through to normal processing

**Returns**: `(handled, continue)` - both booleans

#### Bash Mode

```python
async def _handle_bash_mode(self, bash_command: str) -> None:
    """Handle bash mode execution with ! prefix."""
```

**Flow**:
1. Add user message with command (without `!`)
2. Get bash tool from `tool_manager.tools.get("bash")`
3. Execute: `result = bash_tool.execute(command=bash_command, description=f"Execute: {bash_command}")`
4. Format response based on success/error
5. Add assistant response to messages
6. Display result to user (if non-empty)
7. Update tokens and auto-save

#### Message Processing

```python
async def _process_user_message(self, user_input: str) -> None:
    """Process user message through full conversation pipeline."""
```

**Flow**:
1. Append user message
2. Add initial context status (if first message)
3. Update tokens and auto-save
4. Start thinking animation
5. Show verbose request info (message count, tokens, functions)
6. Clear current turn tool calls and suggestions
7. Set `request_in_progress = True`
8. Reset interrupt state
9. Set application state to `MODEL_REQUEST_ACTIVE`
10. **Refresh system prompt** (latest ALLY.md)
11. Send request:
    ```python
    response = await model_client.send(
        messages,
        functions=tool_manager.get_function_definitions(),
        stream=True,
    )
    ```
12. Check for interruption
13. Finally: reset `request_in_progress`
14. If interrupted: stop animation and return
15. Check response for interruption markers
16. Log verbose response info
17. Stop thinking animation
18. Process LLM response

#### Conversation Reset

```python
def _reset_conversation_to_index(self, message_index: int) -> None:
    """Reset conversation to specific message index (inclusive)."""
```

**Flow**:
1. Store original messages for rollback
2. Validate bounds
3. Validate it's a user message
4. Validate tool call boundaries (`_validate_reset_boundary`)
5. Keep messages up to and including selected index
6. Update tokens and auto-save
7. Show feedback with preview and removed count

```python
def _validate_reset_boundary(self, target_index: int) -> tuple[bool, str]:
    """Validate that reset point doesn't break tool call sequences."""
```

**Check**: Ensure no tool result after reset point belongs to assistant message before reset point

**Returns**: `(is_valid, error_message)`

### Session Manager

**File**: `session_manager.py`

#### Responsibilities

- Auto-save conversation to session files
- Skip for non-interactive agents

#### Auto-Save

```python
def auto_save_session(self) -> None:
    """Auto-save current conversation to active session."""
```

**Flow**:
1. Skip if `non_interactive`
2. Get session_manager from service registry
3. Get current session name
4. Filter out system messages (avoid duplication)
5. Skip if no conversation messages
6. Create session if doesn't exist
7. Save session: `session_manager.save_session(name, messages)`
8. Log success in verbose mode, log failures at warning level

**Error Handling**: Graceful - auto-save failures don't disrupt conversation

### Tool Result Manager

**File**: `tool_result_manager.py`

#### Responsibilities

- Context-aware truncation of tool results
- Tool call estimation
- Context status messages
- Tool usage statistics

#### Configuration

```python
TRUNCATION_LEVELS = {
    "normal": (0, 70),       # 0-70% context
    "moderate": (70, 85),    # 70-85% context
    "aggressive": (85, 95),  # 85-95% context
    "critical": (95, 100)    # 95%+ context
}

MAX_RESULT_TOKENS = {
    "normal": 1000,
    "moderate": 750,
    "aggressive": 500,
    "critical": 200
}

DEFAULT_TOOL_SIZES = {
    "bash": 400,
    "read": 800,
    "glob": 300,
    "grep": 600,
    "write": 100,
    "edit": 200,
    "default": 400
}
```

**Initialization**:
```python
def __init__(self, token_manager, config_manager=None):
    """Initialize with configurable limits."""
```

Loads from config:
- `tool_result_max_tokens_normal`
- `tool_result_max_tokens_moderate`
- `tool_result_max_tokens_aggressive`
- `tool_result_max_tokens_critical`

#### Tool Result Processing

```python
def process_tool_result(self, tool_name: str, raw_result: str) -> str:
    """Process tool result with context-aware truncation."""
```

**Flow**:
1. Get context percentage
2. Determine truncation level (`_get_truncation_level`)
3. Get max tokens for level
4. Count actual tokens
5. Update tool usage statistics (`_update_tool_stats`)
6. If under limit: return unchanged
7. Reserve tokens for notice
8. Truncate content: `token_manager.truncate_content_to_tokens(raw_result, content_tokens)`
9. Append notice:
   - Critical: `[Result truncated due to critical context usage]`
   - Aggressive: `[Result truncated due to high context usage]`
   - Other: `[Result truncated due to context limits]`

**Returns**: Processed (potentially truncated) result

#### Tool Call Estimation

```python
def estimate_remaining_tool_calls(self) -> int:
    """Estimate how many tool calls can still be made."""
```

**Algorithm**:
1. Calculate remaining context budget: `total - used - (10% buffer)`
2. Get average tool size (from statistics or defaults)
3. Estimate: `remaining_tokens / avg_tool_size`
4. Cap at 50 for reasonable display

#### Context Status Messages

```python
def get_context_status_message(self) -> str:
    """Generate context status message with guidance."""
```

**Critical (95%+)**:
```
🚨 CRITICAL: {pct}% context used | {remaining} tools remaining
⛔ STOP TOOL USE NOW. You MUST:
   1. Summarize work completed so far
   2. Conclude your response immediately
   3. Do NOT make additional tool calls
Further tool calls will likely be BLOCKED due to context overflow.
```

**Aggressive (85-95%)**:
```
⚠️ WARNING: {pct}% context used | ~{remaining} tools remaining
⚠️ Context approaching limits. You should:
   1. Complete ONLY your current task
   2. Avoid starting new investigations
   3. Provide a summary soon
Tool results are heavily truncated ({max_tokens} tokens max).
```

**Moderate (70-85%)**:
```
💡 Notice: {pct}% context used | ~{remaining} tools remaining
💡 Context filling up. Consider:
   1. Prioritizing essential operations
   2. Wrapping up non-critical work
Tool results now limited to {max_tokens} tokens.
```

**Normal (<70%)**:
```
✅ {pct}% context used | ~{remaining} tools available | Normal operation
```

#### Statistics Tracking

```python
def _update_tool_stats(self, tool_name: str, result_tokens: int) -> None:
    """Update tool usage statistics."""
```

**Tracked Metrics**:
- `call_count`: Number of times tool called
- `total_tokens`: Cumulative tokens from results

**Reset Logic**: If `call_count > 100`, reset to recent average (prevent overflow)

### Factories

**File**: `factories.py`

#### Responsibilities

- Context-aware component creation
- Agent delegation support
- Tool filtering
- Trust manager configuration
- UI manager delegation

#### Tool Filter Factory

```python
class ToolFilterFactory:
    @staticmethod
    def get_available_tools(tool_manager: Any) -> list[Any]:
        """Get tools appropriate for current execution context."""
```

**Behavior**:
- Get execution context
- Filter tools based on context
- Exclude "agent" tool if `is_in_agent_delegation` (prevent recursion)

#### Trust Manager Factory

```python
class TrustManagerFactory:
    @staticmethod
    def create_for_delegation(parent_trust_manager: Optional[TrustManager]) -> Optional[TrustManager]:
        """Create trust manager configured for agent delegation."""

    @staticmethod
    def configure_for_delegation(sub_agent_trust: TrustManager, parent_trust: TrustManager) -> None:
        """Configure sub-agent's trust manager for delegation."""
```

**Configuration**:
- Inherit `auto_confirm` from parent (don't force)
- Copy `trusted_tools` from parent
- Copy `pre_approved_operations` from parent
- Add safe delegation operations: `["read", "list", "search", "analyze", "explore", "find"]`

#### UI Manager Factory

```python
class UIManagerFactory:
    @staticmethod
    def create_for_delegation(original_ui_manager: Any) -> Any:
        """Create UI manager appropriate for agent delegation."""
```

**Behavior**:
- Check execution context
- If in delegation: return `DelegationUIManager`
- Else: return original

#### Delegation UI Manager

```python
class DelegationUIManager:
    """UI manager that provides appropriate output for agent delegation context."""
```

**Suppressed Methods** (no output):
```python
_SUPPRESSED_METHODS = {
    'print_content', 'print_assistant_response', 'print_markdown', 'print_success',
    'print_error', 'print_tool_result', 'print', 'print_info', 'print_debug',
    'display_error', 'handle_error', 'show_error',
    'start_thinking_animation', 'stop_thinking_animation', 'start_streaming_animation',
    'stop_streaming_animation', 'start_tagline_status', 'stop_tagline_status',
    'update_tagline_status', 'pause_tagline_status', 'resume_tagline_status'
}
```

**Safe Delegated Methods** (pass-through):
```python
_SAFE_DELEGATED_METHODS = {
    'display_console', 'verbose', '_format_tool_arguments', 'confirm',
    'get_user_input', 'set_verbose'
}
```

**Special Methods**:

- `print_tool_call`: Show with delegation indentation (`"     "`)
- `print_warning`: Show with delegation indentation
- `print_tool_result_preview`: Show with delegation indentation (use tool-specific preview)

**__getattr__ Logic**:
1. If in `_SUPPRESSED_METHODS`: return no-op lambda
2. If in `_SAFE_DELEGATED_METHODS`: delegate to original UI
3. Else: return no-op lambda (safe default)

#### Agent Factory

```python
class AgentFactory:
    @staticmethod
    def get_delegation_config() -> dict[str, Any]:
        """Get agent configuration appropriate for delegation context."""
```

**Delegation Config**:
```python
{
    "verbose": False,
    "check_context_msg": False,
    "non_interactive": True,
}
```

**Main Agent Config**:
```python
{
    "verbose": True,
    "check_context_msg": True,
    "non_interactive": False,
}
```

### Execution Context

**File**: `execution_context.py`

#### Responsibilities

- Track agent delegation depth
- Context-aware behavior enablement
- Prevent recursive agent suggestions

#### Design

```python
class ExecutionContext:
    """Tracks current execution context for agent operations."""

    def __init__(self):
        self._agent_depth: contextvars.ContextVar[int] = contextvars.ContextVar('agent_depth', default=0)
```

**Using `contextvars`**: Provides proper isolation between concurrent coroutine contexts (parallel agent execution)

**Properties**:
```python
@property
def agent_depth(self) -> int:
    """Get current agent delegation depth (0 for main, 1+ for delegated)."""

@property
def is_in_agent_delegation(self) -> bool:
    """Check if currently executing within delegated agent."""
```

**Methods**:
```python
def enter_agent_delegation(self) -> None:
    """Enter agent delegation context (increment depth)."""

def exit_agent_delegation(self) -> None:
    """Exit agent delegation context (decrement depth)."""
```

**Error Handling**: Exit with error recovery (reset to 0 if corrupted)

**Global Instance**:
```python
execution_context = ExecutionContext()

def get_execution_context() -> ExecutionContext:
    """Get global execution context instance."""
    return execution_context
```

### Thinking Manager

**File**: `thinking.py`

#### Responsibilities

- Detect thinking-capable models
- Parse thinking tags from responses
- Support native and embedded thinking

#### Classes

```python
@dataclass
class ThinkingResponse:
    """Parsed response from thinking model."""
    thinking: str | None
    content: str
```

```python
class ThinkingModelDetector:
    """Detects thinking-capable models."""

    THINKING_PATTERNS = [
        re.compile(r"<think>\s*(.*?)\s*</think>\s*(.*)", re.DOTALL | re.IGNORECASE),
        re.compile(r"<thinking>\s*(.*?)\s*</thinking>\s*(.*)", re.DOTALL | re.IGNORECASE),
    ]
```

```python
class ThinkingResponseParser:
    """Parses thinking content from model responses."""
```

**Parse Algorithm**:
1. Try all thinking patterns
2. If match: extract thinking and content groups
3. Return `ThinkingResponse(thinking=..., content=...)`
4. If no match: return `ThinkingResponse(thinking=None, content=original)`

```python
class ThinkingModelManager:
    """Manages thinking model capabilities."""

    def has_thinking_content(self, content: str) -> bool
    def parse_response(self, content: str) -> ThinkingResponse
```

### Tool Manager

**File**: `tool_manager.py`

#### Responsibilities

- Tool registration and registry
- Function definition generation
- Tool validation
- Tool execution coordination
- Permission checking
- File read requirement validation
- Redundancy detection
- Performance tracking

#### Initialization

```python
def __init__(
    self,
    tools: list[BaseTool],
    trust_manager: TrustManager,
    permission_manager: PermissionManager = None,
) -> None:
```

**State**:
```python
self.tools: dict[str, BaseTool]              # name -> tool
self.trust_manager: TrustManager
self.permission_manager: PermissionManager
self._ui: Optional[UIManager]                 # Set by Agent
self.client_type: Optional[str]               # Set by Agent

# Redundancy tracking
self.recent_tool_calls: list[tuple[str, tuple]]
self.max_recent_calls: int = 5
self.current_turn_tool_calls: list[tuple[str, tuple]]

# Performance monitoring
self._tool_performance_stats: dict[str, dict[str, Any]]

# File tracking
self._read_files: dict[str, float]            # file_path -> read_timestamp
```

#### Function Definitions

```python
def get_function_definitions(self) -> list[dict[str, Any]]:
    """Create function definitions for tools in LLM format."""
```

**Flow**:
1. For each tool:
   - Check if tool has custom `get_function_definition()` method
   - If yes: use custom definition
   - Else: generate default with `_generate_dynamic_parameters`
2. Log token estimate in verbose mode

**Default Format**:
```python
{
    "type": "function",
    "function": {
        "name": tool.name,
        "description": tool.description,
        "parameters": parameters_schema,
    },
}
```

#### Parameter Schema Generation

```python
def _generate_dynamic_parameters(self, tool: BaseTool) -> dict[str, Any]:
    """Generate parameter schema dynamically with improved descriptions."""
```

**Algorithm**:
1. Inspect `tool.execute` signature
2. For each parameter (skip `self`, `kwargs`):
   - Determine type from annotation (int, bool, list, float, string)
   - Get description from map or format parameter name
   - Add to properties
   - Add to required if no default value
3. Return schema:
   ```python
   {
       "type": "object",
       "properties": {...},
       "required": [...]
   }
   ```

**Description Map** (concise for model clarity):
```python
{
    "file_path": "File path",
    "path": "Directory to search",
    "content": "Content to write",
    "command": "Shell command",
    "pattern": "Search pattern (regex)",
    "old_string": "Text to replace",
    "new_string": "Replacement text",
    # ... etc
}
```

#### Tool Validation

```python
def _validate_tool_arguments(
    self,
    tool: BaseTool,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    """Lightweight validation with enhanced error messages."""
```

**Flow**:
1. Skip if mocked method
2. Inspect signature
3. For each parameter:
   - Check if required (no default) and missing
   - If missing: create helpful error with example
4. Return `{"valid": True/False, "error": "...", "error_type": "validation_error", "suggestion": "..."}`

**Error Format**:
```python
{
    "valid": False,
    "error": f"Missing required parameter '{param_name}' for {tool_name}",
    "error_type": "validation_error",
    "suggestion": f"Example: {tool_name}({param_name}=\"{example}\")",
}
```

#### Tool Execution

```python
async def execute_tool(
    self,
    tool_name: str,
    arguments: dict[str, Any],
    check_context_msg: bool = True,
    client_type: str | None = None,
    pre_approved: bool = False,
) -> dict[str, Any]:
    """Execute tool with arguments after checking trust."""
```

**Flow**:
1. Verbose log: starting execution
2. **Validate tool existence** (`_is_valid_tool`)
3. **Check redundancy** (`_is_redundant_call`)
4. **Record call** (`_record_tool_call`)
5. **Validate arguments** (`_validate_tool_arguments`) - return error if invalid
6. **Validate file read requirement** (for write/edit tools) - return error if not read
7. **Show preview** (for write/edit tools) - before permission prompt
8. **Check outside CWD** (`_is_accessing_outside_cwd`) - only for destructive tools
9. **Check permissions** (if not pre-approved and tool requires confirmation):
   - Get permission path
   - Add `outside_cwd` flag if applicable
   - Check trust: `trust_manager.is_trusted(tool_name, permission_path)`
   - Prompt if not trusted: `trust_manager.prompt_for_permission(tool_name, permission_path)`
   - Raise `PermissionDeniedError` if denied
10. **Execute tool** (`_perform_tool_execution`)
11. **Track file operation** (`_track_file_operation`)
12. **Inject pattern suggestions** (`_inject_pattern_suggestions`)
13. Return result

#### File Read Validation

```python
def _validate_file_read_requirement(self, file_path: str) -> dict[str, Any] | None:
    """Validate that file has been read before modification."""
```

**Checks**:
1. Resolve path (focus-aware)
2. If file doesn't exist: pass (new file)
3. If file not in `_read_files`: return error
4. If file modified since read (check mtime): return error
5. Else: pass (None)

**Error Format**:
```python
{
    "valid": False,
    "error": "File exists but has not been read in this session. Use Read tool first...",
    "error_type": "validation_error",
    "suggestion": "Use the Read tool to examine the file content before making changes",
}
```

#### File Operation Tracking

```python
def _track_file_operation(
    self,
    tool_name: str,
    arguments: dict[str, Any],
    result: dict[str, Any],
) -> None:
    """Track file operations for read-before-write validation."""
```

**Behavior**:
- **Read tool**: Track all `file_paths` with current timestamp
- **Write/Edit tools**: Update timestamp (model has current version)
- Uses focus-aware path resolution

#### Tool Performance Execution

```python
async def _perform_tool_execution(
    self,
    tool_name: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    """Execute tool with given arguments."""
```

**Flow**:
1. Get tool instance
2. Extract description from arguments (if available)
3. **Start execution animation** (if not suppressed by tool)
4. Verbose log: executing
5. Check if `tool.execute` is async:
   - Async: `await tool.execute(**arguments)`
   - Sync: `tool.execute(**arguments)`
6. **Stop execution animation** (if was started)
7. Calculate execution time
8. Record performance (`_record_tool_performance`)
9. Verbose log: completion time and success
10. Return result
11. On error: stop animation, log error, return error result

#### Performance Tracking

```python
def _record_tool_performance(
    self,
    tool_name: str,
    execution_time: float,
    success: bool,
    arguments: dict[str, Any],
) -> None:
    """Record performance metrics for tool execution."""
```

**Metrics**:
```python
{
    "total_calls": int,
    "successful_calls": int,
    "total_time": float,
    "avg_time": float,
    "min_time": float,
    "max_time": float,
    "success_rate": float,
}
```

#### Redundancy Detection

```python
def _is_redundant_call(self, tool_name: str, arguments: dict[str, Any]) -> bool:
    """Check if tool call is redundant (only current conversation turn)."""
```

**Algorithm**:
1. Create hashable representation: `(tool_name, tuple(sorted(arguments.items())))`
2. Check if in `current_turn_tool_calls`

**Note**: Only current turn matters (not across turns)

#### Pattern Suggestions

```python
def _inject_pattern_suggestions(
    self,
    tool_name: str,
    arguments: dict[str, Any],
    result: dict[str, Any]
) -> None:
    """Inject usage pattern suggestions into tool result if patterns detected."""
```

**Flow**:
1. Get `usage_pattern_analyzer` from service registry
2. Analyze current turn: `pattern_analyzer.analyze_turn_patterns(current_turn_tool_calls)`
3. For each suggestion:
   - Check if not already injected this turn
   - Inject into result: `result['suggestion'] = suggestion.message`
   - Mark pattern type as injected
4. Log for debugging

**Deduplication**: Use `_suggestions_injected_this_turn` set

```python
def clear_turn_suggestions(self) -> None:
    """Clear turn-specific suggestion tracking."""
```

Called at start of each new turn

---

## Data Flow Diagrams

### Conversation Flow

```
User Input
    ↓
ConversationManager._get_and_validate_user_input()
    ↓
ConversationManager._route_special_commands()
    ├─→ Slash Command → CommandHandler.handle_command()
    ├─→ Bash Mode (!cmd) → _handle_bash_mode()
    └─→ Normal Input
            ↓
ConversationManager._process_user_message()
    ↓
1. Append user message
2. Add context status if first message
3. Update tokens & auto-save
4. Start thinking animation
5. Reset interrupt state
6. Refresh system prompt
7. Send to LLM
    ↓
ModelClient.send(messages, functions, stream=True)
    ↓
Response
    ↓
ResponseProcessor.process_llm_response(response)
    ├─→ Tool Calls → _process_tool_response()
    │        ↓
    │   ToolOrchestrator.execute_tool_calls()
    │        ├─→ Concurrent → _process_concurrent_tool_calls()
    │        └─→ Sequential → _process_sequential_tool_calls()
    │                ↓
    │   ToolManager.execute_tool() for each call
    │        ↓
    │   Tool Result Processing
    │        ↓
    │   Follow-up Request → ModelClient.send()
    │        ↓
    │   Recursive process_llm_response()
    │
    └─→ Text Response → _process_text_response()
             ↓
        UI.print_assistant_response()
```

### Tool Execution Flow

```
ToolOrchestrator.execute_tool_calls(tool_calls)
    ↓
_check_context_before_execution()
    ├─→ Context ≥95% → Block execution, return
    └─→ Context <95% → Proceed
        ↓
_can_run_concurrently() → Determine execution mode
    ↓
    ├─────────────────────────────┬─────────────────────────────┐
    ↓                             ↓                             ↓
CONCURRENT                    SEQUENTIAL                    SINGLE TOOL
    ↓                             ↓                             ↓
_process_concurrent_          _process_sequential_          _execute_single_tool()
tool_calls()                  tool_calls()                      ↓
    ↓                             ↓                         ToolManager.execute_tool()
Create async tasks               ↓                             ↓
    ↓                         _handle_batch_                1. Validate tool exists
asyncio.gather(*tasks)        permissions()                 2. Check redundancy
    ↓                             ↓                         3. Validate arguments
Each task:                    For each tool:                4. Validate file read req
_execute_single_tool()            ↓                         5. Show preview
    ↓                         _execute_single_tool()        6. Check permissions
    ↓                             ↓                         7. Execute tool
    ↓                         _process_tool_result()        8. Track file operation
    └─→ _process_tool_result()    ↓                         9. Inject suggestions
            ↓                 _monitor_context_              ↓
    1. Format result          during_execution()            Return result
    2. Truncate if needed         ↓
    3. Add to messages        Repeat for next tool
    4. Display agent content
    5. Add context status
```

### Interrupt Handling Flow

```
User presses Ctrl+C
    ↓
Signal.SIGINT received
    ↓
InterruptCoordinator._signal_handler()
    ↓
1. Check for rapid interrupts
2. Update counters
3. Set _interrupt_pending = True
4. Schedule deferred processing
    ↓
    ├─────────────────────┬─────────────────────┐
    ↓                     ↓                     ↓
Event Loop Running    No Event Loop       Rapid Interrupts
    ↓                     ↓                     ↓
loop.call_soon_       _process_interrupt_   _force_exit_
threadsafe()          minimal()             immediate()
    ↓                     ↓                     ↓
_process_interrupt_   Minimal actions       sys.exit(1)
deferred()                ↓
    ↓                 Set flags only
Acquire lock              ↓
    ↓                 Return
_determine_action()
    ↓
    ├───────────────────┬──────────────────┬──────────────────┐
    ↓                   ↓                  ↓                  ↓
MODEL_REQUEST      TOOL_EXECUTION    USER_INPUT       IDLE
or TOOL_EXECUTION      ↓              (with content)       ↓
    ↓                  ↓                  ↓              EXIT_APPLICATION
CANCEL_REQUEST     CANCEL_REQUEST   CLEAR_INPUT
    ↓
_execute_action()
    ↓
    ├──────────────────┬────────────────┬────────────────┐
    ↓                  ↓                ↓                ↓
_cancel_model_     _clear_input()  _request_exit()  NO_ACTION
request()
    ↓
1. Mask signals
2. Set cancellation events
3. Cancel tasks
4. Stop animations
5. Set state to IDLE
6. Restore signal mask
```

### Context-Aware Tool Result Truncation

```
Tool Execution Complete
    ↓
ToolOrchestrator._process_tool_result()
    ↓
ResponseProcessor.format_tool_result_as_natural_language()
    ↓
ToolResultManager.process_tool_result(tool_name, raw_result)
    ↓
1. Get context percentage
2. Determine truncation level
    ├─→ 0-70%: normal (1000 tokens max)
    ├─→ 70-85%: moderate (750 tokens max)
    ├─→ 85-95%: aggressive (500 tokens max)
    └─→ 95%+: critical (200 tokens max)
        ↓
3. Count actual result tokens
4. Update tool statistics
5. If under limit → return unchanged
6. If over limit:
    ↓
    a. Reserve tokens for notice
    b. Truncate content via TokenManager
    c. Append truncation notice
        ↓
Return processed result
    ↓
ToolOrchestrator._add_tool_result_with_update()
    ↓
Add to messages with tool_call_id
    ↓
ToolOrchestrator._add_context_status_with_update()
    ↓
1. Determine if status changed
2. Add status message if changed
3. Always update token count
```

### Agent Delegation Flow

```
Agent tool call requested
    ↓
AgentTool.execute()
    ↓
1. Get execution context
2. Enter agent delegation
    ↓
execution_context.enter_agent_delegation()
    ↓
Create sub-agent
    ├─→ Use DelegationUIManager (suppressed output)
    ├─→ Configure trust manager (inherit parent)
    ├─→ Filter tools (exclude "agent" to prevent recursion)
    ├─→ Set non_interactive=True
    └─→ Set is_specialized_agent=True
        ↓
Sub-agent.run_single_message(task_prompt)
    ↓
Process message
    ├─→ Tool calls → execute with delegation UI
    ├─→ No animation display to main user
    └─→ Content accumulated for LLM context
        ↓
Return result
    ↓
Exit agent delegation
    ↓
execution_context.exit_agent_delegation()
    ↓
Format result for main agent
    ↓
Display completion status only
    ├─→ [cyan]→ {agent_name}[/] [dim]({task})[/]
    └─→ [green]Complete[/] [dim]({duration}s)[/]
        ↓
Add full result to main agent's messages
(Main agent summarizes result in follow-up response)
```

---

## State Machines

### Application State Machine

```
States:
- IDLE: No active operations
- USER_INPUT_ACTIVE: Waiting for/processing user input
- MODEL_REQUEST_ACTIVE: LLM request in progress
- TOOL_EXECUTION_ACTIVE: Tools being executed

Transitions:
IDLE → USER_INPUT_ACTIVE
    Trigger: ui.get_user_input() called

USER_INPUT_ACTIVE → IDLE
    Trigger: Input received or cancelled

IDLE → MODEL_REQUEST_ACTIVE
    Trigger: model_client.send() called

MODEL_REQUEST_ACTIVE → TOOL_EXECUTION_ACTIVE
    Trigger: Tool calls detected in response

TOOL_EXECUTION_ACTIVE → MODEL_REQUEST_ACTIVE
    Trigger: Tools complete, follow-up request sent

MODEL_REQUEST_ACTIVE → IDLE
    Trigger: Text response received (no tools)

TOOL_EXECUTION_ACTIVE → IDLE
    Trigger: Permission denied, error, or interruption

Any State → IDLE
    Trigger: Interrupt signal with appropriate action
```

### Tool Execution State Machine

```
States:
- IDLE: No tool execution
- VALIDATING: Checking tool and arguments
- REQUESTING_PERMISSION: Awaiting user permission
- EXECUTING: Tool running
- PROCESSING_RESULT: Formatting and adding result
- COMPLETED: Execution finished
- FAILED: Error occurred

Transitions:
IDLE → VALIDATING
    Trigger: execute_tool() called

VALIDATING → REQUESTING_PERMISSION
    Trigger: Validation passed, tool requires confirmation

VALIDATING → EXECUTING
    Trigger: Validation passed, no permission needed

VALIDATING → FAILED
    Trigger: Validation failed

REQUESTING_PERMISSION → EXECUTING
    Trigger: Permission granted

REQUESTING_PERMISSION → FAILED
    Trigger: Permission denied

EXECUTING → PROCESSING_RESULT
    Trigger: Tool completed successfully

EXECUTING → FAILED
    Trigger: Tool raised exception

PROCESSING_RESULT → COMPLETED
    Trigger: Result processed and added to messages

FAILED → COMPLETED
    Trigger: Error result added to messages
```

### Context Truncation State Machine

```
States:
- NORMAL: 0-70% context used (1000 tokens max)
- MODERATE: 70-85% context used (750 tokens max)
- AGGRESSIVE: 85-95% context used (500 tokens max)
- CRITICAL: 95%+ context used (200 tokens max)

Transitions:
ANY → NORMAL
    Trigger: Context drops below 70%
    Effect: Full tool results

NORMAL → MODERATE
    Trigger: Context exceeds 70%
    Effect: Status message, moderate truncation

MODERATE → AGGRESSIVE
    Trigger: Context exceeds 85%
    Effect: Warning status, aggressive truncation

AGGRESSIVE → CRITICAL
    Trigger: Context exceeds 95%
    Effect: Critical warning, minimal results

CRITICAL → EXECUTION_BLOCKED
    Trigger: Context reaches 95% during tool execution check
    Effect: Block further tool calls, force summary

Note: Only forward transitions shown (backward possible via compaction)
```

### Session State Machine

```
States:
- NO_SESSION: Session not active
- SESSION_ACTIVE: Session loaded and active
- SAVING: Auto-save in progress
- SAVED: Auto-save completed

Transitions:
NO_SESSION → SESSION_ACTIVE
    Trigger: Session loaded or created

SESSION_ACTIVE → SAVING
    Trigger: Message added, token count updated

SAVING → SAVED
    Trigger: Session saved successfully

SAVING → SESSION_ACTIVE
    Trigger: Save failed (graceful error handling)

SAVED → SAVING
    Trigger: Next message or update
```

---

## Configuration Points

### Agent Configuration

```python
# Basic setup
model_client: ModelClient              # Required: LLM client
tools: list[Any]                       # Required: Tool instances
client_type: str = "ollama"            # Format type
verbose: bool = False                  # Verbose logging
check_context_msg: bool = True         # Context reminders
non_interactive: bool = False          # Single-message mode
is_specialized_agent: bool = False     # Agent delegation flag

# Component configuration
context_size: int                      # From model_client (default: 16384)
system_prompt: str | None              # Optional custom prompt
service_registry: ServiceRegistry      # Optional (creates if not provided)
```

### Token Manager Configuration

```python
context_size: int                      # Max context tokens
token_buffer_ratio: float = 0.90       # Auto-compact threshold
tokens_per_message: int = 4            # Message overhead
tokens_per_name: int = 1               # Role overhead
chars_per_token: float = 3.8           # Estimation ratio
min_compaction_interval: int = 180     # Cooldown seconds
```

### Tool Result Manager Configuration

```python
# Truncation levels (context percentage ranges)
TRUNCATION_LEVELS = {
    "normal": (0, 70),
    "moderate": (70, 85),
    "aggressive": (85, 95),
    "critical": (95, 100)
}

# Maximum tokens per truncation level (configurable via config)
tool_result_max_tokens_normal: int = 1000
tool_result_max_tokens_moderate: int = 750
tool_result_max_tokens_aggressive: int = 500
tool_result_max_tokens_critical: int = 200

# Tool size estimates (tokens)
DEFAULT_TOOL_SIZES = {
    "bash": 400,
    "read": 800,
    "glob": 300,
    "grep": 600,
    "write": 100,
    "edit": 200,
    "default": 400
}
```

### Interrupt Coordinator Configuration

```python
_interrupt_debounce_seconds: float = 0.5     # Rapid interrupt detection
_rapid_interrupt_threshold: int = 3          # Force exit threshold
```

### Diff Display Configuration

```python
diff_display_enabled: bool = True
diff_display_max_file_size: int = 102400    # 100KB
diff_display_context_lines: int = 3
diff_display_theme: str = "auto"
diff_display_color_removed: str = "on rgb(60,25,25)"
diff_display_color_added: str = "on rgb(25,60,25)"
diff_display_color_modified: str = "on rgb(60,60,25)"
```

### Tool Manager Configuration

```python
max_recent_calls: int = 5                    # Redundancy tracking size
```

### Delegation Configuration

```python
# From AgentFactory.get_delegation_config()
delegation_config = {
    "verbose": False,
    "check_context_msg": False,
    "non_interactive": True,
}

# Trust configuration
delegation_safe_operations = [
    "read", "list", "search", "analyze", "explore", "find"
]
```

### Auto-ID Prefixes

```python
agent_auto_id_prefix: str = "auto-id"        # Auto-generated call IDs
agent_manual_id_prefix: str = "manual-id"    # Legacy single-call format
```

---

## Critical Implementation Notes

### Thread Safety

1. **Message List Protection**:
   ```python
   async with self.agent._messages_lock:
       self.agent.messages.append(message)
   ```

2. **Interrupt Coordinator State Lock**:
   ```python
   self._state_lock.acquire(timeout=1.0)
   ```
   Use `RLock` (reentrant) to allow same thread to re-acquire

3. **Cancellation Events**:
   - `threading.Event` for thread-safe cancellation
   - `asyncio.Event` for async-safe cancellation (created lazily)

### Signal Safety

1. **Minimal Signal Handler**:
   - Only atomic operations (no locks, I/O, logging)
   - Set flags and schedule deferred work
   - Use `loop.call_soon_threadsafe()` to schedule in event loop

2. **Signal Masking**:
   ```python
   old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT})
   try:
       # Critical section
   finally:
       signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
   ```

### Error Handling

1. **Graceful Degradation**:
   - Auto-save failures don't disrupt conversation
   - Diff display errors don't block operations
   - Pattern suggestion failures are silent

2. **Permission Errors**:
   - `PermissionDeniedError` propagates up
   - Abort entire tool execution sequence
   - Add interruption marker to messages

3. **Validation Errors**:
   - Return error dict with helpful suggestions
   - Attempt auto-retry for common fixes
   - Log for debugging but don't crash

### Context Awareness

1. **ExecutionContext** (via contextvars):
   - Properly isolated between concurrent coroutines
   - Prevents recursive agent suggestions
   - Enables delegation-specific behavior

2. **Context Monitoring**:
   - Check before tool execution
   - Monitor during sequential execution
   - Add status messages only when level changes
   - Block execution at 95%

3. **Progressive Truncation**:
   - Normal → Moderate → Aggressive → Critical
   - Configurable limits per level
   - Always add truncation notice

### Agent Delegation

1. **UI Suppression**:
   - `DelegationUIManager` suppresses output methods
   - Allows tool call display with indentation
   - Preserves warnings and permissions

2. **Trust Inheritance**:
   - Sub-agents inherit parent's auto_confirm
   - Copy trusted_tools and pre_approved_operations
   - Add safe delegation operations

3. **Tool Filtering**:
   - Exclude "agent" tool in delegations (prevent recursion)
   - All other tools available

4. **Result Display**:
   - Header printed BEFORE execution
   - Content NOT displayed to user (LLM context only)
   - Completion status shown: "Complete (Xs)"
   - Main agent summarizes in follow-up

### Streaming Modes

1. **Replace Streaming**:
   - Content streamed with thinking shown in real-time
   - Replace with clean formatted version
   - Skip thinking display (already shown)
   - Flag: `_should_replace_streaming=True`

2. **Non-Streaming**:
   - Regular response processing
   - Show content and thinking normally
   - Flag: `_content_was_streamed=False`

3. **Already Streamed**:
   - Content was displayed during streaming
   - Don't duplicate output
   - Neither flag set

### Token Update Timing

**Single Point of Update**: `ToolOrchestrator._add_context_status_with_update()`

**Flow**:
1. Add tool result (no token update)
2. Generate unhelpful suggestion (no token update)
3. Add context status if level changed (no token update)
4. **Single token update** at end (ensures consistency)

**Rationale**: Prevents multiple redundant token calculations per tool

### File Read Requirements

**Validation**:
- Write/edit tools require file to be read first (if file exists)
- Track read timestamps in `_read_files`
- Check if file modified since read (mtime comparison)
- New files don't require read

**Error Handling**:
- Clear error messages with suggestions
- Error type: `"validation_error"`
- Suggestion: "Use the Read tool to examine..."

### Auto-Retry Logic

**Corrections Attempted**:
1. Path validation (legacy, mostly unused)
2. Missing required parameters (e.g., `content=""` for write)
3. Non-unique string match (add `replace_all=True`)

**Returns**: Retry result or None

**Verbose Logging**: Each correction logged

---

## End of Documentation

This documentation covers the complete architecture of CodeAlly's core agent system, including all components, flows, state machines, and configuration points. It should provide sufficient detail for reimplementation in TypeScript while maintaining the same architectural patterns and behaviors.
