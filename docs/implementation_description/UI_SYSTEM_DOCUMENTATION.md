# CodeAlly UI System - Complete Documentation

**Document Version:** 1.0
**Date:** 2025-10-20
**Purpose:** Complete reference for reimplementing CodeAlly's UI system in React/Ink

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Core Components](#core-components)
3. [BaseUIManager](#baseuimanager)
4. [UIManager (Interactive)](#uimanager-interactive)
5. [NonInteractiveUIManager](#noninteractiveuimanager)
6. [AnimationManager](#animationmanager)
7. [DisplayManager](#displaymanager)
8. [InputManager](#inputmanager)
9. [DiffDisplay System](#diffdisplay-system)
10. [DelegationUIManager](#delegationuimanager)
11. [PromptHistorySelector](#prompthistoryselector)
12. [Rich Library Integration](#rich-library-integration)
13. [State Management](#state-management)
14. [User Interaction Flows](#user-interaction-flows)

---

## Architecture Overview

### Component Hierarchy

```
BaseUIManager (abstract base)
├── UIManager (interactive mode)
│   ├── AnimationManager (animations & spinners)
│   ├── DisplayManager (content rendering)
│   └── InputManager (user input & completion)
└── NonInteractiveUIManager (single-message mode)

DelegationUIManager (wrapper for sub-agents)
└── Wraps any UI manager with suppression logic

DiffDisplayManager (file change previews)
├── DiffFormatter (formatting logic)
├── DiffPreviewManager (preview operations)
└── DiffConfig (theme & configuration)

PromptHistorySelector (modal for history navigation)
```

### Design Principles

1. **Separation of Concerns**: Display, input, and animation are separate managers
2. **Lazy Loading**: Components initialize on-demand to avoid circular dependencies
3. **Context Awareness**: UI adapts based on execution context (interactive vs non-interactive, delegation depth)
4. **Animation Safety**: Animations always stop before display operations to prevent visual conflicts
5. **Rich Integration**: All UI components use Rich library for terminal rendering

---

## Core Components

### File Structure

```
code_ally/ui/
├── __init__.py              # Public API exports
├── base.py                  # BaseUIManager abstract class
├── ui_manager.py            # Interactive UIManager
├── non_interactive_ui_manager.py  # Single-message mode
├── animation_manager.py     # Animations & live displays
├── display_manager.py       # Content rendering
├── input_manager.py         # User input & completion
├── diff_display.py          # File diff rendering
├── diff_preview.py          # Diff preview operations
├── diff_formatter.py        # Diff formatting logic
├── diff_config.py           # Diff theme configuration
└── utils.py                 # Shared utilities
```

---

## BaseUIManager

**File:** `code_ally/ui/base.py`

### Purpose
Abstract base class providing shared functionality for all UI managers.

### Properties

```python
verbose: bool                           # Verbose mode flag
agent: Agent | None                     # Reference to agent
_suppress_top_level_assistant: bool     # Suppress assistant responses flag
```

### Methods

#### `__init__(self) -> None`
Initialize base UI manager with default values.

#### `set_top_level_suppression(self, enabled: bool) -> None`
Enable/disable suppression of top-level assistant responses (used during delegation).

#### `set_verbose(self, verbose: bool) -> None`
Set verbose mode flag.

#### `_extract_result_preview_content(self, result: dict | str) -> str`
Extract preview content from a tool result.

**Logic:**
- String results: Return stripped content
- Dict results with `success=True`:
  - Bash results: Return output or "Command completed (exit code: N)"
  - Check fields in order: `content`, `output`, `result`, `data`
  - File operations: Return summary like "Read N lines from path"
- Dict results with `success=False`:
  - Return "Error (exit code N): message" or "Error: message"

#### `_format_tool_arguments(self, arguments: dict) -> str`
Format tool arguments in a concise way for display.

**Features:**
- Truncates values > 50 chars to 47 + "..."
- Shows only first line of multiline strings
- Joins with ", " separator
- Final truncation at 100 chars

#### `print_error(self, message: str) -> None` (abstract)
Print error message - subclasses must implement.

#### `print_warning(self, message: str) -> None` (abstract)
Print warning message - subclasses must implement.

#### `print_success(self, message: str) -> None` (abstract)
Print success message - subclasses must implement.

---

## UIManager (Interactive)

**File:** `code_ally/ui/ui_manager.py`

### Purpose
Main UI manager for interactive mode, orchestrating animation, display, and input components.

### Properties

```python
display_console: Console                    # Rich console for output
animation: AnimationManager                 # Animation component
input: InputManager                         # Input component
display: DisplayManager                     # Display component

# Plan UI state (for future feature)
plan_tasks_table: Any | None
plan_panel: Any | None
plan_panel_group: Any | None
current_interactive_plan: dict | None
current_interactive_plan_tasks: list[dict]
```

### Initialization

```python
def __init__(self) -> None:
    super().__init__()
    self.display_console = Console()
    self.animation = AnimationManager(self.display_console, verbose=self.verbose)
    self.input = InputManager()
    self.display = DisplayManager(self.display_console, self._suppress_top_level_assistant)
```

### Component Management

#### `set_agent(self, agent: Agent) -> None`
Set agent reference for all components.

#### `set_verbose(self, verbose: bool) -> None`
Set verbose mode for all components.

#### `set_top_level_suppression(self, enabled: bool) -> None`
Enable/disable suppression in display component.

### Animation Methods (Delegated to AnimationManager)

#### `start_thinking_animation(token_percentage: int, context: str, model_name: str | None)`
Start the thinking animation with spinner.

#### `stop_thinking_animation()`
Stop the thinking animation.

#### `update_thinking_animation_tokens(token_count: int, latest_token: str)`
Update token count during thinking animation.

#### `start_tool_execution_animation(tool_name: str, description: str)`
Start tool execution animation.

#### `stop_tool_execution_animation()`
Stop tool execution animation.

#### `start_tool_output_streaming(tool_name: str, description: str)`
Start streaming tool output in real-time.

#### `update_tool_output_streaming(line: str)`
Add a line to streaming tool output.

#### `stop_tool_output_streaming()`
Stop streaming tool output.

#### `start_streaming_response()`
Start streaming response display.

#### `update_streaming_response(content: str, thinking: str | None)`
Update streaming response content.

#### `stop_streaming_response() -> str`
Stop streaming and return final content.

#### `start_tagline_status(label: str)`
Start custom tagline status (for agent delegation).

#### `update_tagline_status(label: str)`
Update tagline status label.

#### `stop_tagline_status()`
Stop tagline status display.

#### `pause_tagline_status()`
Pause tagline status (for permission prompts).

#### `resume_tagline_status()`
Resume tagline status after pause.

### Input Methods (Delegated to InputManager)

#### `async get_user_input() -> str`
Get user input with history navigation support.

**Important:** Stops animations before showing prompt.

#### `confirm(prompt: str, default: bool) -> bool`
Ask user for confirmation.

#### `has_input_content() -> bool`
Check if input buffer has content.

#### `clear_input()`
Clear current input buffer.

#### `is_input_active() -> bool`
Check if prompt_toolkit input is currently active.

#### `refresh_path_completion(working_dir: Path | None)`
Refresh path completion index.

#### `refresh_agent_completion()`
Refresh agent completion cache.

### Display Methods (Delegated to DisplayManager)

#### `print_content(content: str, style: str | None, panel: bool, title: str | None, border_style: str | None, use_markdown: bool)`
Print content with optional styling and panel.

**Important:** Stops animations before display.

#### `print_markdown(content: str)`
Print markdown-formatted content.

#### `print_assistant_response(content: str, thinking: str | None)`
Print assistant response with optional thinking content.

**Respects:** `_suppress_top_level_assistant` flag.

#### `print_tool_call(tool_name: str, arguments: dict, success: bool | None, tool_call_id: str | None)`
Print concise tool call notification.

#### `print_tool_result_preview(tool_name: str, result: dict | str, max_lines: int)`
Print standardized preview of tool results.

#### `print_error(message: str)`
Print error message.

#### `print_warning(message: str)`
Print warning message.

#### `print_success(message: str)`
Print success message.

#### `print_verbose(message: str)`
Print verbose debug message if verbose mode enabled.

#### `print_startup_banner(model_name: str | None)`
Print startup banner with version and model info.

#### `print_help()`
Print help information.

### Internal Methods

#### `_ensure_animation_stopped_before_display()`
Stop animations to prevent visual conflicts during display operations.

**Called by:** All display methods before rendering.

---

## NonInteractiveUIManager

**File:** `code_ally/ui/non_interactive_ui_manager.py`

### Purpose
UI manager for single-message mode (--once) with clean text output, no animations.

### Properties

```python
display_console: Console  # Rich console with force_terminal=False
```

### Initialization

```python
def __init__(self) -> None:
    super().__init__()
    self.display_console = Console(file=None, force_terminal=False)
```

### Animation Methods (No-ops)

All animation methods are no-ops:
- `start_thinking_animation()` - pass
- `stop_thinking_animation()` - pass
- `start_tool_execution_animation()` - pass
- `stop_tool_execution_animation()` - pass
- `start_tool_output_streaming()` - pass
- `update_tool_output_streaming()` - pass
- `stop_tool_output_streaming()` - pass
- `start_tagline_status()` - pass
- `stop_tagline_status()` - pass
- `update_tagline_status()` - pass

### Display Methods

#### `print_content(content: str, style: str | None, panel: bool, title: str | None, border_style: str | None, use_markdown: bool)`
Print content as plain text, stripping Rich formatting.

**Implementation:** `stripped_content = re.sub(r"[/?[^]]*]", "", str(content))`

#### `print_markdown(content: str)`
Print as plain text (no markdown rendering).

#### `print_assistant_response(content: str, thinking: str | None)`
Print assistant response as plain text with "● " prefix.

**Logic:**
- Checks `_suppress_top_level_assistant` flag
- Strips "THINKING: ...\n\n" prefix if present
- Prints with "● " prefix

#### `print_tool_call(tool_name: str, arguments: dict, success: bool | None, tool_call_id: str | None)`
Print tool call only in verbose mode.

**Format:** `{prefix} {tool_name}({args_str})`
- prefix: "→" if success, "x" if failure

#### `print_tool_result_preview(tool_name: str, result: dict | str, max_lines: int)`
Print tool result preview only in verbose mode.

**Features:**
- Skips if `_internal_only` flag set
- Truncates to max_lines
- Indents with 5 spaces
- Truncates lines at 100 chars

#### `print_error(message: str)`
Print to stderr: `Error: {message}`

#### `print_warning(message: str)`
Print to stderr: `Warning: {message}`

#### `print_success(message: str)`
Print to stdout: `Success: {message}`

#### `confirm(prompt: str, default: bool) -> bool`
Auto-confirm (always returns default).

#### `print_startup_banner(model_name: str | None)`
No-op for non-interactive mode.

#### `print_help()`
No-op for single-message mode.

### Unsupported Methods

#### `get_user_input() -> str`
Raises `NotImplementedError` - not supported in non-interactive mode.

---

## AnimationManager

**File:** `code_ally/ui/animation_manager.py`

### Purpose
Manages all UI animations including thinking spinners, streaming displays, and tool execution status.

### State Machine

```python
class AnimationState(Enum):
    IDLE = auto()                    # No animation active
    THINKING = auto()                # Waiting for model response
    STREAMING = auto()               # Streaming assistant response
    TOOL_EXECUTING = auto()          # Tool execution spinner
    TOOL_OUTPUT_STREAMING = auto()   # Streaming tool output
    TAGLINE_STATUS = auto()          # Custom status line (delegation)
```

### Properties

```python
console: Console                      # Rich console for output
agent: Agent | None                   # Reference to agent
verbose: bool                         # Verbose mode flag

# Animation state
_animation_lock: threading.Lock       # Thread-safe state management
_animation_state: AnimationState      # Current animation state
_animation_thread: Thread | None      # Animation loop thread
_animation_stop_event: Event          # Stop signal for animation
active_live_display: Live | None      # Active Rich Live display

# State-specific content
_thinking_spinner: Spinner            # Spinner for thinking state
_streaming_renderable: Group | Text | Markdown  # Streaming content
_thinking_phase_ended: bool           # Track thinking phase completion
_tool_executing_spinner: Spinner      # Spinner for tool execution
_tool_output_lines: list[str]         # Lines for tool output streaming
_tool_output_max_lines: int           # Max lines to show (default: 10)

# Status tracking
_thinking_context: str                # Context label (e.g., "thinking")
_current_token_count: int             # Token count during thinking
_current_model_name: str | None       # Model name for display
_animation_start_time: float          # Start time for elapsed seconds
_tool_name: str                       # Current tool name
_tool_description: str                # Tool description

# Tagline status
_tagline_label: str                   # Tagline status label
_tagline_paused: bool                 # Tagline paused flag
_tagline_paused_label: str            # Label before pause
```

### Initialization

```python
def __init__(self, console: Console, agent: Agent | None = None, verbose: bool = False):
    self.console = console
    self.agent = agent
    self.verbose = verbose
    # ... initialize all state variables
```

### Core Animation Methods

#### `_animation_loop()`
Central animation loop that renders different states.

**Implementation:**
```python
with Live(console=self.console, refresh_per_second=12, transient=True) as live:
    while not self._animation_stop_event.is_set():
        with self._animation_lock:
            current_state = self._animation_state
            renderable = self._get_renderable_for_state(current_state)
        if renderable:
            live.update(renderable)
        time.sleep(0.08)  # 12 FPS
```

#### `_get_renderable_for_state(state: AnimationState) -> Group | Text | Markdown | None`
Get Rich renderable for current animation state.

**States:**
- `IDLE`: Empty text
- `THINKING`: Thinking spinner with model name, token count, elapsed time
- `STREAMING`: Streaming content with thinking if present
- `TOOL_EXECUTING`: Tool execution spinner
- `TOOL_OUTPUT_STREAMING`: Tool output with last N lines
- `TAGLINE_STATUS`: Custom tagline with elapsed time

#### `_stop_current_animation()`
Safely stop the unified animation loop.

**Features:**
- Sets state to IDLE
- Signals stop event
- Waits for thread to finish (timeout: 2s)
- Stops Live display
- Clears visual artifacts
- Thread-safe cleanup

#### `stop_animation()`
Public method to stop any current animation.

#### `_start_animation_loop_if_needed()`
Start animation loop thread if not already running.

**Features:**
- Waits for old thread to finish
- Clears stop event
- Starts new daemon thread

### Thinking Animation

#### `start_thinking_animation(token_percentage: int, context: str, model_name: str | None)`
Start thinking animation.

**Display Format:**
```
[spinner] [model_name] Thinking (N tokens) (focus_status) [Ns]
▶ [current todo]
```

**Verbose Mode:** Prints "VERBOSE MODE: Waiting for model to respond"

#### `stop_thinking_animation()`
Stop thinking animation.

#### `update_thinking_animation_tokens(token_count: int, latest_token: str)`
Update token count display.

#### `_get_thinking_renderable() -> Group | Spinner`
Construct renderable for THINKING state.

**Elements:**
- Model name (truncated to 5 chars, dim yellow)
- Context label ("thinking", "generating", etc., cyan)
- Token count (dim green)
- Focus status if active (dim cyan)
- Elapsed seconds
- Current todo if available

### Streaming Animation

#### `start_streaming_response()`
Start streaming response display.

#### `update_streaming_response(content: str, thinking: str | None)`
Update streaming response content.

**Features:**
- Parses thinking content from `<think>` tags or native thinking
- Separates thinking (dim italic cyan) from regular content (green markdown)
- Adds todo display if available
- Updates `_thinking_phase_ended` flag when regular content appears

#### `stop_streaming_response() -> str`
Stop streaming and return final content.

**Returns:** Final content extracted from renderable.

### Tool Execution Animation

#### `start_tool_execution_animation(tool_name: str, description: str)`
Start tool execution animation.

**Display Format:**
```
[spinner] ToolName [description] [Ns]
▶ [current todo]
```

**Verbose Mode:** Prints "VERBOSE MODE: Executing ToolName (description)"

#### `stop_tool_execution_animation()`
Stop tool execution animation.

#### `_get_tool_executing_renderable() -> Group | Spinner`
Construct renderable for TOOL_EXECUTING state.

**Elements:**
- Tool name (yellow)
- Description if provided (dim, truncated to 50 chars)
- Elapsed seconds (dim cyan)
- Current todo if available

### Tool Output Streaming

#### `start_tool_output_streaming(tool_name: str, description: str)`
Start streaming tool output in real-time.

**Display Format:**
```
ToolName [description] [Ns]
... (if more than max_lines)
[last N lines of output]
▶ [current todo]
```

#### `update_tool_output_streaming(line: str)`
Add a line to streaming output.

#### `stop_tool_output_streaming()`
Stop streaming tool output.

#### `_get_tool_output_streaming_renderable() -> Group`
Construct renderable for TOOL_OUTPUT_STREAMING state.

**Features:**
- Shows header with tool name, description, elapsed time
- Shows last `_tool_output_max_lines` lines (default: 10)
- Truncates long lines at 120 chars
- Shows "..." if more lines than displayed
- Shows "[waiting for output...]" if no output yet
- Adds todo display if available

### Tagline Status

#### `start_tagline_status(label: str)`
Start custom tagline status (used for agent delegation).

**Display Format:**
```
[spinner] {label} [Ns]
```

#### `update_tagline_status(label: str)`
Update tagline status label.

#### `stop_tagline_status()`
Stop tagline status display.

#### `pause_tagline_status()`
Pause tagline status (for permission prompts).

**Behavior:** Sets `_tagline_paused` flag, stops rendering.

#### `resume_tagline_status()`
Resume tagline status after pause.

#### `_get_tagline_status_renderable() -> Spinner`
Construct renderable for TAGLINE_STATUS state.

**Features:**
- Returns empty spinner if paused
- Shows label with elapsed seconds

### Helper Methods

#### `_truncate_model_name(model_name: str | None) -> str`
Truncate model name to 5 characters for display.

#### `_get_focus_status_text() -> str`
Get focus status text from focus manager if available.

#### `_get_todo_text() -> str`
Get minimal todo text for display in animations.

**Format:**
- 1 task: `▶ task_name`
- 2 tasks: `▶ task_1 · task_2`
- 3+ tasks: `▶ task_1 (+N more)`

#### `_build_spinner_with_todo(spinner: Spinner, parts: list[str]) -> Spinner | Group`
Build spinner with optional todo text below.

### Verbose Mode

When verbose mode is enabled:
- Thinking animation: Prints "VERBOSE MODE: Waiting for model to respond"
- Tool execution: Prints "VERBOSE MODE: Executing {tool_name} ({description})"
- Tool output streaming: Prints "VERBOSE MODE: Streaming output from {tool_name} ({description})"

---

## DisplayManager

**File:** `code_ally/ui/display_manager.py`

### Purpose
Manages content display and formatting for all non-animated output.

### Properties

```python
console: Console                        # Rich console for output
_suppress_top_level_assistant: bool     # Suppress assistant responses flag
```

### Initialization

```python
def __init__(self, console: Console, suppress_top_level_assistant: bool = False):
    self.console = console
    self._suppress_top_level_assistant = suppress_top_level_assistant
```

### Core Display Methods

#### `print_content(content: str, style: str | None, panel: bool, title: str | None, border_style: str | None, use_markdown: bool)`
Print content with optional styling and panel.

**Logic:**
1. Convert content to renderable:
   - `use_markdown=True`: `Markdown(content)`
   - `style` provided: `Text(content, style=style)`
   - Otherwise: `Text.from_markup(content)`
2. Wrap in Panel if `panel=True`:
   - Title: `title`
   - Border style: `border_style` or "none"
   - Expand: False
3. Print to console

#### `print_markdown(content: str)`
Print markdown-formatted content.

**Delegates to:** `print_content(content, use_markdown=True)`

#### `print_assistant_response(content: str, thinking: str | None)`
Print assistant response with optional thinking content.

**Logic:**
1. Return early if `_suppress_top_level_assistant` is True
2. Parse content using `parse_streaming_thinking()` to separate thinking
3. If thinking content:
   - Print thinking with style: `[dim italic]{thinking}[/dim italic]`
   - Print empty line
4. Print regular content as markdown

#### `print_tool_call(tool_name: str, arguments: dict, format_tool_arguments_fn, success: bool | None, tool_call_id: str | None)`
Print concise tool call notification.

**Format:** `{icon} {tool_name}({args_str})`
- Success/None: icon="→", style="dim cyan"
- Failure: icon="x", style="dim red"

#### `print_tool_result_preview(tool_name: str, result: dict | str, extract_preview_fn, max_lines: int)`
Print standardized preview of tool results.

**Logic:**
1. Skip if `result["_internal_only"]` is True
2. Extract preview content using `extract_preview_fn`
3. Split into lines
4. Truncate to `max_lines` + "..." if needed
5. Print each line with 5-space indentation, truncated at 100 chars

### Message Display Methods

#### `print_error(message: str)`
Print error message.

**Format:** `Error: {message}` with style "bold red"

#### `print_warning(message: str)`
Print warning message.

**Format:** `Warning: {message}` with style "bold yellow"

#### `print_success(message: str)`
Print success message.

**Format:** `Success: {message}` with style "bold green"

#### `print_verbose(message: str, verbose: bool)`
Print verbose debug message if verbose mode enabled.

**Format:** `[dim cyan][Verbose] {message}[/]`

### Special Display Methods

#### `print_startup_banner(model_name: str | None)`
Print startup banner with version and model info.

**Layout:**
```
  [o_o]     Code Ally v{version}
   \_/      Model: {model_name}
```

**Implementation:**
- Robot art in cyan
- Version from `code_ally._version.__version__`
- Model name if provided (dim)
- Uses `rich.columns.Columns` with padding=(0, 2)

#### `print_help()`
Print help information as markdown.

**Content Sections:**
- Setup & Configuration
- Project Management
- Conversation Management
- Model Management
- Debug Commands
- Focus Management
- Completion System
- Direct Execution

**Format:** Full markdown text with command descriptions.

### Configuration Methods

#### `set_top_level_suppression(enabled: bool)`
Enable/disable suppression of top-level assistant responses.

---

## InputManager

**File:** `code_ally/ui/input_manager.py`

### Purpose
Manages user input, prompts, key bindings, and completion system.

### Properties

```python
agent: Agent | None                     # Reference to agent
path_indexer: PathIndexer | None        # Path indexer for completion
path_completer: CompositeCompleter | None  # Path completer
composite_completer: CompositeCompleter | None  # Composite completer

prompt_style: Style                     # Prompt style definitions
prompt_session: PromptSession           # prompt_toolkit session
```

### Initialization

```python
def __init__(self, agent: Agent | None = None):
    self.agent = agent
    # Setup key bindings
    kb = KeyBindings()
    # ... define key bindings

    self.prompt_style = Style.from_dict({
        "command": "#ffaa00 bold",        # / commands
        "bash": "#00ff00 bold",           # ! commands
        "agent": "#ff00ff bold",          # @ commands
        "context-low": "#00ff00",         # 50-69% context
        "context-medium": "#ffaa00",      # 70-89% context
        "context-high": "#ff0000",        # 90%+ context
        "todo-dim": "#888888",            # Todo text
        "bottom-toolbar": "noinherit",
        "bottom-toolbar.text": "noinherit",
    })

    self._setup_path_completion()

    self.prompt_session = PromptSession(
        history=FileHistory(str(COMMAND_HISTORY_FILE)),
        key_bindings=kb,
        style=self.prompt_style,
        completer=self.path_completer,
        multiline=True,
        complete_style=CompleteStyle.MULTI_COLUMN,
    )
```

### Key Bindings

#### `Ctrl+C`
Handle Ctrl+C during input.

**Logic:**
1. Get buffer state (has content or empty)
2. Perform action FIRST (to avoid race conditions):
   - Has content: Reset buffer
   - Empty: Exit with EOFError
3. Update InterruptCoordinator state AFTER action

#### `Ctrl+J` / `Ctrl+O`
Insert newline without submitting.

#### `Enter`
Either select completion or submit input.

**Logic:**
- If completion active: Apply completion
- Otherwise: Validate and submit

#### `Escape`
Dismiss completion or show prompt history selector.

**Logic:**
- If completion active: Cancel completion
- If buffer empty: Show prompt history selector

#### `Tab` (Ctrl+I)
Start completion with first result selected.

**Logic:**
- If completion active: Move to next completion
- Otherwise: Start completion with first item selected

### Input Methods

#### `async get_user_input(display_console) -> str`
Get user input with history navigation support.

**Features:**
- Dynamic prompt that changes based on input:
  - Starts with "/": `Command > ` (orange)
  - Starts with "!": `Bash > ` (green)
  - Starts with "@": `Agent > ` (magenta)
  - Otherwise: `> `
- Shows context usage if >= 70% or enabled in config
- Continuation lines show `... `
- Bottom toolbar shows next incomplete todos
- Returns special format for history selection: `__RESET_TO_INDEX_{index}__CONTENT__{content}__`

#### `confirm(prompt: str, default: bool) -> bool`
Ask user for confirmation.

**Format:** `\n{prompt} ({'Y/n' if default else 'y/N'}) > `

**Returns:**
- Empty input: Returns `default`
- "y"/"yes": Returns True
- "n"/"no": Returns False
- Other: Returns `default`

### Prompt Formatting

#### `_get_context_prefix() -> tuple[str, str]`
Get context usage prefix for prompt display.

**Thresholds:**
- 90%+ used: "context-high" (red)
- 70-89% used: "context-medium" (orange)
- 50-69% used: "context-low" (green)

**Format:** `({remaining}% remaining) `

**Display Logic:**
- Always show if `show_context_in_prompt` config enabled
- Auto-show if >= `context_display_threshold` (default: 70%)

#### `_get_todo_toolbar() -> list[tuple[str, str]]`
Get formatted text for todo toolbar.

**Format:**
- 1 incomplete: `▶ task_1`
- 2 incomplete: `▶ task_1 · task_2`
- 3+ incomplete: `▶ task_1 (+N more)`

**Returns:** List of (style, text) tuples for FormattedText

### Completion System

#### `_setup_path_completion()`
Setup completion system with path, agent, and command completion.

**Logic:**
1. Create PathIndexer
2. Load cache or rebuild index for current directory
3. Create PathCompleter with indexer
4. Create CompositeCompleter with path completer
5. Gracefully handle setup failures

#### `refresh_path_completion(working_dir: Path | None)`
Refresh path completion index.

**Actions:**
1. Rebuild index for working directory
2. Save cache
3. Log success/failure

#### `refresh_agent_completion()`
Refresh agent completion cache.

**Delegates to:** `composite_completer.invalidate_agent_cache()`

### State Management

#### `has_input_content() -> bool`
Check if input buffer has content.

**Returns:** True if buffer has non-empty text.

#### `clear_input()`
Clear current input buffer.

**Calls:** `prompt_session.app.current_buffer.reset()`

#### `is_input_active() -> bool`
Check if prompt_toolkit input is currently active.

**Returns:** True if `prompt_session.app` is not None.

### History Selection

#### `_show_prompt_history_selector(app)`
Show prompt history selector modal.

**Action:** Exits prompt with result "__SHOW_PROMPT_HISTORY__"

#### `_handle_prompt_history_selection(display_console) -> tuple[int, str] | None`
Handle prompt history selection modal.

**Returns:**
- Tuple of (message_index, prompt_content) if selected
- None if cancelled

**Uses:** PromptHistorySelector component

---

## DiffDisplay System

### Overview

The diff display system provides visual previews of file changes before they are applied. It consists of four main components:

1. **DiffDisplayManager**: High-level manager for diff rendering
2. **DiffFormatter**: Formatting logic for diff lines
3. **DiffPreviewManager**: Preview operations for tool integration
4. **DiffConfig**: Theme and configuration management

---

### DiffDisplayManager

**File:** `code_ally/ui/diff_display.py`

#### Purpose
Manages diff display for file operations with Rich terminal rendering.

#### Properties

```python
console: Console                    # Rich console for output
config: DiffDisplayConfig          # Configuration
formatter: DiffFormatter           # Formatting logic
```

#### Initialization

```python
def __init__(self, console: Console, config: dict[str, Any] | None = None):
    self.console = console
    self.config = DiffDisplayConfig(config)
    self.formatter = DiffFormatter(
        self.config.colors,
        self.config.context_lines,
        self.config.max_line_length
    )
```

#### Methods

##### `should_show_diff(old_content: str, new_content: str) -> bool`
Determine if diff should be displayed.

**Checks:**
- Config enabled
- Content not identical
- File size < max_file_size (default: 100KB)

##### `show_file_diff(old_content: str, new_content: str, file_path: str, operation_type: str)`
Display a rich diff panel showing file changes.

**Operation Types:**
- "edit": File Edit
- "write": File Write

**Process:**
1. Check if should show diff
2. Generate unified diff
3. Format diff lines
4. Display in panel

##### `show_file_write_preview(file_path: str, new_content: str, existing_content: str | None)`
Show preview for file write operations.

**Logic:**
- If `existing_content` provided: Show diff
- If None: Show new file preview

##### `_show_new_file_preview(file_path: str, content: str)`
Show preview for new file creation.

**Panel:**
- Title: "📄 New File: {path}"
- Border: green
- Content: Formatted with line numbers and green background

##### `show_edit_preview(file_path: str, original_content: str, final_content: str, edits_count: int)`
Show preview for edit operations.

**Features:**
- Shows diff
- Adds summary: "📝 N edit operation(s) will be applied"

---

### DiffFormatter

**File:** `code_ally/ui/diff_formatter.py`

#### Purpose
Handles formatting of diff content for visual display.

#### Properties

```python
colors: DiffColors                  # Color configuration
context_lines: int                  # Context lines in diffs
max_line_length: int                # Max line length (default: 120)
```

#### Constants

```python
DEFAULT_MAX_LINE_LENGTH = 120
TRUNCATION_SUFFIX = "..."
```

#### Methods

##### `generate_unified_diff(old_content: str, new_content: str, file_path: str) -> list[str]`
Generate unified diff lines.

**Uses:** `difflib.unified_diff()` with `n=context_lines`

**Format:**
- From: `a/{file_path}`
- To: `b/{file_path}`

##### `format_diff_lines(diff_lines: list[str]) -> Text`
Format diff lines with colors, styling, and line numbers.

**Line Types:**
- Header lines (`---`, `+++`, `@@`): dim style
- Removed lines (`-`): Red background, line number on left
- Added lines (`+`): Green background, line number on left
- Context lines: Normal style, line number on left

**Line Number Format:** `{num:4d} │ `

**Features:**
- Parses line numbers from `@@` headers
- Truncates lines > max_line_length
- Graceful error handling for malformed lines

##### `format_new_file_preview(content: str, max_lines: int = 20) -> Text`
Format content for new file preview with line numbers.

**Features:**
- Shows first `max_lines - 5` lines if truncation needed
- Adds "..." and "(N more lines)" if truncated
- Line numbers with green background
- Dim style for truncation markers

##### `_truncate_line(line: str) -> str`
Truncate line if exceeds max_line_length.

**Returns:** `line[:max_line_length] + "..."`

##### `sanitize_file_path_for_display(file_path: str, max_length: int = 50) -> str`
Sanitize file path for display purposes.

**Logic:** Return basename if path > max_length, otherwise full path.

---

### DiffConfig

**File:** `code_ally/ui/diff_config.py`

#### Theme System

##### `DiffColors(NamedTuple)`
Color configuration for diff display.

**Fields:**
- `removed: str` - Color for removed lines
- `added: str` - Color for added lines
- `modified: str` - Color for modified lines

##### `DiffTheme`
Theme configuration for diff display.

**Themes:**

```python
THEMES = {
    "dark": DiffColors(
        removed="on rgb(60,25,25)",      # Dark red
        added="on rgb(25,60,25)",        # Dark green
        modified="on rgb(60,60,25)",     # Dark yellow
    ),
    "light": DiffColors(
        removed="on rgb(255,235,235)",   # Soft light red
        added="on rgb(235,255,235)",     # Soft light green
        modified="on rgb(255,255,220)",  # Soft light yellow
    ),
    "minimal": DiffColors(
        removed="red",                   # ANSI red
        added="green",                   # ANSI green
        modified="yellow",               # ANSI yellow
    ),
}
```

**Methods:**

###### `get_colors(theme: str, config_overrides: dict | None) -> DiffColors`
Get colors for specified theme with optional overrides.

**Logic:**
1. If theme="auto": Detect terminal theme
2. Get base colors for theme (fallback to "minimal")
3. Apply config overrides if provided

###### `_detect_terminal_theme() -> str`
Detect terminal theme from environment variables.

**Detection Order:**
1. `COLORFGBG` env var (macOS): 0-7=dark, 8-15=light
2. `TERMINAL_THEME` env var: explicit "light" or "dark"
3. `ITERM_SESSION_ID`: Default to "dark"
4. `TERM` contains "light" or "dark"
5. Fallback: "minimal"

#### Configuration

##### `DiffDisplayConfig`
Configuration for diff display functionality.

**Properties:**

```python
enabled: bool                      # Enable diff display (default: True)
max_file_size: int                 # Max file size in bytes (default: 100KB)
context_lines: int                 # Context lines in diffs (default: 3)
max_line_length: int | None        # Max line length (default: None = use formatter default)
colors: DiffColors                 # Resolved color configuration
```

**Initialization:**

```python
def __init__(self, config: dict[str, Any] | None = None):
    self.config = config or {}
    self.enabled = self.config.get("enabled", True)
    self.max_file_size = self.config.get("max_file_size", 100 * 1024)
    self.context_lines = self.config.get("context_lines", 3)
    self.max_line_length = self.config.get("max_line_length", None)

    theme = self.config.get("theme", "auto")
    self.colors = DiffTheme.get_colors(theme, self.config)
```

**Methods:**

###### `should_show_diff(old_content: str, new_content: str) -> bool`
Determine if diff should be displayed.

**Checks:**
1. Config enabled
2. Content not identical
3. File sizes < max_file_size
4. Content is valid UTF-8

---

### DiffPreviewManager

**File:** `code_ally/ui/diff_preview.py`

#### Purpose
High-level preview operations for tool integration.

#### Properties

```python
diff_display: DiffDisplayManager    # DiffDisplayManager for rendering
```

#### Methods

##### `preview_write_operation(file_path: str, new_content: str) -> dict[str, Any]`
Preview a file write operation.

**Process:**
1. Resolve absolute path using `resolve_path()`
2. Check if file exists
3. Read existing content if file exists
4. Show write preview (diff or new file)
5. Return `{"success": True}`

**Error Handling:** Returns success even on preview errors (don't fail operation).

##### `preview_edit_operation(file_path: str, edits: list[dict]) -> dict[str, Any]`
Preview an edit operation with multiple edits.

**Process:**
1. Resolve absolute path
2. Check file exists
3. Read file content
4. Apply edits sequentially:
   - String replacement with `old_string` / `new_string`
   - Respect `replace_all` flag
   - Skip non-unique matches if not `replace_all`
5. Show edit preview with edits count
6. Return `{"success": True}`

##### `preview_line_edit_operation(file_path: str, edits: list[dict]) -> dict[str, Any]`
Preview a line-based edit operation.

**Line Edit Format:**
```python
{
    "start_line": int,    # 1-based line number
    "end_line": int,      # 1-based line number (inclusive)
    "new_content": str,   # New content for range
}
```

**Process:**
1. Resolve absolute path
2. Read file preserving line endings
3. Split into lines with `splitlines(keepends=True)`
4. Detect line ending style (`\n` or `\r\n`)
5. Apply line edits sequentially:
   - Convert to 0-based indexing
   - Replace line range with new content
   - Update total line count
6. Join lines back into content
7. Show edit preview
8. Return `{"success": True}`

**Error Handling:** Returns success even on preview errors.

---

## DelegationUIManager

**File:** `code_ally/agent/factories.py`

### Purpose
UI manager wrapper that provides appropriate output for agent delegation context. Suppresses most output from sub-agents to avoid cluttering the display.

### Properties

```python
original_ui: Any                    # Parent agent's UI manager
verbose: bool                       # Verbose mode flag
display_console: Console            # Rich console (from original or new)
```

### Method Sets

#### Suppressed Methods (No Output)

```python
_SUPPRESSED_METHODS = {
    # Display methods
    'print_content', 'print_assistant_response', 'print_markdown',
    'print_success', 'print_error', 'print_tool_result',
    'print', 'print_info', 'print_debug',
    'display_error', 'handle_error', 'show_error',

    # Animation methods
    'start_thinking_animation', 'stop_thinking_animation',
    'start_streaming_animation', 'stop_streaming_animation',
    'start_tagline_status', 'stop_tagline_status',
    'update_tagline_status', 'pause_tagline_status', 'resume_tagline_status'
}
```

#### Safe Delegated Methods

```python
_SAFE_DELEGATED_METHODS = {
    'display_console', 'verbose', '_format_tool_arguments',
    'confirm', 'get_user_input', 'set_verbose'
}
```

### Initialization

```python
def __init__(self, original_ui: Any):
    self.original_ui = original_ui

    if original_ui:
        self.verbose = getattr(original_ui, "verbose", False)
        self.display_console = getattr(original_ui, "display_console", None)
    else:
        self.verbose = False
        from rich.console import Console
        self.display_console = Console()
```

### Special Methods

#### `__getattr__(self, name)`
Handle method calls with unified suppression/delegation logic.

**Logic:**
1. If in `_SUPPRESSED_METHODS`: Return lambda that does nothing
2. If in `_SAFE_DELEGATED_METHODS` and exists on original: Delegate
3. Otherwise: Return no-op lambda

**Debug:** Prints "[DEBUG DelegationUIManager] Suppressing method: {name}" for suppressed methods.

#### `print_tool_call(tool_name: str, arguments: dict, success: bool | None, tool_call_id: str | None)`
Show tool calls with delegation indentation.

**Format:** `     {prefix} {tool_name}({args_str})`
- prefix: "→" (dim cyan) if success, "x" (dim red) if failure

#### `print_warning(message: str)`
Allow warnings with delegation indentation.

**Format:** `     [yellow]Warning:[/] {message}`

#### `print_tool_result_preview(tool_name: str, result: dict, max_lines: int)`
Show tool result previews with delegation indentation.

**Process:**
1. Try tool-specific preview using `tool.get_result_preview()`
2. Fallback to generic result preview
3. All lines indented with 5 spaces

**Generic Preview:**
- Success: Truncated content (100 chars)
- Error: Truncated error message (100 chars)

### Delegation Pattern

The DelegationUIManager uses a **method suppression pattern**:
1. Most display methods are suppressed (no-op)
2. Tool calls and warnings are shown with indentation
3. Safe methods are delegated to parent UI
4. Unknown methods become no-ops (defensive)

This creates a clean nested output:
```
→ main_tool()
     → sub_tool()          # Indented to show delegation
     [yellow]Warning:[/] message  # Warnings still visible
```

---

## PromptHistorySelector

**File:** `code_ally/prompt_history_selector.py`

### Purpose
Interactive modal for navigating and selecting from conversation history using arrow keys.

### Components

#### `PromptHistoryEntry(NamedTuple)`
Information about a prompt history entry for display.

**Fields:**
- `index: int` - Message index in conversation
- `content: str` - User prompt content
- `timestamp: str` - When prompt was made (e.g., "#1", "#2")
- `preview: str` - Truncated preview for display

### PromptHistorySelector Class

#### Properties

```python
console: Console                    # Rich console for output
```

#### Initialization

```python
def __init__(self, console: Console):
    self.console = console
```

### Key Input

#### `_get_key() -> str`
Get a single key press from user using raw terminal mode.

**Returns:**
- "up" - Up arrow
- "down" - Down arrow
- "right" - Right arrow
- "left" - Left arrow
- "enter" - Enter key
- "quit" - Escape or Q
- "ctrl_c" - Ctrl+C
- Other characters as-is

**Implementation:**
- Uses `termios` and `tty` for raw mode
- Handles ANSI escape sequences for arrow keys
- Timeout-based detection for standalone ESC

### Content Processing

#### `_create_prompt_preview(content: str, max_length: int = 80) -> str`
Create truncated preview of prompt content.

**Logic:**
1. Replace newlines with spaces
2. Clean up whitespace
3. Truncate at max_length - 3 + "..." if needed

#### `_extract_prompts_from_messages(messages: list[dict]) -> list[PromptHistoryEntry]`
Extract user prompts from conversation messages.

**Process:**
1. Filter for role="user"
2. Skip empty messages
3. Create timestamp "#N" (chronological order)
4. Create preview (truncated)
5. Return in chronological order (oldest first)

### Display

#### `_create_prompts_table(prompts: list[PromptHistoryEntry], selected_index: int) -> Table`
Create Rich table showing prompt history.

**Table Format:**
- Title: "Select Conversation Point"
- Columns:
  - "" (2 chars): Selection indicator "▶" or space
  - "Prompt Preview" (50-80 chars): Preview text
- Selected row: bright cyan, bold
- Other rows: normal cyan

**Styles:**
- Title: bold blue
- Header: bold blue
- Border: blue

#### `_create_prompt_display(prompts: list[PromptHistoryEntry], selected_index: int)`
Create full prompt display with current selection.

**Elements:**
1. Main table with prompts
2. Status info:
   - "Selected prompt N of M:"
   - "Full prompt:"
   - Content preview (up to 5 lines, max 200 chars)
3. Info text:
   - Current prompt: "The current prompt will be loaded for editing. The conversation will be truncated to just before it."
   - Other prompts: "The selected prompt will be loaded into the input buffer for editing. Everything after it will be removed."
4. Navigation instructions:
   - "Navigation: ↑/↓ move • Enter load for editing • q/Esc cancel"

**Layout:** Vertically centered with `Align.center(content, vertical="middle")`

### Selection

#### `select_prompt(messages: list[dict]) -> tuple[int, str] | None`
Interactive prompt selection with arrow key navigation.

**Process:**
1. Extract prompts from messages
2. If no prompts: Print warning and return None
3. Start with last (most recent) prompt selected
4. Enter alternate screen buffer (preserves conversation)
5. Hide cursor
6. Show initial display
7. Loop:
   - Get key press
   - Up: Move selection up (if not at top)
   - Down: Move selection down (if not at bottom)
   - Enter: Return (message_index, prompt_content)
   - Quit/Ctrl+C: Return None
8. Restore screen and cursor

**Returns:**
- Tuple of (message_index, prompt_content) if selected
- None if cancelled

**Features:**
- Uses `console.screen()` for alternate buffer
- Preserves conversation history
- Real-time display updates
- Graceful keyboard interrupt handling

---

## Rich Library Integration

### Core Rich Components Used

#### Console
Primary interface for all terminal output.

**Usage:**
- `Console()` - Interactive with auto-detection
- `Console(file=None, force_terminal=False)` - Non-interactive

**Methods:**
- `print()` - Print renderable objects
- `screen()` - Context manager for alternate screen

#### Live
Real-time updating display for animations.

**Configuration:**
```python
Live(
    console=console,
    refresh_per_second=12,  # 12 FPS
    transient=True,         # Clear on exit
)
```

**Methods:**
- `update(renderable)` - Update display content
- `stop()` - Stop live display

#### Text
Styled text with Rich markup or plain style.

**Creation:**
- `Text(content, style=style)` - With style
- `Text.from_markup(content)` - Parse Rich markup

**Styles:**
- "bold red", "dim cyan", etc.
- "on rgb(R,G,B)" for backgrounds

#### Markdown
Markdown rendering with syntax highlighting.

**Usage:**
```python
Markdown(content, style="green")
```

#### Panel
Bordered panel for content grouping.

**Configuration:**
```python
Panel(
    content,
    title="Title",
    border_style="blue",
    expand=False,
)
```

#### Spinner
Animated spinner for loading states.

**Types:**
- "dots2" - Thinking animation
- "dots" - Tool execution

**Usage:**
```python
Spinner("dots2", text=Text.from_markup("[cyan]Thinking[/]"))
```

#### Group
Vertical group of renderables.

**Usage:**
```python
Group(
    header,
    content_line_1,
    content_line_2,
    footer,
)
```

#### Table
Tabular data display.

**Configuration:**
```python
Table(
    title="Title",
    show_header=True,
    header_style="bold blue",
    title_style="bold blue",
    border_style="blue",
)

table.add_column("Name", style="cyan", width=20)
table.add_row("Value", style="dim")
```

#### Columns
Horizontal column layout.

**Usage:**
```python
Columns([left_content, right_content], padding=(0, 2))
```

#### Align
Content alignment.

**Usage:**
```python
Align.center(content, vertical="middle")
```

### Rich Markup Language

#### Colors
- Named colors: `[red]text[/red]`, `[green]text[/]`
- RGB colors: `[rgb(255,128,0)]text[/]`
- Background: `[on red]text[/]`, `[on rgb(50,50,50)]text[/]`

#### Styles
- `[bold]text[/]`
- `[dim]text[/]`
- `[italic]text[/]`
- Combined: `[bold red]text[/]`

#### Closing Tags
- Specific: `[/red]`, `[/bold]`
- Generic: `[/]` closes last opened tag

---

## State Management

### Animation State

**State Machine:** `AnimationState` enum with 6 states
- Transitions managed by `AnimationManager`
- Thread-safe with `_animation_lock`
- Single animation thread handles all states
- Stop event for graceful shutdown

**State Flow:**
```
IDLE → THINKING → STREAMING → IDLE
       ↓         ↓
   TOOL_EXECUTING | TOOL_OUTPUT_STREAMING → IDLE
       ↓
   TAGLINE_STATUS → IDLE
```

### UI Suppression State

**Managed By:** `BaseUIManager._suppress_top_level_assistant`

**Purpose:** Suppress assistant responses during tool execution or delegation

**Set By:**
- Tool execution (temporarily)
- Agent delegation (for sub-agents)

**Affects:**
- `print_assistant_response()` - Returns early if suppressed
- Delegation nesting (shows indented tool calls)

### Input State

**Managed By:** `InputManager`

**States:**
- Input active: `prompt_session.app is not None`
- Buffer has content: `current_buffer.text.strip()` is not empty
- Completion active: `complete_state is not None`

**Coordination:**
- InterruptCoordinator tracks input state
- Ctrl+C behavior depends on buffer state
- Animation stops before input prompt

### Context State

**Managed By:** `TokenManager` (in Agent)

**Tracked:**
- Token usage percentage
- Remaining context
- Auto-show threshold (default: 70%)

**Displayed:**
- Prompt prefix (if >= threshold or config enabled)
- Color-coded by severity

### Todo State

**Managed By:** `TodoSessionManager`

**Tracked:**
- Active todos
- Completed todos
- Current task in progress

**Displayed:**
- Animation overlays (thinking, tool execution)
- Input bottom toolbar
- Compact format (first 1-3 tasks)

---

## User Interaction Flows

### 1. Standard Message Flow (Interactive)

```
User types message
↓
InputManager.get_user_input()
  - Shows dynamic prompt (> / Command > / Bash > / Agent >)
  - Shows context usage if >= 70%
  - Shows todo toolbar at bottom
  - Handles key bindings (Enter, Tab, Esc, Ctrl+C)
↓
Agent processes message
↓
AnimationManager.start_thinking_animation()
  - Shows spinner with model name, token count, elapsed time
  - Shows current todo below spinner
↓
Model returns tool calls
↓
AnimationManager.stop_thinking_animation()
↓
For each tool call:
  DisplayManager.print_tool_call()
    - Shows: → tool_name(args)
  ↓
  AnimationManager.start_tool_execution_animation()
    - Shows spinner with tool name, description, elapsed time
  ↓
  Tool executes
  ↓
  AnimationManager.stop_tool_execution_animation()
  ↓
  DisplayManager.print_tool_result_preview()
    - Shows indented preview (5 spaces)
↓
AnimationManager.start_streaming_response()
  - Shows streaming markdown content
  - Shows thinking if present (dim italic cyan)
  - Shows todo below content
↓
Content streams in...
↓
AnimationManager.stop_streaming_response()
↓
DisplayManager.print_assistant_response()
  - Shows final formatted response
↓
Back to input prompt
```

### 2. Tool with Real-time Output (e.g., Bash)

```
Tool execution begins
↓
AnimationManager.start_tool_output_streaming(tool_name, description)
  - Shows header: ToolName [description] [Ns]
↓
For each line of output:
  AnimationManager.update_tool_output_streaming(line)
    - Adds line to buffer
    - Display shows last 10 lines (scrolling window)
    - Shows "..." if more lines
    - Truncates long lines at 120 chars
↓
Tool execution completes
↓
AnimationManager.stop_tool_output_streaming()
↓
DisplayManager.print_tool_result_preview()
  - Shows final summary
```

### 3. File Edit with Diff Preview

```
Tool calls Edit
↓
DiffPreviewManager.preview_edit_operation()
  - Reads file content
  - Applies edits to simulate final state
↓
DiffDisplayManager.show_edit_preview()
  - Generates unified diff
  - Formats with line numbers and colors
  - Shows in panel with "📄 File Edit: path"
  - Shows summary: "📝 N edit operation(s) will be applied"
↓
User sees preview
↓
Edit executes
↓
Result preview shows success
```

### 4. Prompt History Selection

```
User presses Esc with empty input buffer
↓
InputManager handles Escape key
  - Calls _show_prompt_history_selector()
↓
Input prompt exits with "__SHOW_PROMPT_HISTORY__"
↓
InputManager._handle_prompt_history_selection()
  - Creates PromptHistorySelector
  - Calls select_prompt(messages)
↓
PromptHistorySelector.select_prompt()
  - Enters alternate screen (preserves conversation)
  - Extracts user prompts from conversation
  - Shows table with previews
  - User navigates with arrow keys
  - Shows full content of selected prompt
  - User presses Enter to select or Esc/Q to cancel
↓
Returns (message_index, prompt_content) or None
↓
If selected:
  - Format as special string: "__RESET_TO_INDEX_{index}__CONTENT__{content}__"
  - Return to conversation manager
  - Conversation resets to selected point
  - Prompt loaded into input buffer for editing
Otherwise:
  - Return to input prompt
```

### 5. Agent Delegation Flow

```
Main agent receives "@agent_name task" message
↓
DelegationUIManager wraps main UI
  - Suppresses most output methods
  - Allows tool calls with indentation
↓
AnimationManager.start_tagline_status("Delegating to agent_name...")
  - Shows spinner with label and elapsed time
↓
Sub-agent created with DelegationUIManager
↓
Sub-agent processes task
  - Thinking animations suppressed
  - Tool calls shown with indentation: "     → tool()"
  - Tool results shown with indentation: "     preview"
  - Warnings shown with indentation: "     [yellow]Warning:[/] msg"
  - Assistant responses suppressed
↓
Sub-agent completes
↓
AnimationManager.stop_tagline_status()
↓
Main agent receives sub-agent result
↓
Main agent continues with normal flow
```

### 6. Non-Interactive (--once) Flow

```
User runs: ally --once "message"
↓
NonInteractiveUIManager used
  - No animations (all no-ops)
  - Plain text output only
  - No input prompts
↓
Agent processes message
  - No thinking animation shown
  - Tool calls shown only in verbose mode: → tool(args)
  - Tool results shown only in verbose mode (indented)
↓
Assistant response printed with "● " prefix
  - Plain text (no markdown rendering)
  - No Rich formatting
↓
Process exits
```

### 7. Confirmation Flow

```
Tool requires confirmation (sensitive operation)
↓
TrustManager checks permission
↓
If confirmation needed:
  AnimationManager.pause_tagline_status() (if active)
  ↓
  InputManager.confirm(prompt, default)
    - Shows prompt with (Y/n) or (y/N)
    - User responds
  ↓
  AnimationManager.resume_tagline_status() (if was active)
↓
Tool proceeds or cancels based on response
```

### 8. Context Warning Flow

```
Agent detects high context usage
↓
Token percentage >= 70%
↓
Input prompt shows context prefix:
  - 90%+: (N% remaining) in RED
  - 70-89%: (N% remaining) in ORANGE
  - Below 70%: (N% remaining) in GREEN (if show_context_in_prompt enabled)
↓
User sees warning in prompt
↓
User can:
  - Continue normally
  - Use /compact to reduce context
  - Use /clear to reset conversation
```

---

## Implementation Notes for Ink

### Key Differences from Rich

1. **React-based**: Components instead of imperative API
2. **State management**: Use React hooks (useState, useEffect)
3. **Streaming**: Use React state updates instead of Live.update()
4. **Input**: Ink's useInput hook instead of prompt_toolkit
5. **Layout**: JSX/Flexbox instead of Rich renderables

### Architecture Mapping

**Rich → Ink**

```
Console → stdout (implicit)
Live → Component with state updates
Text → <Text> component with color prop
Markdown → Custom markdown renderer component
Panel → <Box> with border props
Spinner → Custom spinner component with animation
Group → <Box> with flexDirection="column"
Table → Custom table component
Columns → <Box> with flexDirection="row"
```

### Component Recommendations

1. **UIManager**: Root component managing app state
2. **AnimationDisplay**: Component for all animation states
3. **ContentDisplay**: Component for static content
4. **InputPrompt**: Component for user input
5. **DiffPanel**: Component for diff display
6. **HistorySelector**: Modal component for history
7. **ToolCallDisplay**: Component for tool execution
8. **ProgressIndicator**: Component for spinners

### State Management

**Global State (Context):**
- Animation state
- Suppression flags
- Verbose mode
- Agent reference

**Local State (Components):**
- Input buffer
- Completion state
- Tool execution progress
- Streaming content

### Animation Strategy

**Rich:** Thread-based with Live.update()
```python
while not stop_event:
    live.update(renderable)
    time.sleep(0.08)
```

**Ink:** React-based with useEffect interval
```javascript
useEffect(() => {
  const interval = setInterval(() => {
    setElapsedSeconds(prev => prev + 1);
  }, 1000);
  return () => clearInterval(interval);
}, []);
```

### Input Handling

**Rich:** prompt_toolkit with key bindings
```python
@kb.add("c-c")
def handle_ctrl_c(event):
    buffer.reset()
```

**Ink:** useInput hook
```javascript
useInput((input, key) => {
  if (key.ctrl && input === 'c') {
    setBuffer('');
  }
});
```

### Challenges & Solutions

**Challenge:** Async input in Ink
**Solution:** Use separate input component with controlled state

**Challenge:** Live animations in Ink
**Solution:** Use interval-based state updates with re-renders

**Challenge:** Alternate screen for history selector
**Solution:** Use Ink's fullscreen mode or modal overlay

**Challenge:** Diff display with colors
**Solution:** Build custom diff component with styled spans

**Challenge:** Real-time tool output streaming
**Solution:** Append to array state, display last N lines

---

## Conclusion

This documentation provides a complete reference for all UI components in CodeAlly. Key takeaways for Ink reimplementation:

1. **Separation of concerns**: Keep animation, display, and input separate
2. **State management**: Use React state for all dynamic content
3. **Animation safety**: Ensure animations can be safely stopped before new displays
4. **Context awareness**: Adapt UI based on execution context (interactive, delegation, verbose)
5. **Error handling**: Gracefully handle all edge cases (malformed content, missing data, etc.)

The system is designed to be:
- **Extensible**: Easy to add new animation states or display formats
- **Safe**: Thread-safe animations with proper cleanup
- **User-friendly**: Clear visual feedback for all operations
- **Context-aware**: Adapts to different execution modes

For Ink implementation, focus on:
1. Component hierarchy matching the manager structure
2. React state for all animations and dynamic content
3. Controlled input components with proper event handling
4. Custom components for complex displays (diffs, tables, history)
5. Global context for shared state (suppression, verbose, etc.)
