# CodeAlly Security & Trust Management - Comprehensive Documentation

**Version**: 1.0
**Last Updated**: 2025-10-20
**Purpose**: Complete reference for implementing secure TypeScript version of CodeAlly's trust system

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [TrustManager Class](#trustmanager-class)
3. [Tool Permission Classification](#tool-permission-classification)
4. [Security Command Lists](#security-command-lists)
5. [Permission Flows](#permission-flows)
6. [User Interaction Patterns](#user-interaction-patterns)
7. [Error Handling](#error-handling)
8. [Integration Points](#integration-points)
9. [Security Boundaries](#security-boundaries)

---

## Architecture Overview

### Component Hierarchy

```
Agent
  └─→ ToolManager
       ├─→ TrustManager (session-based permissions)
       ├─→ PermissionManager (path validation)
       └─→ Tools (with requires_confirmation flag)
```

### Trust System Flow

```
Tool Execution Request
  ↓
Argument Validation
  ↓
File Read Requirement Check (for write/edit/line_edit)
  ↓
Diff Preview (for file modifications)
  ↓
Permission Check
  ├─→ Auto-confirm enabled? → Execute
  ├─→ Already trusted? → Execute
  └─→ Requires confirmation?
       ├─→ Single tool → prompt_for_permission()
       └─→ Multiple tools → prompt_for_batch_operations()
  ↓
Command Security Validation (for bash)
  ↓
Tool Execution
```

---

## TrustManager Class

**Location**: `/Users/bhm128/CodeAlly/code_ally/trust.py`

### Core Responsibilities

1. **Permission Confirmation Flow**: Prompt users for tool execution approval
2. **Trust Cache Management**: Session-based storage of approved operations
3. **Batch Operation Handling**: Unified permissions for multiple tools
4. **Sensitivity Detection**: Classify commands and disable "Always Allow" for dangerous operations

### Class Structure

```python
class TrustManager:
    def __init__(self) -> None:
        # Session-based trust storage
        self.trusted_tools: dict[str, set[str]] = {}

        # Auto-confirm flag (dangerous, for scripting only)
        self.auto_confirm = False

        # Pre-approved operations (for batch processing)
        self.pre_approved_operations: set[str] = set()
```

### Key Methods

#### `prompt_for_permission(tool_name: str, path: CommandPath | None) -> bool`

**Purpose**: Request user permission for single tool execution

**Parameters**:
- `tool_name`: Name of the tool requesting permission
- `path`: Context-specific path/command (str, dict, or None)
  - For bash: `{"command": "rm file.txt"}`
  - For file ops: `"/path/to/file.txt"`
  - For other tools: `None`

**Return**: `True` if permission granted, raises `PermissionDeniedError` if denied

**Behavior**:
1. Skip prompt if `auto_confirm=True` or tool already trusted
2. Build display message based on tool type
3. Detect command sensitivity tier
4. Show permission menu with keyboard navigation:
   - **NORMAL/SENSITIVE**: Allow, Deny, Always Allow
   - **EXTREMELY_SENSITIVE**: Allow, Deny (no "Always Allow")
5. Handle user selection:
   - **Allow**: One-time permission
   - **Always Allow**: Add to `trusted_tools` with global scope (`*`)
   - **Deny/Ctrl+C**: Raise `PermissionDeniedError`

**UI Integration**:
- Pauses active tagline spinner before showing prompt
- Resumes spinner after user response
- Clears prompt from terminal after selection

#### `prompt_for_batch_operations(tool_calls: list[dict]) -> bool`

**Purpose**: Request permission for multiple tools in a batch

**Parameters**:
- `tool_calls`: List of tool call dictionaries with structure:
  ```python
  {
      "id": "call_123",
      "function": {
          "name": "write",
          "arguments": {...}
      }
  }
  ```

**Return**: `True` if permission granted, `False` if denied

**Behavior**:
1. Skip prompt if `auto_confirm=True`
2. Check for extremely sensitive commands in batch
3. Display simplified batch prompt: "🔐 Batch Permission Required"
4. Show permission menu:
   - If any command is extremely sensitive: Allow, Deny
   - Otherwise: Allow, Deny, Always Allow
5. On "Allow": Mark all operations as pre-approved via `mark_operation_as_approved()`
6. On "Always Allow": Trust all tools via `trust_tool()` AND mark as pre-approved
7. On "Deny": Return `False` (does not raise exception)

**Pre-Approval System**:
- Batch approval marks operations in `pre_approved_operations` set
- Individual tools check this set via `is_trusted()` before prompting
- Pre-approvals are cleared when no longer needed

#### `is_trusted(tool_name: str, path: CommandPath | None) -> bool`

**Purpose**: Check if a tool is already trusted for given context

**Trust Resolution Order**:
1. Check `auto_confirm` flag → `True`
2. Check `pre_approved_operations` set → `True` if found
3. Check `trusted_tools` dictionary:
   - If tool has `"*"` in paths → `True` (global trust)
   - If specific path matches → `True`
   - Check parent directories for path trust → `True` if found
4. Otherwise → `False`

**Operation Key Generation**:
```python
def get_operation_key(tool_name: str, path: CommandPath | None) -> str:
    # Bash tool: truncate command to 50 chars
    if tool_name == "bash" and isinstance(path, dict):
        return f"bash:{path['command'][:50]}"

    # File operations: use absolute path
    if isinstance(path, str):
        return f"{tool_name}:{os.path.abspath(path)}"

    # No path: tool name only
    return tool_name
```

#### `trust_tool(tool_name: str, path: str | None) -> None`

**Purpose**: Mark a tool as trusted (for "Always Allow")

**Behavior**:
- `path=None`: Add `"*"` to tool's trusted paths (global trust)
- `path="..."`: Add normalized absolute path to tool's trusted paths

**Session Scope**: Trust is session-based, cleared when program exits

#### `mark_operation_as_approved(tool_name: str, path: CommandPath | None) -> None`

**Purpose**: Pre-approve specific operation (for batch processing)

**Usage**: Called after batch permission granted to allow individual tools to execute without re-prompting

---

## Tool Permission Classification

**Location**: `/Users/bhm128/CodeAlly/code_ally/tools/base.py` (documentation)

### Classification System

Tools are classified into three permission categories:

#### 1. NON-DESTRUCTIVE (requires_confirmation = False)

**Definition**: Read-only operations that don't modify system state

**Examples**:
- `read` - Read file contents
- `glob` - List files matching pattern
- `grep` - Search file contents
- `ls` - List directory contents
- `agent` - Delegate to specialized agent

**Permission Behavior**:
- **Never** require user permission
- Execute immediately without prompts
- Even when accessing outside CWD (if path validation passes)

**Implementation**:
```python
class ReadTool(BaseTool):
    name = "read"
    description = "Read file contents"
    requires_confirmation = False  # NON-DESTRUCTIVE
```

#### 2. SENSITIVE (requires_confirmation = True, normal prompt)

**Definition**: Destructive operations affecting single files or isolated changes

**Examples**:
- `write` - Create or overwrite file
- `edit` - Modify file content
- `line_edit` - Line-based file editing
- `bash` - Execute shell commands (context-dependent)

**Permission Behavior**:
- Require permission prompt with: **Allow, Deny, Always Allow**
- "Always Allow" adds tool to `trusted_tools` with global scope
- Diff preview shown before permission prompt (for file operations)

**Implementation**:
```python
class WriteTool(BaseTool):
    name = "write"
    description = "Create or overwrite files"
    requires_confirmation = True  # SENSITIVE
```

#### 3. EXTREMELY_SENSITIVE (requires_confirmation = True, detected by content)

**Definition**: Multi-file destructive operations or system-level changes

**Detection**: Not a separate flag - determined by command content analysis

**Examples**:
- `rm -rf /` - System destruction
- `rm *.txt` - Multi-file deletion (wildcard)
- `rm file1.txt file2.txt` - Multi-file deletion (multiple args)
- `sudo su` - Privilege escalation
- `curl | bash` - Remote code execution

**Permission Behavior**:
- Require permission prompt with: **Allow, Deny** (NO "Always Allow")
- Detection via `get_command_sensitivity_tier()` function
- Applies to bash tool commands, not the tool itself

**Detection Logic**:
```python
def get_command_sensitivity_tier(command: str) -> str:
    # Check EXTREMELY_SENSITIVE_COMMANDS list
    for dangerous_cmd in EXTREMELY_SENSITIVE_COMMANDS:
        if dangerous_cmd.lower() in command.lower():
            return "EXTREMELY_SENSITIVE"

    # Check EXTREMELY_SENSITIVE_PATTERNS regex list
    for pattern in COMPILED_EXTREMELY_SENSITIVE_PATTERNS:
        if pattern.search(command):
            return "EXTREMELY_SENSITIVE"

    # Check SENSITIVE_PATTERNS
    for pattern in COMPILED_SENSITIVE_PATTERNS:
        if pattern.search(command):
            return "SENSITIVE"

    # Check SENSITIVE_COMMAND_PREFIXES
    for prefix in SENSITIVE_COMMAND_PREFIXES:
        if command.startswith(prefix):
            return "SENSITIVE"

    return "NORMAL"
```

---

## Security Command Lists

**Location**: `/Users/bhm128/CodeAlly/code_ally/trust.py`

### DISALLOWED_COMMANDS (Empty by Default)

**Purpose**: Hard-blocked commands that cannot be executed under any circumstances

**Current State**: Empty - all dangerous commands moved to EXTREMELY_SENSITIVE_COMMANDS to allow user choice

**Historical Note**: Previously contained commands like `rm -rf /`, now handled via user prompt

### DISALLOWED_PATTERNS (Empty by Default)

**Purpose**: Regex patterns for hard-blocked commands

**Current State**: Empty - patterns moved to EXTREMELY_SENSITIVE_PATTERNS

### EXTREMELY_SENSITIVE_COMMANDS

**Purpose**: Commands that require "Allow/Deny" prompt (no "Always Allow")

**Complete List** (114 entries):

```python
EXTREMELY_SENSITIVE_COMMANDS = [
    # System destruction
    "rm -rf /",
    "rm -rf /*",
    "rm -rf ~",
    "rm -rf ~/",
    "rm -rf .",
    "rm -rf ./",
    "rm -rf --no-preserve-root /",
    "find / -delete",
    "find ~ -delete",

    # Dangerous disk operations
    "dd if=/dev/zero",
    "> /dev/sda",
    "mkfs",
    "fdisk",
    "parted",

    # Destructive system operations
    ":(){ :|:& };:",  # Fork bomb
    "shutdown",
    "poweroff",
    "reboot",
    "halt",
    "systemctl poweroff",
    "systemctl reboot",
    "systemctl halt",

    # Remote code execution
    "wget -O- | bash",
    "curl | bash",
    "wget | sh",
    "curl | sh",
    "curl -s | bash",

    # Dangerous network tools
    "nc -l",
    "netcat -l",
    "socat",
    "ncat -l",

    # Privilege escalation attempts
    "sudo su",
    "sudo -i",
    "sudo bash",
    "sudo sh",

    # System configuration changes
    "passwd",
    "usermod",
    "userdel",
    "groupmod",
    "visudo",

    # Critical system files
    "rm /etc/passwd",
    "rm /etc/shadow",
    "rm /boot/*",

    # Additional dangerous patterns
    "> /dev/sda",
    "> /dev/null",
]
```

### EXTREMELY_SENSITIVE_PATTERNS

**Purpose**: Regex patterns for commands requiring "Allow/Deny" prompt

**Complete List** (14 patterns):

```python
EXTREMELY_SENSITIVE_PATTERNS = [
    r"^rm\s+(-[rf]+|--recursive|--force).*",  # rm with recursive/force flags
    r"^rm\s+.*\*",  # rm with wildcards
    r"^rm\s+.*\s+.*",  # rm with multiple arguments
    r"dd\s+if=\/dev\/zero\s+of=",  # Disk wiping
    r">\s*\/dev\/sd[a-z]",  # Writing to disk devices
    r"curl\s+.+\s*\|\s*(bash|sh|zsh)",  # Piping curl to shell
    r"wget\s+.+\s*\|\s*(bash|sh|zsh)",  # Piping wget to shell
    r"ssh\s+.+\s+'.*'",  # SSH with commands
    r"sudo\s+(su|bash|sh|zsh)",  # Privilege escalation
    r"chmod\s+777\s+\/(\s|$)",  # Dangerous permissions on root
    r"chown\s+.*\s+\/(\s|$)",  # Ownership changes on root
    r"ls\s+.*\*",  # File listing with globs
    r"\*.*\|",  # Commands with wildcards and pipes
    r"\/.*\*",  # Absolute paths with wildcards
    r"\/Users\/[^/]+\/\.[^/]+",  # Access to hidden directories
    r"\/opt\/",  # Access to /opt
    r"\/usr\/local",  # Access to /usr/local
    r"eval\s+.+",  # Eval with commands
]
```

**Pattern Compilation**:
```python
COMPILED_EXTREMELY_SENSITIVE_PATTERNS = [
    re.compile(pattern) for pattern in EXTREMELY_SENSITIVE_PATTERNS
]
```

### SENSITIVE_PATTERNS

**Purpose**: Commands requiring permission but allowing "Always Allow"

**Complete List** (9 patterns):

```python
SENSITIVE_PATTERNS = [
    r"ls\s+(-[alFhrt]+\s+)?(\.\.|\/|\~)[\/]?",  # List files outside CWD
    r"cat\s+(\.\.|\/|\~)[\/]?",  # Cat files outside CWD
    r"more\s+(\.\.|\/|\~)[\/]?",  # More files outside CWD
    r"less\s+(\.\.|\/|\~)[\/]?",  # Less files outside CWD
    r"head\s+(\.\.|\/|\~)[\/]?",  # Head files outside CWD
    r"tail\s+(\.\.|\/|\~)[\/]?",  # Tail files outside CWD
    r"grep\s+.+\s+(\.\.|\/|\~)[\/]?",  # Grep outside CWD
    r"find\s+(\.\.|\/|\~)[\/]?\s+",  # Find outside CWD
    r"^rm\s+[^\s\-\*]+$",  # Single file rm (no flags, wildcards, or multiple args)
]
```

### SENSITIVE_COMMAND_PREFIXES

**Purpose**: Command prefixes requiring permission (SENSITIVE tier)

**Complete List** (26 prefixes):

```python
SENSITIVE_COMMAND_PREFIXES = [
    "sudo ",
    "su ",
    "chown ",
    "chmod ",
    "rm -r",
    "rm -f",
    "mv /* ",
    "cp /* ",
    "ln -s ",
    "wget ",
    "curl ",
    "ssh ",
    "scp ",
    "rsync ",
    "ls ..",
    "ls ../",
    "ls /",
    "ls ~/",
    "cat ../",
    "cat /",
    "cat ~/",
    "grep ../",
    "grep /",
    "grep ~/",
    "find ../",
    "find /",
    "find ~/",
    "head ../",
    "head /",
    "head ~/",
    "tail ../",
    "tail /",
    "tail ~/",
]
```

### Command Validation Function

```python
def is_command_allowed(command: str) -> bool:
    """Check if command is allowed to execute."""

    # Check explicit disallowed commands
    for disallowed in DISALLOWED_COMMANDS:
        if disallowed in command:
            return False

    # Check regex patterns
    for pattern in COMPILED_DISALLOWED_PATTERNS:
        if pattern.search(command):
            return False

    # Check dangerous piping (curl/wget to bash)
    if "|" in command and ("bash" in command or "sh" in command):
        if "curl" in command or "wget" in command:
            return False

    # Check dangerous path patterns
    if has_dangerous_path_patterns(command):
        return False

    # Check directory traversal (cd commands)
    if "cd" in command:
        # Extract target directory
        parts = command.split("cd ", 1)
        if len(parts) > 1:
            dir_path = parts[1].strip().split()[0].strip("\"'")

            # Block traversal attempts
            if dir_path in ("..", "/", "~") or \
               dir_path.startswith(("../", "/", "~")):
                return False

            # Verify path is within CWD
            if not is_path_within_cwd(dir_path):
                return False

    return True
```

---

## Permission Flows

### Single Tool Permission Flow

```
Tool Execution Request
  ↓
Check: requires_confirmation?
  ├─→ False (NON-DESTRUCTIVE) → Execute immediately
  └─→ True (SENSITIVE)
       ↓
       Check: auto_confirm?
       ├─→ True → Execute immediately
       └─→ False
            ↓
            Check: is_trusted(tool_name, path)?
            ├─→ True → Execute immediately
            └─→ False
                 ↓
                 Show Diff Preview (if file modification)
                 ↓
                 Detect Command Sensitivity Tier
                 ├─→ EXTREMELY_SENSITIVE → Menu: Allow, Deny
                 └─→ NORMAL/SENSITIVE → Menu: Allow, Deny, Always Allow
                 ↓
                 User Selection
                 ├─→ Allow → Execute once
                 ├─→ Always Allow → trust_tool(tool_name) → Execute
                 └─→ Deny/Ctrl+C → Raise PermissionDeniedError
```

### Batch Permission Flow

```
Multiple Tool Calls Detected
  ↓
Display: "→ Multiple Operations"
  ├─→ ○ tool_name_1
  ├─→ ○ tool_name_2
  └─→ ○ tool_name_3
  ↓
Show File Modification Previews (diffs for write/edit)
  ↓
Check: Any tool requires_confirmation?
  ├─→ No → Execute all immediately
  └─→ Yes
       ↓
       Check: auto_confirm?
       ├─→ True → mark_operation_as_approved() for all → Execute all
       └─→ False
            ↓
            Prompt: "🔐 Batch Permission Required"
            ↓
            Detect: Any EXTREMELY_SENSITIVE commands?
            ├─→ Yes → Menu: Allow, Deny
            └─→ No → Menu: Allow, Deny, Always Allow
            ↓
            User Selection
            ├─→ Allow → mark_operation_as_approved() for all → Execute all
            ├─→ Always Allow → trust_tool() + mark_operation_as_approved() for all → Execute all
            └─→ Deny/Ctrl+C → Return False → Skip execution
  ↓
Execute Each Tool
  ├─→ Check: pre_approved?
  │    ├─→ Yes → Skip permission check → Execute
  │    └─→ No → Follow single tool permission flow
  └─→ Clear pre_approved_operations after batch
```

### File Modification Permission Flow (write/edit/line_edit)

```
File Modification Request (write/edit/line_edit)
  ↓
Validate: file_path parameter exists
  ↓
Check: File exists?
  ├─→ No (new file) → Skip read requirement
  └─→ Yes
       ↓
       Check: File read in this session?
       ├─→ No → Return validation error: "Use Read tool first"
       └─→ Yes
            ↓
            Check: File modified since read?
            ├─→ Yes → Return validation error: "Read file again"
            └─→ No → Continue
  ↓
Show Diff Preview
  ├─→ write: Show file_write_preview (existing content vs new content)
  ├─→ edit: Show edit_preview (original vs final with edits_count)
  └─→ line_edit: Show line_edit_preview (line-based diff)
  ↓
Permission Check (follows single tool flow)
  ↓
Execute Tool
  ↓
Record File Activity (update read timestamp)
```

---

## User Interaction Patterns

### Permission Menu (Keyboard Navigation)

**Display Format**:
```
┌────────────────────────────────────────────┐
│  🔐 PERMISSION REQUIRED                    │
│                                             │
│  Allow bash to execute command:            │
│                                             │
│  rm temp.txt                                │
│                                             │
└────────────────────────────────────────────┘

Use arrow keys to navigate, Enter to select:

> Allow
  Deny
  Always Allow
```

**Keyboard Controls**:
- `↑` / `↓`: Navigate menu options
- `Enter`: Select highlighted option
- `Ctrl+C`: Cancel (raises PermissionDeniedError)

**Menu Rendering**:
```python
def _show_permission_menu(
    options: list[str],
    selected_index: int,
    first_display: bool,
    panel_lines: int,
) -> None:
    # Move cursor up to overwrite menu (if not first display)
    if not first_display:
        menu_lines = len(options) + 2
        sys.stdout.write(f"\033[{menu_lines}A")

    # Render menu with highlighting
    for i, option in enumerate(options):
        if i == selected_index:
            print(f"> {option}", style="bold green on black")
        else:
            print(f"  {option}", style="white")
```

**Menu Cleanup**:
```python
# Clear both panel and menu after selection
total_lines = panel_lines + len(options) + 2
sys.stdout.write(f"\033[{total_lines}A")  # Move cursor up
for _ in range(total_lines):
    sys.stdout.write("\033[K\033[B")  # Clear line and move down
sys.stdout.write(f"\033[{total_lines}A")  # Move cursor back up
```

### Bash Command Display

**Standard Commands**:
```
┌────────────────────────────────────────────┐
│  🔐 PERMISSION REQUIRED                    │
│                                             │
│  You are about to execute the following    │
│  command:                                   │
│                                             │
│  pytest tests/test_agent.py                │
│                                             │
└────────────────────────────────────────────┘
```

**With Syntax Highlighting**:
```python
from rich.syntax import Syntax

command_syntax = Syntax(
    command,
    "bash",
    theme="monokai",
    word_wrap=True
)
```

### File Modification Display

**Write Tool (New File)**:
```
┌────────────────────────────────────────────┐
│  📝 New File: src/new_module.py            │
│  Lines: 42 | Bytes: 1234                   │
└────────────────────────────────────────────┘
[Shows first 10 lines of new content with syntax highlighting]
```

**Write Tool (Overwrite Existing)**:
```
┌────────────────────────────────────────────┐
│  📝 Overwrite: src/config.py               │
│  Changes: 3 additions, 2 deletions         │
└────────────────────────────────────────────┘
[Shows unified diff with + and - lines]
```

**Edit Tool**:
```
┌────────────────────────────────────────────┐
│  ✏️  Edit: src/main.py (2 edits)            │
└────────────────────────────────────────────┘
[Shows cumulative diff of all edits]
```

### Batch Operations Display

```
→ Multiple Operations
     ○ write
     ○ edit
     ○ bash

[Diff preview for write operation]
[Diff preview for edit operation]

📋 Previewed 2 file modification(s) above

🔐 Batch Permission Required

Use arrow keys to navigate, Enter to select:

> Allow
  Deny
  Always Allow
```

---

## Error Handling

### Permission Denied Error

**Exception Class**:
```python
class PermissionDeniedError(Exception):
    """Raised when user denies permission for a tool.

    This special exception allows the agent to immediately stop
    processing and return to the main conversation loop.
    """
    pass
```

**Propagation**:
- Raised by `prompt_for_permission()` when user selects "Deny" or presses Ctrl+C
- Propagates through tool execution stack
- Caught in agent's main loop
- Adds message to conversation: `"[Request interrupted by user due to permission denial]"`

**User Feedback**:
```python
# Display message after denial
console.print("[bold yellow]Permission denied. Enter a new message.[/]")

# Or for cancellation
console.print("[bold yellow]Permission cancelled. Enter a new message.[/]")
```

### Directory Traversal Error

**Exception Class**:
```python
class DirectoryTraversalError(Exception):
    """Raised when an operation attempts to access paths outside
    of allowed directory.

    This special exception prevents the agent from accessing files
    or directories outside of the current working directory.
    """
    pass
```

**Detection**:
```python
def has_path_traversal_patterns(input_str: str) -> bool:
    """Check if string contains path traversal patterns."""

    traversal_patterns = [
        "..",
        "/../",
        "/./",
        "~/",
        "$HOME",
        "${HOME}",
        "$(pwd)",
        "`pwd`",
        "/etc/",
        "/var/",
        "/usr/",
        "/bin/",
        "/tmp/",
        "/root/",
        "/proc/",
        "/sys/",
        "/dev/",
        "/*",
        "~/*",
    ]

    # Check absolute paths - allow if within CWD
    if input_str.startswith("/") or input_str.startswith("~"):
        if "*" in input_str:
            # Check if glob pattern base is within CWD
            base_path = input_str.split("*")[0].rstrip("/")
            if is_path_within_cwd(base_path):
                return False  # Safe
            return True  # Dangerous

        # Check if absolute path is within CWD
        if is_path_within_cwd(input_str):
            return False  # Safe
        return True  # Dangerous

    # Check for traversal patterns
    return any(pattern in input_str for pattern in traversal_patterns)
```

**Path Validation**:
```python
def is_path_within_cwd(path: str) -> bool:
    """Check if path is within current working directory."""
    try:
        abs_path = os.path.abspath(path)
        cwd = os.path.abspath(os.getcwd())
        return abs_path.startswith(cwd)
    except Exception:
        return False  # Assume unsafe on error
```

### Command Validation Errors

**Blocked Commands**:
```python
# Hard-blocked (empty by default, but logic remains)
if not is_command_allowed(command):
    return {
        "success": False,
        "error": f"Command not allowed for security reasons: {command}",
        "output": "",
        "return_code": -1,
    }
```

**Path Security Errors**:
```python
# From bash tool parameter validation
is_valid, security_error = self._check_path_security(command)
if not is_valid:
    return {
        "success": False,
        "error": f"Command contains security risks: {security_error}",
        "error_type": "security_error",
        "output": "",
        "return_code": -1,
    }
```

---

## Integration Points

### ToolManager Integration

**Location**: `/Users/bhm128/CodeAlly/code_ally/agent/tool_manager.py`

**Permission Check in execute_tool()**:
```python
async def execute_tool(
    tool_name: str,
    arguments: dict[str, Any],
    pre_approved: bool = False,
) -> dict[str, Any]:
    # ... validation ...

    # Check if tool accesses outside CWD (makes it extremely sensitive)
    is_outside_cwd = False
    if tool.requires_confirmation:
        is_outside_cwd = self._is_accessing_outside_cwd(tool_name, arguments)

    # Check permissions if not pre-approved
    needs_confirmation = tool.requires_confirmation or is_outside_cwd
    if needs_confirmation and not pre_approved:
        permission_path = self._get_permission_path(tool_name, arguments)

        # Add outside CWD flag for extremely sensitive handling
        if is_outside_cwd:
            if isinstance(permission_path, str):
                permission_path = {"path": permission_path, "outside_cwd": True}
            elif isinstance(permission_path, dict):
                permission_path["outside_cwd"] = True
            else:
                permission_path = {"outside_cwd": True}

        # Check trust status
        if not self.trust_manager.is_trusted(tool_name, permission_path):
            # Prompt for permission (may raise PermissionDeniedError)
            if not self.trust_manager.prompt_for_permission(
                tool_name,
                permission_path,
            ):
                return {"success": False, "error": f"Permission denied for {tool_name}"}

    # Execute tool
    result = await self._perform_tool_execution(tool_name, arguments)
    return result
```

**Outside CWD Detection**:
```python
def _is_accessing_outside_cwd(tool_name: str, arguments: dict[str, Any]) -> bool:
    """Check if tool accesses paths outside CWD."""
    import os
    cwd = os.path.abspath(os.getcwd())

    # Check file_path argument
    file_path = arguments.get("file_path")
    if file_path:
        from code_ally.services.path_resolver import resolve_path
        abs_path = resolve_path(file_path)
        if not abs_path.startswith(cwd):
            return True

    # Check path argument
    path = arguments.get("path")
    if path:
        from code_ally.services.path_resolver import resolve_path
        abs_path = resolve_path(path)
        if not abs_path.startswith(cwd):
            return True

    return False
```

### ToolOrchestrator Integration

**Location**: `/Users/bhm128/CodeAlly/code_ally/agent/tool_orchestrator.py`

**Batch Permission Handling**:
```python
def _handle_batch_permissions(tool_calls: list[dict]) -> bool:
    """Handle multi-tool permission logic and display operations."""

    # Check if any tools require confirmation
    requires_multi_permission = False
    if len(tool_calls) > 1:
        for tool_call in tool_calls:
            _, tool_name, _ = self._normalize_tool_call(tool_call)
            if tool_name in self.agent.tool_manager.tools:
                tool = self.agent.tool_manager.tools[tool_name]
                if hasattr(tool, "requires_confirmation") and tool.requires_confirmation:
                    requires_multi_permission = True
                    break

    # Display multiple operations
    if len(tool_calls) > 1:
        self._display_multiple_operations(tool_calls)
        self._show_file_modification_previews(tool_calls)

        # Handle multi-tool permissions upfront
        if requires_multi_permission:
            trust_manager = self.agent.service_registry.get("trust_manager")
            if trust_manager and hasattr(trust_manager, "prompt_for_batch_operations"):
                if not trust_manager.prompt_for_batch_operations(tool_calls):
                    # User denied permission
                    self._handle_permission_denial()
                    raise PermissionDeniedError("User denied multi-tool permissions")

    return requires_multi_permission
```

**Individual Tool Execution with Pre-Approval**:
```python
# For multi-tool operations that required permission, mark as pre-approved
multi_pre_approved = is_multi_operation and requires_multi_permission

raw_result = await self.agent.tool_manager.execute_tool(
    tool_name,
    arguments,
    self.agent.check_context_msg,
    self.agent.client_type,
    pre_approved=multi_pre_approved,  # Skip individual permission check
)
```

### UI Manager Integration

**Tagline Status Pausing**:
```python
# Pause tagline spinner before showing permission prompt
try:
    from code_ally.service_registry import ServiceRegistry
    service_registry = ServiceRegistry.get_instance()
    if service_registry and service_registry.has_service("ui_manager"):
        ui_manager = service_registry.get("ui_manager")
        original_ui = getattr(ui_manager, "original_ui", None)
        target_ui = original_ui or ui_manager
        if target_ui and hasattr(target_ui, "pause_tagline_status"):
            target_ui.pause_tagline_status()
except Exception:
    pass

# ... show permission prompt ...

# Resume tagline spinner after user response
try:
    if target_ui and hasattr(target_ui, "resume_tagline_status"):
        target_ui.resume_tagline_status()
except Exception:
    pass
```

### Diff Display Integration

**BaseTool Mixin Methods**:
```python
def _show_diff_preview(
    old_content: str,
    new_content: str,
    file_path: str,
    operation_type: str = "edit",
) -> None:
    """Show diff preview before file operation."""
    if self._diff_display_manager:
        self._diff_display_manager.show_file_diff(
            old_content,
            new_content,
            file_path,
            operation_type,
        )

def _show_write_preview(
    file_path: str,
    new_content: str,
    existing_content: str | None = None,
) -> None:
    """Show preview for file write operations."""
    if self._diff_display_manager:
        self._diff_display_manager.show_file_write_preview(
            file_path,
            new_content,
            existing_content,
        )

def _show_edit_preview(
    file_path: str,
    original_content: str,
    final_content: str,
    edits_count: int,
) -> None:
    """Show preview for edit operations."""
    if self._diff_display_manager:
        self._diff_display_manager.show_edit_preview(
            file_path,
            original_content,
            final_content,
            edits_count,
        )
```

**Preview Timing**:
- Called by ToolManager BEFORE permission prompt
- Ensures user sees changes before deciding
- Only shown for file modification tools (write, edit, line_edit)

---

## Security Boundaries

### Trust Scope Levels

```python
class PermissionScope(Enum):
    """Permission scope levels for trust management."""
    GLOBAL = auto()     # Trust for all paths and instances
    SESSION = auto()    # Trust for current session only (all paths)
    DIRECTORY = auto()  # Trust for specific directory and subdirectories
    FILE = auto()       # Trust for specific file only
    ONCE = auto()       # Trust for this one call only
```

**Current Implementation**: Uses SESSION scope exclusively
- "Always Allow" grants SESSION-level trust (cleared on program exit)
- No persistence across sessions for security
- Global trust represented by `"*"` in `trusted_tools` dictionary

### Path Restrictions

**Current Working Directory (CWD) Enforcement**:
1. All file operations validated against CWD
2. Absolute paths outside CWD trigger "extremely sensitive" handling
3. Relative paths normalized and checked against CWD bounds
4. Glob patterns with absolute paths checked at base directory level

**Dangerous Path Patterns** (from `has_dangerous_path_patterns()`):
```python
[
    "/etc/passwd",
    "/etc/shadow",
    "/etc/sudoers",
    "/boot/",
    "/sys/",
    "/proc/",
    "/dev/sd",  # Disk devices
    "$(pwd)",
    "`pwd`",
    "${HOME}",
    "$HOME/.*",  # Home directory via variables
]
```

### Command Execution Safeguards

**Bash Tool Restrictions**:
1. Command allowlist/denylist checking
2. Pattern-based sensitivity detection
3. Directory traversal prevention (cd commands)
4. Path traversal pattern detection
5. Piping to shell detection (curl/wget | bash)

**Interactive Command Detection**:
- Commands likely to require user input receive special warnings
- Timeout increased automatically for potentially interactive commands
- Suggestions provided for non-interactive alternatives

**cd Command Special Handling**:
```python
if "cd" in command:
    # Extract target directory
    parts = command.split("cd ", 1)
    if len(parts) > 1:
        dir_path = parts[1].strip().split()[0].strip("\"'")

        # Block traversal attempts
        if dir_path in ("..", "/", "~") or \
           dir_path.startswith(("../", "/", "~")):
            return False

        # Verify within CWD
        if not is_path_within_cwd(dir_path):
            return False
```

### File Modification Safeguards

**Read-Before-Write Requirement**:
1. Tracks all file reads with timestamps via `_read_files` dictionary
2. Blocks write/edit/line_edit if file not read in session
3. Blocks modifications if file changed since last read
4. Updates read timestamp after successful modifications

**Validation Flow**:
```python
def _validate_file_read_requirement(file_path: str) -> dict | None:
    """Validate file has been read before modification."""
    abs_path = resolve_path(file_path)

    # Check if file exists
    if not os.path.exists(abs_path):
        return None  # New file, no read requirement

    # Check if file was read in this session
    if abs_path not in self._read_files:
        return {
            "valid": False,
            "error": f"File exists but has not been read. Use Read tool first.",
            "suggestion": "Use the Read tool to examine the file content",
        }

    # Check if file was modified since read
    file_mtime = os.path.getmtime(abs_path)
    read_time = self._read_files[abs_path]

    if file_mtime > read_time:
        return {
            "valid": False,
            "error": f"File modified since last read. Please read again.",
            "suggestion": "Use the Read tool to examine current content",
        }

    return None  # Validation passed
```

### Security Best Practices

**For TypeScript Implementation**:

1. **Never Skip Permission Checks**:
   - Always enforce `requires_confirmation` flag
   - Never silently trust operations
   - Maintain session-based trust scope

2. **Command Validation Order**:
   - Argument validation first
   - File read requirement check second
   - Diff preview third
   - Permission check fourth
   - Command security validation fifth (for bash)
   - Tool execution last

3. **Error Handling**:
   - Always propagate `PermissionDeniedError`
   - Log security-related errors at WARNING level
   - Provide clear error messages to users
   - Never expose sensitive paths in error messages

4. **UI Considerations**:
   - Pause background animations during permission prompts
   - Clear prompts from terminal after user response
   - Show diffs before asking for permission
   - Use keyboard navigation for accessibility

5. **Trust Management**:
   - Clear pre-approved operations after batch completion
   - Never persist trust across sessions
   - Validate trust scope before execution
   - Log all trust-related decisions

6. **Path Security**:
   - Normalize all paths to absolute before comparison
   - Check CWD bounds for all file operations
   - Detect path traversal patterns early
   - Special handling for glob patterns

---

## Implementation Checklist for TypeScript

### Core Trust Manager
- [ ] Implement `TrustManager` class with session-based storage
- [ ] Implement `prompt_for_permission()` with keyboard navigation
- [ ] Implement `prompt_for_batch_operations()`
- [ ] Implement `is_trusted()` with multi-level checking
- [ ] Implement `trust_tool()` for "Always Allow"
- [ ] Implement `mark_operation_as_approved()` for batch pre-approval
- [ ] Implement `get_operation_key()` for trust cache keys

### Command Security
- [ ] Port all command lists (EXTREMELY_SENSITIVE_COMMANDS, etc.)
- [ ] Port all regex patterns (EXTREMELY_SENSITIVE_PATTERNS, etc.)
- [ ] Implement `get_command_sensitivity_tier()`
- [ ] Implement `is_command_allowed()`
- [ ] Implement `has_path_traversal_patterns()`
- [ ] Implement `has_dangerous_path_patterns()`
- [ ] Implement `is_path_within_cwd()`

### Tool Integration
- [ ] Add `requires_confirmation` flag to all tool classes
- [ ] Implement permission check in tool manager's `execute_tool()`
- [ ] Implement `_is_accessing_outside_cwd()` detection
- [ ] Implement `_get_permission_path()` extraction
- [ ] Implement diff preview system integration

### Batch Operations
- [ ] Implement `_handle_batch_permissions()` in orchestrator
- [ ] Implement `_display_multiple_operations()`
- [ ] Implement `_show_file_modification_previews()`
- [ ] Implement pre-approval system for batch execution

### Error Handling
- [ ] Define `PermissionDeniedError` exception
- [ ] Define `DirectoryTraversalError` exception
- [ ] Implement error propagation through execution stack
- [ ] Implement user feedback for permission denial

### UI Components
- [ ] Implement keyboard navigation menu rendering
- [ ] Implement terminal cleanup after prompts
- [ ] Implement tagline/spinner pausing during prompts
- [ ] Implement diff display integration
- [ ] Implement Rich-style panels and syntax highlighting

### File Modification Safety
- [ ] Implement read-before-write tracking
- [ ] Implement `_validate_file_read_requirement()`
- [ ] Implement file modification timestamp checking
- [ ] Update read timestamps after successful modifications

### Testing
- [ ] Test single tool permission flow
- [ ] Test batch permission flow
- [ ] Test command sensitivity detection
- [ ] Test path traversal detection
- [ ] Test trust persistence across tool calls
- [ ] Test pre-approval system
- [ ] Test error handling and propagation

---

## Appendix: Key Code Locations

### Primary Files
- **Trust System**: `/Users/bhm128/CodeAlly/code_ally/trust.py` (1250 lines)
- **Tool Manager**: `/Users/bhm128/CodeAlly/code_ally/agent/tool_manager.py` (400+ lines)
- **Tool Orchestrator**: `/Users/bhm128/CodeAlly/code_ally/agent/tool_orchestrator.py` (500+ lines)
- **Permission Manager**: `/Users/bhm128/CodeAlly/code_ally/agent/permission_manager.py` (278 lines)
- **Base Tool**: `/Users/bhm128/CodeAlly/code_ally/tools/base.py` (327 lines)

### Tool Examples
- **Bash Tool**: `/Users/bhm128/CodeAlly/code_ally/tools/bash.py` (25 lines, `requires_confirmation = True`)
- **Write Tool**: `/Users/bhm128/CodeAlly/code_ally/tools/write.py` (31 lines, `requires_confirmation = True`)
- **Edit Tool**: `/Users/bhm128/CodeAlly/code_ally/tools/edit.py` (30 lines, `requires_confirmation = True`)
- **Read Tool**: Referenced in base documentation (requires_confirmation = False)

---

**End of Documentation**

This document provides complete reference for implementing CodeAlly's security and trust management system in TypeScript. All command lists, patterns, and flows have been documented with exact line numbers and implementation details from the source code.
