# CodeAlly Tool System - Complete Technical Documentation

**Version:** 1.0
**Date:** 2025-10-20
**Purpose:** Comprehensive reference for TypeScript reimplementation

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Tool Lifecycle](#tool-lifecycle)
3. [Base Tool Class](#base-tool-class)
4. [Tool Manager](#tool-manager)
5. [Tool Loader & Registry](#tool-loader--registry)
6. [Individual Tools Reference](#individual-tools-reference)
7. [Mixins System](#mixins-system)
8. [Function Definition Schema](#function-definition-schema)
9. [Extension Guide](#extension-guide)

---

## Architecture Overview

The tool system follows a clean architecture with clear separation of concerns:

```
┌─────────────────────────────────────────────────────────┐
│                      Agent Layer                         │
│  (Orchestrates tool execution via ToolManager)          │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│                    Tool Manager                          │
│  • Registration & Discovery                              │
│  • Function Definition Generation                        │
│  • Validation & Execution Pipeline                       │
│  • Permission Handling                                   │
│  • Animation Lifecycle                                   │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│              Tool Loader & Registry                      │
│  • Lazy Loading (prevents circular imports)             │
│  • Module Mapping                                        │
│  • Tool Instantiation                                    │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│                   Individual Tools                       │
│  • BaseTool inheritance                                  │
│  • Mixin composition                                     │
│  • Execute implementation                                │
└─────────────────────────────────────────────────────────┘
```

### Key Principles

1. **Lazy Loading**: Tools are loaded on-demand via `ToolLoader` to prevent circular imports
2. **Dependency Injection**: Services (UI, TrustManager, etc.) injected via `ServiceRegistry`
3. **Mixin Composition**: Shared functionality via mixins (FilePathValidationMixin, PatchMixin, etc.)
4. **Security Layers**: Permission checks, path validation, command filtering
5. **Focus-Aware**: Path resolution respects focus constraints when set

---

## Tool Lifecycle

### 1. Registration Phase

```python
# ToolLoader maps tool names to modules
_tool_modules = {
    "bash": "code_ally.tools.bash",
    "read": "code_ally.tools.read",
    # ...
}

# ToolRegistry creates instances on demand
tool_instances = registry.get_tool_instances()
```

### 2. Function Definition Generation

```python
# ToolManager generates function definitions for LLM
function_defs = tool_manager.get_function_definitions()

# For each tool:
{
    "type": "function",
    "function": {
        "name": "bash",
        "description": "Execute shell commands...",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command"},
                "description": {"type": "string", "description": "Operation description"},
                # ...
            },
            "required": ["command"]
        }
    }
}
```

### 3. Validation Phase

When LLM calls a tool:

```python
# 1. Tool existence check
if tool_name not in self.tools:
    return error_response

# 2. Redundancy check (same call in same turn)
if self._is_redundant_call(tool_name, arguments):
    return redundant_call_error

# 3. Argument validation
validation_result = self._validate_tool_arguments(tool, arguments)
if not validation_result["valid"]:
    return validation_error

# 4. File read requirement check (for write/edit/line_edit)
if tool_name in ("write", "edit", "line_edit"):
    if file not read previously:
        return read_required_error

# 5. Preview generation (for file modification tools)
preview_result = self._show_tool_preview(tool_name, arguments)
```

### 4. Permission Phase

```python
# 1. Check if tool requires confirmation
needs_confirmation = tool.requires_confirmation or is_outside_cwd

if needs_confirmation:
    # 2. Get permission path
    permission_path = self._get_permission_path(tool_name, arguments)

    # 3. Check trust manager
    if not trust_manager.is_trusted(tool_name, permission_path):
        # Prompt user for permission
        granted = trust_manager.prompt_for_permission(tool_name, permission_path)
        if not granted:
            raise PermissionDeniedError()
```

### 5. Execution Phase

```python
# 1. Start animation (if tool doesn't suppress it)
if not tool.suppress_execution_animation:
    ui.start_tool_execution_animation(tool_name, description)

# 2. Execute tool
if inspect.iscoroutinefunction(tool.execute):
    result = await tool.execute(**arguments)
else:
    result = tool.execute(**arguments)

# 3. Stop animation
if not tool.suppress_execution_animation:
    ui.stop_tool_execution_animation()

# 4. Track file operations
self._track_file_operation(tool_name, arguments, result)

# 5. Inject usage pattern suggestions
self._inject_pattern_suggestions(tool_name, arguments, result)
```

### 6. Result Formatting

```python
# Tool returns standardized dict:
{
    "success": True/False,
    "error": "" or error_message,
    # Tool-specific fields...
}
```

---

## Base Tool Class

**File:** `/Users/bhm128/CodeAlly/code_ally/tools/base.py` (328 lines)

### Class Variables (Required)

```python
class BaseTool(ABC):
    name: ClassVar[str]                           # Unique tool identifier
    description: ClassVar[str]                     # LLM-facing description
    requires_confirmation: ClassVar[bool]          # Permission requirement
    suppress_execution_animation: ClassVar[bool]   # Opt-out of standard animation (default: False)
```

### Tool Classification System

Tools are classified into three permission categories:

#### 1. NON-DESTRUCTIVE (requires_confirmation = False)
- **Read-only operations** that don't modify system state
- Examples: `read`, `glob`, `grep`, `ls`, `agent`
- **Never require user permission**, even when accessing outside CWD

#### 2. SENSITIVE (requires_confirmation = True)
- **Destructive operations** affecting single files or isolated changes
- Examples: `write`, `edit`, single-file bash commands (`rm file.txt`)
- Require permission with **"Allow", "Deny", "Always Allow"** options

#### 3. EXTREMELY_SENSITIVE (requires_confirmation = True, detected by command content)
- **Multi-file destructive operations** or system-level changes
- Examples: `rm -rf`, `find -delete`, system shutdown, privilege escalation
- Only allow **"Allow" or "Deny"** options (no "Always Allow")
- Detection handled in `trust.py` via `EXTREMELY_SENSITIVE_COMMANDS/PATTERNS`

### Instance Variables

```python
def __init__(self) -> None:
    self._diff_display_manager: DiffDisplayManager | None = None
    self.ui: Any = None  # Set by ToolManager for UI interactions
```

### Abstract Method

```python
@abstractmethod
def execute(self, **kwargs: dict[str, object]) -> dict[str, Any]:
    """Execute the tool with the given parameters.

    Args:
        **kwargs: Tool-specific parameters

    Returns:
        Dictionary containing at least:
        - success: Whether the tool execution succeeded
        - error: Error message if execution failed, empty string otherwise

        Additional key-value pairs depend on the specific tool.
    """
    raise NotImplementedError("Subclasses must implement the execute method")
```

### Response Formatting Methods

#### Error Responses

```python
def _format_error_response(
    self,
    error_message: str,
    error_type: str = "general",
    suggestion: str = "",
    **additional_fields: Any,
) -> dict[str, Any]:
    """Format a standard error response with tool name and parameter context.

    Args:
        error_message: The error message
        error_type: Type of error (user_error, system_error, permission_error, validation_error)
        suggestion: Optional suggestion for resolving the error
        **additional_fields: Additional custom fields to include in the response

    Returns:
        {
            "success": False,
            "error": "tool_name(param1='val1', ...): error_message",
            "error_type": "validation_error",
            "suggestion": "Use the Read tool first...",
            # Additional fields...
        }
    """
```

**Error Types:**
- `user_error`: Incorrect usage, invalid input
- `system_error`: Internal errors, exceptions
- `permission_error`: Access denied, focus violations
- `validation_error`: Parameter validation failures
- `security_error`: Security violations, path traversal

#### Success Responses

```python
def _format_success_response(self, **kwargs: dict[str, object]) -> dict[str, Any]:
    """Format a standard success response.

    Returns:
        {
            "success": True,
            "error": "",
            # Additional kwargs...
        }
    """
```

#### Internal Responses

```python
def _format_internal_response(self, **kwargs: dict[str, object]) -> dict[str, Any]:
    """Format a response that should be available to LLM but not displayed to user.

    Used by tools that handle their own user display (like agent tool).

    Returns:
        {
            "success": True,
            "error": "",
            "_internal_only": True,
            # Additional kwargs...
        }
    """
```

### Parameter Capture

```python
def _capture_params(self, **kwargs: Any) -> None:
    """Capture parameters for error context.

    Should be called at the beginning of execute() to capture
    the parameters for enhanced error reporting.

    Filters out None values and empty kwargs for cleaner output.
    """
    # Filter out None values and empty kwargs entries
    filtered_params = {k: v for k, v in kwargs.items() if v not in (None, {}, [])}
    self._current_params = filtered_params
```

### Result Preview System

```python
def get_result_preview(self, result: dict[str, Any], max_lines: int = 3) -> list[str]:
    """Get a preview of the tool result for display.

    This method can be overridden by individual tools to provide
    custom preview formatting for their specific result structure.

    Args:
        result: The tool execution result
        max_lines: Maximum number of lines to return

    Returns:
        List of preview lines to display (without indentation)
    """
```

**Default Implementation:**
- Skips internal-only results (`_internal_only` flag)
- Handles error results specially
- Tries common content fields: `content`, `output`, `result`, `data`
- Truncates to `max_lines` with `...` indicator

**Custom Implementations** (examples):
- **BashTool**: Shows exit code and first few lines of output
- **ReadTool**: Shows first few lines of file content
- **GrepTool**: Shows match count and first few matches
- **GlobTool**: Shows file count and first few file paths

### Diff Preview Methods

```python
def set_diff_display_manager(self, diff_display_manager: DiffDisplayManager) -> None:
    """Set the diff display manager for this tool."""
    self._diff_display_manager = diff_display_manager

def _show_diff_preview(
    self,
    old_content: str,
    new_content: str,
    file_path: str,
    operation_type: str = "edit",
) -> None:
    """Show diff preview before file operation if diff display is available."""

def _show_write_preview(
    self,
    file_path: str,
    new_content: str,
    existing_content: str | None = None,
) -> None:
    """Show preview for file write operations.

    Shows either a diff (for file overwrites) or a new file
    preview (for file creation).
    """

def _show_edit_preview(
    self,
    file_path: str,
    original_content: str,
    final_content: str,
    edits_count: int,
) -> None:
    """Show preview for edit operations.

    Displays the cumulative effect of multiple edit operations.
    """
```

---

## Tool Manager

**File:** `/Users/bhm128/CodeAlly/code_ally/agent/tool_manager.py` (879 lines)

### Initialization

```python
class ToolManager:
    def __init__(
        self,
        tools: list[BaseTool],
        trust_manager: TrustManager,
        permission_manager: PermissionManager = None,
    ) -> None:
        self.tools = {tool.name: tool for tool in tools}
        self.trust_manager = trust_manager
        self.permission_manager = permission_manager or PermissionManager(trust_manager)
        self._ui = None  # Will be set by the Agent class
        self.client_type = None  # Will be set by the Agent when initialized

        # Track recent tool calls to avoid redundancy
        self.recent_tool_calls: list[tuple[str, tuple]] = []
        self.max_recent_calls = 5
        self.current_turn_tool_calls: list[tuple[str, tuple]] = []

        # Performance monitoring
        self._tool_performance_stats: dict[str, dict[str, Any]] = {}

        # Track files that have been read in this session with timestamps
        self._read_files: dict[str, float] = {}  # file_path -> read_timestamp
```

### UI Manager Propagation

```python
@property
def ui(self):
    """Get the UI manager."""
    return self._ui

@ui.setter
def ui(self, value):
    """Set the UI manager and propagate to all tools."""
    self._ui = value
    # Propagate UI to all tools
    for tool in self.tools.values():
        tool.ui = value
```

### Function Definition Generation

```python
def get_function_definitions(self) -> list[dict[str, Any]]:
    """Create function definitions for tools in the format expected by the LLM.

    Returns:
        List of function definitions for LLM function calling
    """
    function_defs = []
    for tool in self.tools.values():
        # Check if tool has a custom get_function_definition method
        if hasattr(tool, 'get_function_definition') and callable(tool.get_function_definition):
            # Use tool's custom function definition
            function_def = tool.get_function_definition()
        else:
            # Generate default function definition
            function_def = {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": self._generate_dynamic_parameters(tool),
                },
            }
        function_defs.append(function_def)

    return function_defs
```

### Dynamic Parameter Generation

```python
def _generate_dynamic_parameters(self, tool: BaseTool) -> dict[str, Any]:
    """Generate parameter schema dynamically with improved descriptions.

    Uses inspect.signature to introspect tool.execute method and build
    parameter schema automatically.

    Returns:
        {
            "type": "object",
            "properties": {
                "param_name": {
                    "type": "string|integer|boolean|array",
                    "description": "Concise description"
                },
                # ...
            },
            "required": ["param1", "param2"]
        }
    """
```

**Type Mapping:**
- `int` annotation → `"integer"`
- `bool` annotation → `"boolean"`
- `list` annotation → `"array"`
- `float` annotation → `"number"`
- Default → `"string"`

**Description Map** (concise for token efficiency):
```python
description_map = {
    "file_path": "File path",
    "path": "Directory to search",
    "content": "Content to write",
    "command": "Shell command",
    "pattern": "Search pattern (regex)",
    "old_string": "Text to replace",
    "new_string": "Replacement text",
    "limit": "Max lines to read",
    "offset": "Start line number",
    "edits": "Array of edit operations, each with old_string, new_string, and optional replace_all",
    # ...
}
```

### Argument Validation

```python
def _validate_tool_arguments(
    self,
    tool: BaseTool,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    """Lightweight validation of tool arguments with enhanced error messages.

    Checks:
    1. All required parameters are present
    2. Generates helpful examples for missing parameters

    Returns:
        {
            "valid": True,
        }

        # OR

        {
            "valid": False,
            "error": "Missing required parameter 'file_path' for read",
            "error_type": "validation_error",
            "suggestion": "Example: read(file_path=\"src/main.py\")",
        }
    """
```

### Tool Execution Pipeline

```python
async def execute_tool(
    self,
    tool_name: str,
    arguments: dict[str, Any],
    check_context_msg: bool = True,
    client_type: str | None = None,
    pre_approved: bool = False,
) -> dict[str, Any]:
    """Execute a tool with the given arguments after checking trust.

    Pipeline:
    1. Validate tool existence
    2. Check for redundant calls
    3. Validate arguments
    4. Validate file read requirements (for write/edit/line_edit)
    5. Show preview (for file modification tools)
    6. Check permissions
    7. Execute tool
    8. Track file operations
    9. Inject usage pattern suggestions

    Returns:
        Tool result dictionary

    Raises:
        PermissionDeniedError: If permission is denied
    """
```

### Redundancy Detection

```python
def _is_redundant_call(self, tool_name: str, arguments: dict[str, Any]) -> bool:
    """Check if a tool call is redundant.

    Only considers calls made in the current conversation turn as redundant.

    Implementation:
    - Creates hashable tuple: (tool_name, sorted(arguments.items()))
    - Checks against current_turn_tool_calls
    """
```

### File Read Requirement Validation

```python
def _validate_file_read_requirement(self, file_path: str) -> dict[str, Any] | None:
    """Validate that a file has been read before modification.

    Checks:
    1. If file doesn't exist, allow modification (new file creation)
    2. If file exists but hasn't been read, return error
    3. If file was read but modified since read, return error

    Returns:
        None if validation passes, error dict if validation fails

    Error response format:
        {
            "valid": False,
            "error": "File exists but has not been read...",
            "error_type": "validation_error",
            "suggestion": "Use the Read tool to examine the file..."
        }
    """
```

### Permission Handling

```python
def _get_permission_path(
    self,
    tool_name: str,
    arguments: dict[str, Any],
) -> str | None:
    """Get the permission path for a tool.

    - For bash tool: returns arguments dict (command-based permission)
    - For other tools: returns first string argument matching file_path/path/working_dir
    """

def _is_accessing_outside_cwd(
    self, tool_name: str, arguments: dict[str, Any],
) -> bool:
    """Check if tool is accessing paths outside current working directory.

    Uses focus-aware path resolution for consistent validation.
    Checks file_path and path arguments.
    """
```

### Preview Generation

```python
def _show_tool_preview(
    self,
    tool_name: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    """Show preview for file modification tools before execution.

    Supported tools:
    - write: Shows diff for overwrites, new file preview for creation
    - edit: Shows cumulative effect of all edit operations
    - line_edit: Shows line-based replacements

    Returns:
        {"success": True} or error dict
    """
```

### File Operation Tracking

```python
def _track_file_operation(
    self,
    tool_name: str,
    arguments: dict[str, Any],
    result: dict[str, Any],
) -> None:
    """Track file operations for read-before-write validation.

    Tracking:
    - read tool: Updates _read_files with current timestamp for each file
    - write/edit/line_edit tools: Updates _read_files timestamp (model has current version)

    Uses focus-aware path resolution for consistent tracking.
    """
```

### Animation Lifecycle Management

```python
async def _perform_tool_execution(
    self,
    tool_name: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    """Execute a tool with the given arguments.

    Animation lifecycle:
    1. Check suppress_execution_animation flag
    2. If not suppressed, call ui.start_tool_execution_animation(tool_name, description)
    3. Execute tool (handle both sync and async)
    4. Call ui.stop_tool_execution_animation()
    5. On error, ensure animation is stopped

    Returns:
        Tool result dictionary
    """
```

**Important:** Tools can opt out of standard animation by setting:
```python
suppress_execution_animation: ClassVar[bool] = True
```

Examples:
- **AgentTool**: Manages its own display lifecycle via DelegationUIManager
- **Standard tools**: Use default animation

### Performance Monitoring

```python
def _record_tool_performance(
    self,
    tool_name: str,
    execution_time: float,
    success: bool,
    arguments: dict[str, Any],
) -> None:
    """Record performance metrics for tool execution.

    Tracks:
    - total_calls
    - successful_calls
    - total_time
    - avg_time
    - min_time
    - max_time
    - success_rate
    """

def get_performance_stats(self) -> dict[str, dict[str, Any]]:
    """Get performance statistics for all tools."""
```

---

## Tool Loader & Registry

### Tool Loader

**File:** `/Users/bhm128/CodeAlly/code_ally/tools/loader.py` (132 lines)

```python
class ToolLoader:
    """Manages loading of tools to prevent circular imports.

    Implements singleton pattern for consistent tool loading.
    """

    _instance: Optional["ToolLoader"] = None
    _tool_modules: dict[str, str] = {
        # Claude Code compatible tools
        "bash": "code_ally.tools.bash",
        "read": "code_ally.tools.read",
        "write": "code_ally.tools.write",
        "edit": "code_ally.tools.edit",
        "line_edit": "code_ally.tools.line_edit",
        "glob": "code_ally.tools.glob",
        "grep": "code_ally.tools.grep",
        "ls": "code_ally.tools.ls",
        "lint": "code_ally.tools.lint",
        "format": "code_ally.tools.format",
        "agent": "code_ally.tools.agent",
        "todo_add": "code_ally.tools.todo_add",
        "todo_complete": "code_ally.tools.todo_complete",
        "todo_clear": "code_ally.tools.todo_clear",
        "cleanup_tool_call": "code_ally.tools.cleanup_tool_call",
        "ally_write": "code_ally.tools.ally_write",
    }

    def get_tool_class(self, tool_name: str) -> type[BaseTool] | None:
        """Get a tool class by name, loading it if needed.

        1. Check if we have a module mapping for this tool
        2. Dynamically import the module
        3. Find the tool class in the module (match by tool.name attribute)
        """

    def _find_tool_class_in_module(
        self,
        module: Any,
        tool_name: str,
    ) -> type[BaseTool] | None:
        """Find the tool class in a module by examining all classes.

        Searches for:
        - Class that inherits from BaseTool
        - Has 'name' attribute matching tool_name
        """

    def get_all_tool_names(self) -> list[str]:
        """Get a list of all available tool names."""
```

### Tool Registry

**File:** `/Users/bhm128/CodeAlly/code_ally/tools/registry.py` (144 lines)

```python
class ToolRegistry:
    """Registry for all available tools in the system using lazy loading.

    Implements singleton pattern.
    """

    _instance: Optional["ToolRegistry"] = None

    def get_tool_classes(self) -> dict[str, type[BaseTool]]:
        """Get all available tool classes using lazy loading."""

    def get_tool_instances(self) -> list[BaseTool]:
        """Create instances of all available tools."""

    def get_tool_by_name(self, name: str) -> type[BaseTool] | None:
        """Get a specific tool class by name using lazy loading."""

    def get_tool_instance_by_name(self, name: str) -> BaseTool | None:
        """Get a specific tool instance by name."""

    def get_tools_for_prompt(self) -> str:
        """Get formatted tool list for the system prompt.

        Returns:
            Formatted string listing all tools with descriptions
        """
```

---

## Individual Tools Reference

### Agent Tool (agent.py)

**Purpose:** Delegate tasks to specialized agents concurrently

**Classification:** NON-DESTRUCTIVE (read-only delegation)

**Parameters:**
```python
{
    "agents": [  # Required, array of agent specs
        {
            "agent_name": "general",  # Optional, default: "general"
            "task_prompt": "Task instructions"  # Required
        }
    ]
}
```

**Returns:**
```python
{
    "success": True,
    "agents_completed": 2,
    "agents_failed": 0,
    "results": [
        {
            "agent_index": 0,
            "agent_name": "general",
            "success": True,
            "result": "Agent's response",
            "duration_seconds": 5.2
        }
    ]
}
```

**Special Features:**
- **Concurrent Execution:** Runs multiple agents in parallel using `asyncio.gather`
- **Custom Animation:** Suppresses standard animation, uses DelegationUIManager
- **Nested Delegation Prevention:** Checks execution context to prevent recursion
- **Tool Wrapping:** Wraps tools for sub-agents to suppress display during delegation
- **Agent-Specific Models:** Supports custom model/temperature per agent
- **Interrupt Handling:** Gracefully handles Ctrl+C during sub-agent execution

**Validation:**
- Each agent spec must have `task_prompt` (required)
- `agent_name` must be string if provided
- Checks for nested delegation via execution context

**Active Delegation Tracking:**
```python
def get_active_delegations(self) -> dict[str, dict[str, Any]]:
    """Get currently active delegations.

    Returns:
        {
            "call_id": {
                "sub_agent": agent_instance,
                "agent_name": "general",
                "task_prompt": "...",
                "start_time": 1234567890.123
            }
        }
    """
```

### Bash Tool (bash.py)

**Purpose:** Execute shell commands safely

**Classification:** SENSITIVE (can be EXTREMELY_SENSITIVE based on command content)

**Parameters:**
```python
{
    "command": "ls -la",           # Required
    "description": "List files",   # Optional (5-10 words, shown in UI)
    "timeout": 5,                  # Optional (default: 5, max: 60 seconds)
    "working_dir": ""              # Optional (default: current directory)
}
```

**Returns:**
```python
{
    "success": True,
    "output": "stdout content",
    "error": "stderr content",
    "return_code": 0
}
```

**Special Features:**

1. **Real-Time Streaming:**
   - Shows command output line-by-line during execution
   - Uses `select` (Unix) or threading (Windows) for non-blocking I/O
   - Calls `ui.start_tool_output_streaming()` and `ui.update_tool_output_streaming(line)`

2. **Cancellation Support:**
   - Checks interrupt coordinator's cancellation event
   - Terminates process gracefully (SIGTERM, then SIGKILL if needed)
   - Returns partial output if cancelled

3. **Interactive Command Detection:**
   - Detects commands likely to require user input
   - Suggests non-interactive alternatives
   - Increases timeout automatically for interactive commands
   - Patterns: `input()`, `read`, SSH, database clients, editors

4. **Security Validation:**
   - Checks against `DISALLOWED_COMMANDS` list
   - Validates working directory path
   - Detects path traversal attempts

**Timeout Handling:**
```python
# Default: 5 seconds
# Interactive commands: 15 seconds
# Max allowed: 60 seconds
```

**Error Messages Include:**
- Timeout with suggestions for interactive commands
- Security violations (disallowed commands)
- Working directory errors
- Cancellation notices

### Edit Tool (edit.py)

**Purpose:** Make find-and-replace edits to files atomically

**Classification:** SENSITIVE (file modification)

**Parameters:**
```python
{
    "file_path": "src/main.py",  # Required
    "edits": [                   # Required, array of edit operations
        {
            "old_string": "def hello():",      # Required
            "new_string": "def hello_world():", # Required
            "replace_all": False                # Optional, default: false
        }
    ]
}
```

**Returns:**
```python
{
    "success": True,
    "edits_applied": 1,
    "file_path": "/absolute/path/to/file.py",
    "patch_number": 42,  # For undo functionality
    "file_check": {      # Automatic syntax checking
        "checker": "python",
        "passed": False,
        "errors": [
            {
                "line": 10,
                "message": "invalid syntax",
                "source": "def hello_world(",
                "marker": "                 ^"
            }
        ]
    },
    "recently_modified": ["src/main.py", "src/utils.py"]  # Context for model
}
```

**Validation:**

1. **Edit Structure:**
   - `old_string` and `new_string` must be strings
   - `old_string` != `new_string`
   - `replace_all` must be boolean

2. **String Matching:**
   - Without `replace_all`: `old_string` must appear exactly once
   - With `replace_all`: `old_string` must exist at least once
   - If not found: suggests similar strings

3. **Similar String Detection:**
   ```python
   def _find_similar_strings(self, text: str, target: str, n: int = 3, cutoff: float = 0.6):
       """Finds strings similar to target.

       Checks for:
       - Whitespace/indentation differences
       - Capitalization differences
       - Internal whitespace differences
       - Substring matches
       - Fuzzy matches (difflib)
       """
   ```

**Features:**

- **Atomic Operations:** All edits succeed or all fail
- **Sequential Application:** Edits applied one after another
- **Patch Capture:** Every edit operation captured for undo
- **File Checking:** Automatic syntax/parse validation after edit
- **Recent Files Context:** Includes recently modified files for model awareness

### Read Tool (read.py)

**Purpose:** Read multiple file contents at once

**Classification:** NON-DESTRUCTIVE (read-only)

**Parameters:**
```python
{
    "file_paths": ["src/main.py", "src/utils.py"],  # Required, array
    "limit": 0,   # Optional, lines per file (0 = all)
    "offset": 0   # Optional, start line (1-based)
}
```

**Returns:**
```python
{
    "success": True,
    "content": """
=== /path/to/src/main.py ===
     1\timport os
     2\t
     3\tdef main():
     4\t    pass

=== /path/to/src/utils.py ===
     1\tdef helper():
     2\t    return True
""",
    "files_read": 2
}
```

**Special Features:**

1. **Token Estimation:**
   - Estimates tokens before reading full files
   - Rejects if total estimated tokens > 1500
   - Samples first 10KB to estimate token density
   - Includes line number overhead in estimate

2. **Multi-File Support:**
   - Reads multiple files in single call
   - Adds file separators (`=== path ===`)
   - Continues on individual file errors

3. **Line Numbering:**
   - Uses 6-character width for line numbers
   - Format: `{line_num:6}\t{content}`
   - Preserves exact line content (no stripping)

4. **Binary Detection:**
   - Checks for null bytes in first 1KB
   - Shows `[Binary file - content not displayed]`

5. **File Activity Tracking:**
   - Records read timestamp for each file
   - Used by write/edit validation

**Validation:**
- All paths must be within CWD (security)
- All paths must exist and be files
- Focus constraints respected

### Write Tool (write.py)

**Purpose:** Create or overwrite files

**Classification:** SENSITIVE (file modification)

**Parameters:**
```python
{
    "file_path": "output.txt",  # Required
    "content": "Hello world"    # Required
}
```

**Returns:**
```python
{
    "success": True,
    "file_path": "/absolute/path/to/output.txt",
    "bytes_written": 11,
    "patch_number": 43,
    "file_check": {...},         # If applicable
    "recently_modified": [...]    # Context
}
```

**Special Features:**

1. **Directory Creation:**
   - Automatically creates parent directories if needed
   - Uses `os.makedirs(directory, exist_ok=True)`

2. **Diff Preview:**
   - Shows diff for file overwrites (handled by tool manager)
   - Shows new file preview for creation
   - Displayed BEFORE permission prompt

3. **Patch Capture:**
   - Captures original content for undo
   - Stores diff between original and new content

4. **File Checking:**
   - Runs syntax/parse validation after write
   - Returns errors in response for model feedback

### Glob Tool (glob.py)

**Purpose:** Find files using glob patterns

**Classification:** NON-DESTRUCTIVE (pattern matching)

**Parameters:**
```python
{
    "pattern": "**/*.py",  # Required (glob syntax)
    "path": ".",           # Optional (default: current directory)
    "limit": 50,           # Optional (default: 50, max: 1000)
    "show_content": False, # Optional (show file previews)
    "content_lines": 10    # Optional (lines per preview)
}
```

**Returns:**
```python
{
    "success": True,
    "files": ["/path/to/file1.py", "/path/to/file2.py"],
    "total_matches": 25,
    "limited": False,
    "show_content": False,
    "suggestion": "No files found. Check your glob pattern..."  # If 0 matches
}
```

**With content preview:**
```python
{
    "files": {
        "/path/to/file1.py": "import os\nimport sys\n...",
        "/path/to/file2.py": "[Binary file]"
    }
}
```

**Glob Patterns:**
- `*.py`: Python files in current directory
- `**/*.py`: Python files recursively
- `src/**/*test*`: Test files in src directory
- `**/models/*.{py,js}`: Python or JS files in models directories

**Sorting:**
- Files sorted by modification time (newest first)

**Validation:**
- Pattern checked for security (path traversal)
- Path validated for existence

### Grep Tool (grep.py)

**Purpose:** Search files for text patterns

**Classification:** NON-DESTRUCTIVE (text search)

**Parameters:**
```python
{
    "pattern": "class.*Test",   # Required (regex)
    "path": ".",                # Optional (default: current directory)
    "file_types": ".py,.js",    # Optional (comma-separated extensions)
    "include": "*",             # Optional (glob pattern for files)
    "exclude": "",              # Optional (glob pattern to exclude)
    "max_depth": -1,            # Optional (directory depth, -1 = unlimited)
    "case_sensitive": False,    # Optional
    "whole_words": False,       # Optional (wrap pattern with \b)
    "max_results": 50           # Optional (default: 50, max: 1000)
}
```

**Returns:**
```python
{
    "success": True,
    "matches": [
        {
            "file": "/path/to/file.py",
            "line": 42,
            "content": "class TestCase:"
        }
    ],
    "replacements": [],  # If replace used
    "total_matches": 15,
    "limited_results": False,
    "files_searched": 123,
    "suggestion": "No matches found. Try a broader pattern..."  # If 0 matches
}
```

**Special Features:**

1. **Streaming Updates:**
   - Shows progress during large searches
   - Calls `ui.start_tool_output_streaming()` and `ui.update_tool_output_streaming()`

2. **Regex Support:**
   - Full Python regex syntax
   - Case-insensitive mode
   - Whole word matching

3. **File Type Filtering:**
   - Handles `.py,.js` format
   - Handles `*.py` format
   - Handles `*` for all files

4. **Binary File Skipping:**
   - Automatically skips binary files
   - Uses null byte detection

5. **Search and Replace** (advanced):
   - `replace`: Replacement string
   - `preview_replace`: Show preview without modifying

**Sorting:**
- Results sorted by file modification time (newest first)

### Line Edit Tool (line_edit.py)

**Purpose:** Replace specific lines in a file by line number

**Classification:** SENSITIVE (file modification)

**Parameters:**
```python
{
    "file_path": "src/main.py",  # Required
    "edits": [                   # Required, array
        {
            "start_line": 10,              # Required (1-based)
            "end_line": 10,                # Required (1-based, inclusive)
            "new_content": "    return True"  # Required (string or array)
        }
    ]
}
```

**Returns:**
```python
{
    "success": True,
    "edits_applied": 1,
    "file_path": "/absolute/path/to/file.py",
    "patch_number": 44,
    "file_check": {...},
    "recently_modified": [...]
}
```

**Content Formats:**

1. **String Format:**
   ```python
   "new_content": "    if x:\n        return y"
   ```

2. **Array Format (recommended for clarity):**
   ```python
   "new_content": ["    if x:", "        return y"]
   ```

3. **Empty (delete lines):**
   ```python
   "new_content": ""  # or []
   ```

**Use Cases:**

1. **Replace single line:**
   ```python
   {"start_line": 10, "end_line": 10, "new_content": "    return True"}
   ```

2. **Replace multiple lines with single line:**
   ```python
   {"start_line": 15, "end_line": 17, "new_content": "    # Simplified"}
   ```

3. **Replace single line with multiple lines:**
   ```python
   {"start_line": 20, "end_line": 20, "new_content": ["    if x:", "        return y"]}
   ```

4. **Delete lines:**
   ```python
   {"start_line": 25, "end_line": 27, "new_content": ""}
   ```

**Validation:**

1. **Line Numbers:**
   - Must be >= 1
   - `start_line` <= `end_line`
   - Must exist in file (with helpful context on error)

2. **Content Format:**
   - String or array of strings
   - If array, all elements must be strings

3. **Conflict Detection:**
   - Warns about overlapping line ranges
   - Warns about line number shifts with multiple edits

**Special Features:**

- **Line Ending Preservation:** Detects and preserves `\n`, `\r\n`, or `\r`
- **Sequential Application:** Edits applied one after another
- **Context on Error:** Shows surrounding lines when line number is invalid

### LS Tool (ls.py)

**Purpose:** List files and directories

**Classification:** NON-DESTRUCTIVE (directory listing)

**Parameters:**
```python
{
    "file_path": ".",              # Required (directory path)
    "ignore": ["*.pyc", "__pycache__"]  # Optional (glob patterns)
}
```

**Returns:**
```python
{
    "success": True,
    "files": [
        {
            "name": "main.py",
            "path": "/absolute/path/to/main.py",
            "type": "file",
            "size": 1234,
            "modified": 1634567890.123,
            "permissions": "644",
            "extension": ".py"
        },
        {
            "name": "src",
            "path": "/absolute/path/to/src",
            "type": "directory",
            "size": None,
            "modified": 1634567890.123,
            "permissions": "755"
        }
    ],
    "total_count": 25,
    "shown_count": 25,
    "directory_path": "/absolute/path",
    "truncated": False,
    "guidance": "Directory listing truncated..."  # If truncated
}
```

**Sorting:**
- Directories first, then files
- Alphabetically within each group

**Truncation:**
- Results limited to 50 items (DEFAULT_LIST_LIMIT)
- `truncated` flag indicates if results were cut off

### Todo Tools

#### todo_add.py

```python
{
    "tasks": ["Task 1", "Task 2", "Task 3"]  # Required, array of strings
}
```

**Returns:**
```python
{
    "success": True,
    "todos": [
        {"id": "uuid", "task": "Task 1", "completed": False, "created_at": "..."},
        {"id": "uuid", "task": "Task 2", "completed": False, "created_at": "..."}
    ],
    "total_count": 2,
    "message": "Added 2 task(s) to todo list..."
}
```

**Features:**
- Generates UUID for each task
- First incomplete task auto-highlighted as NEXT
- Displays updated todo UI

#### todo_complete.py

```python
{
    "index": 0  # Required, 0-based index
}
```

#### todo_clear.py

```python
{}  # No parameters, clears entire list
```

---

## Mixins System

**File:** `/Users/bhm128/CodeAlly/code_ally/tools/mixins.py` (746 lines)

### FilePathValidationMixin

**Purpose:** Centralized file path validation with security checks

**Key Methods:**

```python
def _validate_file_path(
    self,
    file_path: str,
    check_exists: bool = True,
    must_be_file: bool = True,
    must_be_dir: bool = False,
    allow_creation: bool = False,
    allow_outside_cwd: bool = False,
) -> tuple[str, dict[str, Any] | None]:
    """Centralized file path validation.

    Returns:
        (normalized_path, error_response)
        error_response is None if valid
    """
```

**Validation Steps:**

1. **Security Check:** Path traversal detection (`../`, `..\\`)
2. **Path Normalization:** Focus-aware resolution via PathResolver
3. **CWD Constraint:** Rejects paths outside CWD (unless allowed)
4. **Focus Constraint:** Validates against focus manager constraints
5. **Existence Check:** Validates file/directory existence
6. **Type Check:** Validates file vs directory type

**Security Patterns:**
```python
TRAVERSAL_PATTERNS = [
    r"\.\./",      # Basic ../ pattern
    r"\.\.\\+",    # ..\\  pattern for Windows
    r"\/\.\.\//",  # /../ pattern
    r"\\\.\.\\+",  # \\..\\  pattern for Windows
    r"\.\.",       # Simple .. pattern
]
```

**Focus Integration:**
```python
def _check_focus_constraint(self, normalized_path: str) -> tuple[bool, str]:
    """Check if path satisfies focus constraints.

    Returns:
        (is_valid, error_message)
    """
```

**Similar File Suggestions:**
```python
def _get_file_not_found_suggestion(self, file_path: str) -> str:
    """Generate helpful suggestions when a file is not found.

    Uses fuzzy matching to suggest similar filenames.
    """
```

**Helper Methods:**
```python
def _is_binary_file(self, file_path: str) -> bool:
    """Check if a file appears to be binary (null byte detection)."""

def _get_file_size(self, file_path: str) -> int:
    """Get file size safely."""

def _validate_path_parameter(
    self, path: str, param_name: str = "path", allow_outside_cwd: bool = False,
) -> tuple[str, dict[str, Any] | None]:
    """Validate a path parameter for search operations."""
```

### ParameterValidationMixin

**Purpose:** Parameter validation and type coercion utilities

**Methods:**

```python
def _safe_int_convert(
    self,
    value: Any,
    default: int,
    min_val: int | None = None,
    max_val: int | None = None,
) -> int:
    """Safely convert parameter to integer with validation."""

def _safe_bool_convert(self, value: Any, default: bool) -> bool:
    """Safely convert parameter to boolean."""

def _safe_str_convert(
    self, value: Any, default: str = "", max_length: int | None = None,
) -> str:
    """Safely convert parameter to string with length validation."""

def _validate_enum_parameter(
    self,
    value: Any,
    valid_values: list[str],
    default: str,
    param_name: str = "parameter",
) -> str:
    """Validate that a parameter is one of the allowed values."""

def _extract_kwargs_with_defaults(
    self, kwargs: dict[str, Any], param_config: dict[str, tuple],
) -> dict[str, Any]:
    """Extract and validate kwargs using parameter configuration.

    param_config format:
        {
            "param_name": (default_value, converter_func, validator_func)
        }
    """
```

**Example Usage:**
```python
param_config = {
    "limit": (50, lambda x: self._safe_int_convert(x, 50, min_val=1, max_val=1000)),
    "case_sensitive": (False, lambda x: self._safe_bool_convert(x, False)),
}

params = self._extract_kwargs_with_defaults(kwargs, param_config)
limit = params["limit"]
case_sensitive = params["case_sensitive"]
```

### PatchMixin

**Purpose:** Patch capture functionality for file operations

**Integration:**
```python
@property
def patch_manager(self) -> PatchManager:
    """Get the patch manager instance from service registry."""
    return self.get_patch_manager()
```

**Methods:**

```python
def _capture_operation_patch(
    self,
    operation_type: str,
    file_path: str,
    original_content: str,
    new_content: str = None
) -> int | None:
    """Capture a file operation as a patch.

    Args:
        operation_type: 'write', 'edit', 'line_edit', 'delete'
        file_path: Path to the file being modified
        original_content: Original content of the file
        new_content: New content after operation (None for delete)

    Returns:
        Patch number if successful, None otherwise
    """

def _read_file_safely(self, file_path: str) -> str:
    """Read file content safely, returning empty string if file doesn't exist."""
```

**Undo System:**
- Every file modification captured as patch
- Stores diff between original and new content
- Patch number returned in tool response
- Used by undo functionality

### FileActivityMixin

**Purpose:** Tracking and reporting file activity

**Methods:**

```python
def _record_file_activity(self, file_path: str, operation: str) -> None:
    """Record a file access operation.

    Args:
        file_path: Path to file that was accessed
        operation: 'read', 'write', 'edit', 'line_edit'
    """

def _get_recent_files_context(self) -> dict[str, Any] | None:
    """Get recently accessed files for context.

    Returns:
        {
            "recently_modified": ["src/main.py", "src/utils.py"]
        }
    """
```

**Constants:**
```python
MAX_RECENT_FILES_IN_RESPONSE = 5
```

**Purpose:** Helps models maintain context by including recently modified files in responses

### FileCheckMixin

**Purpose:** Automatic file checking after modifications

**Methods:**

```python
def _check_file_after_modification(
    self,
    file_path: str,
    enable_checking: bool = True
) -> dict[str, Any] | None:
    """Check file after modification and return concise results.

    Returns:
        {
            "checker": "python",
            "passed": False,
            "errors": [
                {
                    "line": 10,
                    "message": "invalid syntax",
                    "source": "def hello_world(",
                    "marker": "                 ^"
                }
            ],
            "additional_errors": 5,  # If more than MAX_ERRORS_IN_RESPONSE
            "message": "Showing 10 of 15 errors. Fix these first."
        }
    """

def _format_error_with_context(
    self,
    error: 'CheckIssue',
    content_lines: list[str]
) -> dict[str, Any]:
    """Format error with source code context."""
```

**Constants:**
```python
MAX_ERRORS_IN_RESPONSE = 10
```

**Supported Checkers:**
- Python: AST parsing, syntax validation
- JavaScript/TypeScript: (if configured)
- Other languages: (extensible via checker registry)

**Integration:**
- Automatically called after write/edit/line_edit
- Results included in tool response
- Only shows errors (not warnings) for context efficiency

---

## Function Definition Schema

### Standard Schema Format

```json
{
    "type": "function",
    "function": {
        "name": "tool_name",
        "description": "Clear description of what the tool does",
        "parameters": {
            "type": "object",
            "properties": {
                "param_name": {
                    "type": "string|integer|boolean|array|number",
                    "description": "Concise parameter description"
                }
            },
            "required": ["required_param1", "required_param2"]
        }
    }
}
```

### Custom Function Definitions

Tools can override default schema generation:

```python
class CustomTool(BaseTool):
    def get_function_definition(self) -> dict[str, Any]:
        """Provide custom function definition."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    # Custom schema...
                }
            }
        }
```

**Example: LineEditTool**

```json
{
    "type": "function",
    "function": {
        "name": "line_edit",
        "description": "Replace specific lines in a file by line number...",
        "parameters": {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Path to the file to modify"
                },
                "edits": {
                    "type": "array",
                    "description": "Array of line-based edits...",
                    "items": {
                        "type": "object",
                        "properties": {
                            "start_line": {
                                "type": "integer",
                                "description": "First line number to replace (1-based)"
                            },
                            "end_line": {
                                "type": "integer",
                                "description": "Last line number to replace (1-based, inclusive)"
                            },
                            "new_content": {
                                "description": "Content to replace line range. Can be: (1) string with \\n for multi-line, or (2) array of strings"
                            }
                        },
                        "required": ["start_line", "end_line", "new_content"]
                    }
                }
            },
            "required": ["file_path", "edits"]
        }
    }
}
```

### Type Mapping

**Python Type → JSON Schema Type:**
```python
int, "int"     → "integer"
bool, "bool"   → "boolean"
list, "list"   → "array"
float, "float" → "number"
str, default   → "string"
```

### Description Optimization

Descriptions are kept concise for token efficiency:

```python
# Optimized descriptions
"file_path" → "File path"
"pattern"   → "Search pattern (regex)"
"edits"     → "Array of edit operations, each with old_string, new_string, and optional replace_all"

# NOT verbose descriptions
"file_path" → "The absolute or relative path to the file that you want to modify or read"
```

---

## Extension Guide

### Creating a New Tool

1. **Create tool file:** `code_ally/tools/my_tool.py`

```python
from typing import Any
from code_ally.tools.base import BaseTool
from code_ally.tools.mixins import (
    FilePathValidationMixin,
    ParameterValidationMixin,
)

class MyTool(BaseTool, FilePathValidationMixin, ParameterValidationMixin):
    """Tool description."""

    # Required class variables
    name = "my_tool"
    description = "What my tool does"
    requires_confirmation = False  # True for destructive operations

    def __init__(self) -> None:
        """Initialize all mixins."""
        BaseTool.__init__(self)
        FilePathValidationMixin.__init__(self)
        ParameterValidationMixin.__init__(self)

    def execute(
        self,
        required_param: str,
        optional_param: int = 0,
        **kwargs: dict[str, object],
    ) -> dict[str, Any]:
        """Execute the tool.

        Args:
            required_param: Description
            optional_param: Description
            **kwargs: Additional arguments

        Returns:
            Tool result dictionary
        """
        # Capture parameters for error context
        self._capture_params(
            required_param=required_param,
            optional_param=optional_param,
            **kwargs
        )

        # Validate parameters
        if not required_param:
            return self._format_error_response(
                "required_param is required",
                error_type="validation_error",
            )

        try:
            # Tool implementation...
            result = "success"

            return self._format_success_response(
                result=result,
            )

        except Exception as e:
            return self._format_error_response(
                f"Error executing tool: {str(e)}",
                error_type="system_error",
            )
```

2. **Register in ToolLoader:**

```python
# code_ally/tools/loader.py
_tool_modules = {
    # ...
    "my_tool": "code_ally.tools.my_tool",
}
```

3. **Test the tool:**

```python
# tests/tools/test_my_tool.py
import pytest
from code_ally.tools.my_tool import MyTool

def test_my_tool_success():
    tool = MyTool()
    result = tool.execute(required_param="test")
    assert result["success"] is True

def test_my_tool_validation():
    tool = MyTool()
    result = tool.execute(required_param="")
    assert result["success"] is False
    assert "validation_error" in result["error_type"]
```

### Using Mixins

**FilePathValidationMixin:**
```python
# Validate file paths
abs_path, error_response = self._validate_file_path(
    file_path,
    check_exists=True,
    must_be_file=True,
    allow_outside_cwd=False,
)
if error_response:
    return error_response
```

**ParameterValidationMixin:**
```python
# Safe type conversion
limit = self._safe_int_convert(limit, default=50, min_val=1, max_val=1000)
case_sensitive = self._safe_bool_convert(case_sensitive, default=False)
```

**PatchMixin:**
```python
# Capture operation for undo
original_content = self._read_file_safely(file_path)
# ... perform modification ...
patch_number = self._capture_operation_patch(
    operation_type="write",
    file_path=file_path,
    original_content=original_content,
    new_content=new_content
)
```

**FileActivityMixin:**
```python
# Record file access
self._record_file_activity(file_path, "write")

# Get recent files for context
recent_context = self._get_recent_files_context()
if recent_context:
    result.update(recent_context)
```

**FileCheckMixin:**
```python
# Automatic syntax checking
check_result = self._check_file_after_modification(file_path)
if check_result:
    result["file_check"] = check_result
```

### Custom Result Preview

```python
def get_result_preview(self, result: dict[str, Any], max_lines: int = 3) -> list[str]:
    """Get a custom preview for this tool's results.

    Args:
        result: The tool execution result
        max_lines: Maximum number of lines to return

    Returns:
        List of preview lines
    """
    # Handle errors with base class
    if not result.get("success", True):
        return super().get_result_preview(result, max_lines)

    # Custom preview logic
    items = result.get("items", [])
    if not items:
        return ["No items found"]

    lines = [f"Found {len(items)} items:"]
    for i, item in enumerate(items[:max_lines-1]):
        lines.append(f"- {item}")

    if len(items) > max_lines-1:
        lines.append("...")

    return lines
```

### Custom Animation Control

```python
class MyTool(BaseTool):
    # Suppress standard animation
    suppress_execution_animation = True

    async def execute(self, **kwargs):
        # Manage your own animation
        if self.ui:
            self.ui.custom_animation_start()

        try:
            # ... tool logic ...
            pass
        finally:
            if self.ui:
                self.ui.custom_animation_stop()
```

### Async Tool Implementation

```python
class MyAsyncTool(BaseTool):
    name = "my_async_tool"
    description = "Async tool example"
    requires_confirmation = False

    async def execute(self, **kwargs) -> dict[str, Any]:
        """Async execution."""
        # Capture params
        self._capture_params(**kwargs)

        try:
            # Async operations
            result = await self._async_operation()

            return self._format_success_response(
                result=result,
            )
        except Exception as e:
            return self._format_error_response(
                str(e),
                error_type="system_error",
            )

    async def _async_operation(self):
        """Async helper method."""
        await asyncio.sleep(1)
        return "success"
```

**Note:** ToolManager automatically detects async tools and awaits them.

---

## Summary Statistics

- **Total Tool Files:** 22
- **Total Lines of Tool Code:** ~6,455 lines
- **Core Components:**
  - `base.py`: 328 lines
  - `tool_manager.py`: 879 lines
  - `loader.py`: 132 lines
  - `registry.py`: 144 lines
  - `mixins.py`: 746 lines

**Tool Count by Type:**
- File Operations: 4 (read, write, edit, line_edit)
- Search Tools: 3 (glob, grep, ls)
- Execution: 1 (bash)
- Delegation: 1 (agent)
- Utility: 4 (format, lint, cleanup_tool_call, ally_write)
- Todo Management: 3 (todo_add, todo_complete, todo_clear)

**Permission Categories:**
- NON-DESTRUCTIVE: 8 tools
- SENSITIVE: 8 tools
- EXTREMELY_SENSITIVE: Detected at runtime (bash tool)

---

## TypeScript Implementation Notes

### Key Considerations

1. **Lazy Loading:**
   - Implement dynamic import system
   - Map tool names to module paths
   - Load on-demand to prevent circular dependencies

2. **Mixin System:**
   - Use TypeScript mixins or composition pattern
   - Ensure proper initialization order
   - Type safety for mixin methods

3. **Async/Await:**
   - All tool execution should support async
   - Detect sync vs async tool methods
   - Use Promise-based architecture

4. **Type Safety:**
   - Define interfaces for all tool responses
   - Use discriminated unions for result types
   - Generic types for tool parameters

5. **Service Registry:**
   - Implement dependency injection container
   - Support singleton, transient, scoped lifestyles
   - Type-safe service resolution

6. **Permission System:**
   - Implement TrustManager with user prompts
   - Support "Allow", "Deny", "Always Allow"
   - Track permissions per session

7. **Focus System:**
   - Implement FocusManager for path constraints
   - Integrate with path validation
   - Provide clear error messages

8. **Streaming:**
   - Support real-time output streaming (bash tool)
   - Use event emitters or observables
   - Handle cancellation gracefully

9. **Undo System:**
   - Implement PatchManager for file operations
   - Capture diffs between original and modified
   - Support undo/redo functionality

10. **File Checking:**
    - Implement checker registry
    - Support multiple language checkers
    - Return structured error information

### Recommended Architecture

```typescript
// Base types
interface ToolResult {
    success: boolean;
    error: string;
    error_type?: string;
    suggestion?: string;
    [key: string]: any;
}

abstract class BaseTool {
    abstract name: string;
    abstract description: string;
    abstract requires_confirmation: boolean;
    suppress_execution_animation: boolean = false;

    abstract execute(args: any): Promise<ToolResult>;

    protected formatErrorResponse(
        message: string,
        type: string = "general",
        suggestion?: string,
        additional?: Record<string, any>
    ): ToolResult {
        // Implementation
    }

    protected formatSuccessResponse(data: Record<string, any>): ToolResult {
        // Implementation
    }
}

// Tool Manager
class ToolManager {
    constructor(
        private tools: Map<string, BaseTool>,
        private trustManager: TrustManager,
        private ui: UIManager
    ) {}

    async executeTool(
        toolName: string,
        arguments: any,
        preApproved: boolean = false
    ): Promise<ToolResult> {
        // Implementation following Python pipeline
    }

    getFunctionDefinitions(): FunctionDefinition[] {
        // Implementation
    }
}

// Tool Loader (using dynamic imports)
class ToolLoader {
    private static toolModules: Record<string, string> = {
        "bash": "./tools/bash",
        "read": "./tools/read",
        // ...
    };

    async getToolClass(toolName: string): Promise<typeof BaseTool | null> {
        const modulePath = ToolLoader.toolModules[toolName];
        if (!modulePath) return null;

        const module = await import(modulePath);
        return module.default || module[toolName];
    }
}
```

---

**End of Documentation**

*This document provides a complete technical reference for reimplementing the CodeAlly tool system in TypeScript. All architectural patterns, validation logic, and special features are documented for accurate translation.*
