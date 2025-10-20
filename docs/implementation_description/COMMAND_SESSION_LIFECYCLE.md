# CodeAlly Command Handling, Session Management & Application Lifecycle

## Document Purpose
Complete technical specification of CodeAlly's command system, session management, CLI arguments, and application lifecycle for TypeScript port reference.

---

## Table of Contents
1. [Command Handler System](#command-handler-system)
2. [Session Management](#session-management)
3. [CLI Arguments & Configuration](#cli-arguments--configuration)
4. [Application Lifecycle](#application-lifecycle)
5. [Logging System](#logging-system)
6. [Message Flow & Architecture](#message-flow--architecture)

---

## Command Handler System

### Overview
Location: `/Users/bhm128/CodeAlly/code_ally/agent/command_handler.py`

The `CommandHandler` class processes slash commands entered during interactive sessions.

### Architecture

```python
class CommandHandler:
    def __init__(
        self,
        ui_manager: UIManager,
        token_manager: TokenManager,
        trust_manager: TrustManager,
    ) -> None
```

**Dependencies:**
- `ui_manager`: UI rendering and user interaction
- `token_manager`: Context tracking and memory management
- `trust_manager`: Permission system
- `agent`: Set after initialization (circular dependency management)

### Command Processing Flow

```
User Input → handle_command() → Specific Handler → Return (handled, updated_messages)
```

**Command Detection:**
- All commands start with `/` prefix
- Format: `/command [arguments]`
- Command name is case-insensitive
- Arguments are space-separated

### Complete Slash Commands Reference

#### 1. `/help`
**Handler:** `handle_command` (inline)
**Arguments:** None
**Description:** Displays help message with available commands
**Implementation:**
```python
if command == "help":
    self.ui.print_help()
    return True, messages
```

#### 2. `/clear`
**Handler:** `handle_command` (inline)
**Arguments:** None
**Description:** Clears conversation history, preserving only system message
**Implementation:**
- Filters messages to keep only those with `role == "system"`
- Updates token count
- Returns success message

#### 3. `/compact`
**Handler:** `compact_conversation()`
**Arguments:** Optional custom instructions (string)
**Description:** Compacts conversation to reduce context usage
**Implementation:**
- Extracts system message and conversation history
- Sends summarization request to LLM with special system prompt
- Prioritizes ongoing debugging/problem-solving context
- Falls back to truncation strategy if LLM summarization fails
- Uses `FALLBACK_TARGET_PERCENTAGE = 0.15` (15% of context)
- Limits each message to `MAX_TOKENS_PER_MESSAGE = 500`

**Summarization System Prompt Focus:**
- Unresolved issues, bugs, errors
- Debugging context (error messages, stack traces)
- Current investigation state
- Technical details (file paths, function names, config)
- Attempted solutions and why they failed
- Breakthrough findings

**Fallback Compaction:**
```python
def _create_fallback_compacted_messages(messages):
    # Truncate from latest backward to target percentage
    # Each message limited to MAX_TOKENS_PER_MESSAGE
    # Returns compacted list
```

#### 4. `/config`
**Handler:** `handle_config_command()`
**Subcommands:**
- `/config` - Show current configuration (table format)
- `/config show` - Same as no arguments
- `/config set key=value` - Set configuration value
- `/config key=value` - Alternative set syntax
- `/config reset` - Reset to defaults (with confirmation)

**Configurable Settings:**
- `auto_confirm` (bool): Skip permission prompts
- `temperature` (float): LLM temperature
- `context_size` (int): Context window size
- `max_tokens` (int): Max generation tokens
- `check_context_msg` (bool): Context reminder messages
- `parallel_tools` (bool): Allow parallel tool execution
- `compact_threshold` (int): Auto-compact percentage
- `verbose` (bool): Verbose logging

**Implementation Notes:**
- Settings with live effect update immediately (runtime)
- Other settings saved to config file for next session
- Type conversion handled per setting
- Updates both config manager and runtime instances

#### 5. `/model`
**Handler:** `handle_model_command()`
**Shortcut:** `/m`
**Subcommands:**
- `/model` - Show help
- `/model ls` - Interactive model selector (arrow keys)
- `/model show` - Display current model information
- `/model set <name>` - Set model by name

**Model Information Display:**
- Model Name
- Temperature
- Max Tokens
- Context Size
- Endpoint

**Interactive Selector:**
- Uses `ModelSelector` class
- Arrow key navigation
- Shows model size, family, parameters, modified date
- Highlights current model with asterisk

#### 6. `/debug`
**Handler:** `handle_debug_command()`
**Subcommands:**
- `/debug` - Show help
- `/debug system` - System prompt and tool definitions
- `/debug tokens` - Token usage and memory statistics
- `/debug context` - Conversation context (JSON)
- `/debug interrupt` - Interrupt coordinator status
- `/debug agent <name>` - Agent configuration and prompt

**Debug System Output:**
- Syntax-highlighted system prompt
- Tool definitions with parameters
- Token counts (system, tools, total)

**Debug Tokens Output:**
- Estimated tokens vs context size
- Usage percentage
- Remaining tokens
- Compact threshold
- Last compaction time
- Message breakdown (system/user/assistant)
- Model settings (name, temperature, max_tokens)

**Debug Context Output:**
- JSON array of all messages
- Each message includes: index, role, content_length, content_tokens, content
- Tool call information where applicable
- Syntax-highlighted with line numbers

**Debug Interrupt Output:**
- Application state
- Has input content flag
- Cancellation set flag
- Agent available flag
- Model client interrupted flag

**Debug Agent Output:**
- Agent configuration (name, description, created, updated, model, temperature, tools)
- Complete system prompt as sent to model
- Token count of system prompt

#### 7. `/init`
**Handler:** `handle_init_command()`
**Arguments:** None
**Description:** Run interactive setup wizard during session
**Implementation:**
- Creates `SetupWizard` instance
- Runs in interactive mode
- Updates configuration on success

#### 8. `/project`
**Handler:** `handle_project_command()`
**Subcommands:**
- `/project` - Show help
- `/project init` - Create ALLY.md configuration
- `/project show` - View ALLY.md contents
- `/project edit` - Edit ALLY.md with default editor

**Project Init:**
- Runs `ProjectWizard`
- Creates ALLY.md in current directory

**Project Show:**
- Displays ALLY.md with markdown syntax highlighting
- Shows file stats (size, line count)
- Panel-based display

**Project Edit:**
- Respects Unix editor conventions: `$VISUAL` → `$EDITOR` → `sensible-editor` → `vi`
- Creates ALLY.md if it doesn't exist (with confirmation)
- Uses `shell=True` to support editors with arguments
- Handles keyboard interrupts gracefully

#### 9. `/agent`
**Handler:** `handle_agent_command()`
**Arguments:** Command string for agent wizard
**Description:** Manage specialized agents
**Implementation:**
- Uses `AgentWizard` for interactive management
- Supports create, list, show, edit, delete operations
- Refreshes agent completion cache on success
- Integrates with `AgentManager` for persistence

#### 10. `/refresh` or `/index`
**Handler:** `handle_command` (inline)
**Arguments:** None
**Description:** Refresh path completion index
**Implementation:**
```python
if hasattr(self.ui, 'refresh_path_completion'):
    self.ui.refresh_path_completion()
```

#### 11. `/undo`
**Handler:** `handle_undo_command()`
**Arguments:** Optional count (default: 1)
**Description:** Revert file operations using patch history
**Implementation:**
- Uses `PatchManager` from service registry
- Shows diff preview of what will be undone
- Supports multi-operation undo
- Requires confirmation unless auto-confirm enabled
- Returns partial success info if some operations fail

**Undo Preview:**
- Shows operation type and file path
- Displays unified diff of changes
- Handles file deletion/recreation cases
- Color-coded diffs

#### 12. `/focus`
**Handler:** `handle_focus_command()`
**Arguments:** Directory path or empty for status
**Description:** Constrain file operations to directory
**Implementation:**
- `/focus` - Show current focus status
- `/focus .` - Focus on current directory
- `/focus path/` - Focus on relative directory
- Validates directory exists and is within CWD
- Refreshes system prompt on focus change

#### 13. `/defocus`
**Handler:** `handle_defocus_command()`
**Arguments:** None
**Description:** Clear focus constraints
**Implementation:**
- Clears focus from `FocusManager`
- Refreshes system prompt
- Shows success message

#### 14. `/memory`
**Handler:** `handle_memory_command()`
**Subcommands:**
- `/memory` - Show help
- `/memory add <text>` - Add memory to ALLY.md
- `/memory [ls|list]` - List all memories
- `/memory rm <index>` - Remove memory by index
- `/memory clear` - Clear all memories (with confirmation)
- `/memory show <index>` - Show specific memory

**Memory Storage:**
- Stored in ALLY.md under "## Notes for Code Ally" section
- Bullet-point format (`- memory text`)
- Indexed for easy reference (1-based)

**Memory Parsing:**
```python
def _parse_memories_from_ally_md(content: str) -> list[str]:
    # Extracts bullet points from Notes section
    # Returns list of memory strings
```

**Memory Update:**
```python
def _update_ally_md_with_memories(content: str, memories: list[str]) -> str:
    # Replaces Notes section with updated memories
    # Creates section if it doesn't exist
```

#### 15. `/todo`
**Handler:** `handle_todo_command()`
**Subcommands:**
- `/todo` - Show help
- `/todo ls` - List current todos
- `/todo add <task>` - Add new task
- `/todo complete [index]` - Mark task complete (0-based, default: 0)
- `/todo rm <index>` - Remove task by index (0-based)
- `/todo clear` - Clear all todos (with confirmation)

**Todo Storage:**
- Stored in session JSON file under `"todos"` field
- Fallback to in-memory storage if no session active
- Session manager provides `get_todos()` and `set_todos()` methods

**Todo Display:**
- Uses `display_todo_ui()` from `todo_common`
- Shows incomplete vs completed count
- 0-based indexing for incomplete tasks only
- `index 0 = NEXT` task semantics

#### 16. `/quit` or `/exit`
**Handler:** `handle_command` (inline)
**Arguments:** None
**Description:** Exit the application
**Implementation:**
```python
if command == "quit" or command == "exit":
    import sys
    self.ui.print_content("Goodbye!", style="green")
    sys.exit(0)
```

### Command Return Values

All command handlers return: `tuple[bool, list[dict[str, Any]]]`

- **First value (handled):** `True` if command was processed
- **Second value (messages):** Updated message list

This allows commands to modify conversation history while signaling completion.

### Error Handling

**Unknown Commands:**
```python
self.ui.print_error(f"Unknown command: /{command}")
return True, messages
```

**Command-Specific Errors:**
- Caught with try-except in each handler
- Error messages displayed via `ui.print_error()`
- Original messages returned unchanged on error

---

## Session Management

### Architecture Overview

**Primary Components:**
1. `/Users/bhm128/CodeAlly/code_ally/session_manager.py` - Core session persistence
2. `/Users/bhm128/CodeAlly/code_ally/agent/session_manager.py` - Agent integration
3. `/Users/bhm128/CodeAlly/code_ally/session_selector.py` - Interactive selection UI

### SessionManager (Core)

**Location:** `code_ally/session_manager.py`

```python
class SessionManager:
    def __init__(self, model_client: ModelClient | None = None) -> None:
        self.sessions_dir = SESSIONS_DIR  # ~/.code_ally/sessions/
        self.current_session: str | None = None
        self.in_memory_todos: list[dict[str, Any]] = []
        self._current_session_todos_cache: list[dict[str, Any]] | None = None
        self.title_generator = SessionTitleGenerator(model_client) if model_client else None
```

### Session File Format

**Location:** `~/.code_ally/sessions/{session_name}.json`

```json
{
  "name": "session_20250120_103855_a1b2c3d4",
  "title": "Debug authentication flow issue",
  "created_at": "2025-01-20T10:38:55.143436",
  "updated_at": "2025-01-20T11:42:19.977816",
  "messages": [
    {
      "role": "user",
      "content": "Help me debug the authentication issue"
    },
    {
      "role": "assistant",
      "content": "I'll help investigate...",
      "tool_calls": [
        {
          "id": "call_abc123",
          "type": "function",
          "function": {
            "name": "read",
            "arguments": "{\"file_path\": \"/path/to/file\"}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_abc123",
      "name": "read",
      "content": "file contents..."
    }
  ],
  "todos": [
    {
      "task": "Fix authentication bug",
      "completed": false,
      "created_at": "2025-01-20T10:40:00.000000"
    }
  ]
}
```

### Session Lifecycle Methods

#### 1. Session Creation
```python
def create_session(self, session_name: str | None = None) -> str:
    """Create new session with auto-generated or provided name."""
    # Auto-generate name: session_{timestamp}_{uuid8}
    # Initialize with empty messages and todos
    # Trigger cleanup of old sessions (keeps 10 most recent)
```

**Name Generation:**
```python
def generate_session_name(self) -> str:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    short_uuid = str(uuid.uuid4())[:8]
    return f"session_{timestamp}_{short_uuid}"
```

#### 2. Session Loading
```python
def load_session(self, session_name: str) -> dict[str, Any] | None:
    """Load session data from JSON file."""
    # Returns None if file doesn't exist or JSON parse fails
```

#### 3. Session Saving
```python
def save_session(self, session_name: str, messages: list[dict[str, Any]]) -> bool:
    """Save messages to session file."""
    # Updates timestamp
    # Triggers title generation for new sessions
    # Triggers cleanup of old sessions
    # Returns success/failure boolean
```

#### 4. Title Generation
```python
def _maybe_generate_title(
    self,
    session_name: str,
    messages: list[dict[str, Any]],
    session_data: dict[str, Any],
) -> None:
    """Generate title on first user message if title_generator available."""
    # Conditions:
    # - Exactly 1 user message
    # - First user message is non-empty
    # - No existing title
    # - Title generator available
    #
    # Calls: title_generator.generate_title_background()
```

**Background Title Generation:**
- Non-blocking (runs in separate thread)
- Uses LLM to generate concise title from first message
- Updates session file when complete
- Graceful failure (session continues without title)

#### 5. Session Cleanup
```python
def _cleanup_old_sessions(self, max_sessions: int = 10) -> None:
    """Remove old sessions beyond limit."""
    # Keeps 10 most recent (by modification time)
    # Deletes older session files
```

### Session State Management

#### Current Session Tracking
```python
def set_current_session(self, session_name: str | None) -> None:
    """Set active session, clearing todos cache."""

def get_current_session(self) -> str | None:
    """Get current active session name."""
```

#### Session Queries
```python
def session_exists(self, session_name: str) -> bool:
    """Check if session file exists."""

def list_sessions(self) -> list[str]:
    """List all session names (file stems)."""

def get_session_messages(self, session_name: str) -> list[dict[str, Any]]:
    """Get messages from session."""
```

#### Session Information
```python
class SessionInfo(NamedTuple):
    session_id: str          # File name (without .json)
    display_name: str        # Title or first message snippet
    last_modified: str       # Formatted datetime
    message_count: int       # Number of messages

def get_sessions_info(self) -> list[SessionInfo]:
    """Get display information for all sessions."""
    # Sorted by modification time (newest first)
    # Display name priority: title > first_message_snippet > "(no messages)"
    # First message snippet: 40 chars max, "..." suffix if truncated
```

### Todo Management in Sessions

#### Todo Storage
- Stored in session JSON under `"todos"` field
- Each todo: `{"task": str, "completed": bool, "created_at": str}`
- Fallback to in-memory storage if no session active

#### Todo Methods
```python
def get_todos(self, session_name: str | None = None) -> list[dict[str, Any]]:
    """Get todos from session with caching."""
    # Uses current session if session_name is None
    # Returns cached todos for current session
    # Returns empty list if session doesn't exist yet

def set_todos(self, todos: list[dict[str, Any]], session_name: str | None = None) -> bool:
    """Save todos to session."""
    # Updates cache for current session
    # Creates session if it doesn't exist
    # Updates timestamp
```

### Agent Session Integration

**Location:** `code_ally/agent/session_manager.py`

```python
class SessionManager:
    """Component for agent-level session auto-save."""

    def __init__(self, agent):
        self.agent = agent

    def auto_save_session(self) -> None:
        """Auto-save after each message."""
        # Skips for non-interactive agents
        # Gets session manager from service registry
        # Filters out system messages
        # Creates session on first save if needed
        # Logs failures as warnings (non-blocking)
```

**Integration Points:**
- Called from `Agent._auto_save_session()`
- Triggered after every message append
- Triggered after command execution
- Ensures continuous persistence

### Interactive Session Selection

**Location:** `code_ally/session_selector.py`

```python
class SessionSelector:
    """Arrow key navigation for session selection."""

    def select_session(self, sessions: list[SessionInfo]) -> str | None:
        """Interactive selector with arrow keys."""
        # Arrow keys: up/down navigation
        # Enter: select session
        # q/Esc: cancel
        # Returns: session_id or None
```

**Implementation Details:**
- Uses raw terminal mode (`termios`, `tty`)
- Handles escape sequences for arrow keys
- Clears screen and redraws table on each key
- Hides cursor during selection
- Shows: indicator (→), title, last modified, message count
- Selection indicator and bold styling for current selection

### Session Operations in main.py

#### Session Setup
```python
def setup_session(
    resume_session_id: str | None,
    disable_sessions: bool = False,
    is_interactive_mode: bool = False,
    agent: Agent | None = None,
    console: Console | None = None,
) -> tuple[SessionManager | None, str | None, int]:
    """Set up session loading/creation."""
    # Creates SessionManager with model client for title generation
    # Registers with service registry (for todo functionality)
    # Returns: (session_manager, session_name, loaded_message_count)
```

**Flow:**
1. If `disable_sessions`: Return `(manager, None, 0)`
2. Determine session name: `resume_session_id` or auto-generate
3. Set as current session
4. If session exists:
   - Load messages
   - Filter out system messages
   - Extend agent messages
   - Update token count IMMEDIATELY (critical for UI)
   - Render last 3 conversation turns
5. If session doesn't exist:
   - Prepare for new session (file created on first save)

#### Session Saving
```python
def save_session(
    session_manager: SessionManager | None,
    session_name: str | None,
    agent_messages: list[dict],
    is_interactive_mode: bool = False,
    console: Console | None = None,
) -> None:
    """Save session with conversation messages only."""
    # Filters out system messages
    # Skips if no messages to save
    # Creates session if doesn't exist
    # Shows display name (title or session name)
```

#### Conversation History Rendering
```python
def _render_conversation_history(agent: Agent, messages: list[dict]) -> None:
    """Render last 3 turns when loading session."""
    # Identifies conversation turns (user + assistant pairs)
    # Shows last 3 turns (or fewer if not available)
    # Uses EXACT same rendering methods as live conversation:
    #   - ui.print_content() for user messages
    #   - ui.print_tool_call() for tool calls
    #   - ui.print_assistant_response() for assistant text
    # Shows "Previous Conversation" header
    # Shows "End of History" footer
```

**Turn Definition:**
- Starts with user message
- Includes subsequent assistant messages/tool calls
- Stops at next user message

#### Message Filtering
```python
def filter_conversation_messages(messages: list[dict]) -> list[dict]:
    """Filter out system messages to avoid duplication."""
    return [msg for msg in messages if msg.get("role") != "system"]
```

### Session CLI Integration

#### Resume Command
```python
def handle_resume_command(args: argparse.Namespace, console: Console) -> str | None:
    """Handle --resume flag."""
    # args.resume is None: not resuming
    # args.resume is "": show interactive selector
    # args.resume is "name": resume that session
    #
    # If session doesn't exist: offer to create it
    # Returns: session_id or None (cancelled)
```

**CLI Flags:**
```bash
--resume              # Interactive selector
--resume session_name # Resume specific session
--no-session         # Disable session persistence
```

---

## CLI Arguments & Configuration

### Argument Parsing

**Location:** `code_ally/main.py` - `parse_args()`

```python
def parse_args() -> argparse.Namespace:
    """Parse command line arguments with config defaults."""
    # Loads config via ConfigManager
    # Creates ArgumentParser with epilog showing interactive commands
    # Organizes arguments into logical groups
```

### Argument Groups

#### 1. Model Settings
```python
model_group = parser.add_argument_group("Model Settings")
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--model` | str | config.get("model") | Model name to use |
| `--endpoint` | str | config.get("endpoint") | Ollama API endpoint URL |
| `--temperature` | float | config.get("temperature") | Temperature (0.0-1.0) |
| `--context-size` | int | config.get("context_size") | Context size in tokens |
| `--max-tokens` | int | config.get("max_tokens") | Maximum tokens to generate |

**Configuration Integration:**
- All defaults loaded from `ConfigManager`
- Updated values override config during session
- Can be persisted with `--config` flag

#### 2. Configuration Management
```python
config_group = parser.add_argument_group("Configuration")
```

| Flag | Type | Description |
|------|------|-------------|
| `--init` | action="store_true" | Run interactive setup wizard |
| `--config` | action="store_true" | Save current CLI options as defaults |
| `--config-show` | action="store_true" | Show current configuration |
| `--config-reset` | action="store_true" | Reset configuration to defaults |

**Configuration Handlers:**
```python
def handle_config_commands(args: argparse.Namespace) -> bool:
    """Handle config commands before main execution."""
    # Returns True if command handled (exits early)
    # Returns False to continue with normal startup
```

**Operations:**
- `--init`: Runs `SetupWizard`, marks setup as completed
- `--config-show`: Prints JSON config
- `--config-reset`: Calls `ConfigManager().reset()`
- `--config`: Saves all CLI args to config file

#### 3. Security and Behavior
```python
security_group = parser.add_argument_group("Security and Behavior")
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--yes-to-all` | action="store_true" | False | Skip all confirmation prompts (dangerous) |
| `--check-context-msg` | action="store_true" | config.get("check_context_msg") | Show context reminders |

**Security Implications:**
- `--yes-to-all`: Sets `TrustManager.auto_confirm = True`
- Auto-enabled in `--once` mode
- Bypasses all permission prompts for file operations

#### 4. Debug and Diagnostics
```python
debug_group = parser.add_argument_group("Debug and Diagnostics")
```

| Flag | Type | Description |
|------|------|-------------|
| `--skip-ollama-check` | action="store_true" | Skip Ollama availability check |
| `--verbose` | action="store_true" | Enable verbose mode (INFO level) |
| `--debug` | action="store_true" | Enable debug mode (DEBUG level) |
| `--debug-tool-calls` | action="store_true" | Print raw tool calls |
| `--debug-info` | choices=["system","tokens","context"] | Show debug info in non-interactive mode |

**Logging Levels:**
- Normal: WARNING level, clean output
- Verbose (`--verbose`): INFO level, startup and operation details
- Debug (`--debug`): DEBUG level, full internal visibility

**Debug Info Flag:**
- Only works in non-interactive mode (with `--once`)
- `system`: Show system prompt and tools
- `tokens`: Show token usage and memory stats
- `context`: Show conversation context (JSON)

#### 5. Single Message Mode
```python
single_msg_group = parser.add_argument_group("Single Message Mode")
```

| Flag | Type | Description |
|------|------|-------------|
| `-1, --once` | str | Single message to process (non-interactive) |
| `--no-session` | action="store_true" | Disable automatic session persistence |
| `--resume` | nargs="?" const="" | Resume session (interactive or by name) |

**Single Message Mode:**
```bash
ally --once "What tools do you have?"
```

**Behavior:**
- Non-interactive mode
- Auto-enables `--yes-to-all` (no permission prompts)
- Still creates/uses session unless `--no-session` specified
- Can use `--resume` for persistent context

**Session Integration:**
```bash
# Auto-generated session
ally --once "What is in the current directory?"

# Continue in same session
ally --once "What type of files?" --resume session_20250120_103855_a1b2c3d4

# Or use named session
ally --once "Start debugging" --resume my-debug-session
ally --once "What did we find?" --resume my-debug-session
```

### Configuration Flow

```
CLI Args → ConfigManager → Runtime Settings → Persistence (optional)
```

**Precedence:**
1. CLI arguments (highest priority)
2. Config file values
3. Hard-coded defaults (lowest priority)

**Configuration File:**
- Location: `~/.code_ally/config.json`
- Managed by `ConfigManager` class
- JSON format with all settings

---

## Application Lifecycle

### Startup Sequence

**Entry Point:** `main.py` - `async def main()`

```
cli_entry_point()
    ↓
asyncio.run(main())
    ↓
1. Parse arguments
2. Configure logging
3. Handle config commands (early exit)
4. Check setup status (run wizard if needed)
5. Handle resume command (session selection)
6. Validate Ollama setup
7. Create model client
8. Setup services and agent
9. Configure agent settings
10. Setup signal handling
11. Run application (conversation loop)
12. Cleanup
```

### Detailed Lifecycle Steps

#### 1. Argument Parsing
```python
args = parse_args()
```
- Loads config defaults
- Parses command line
- Returns `argparse.Namespace`

#### 2. Logging Configuration
```python
configure_logging(args.verbose, args.debug)
```

**Logging Levels:**
```python
def configure_logging(verbose: bool, debug: bool) -> None:
    if debug:
        target_level = logging.DEBUG
    elif verbose:
        target_level = logging.INFO
    else:
        target_level = logging.WARNING

    # Set root logger
    logging.getLogger().setLevel(target_level)

    # Set all code_ally.* loggers
    for name in logging.getLogger().manager.loggerDict:
        if name.startswith("code_ally"):
            logging.getLogger(name).setLevel(target_level)
```

**Key Points:**
- Only affects `code_ally.*` loggers (not third-party)
- Uses `RichHandler` for formatted output
- Hierarchical: DEBUG > INFO > WARNING

#### 3. Config Command Handling
```python
if handle_config_commands(args):
    return  # Early exit
```

**Commands:**
- `--init`: Setup wizard
- `--config-show`: Display config
- `--config-reset`: Reset config
- `--config`: Save CLI args

#### 4. Setup Check
```python
if handle_setup_check(args, console):
    return  # Exit after setup
```

**Behavior:**
- Checks `setup_completed` flag in config
- Skips for config commands
- Prompts user to run setup if not completed
- Runs `SetupWizard` if user confirms
- Marks setup as completed on success
- Always exits (to allow fresh start)

#### 5. Resume Command
```python
resume_session_id = handle_resume_command(args, console)
if args.resume is not None and resume_session_id is None:
    return  # User cancelled
```

**Resume Flow:**
- `args.resume is None`: Not resuming
- `args.resume == ""`: Show interactive selector
- `args.resume == "name"`: Resume that session
- If session doesn't exist: offer to create
- Returns session_id or None (cancelled)
- Forces interactive mode if resuming

#### 6. Ollama Validation
```python
setup_ollama_validation(args, console)
```

**Validation Steps:**
1. Check if Ollama is running (`/api/tags` endpoint)
2. Get list of available models
3. If no models: prompt to continue or exit
4. If configured model not available: offer to auto-select
5. Update `args.model` with selected model

**Auto-Selection:**
- Selects first available model if none configured
- Shows warning and prompts if configured model missing
- Allows manual continuation if validation fails

**Skip Flag:**
```bash
ally --skip-ollama-check
```

#### 7. Model Client Creation
```python
model_client, client_type = create_model_client(args)
```

```python
def create_model_client(args: argparse.Namespace) -> tuple[OllamaClient, str]:
    client_type = "ollama"
    model_client = OllamaClient(
        endpoint=args.endpoint,
        model_name=args.model,
        temperature=args.temperature,
        context_size=args.context_size,
        max_tokens=args.max_tokens,
        keep_alive=60,
    )
    return model_client, client_type
```

**Client Type:**
- Currently only "ollama" supported
- Future: Anthropic, OpenAI, etc.

#### 8. Services and Agent Setup
```python
agent = setup_services_and_agent(args, model_client, client_type)
```

**Setup Flow:**
```python
def setup_services_and_agent(args, model_client, client_type):
    # 1. Get tool instances
    tools = get_registry().get_tool_instances()

    # 2. Create service registry
    service_registry = ServiceRegistry.get_instance()
    config_manager = ConfigManager()
    service_registry.register_instance("config_manager", config_manager)
    service_registry.register_instance("llm_client", model_client)

    # 3. Generate system prompt (after services registered)
    system_prompt = get_main_system_prompt()

    # 4. Create agent
    agent = Agent(
        model_client=model_client,
        client_type=client_type,
        tools=tools,
        system_prompt=system_prompt,
        verbose=args.verbose,
        check_context_msg=args.check_context_msg,
        service_registry=service_registry,
        non_interactive=bool(args.once),
    )

    return agent
```

**Agent Initialization:**
- Registers all components in service registry
- Creates managers: UI, Trust, Permission, Token, Tool, Command
- Sets up diff display for file operation previews
- Initializes usage pattern analyzer
- Registers agent itself for tool access

#### 9. Agent Configuration
```python
configure_agent(args, agent)
```

```python
def configure_agent(args: argparse.Namespace, agent: Agent) -> None:
    # Enable debug logging for tool calls
    if args.debug_tool_calls:
        logging.getLogger("code_ally.agent").setLevel(logging.DEBUG)

    # Enable auto-confirm mode
    if args.yes_to_all:
        agent.trust_manager.set_auto_confirm(True)
        logger.warning("Auto-confirm mode enabled")

    # Auto-confirm in single message mode
    if args.once:
        agent.trust_manager.set_auto_confirm(True)
```

#### 10. Signal Handling
```python
setup_signal_handling(agent)
```

```python
def setup_signal_handling(agent: Agent) -> None:
    from code_ally.agent.interrupt_coordinator import setup_interrupt_coordination
    setup_interrupt_coordination(agent)
```

**Interrupt Coordination:**
- Centralized Ctrl+C handling
- Application state tracking
- Graceful interruption during:
  - Model requests
  - Tool execution
  - User input
- Prevents leakage and corruption

#### 11. Application Execution
```python
await run_application(args, agent, console, resume_session_id)
```

**Run Application Flow:**
```python
async def run_application(args, agent, console, resume_session_id):
    try:
        if args.once:
            # Single message mode
            session_manager, session_name, _ = setup_session(
                resume_session_id,
                disable_sessions=args.no_session,
                is_interactive_mode=False,
                agent=agent,
                console=console,
            )

            # Handle debug info or process message
            if args.debug_info:
                handle_debug_info(args.debug_info, agent, console)
            else:
                await agent.run_single_message(args.once)

            # Save session
            save_session(session_manager, session_name, agent.messages,
                        is_interactive_mode=False, console=console)
        else:
            # Interactive conversation mode
            session_manager, session_name, _ = setup_session(
                resume_session_id,
                disable_sessions=args.no_session,
                is_interactive_mode=True,
                agent=agent,
                console=console,
            )

            await agent.run_conversation()

            # Save session
            save_session(session_manager, session_name, agent.messages,
                        is_interactive_mode=True, console=console)

    except (KeyboardInterrupt, GracefulExit):
        # Handled by InterruptCoordinator
        await asyncio.sleep(0.1)  # Let coordinator handle
        handle_application_errors(agent, console, args)
        sys.exit(0)

    except requests.exceptions.RequestException as e:
        # Ollama connection error
        console.print(f"Error connecting to Ollama: {e}")
        print_ollama_instructions(args.endpoint, args.model, str(e))
        sys.exit(1)

    except Exception as e:
        # Unexpected error
        logger.exception("Unexpected error occurred:")
        console.print(f"Unexpected error: {e}")
        if args.verbose:
            # Show full traceback
            console.print(Panel(traceback.format_exc(), ...))
        sys.exit(1)

    finally:
        # Cleanup
        if agent and hasattr(agent, 'model_client'):
            await agent.model_client.close()

        # Disable logging during shutdown (prevents Rich handler issues)
        logging.disable(logging.CRITICAL)
```

#### 12. Cleanup
**Finally Block:**
- Close model client HTTP session
- Disable logging to prevent Rich handler errors
- Let asyncio handle remaining tasks

### Conversation Loop

**Entry:** `agent.run_conversation()` → `ConversationManager.run_conversation_loop()`

```
while True:
    1. Manage context (deduplication, warnings, auto-compact)
    2. Get user input (with EOFError handling)
    3. Validate input (skip empty, handle reset commands)
    4. Route special commands (/commands, !bash, @agent)
    5. Prepare user message (permission denial recovery)
    6. Process user message:
        a. Append to messages
        b. Add context status if needed
        c. Update token count
        d. Auto-save session
        e. Start thinking animation
        f. Refresh system prompt
        g. Send request to LLM (streaming)
        h. Stop animation
        i. Process LLM response (tool calls, text)
        j. Loop until response complete
```

**Context Management:**
```python
async def _manage_context_before_input(self) -> None:
    # 1. Deduplication at 80% context
    if token_percentage > 80:
        deduplicate_file_content()

    # 2. Graduated warnings
    urgency, reason = get_compaction_urgency()
    if urgency in ["high", "critical"]:
        show_warning()

    # 3. Auto-compact if needed
    if should_compact():
        compact_conversation()
```

**User Input Flow:**
```python
async def _get_and_validate_user_input(self) -> Optional[str]:
    # Get input with interrupt coordination
    user_input = await ui.get_user_input()

    # Handle EOFError
    if EOFError:
        return "EOF"

    # Skip empty input
    if not user_input.strip():
        return None

    # Handle conversation reset commands
    if user_input.startswith("__RESET_TO_INDEX_"):
        # Parse index and content
        # Reset conversation
        # Prompt for edited input
        return edited_input

    return user_input
```

**Special Command Routing:**
```python
async def _route_special_commands(self, user_input: str) -> Tuple[bool, bool]:
    # Slash commands
    if user_input.startswith("/"):
        handled, messages = await command_handler.handle_command()
        return True, True  # handled, continue

    # Bash mode
    if user_input.startswith("!"):
        await _handle_bash_mode(bash_command)
        return True, True

    # @ prefix for agent calling
    if user_input.startswith("@"):
        # Let Ally handle naturally
        pass

    return False, True  # not handled, continue
```

**Message Processing:**
```python
async def _process_user_message(self, user_input: str) -> None:
    # 1. Append user message
    messages.append({"role": "user", "content": user_input})

    # 2. Add context status for new conversations
    if len(messages) <= 2:
        context_status = tool_result_manager.get_context_status_message()
        messages.append({"role": "system", "content": context_status})

    # 3. Update token count and auto-save
    token_manager.update_token_count(messages)
    _auto_save_session()

    # 4. Start animation
    animation = ui.start_thinking_animation(token_pct, model_name)

    # 5. Refresh system prompt
    _refresh_system_prompt()

    # 6. Send request to LLM
    try:
        request_in_progress = True
        interrupt_coordinator.reset_interrupt_state()
        interrupt_coordinator.set_state(MODEL_REQUEST_ACTIVE)

        response = await model_client.send(
            messages,
            functions=tool_manager.get_function_definitions(),
            stream=True,
        )
        was_interrupted = response.get("interrupted", False)
    finally:
        request_in_progress = False

    # 7. Stop animation
    ui.stop_thinking_animation()

    # 8. Process response
    if not was_interrupted and response:
        await response_processor.process_llm_response(response)
```

### Shutdown Sequence

**Triggers:**
- User types `/quit` or `/exit`
- User presses Ctrl+D (EOFError in input loop)
- User presses Ctrl+C (KeyboardInterrupt)
- Unhandled exception

**Cleanup Steps:**
1. Stop thinking animation if running
2. Save current session
3. Close model client HTTP session
4. Let InterruptCoordinator handle signal
5. Disable logging (prevent Rich handler issues)
6. Exit with appropriate code

---

## Logging System

### Configuration

**Location:** `main.py` - `configure_logging()`

```python
def configure_logging(verbose: bool, debug: bool) -> None:
    """Configure logging level based on flags."""
    # Determine level
    if debug:
        target_level = logging.DEBUG
        mode_msg = "Debug logging enabled"
    elif verbose:
        target_level = logging.INFO
        mode_msg = "Verbose logging enabled"
    else:
        target_level = logging.WARNING
        mode_msg = None

    # Set root logger
    logging.getLogger().setLevel(target_level)

    # Set all code_ally package loggers
    for name in logging.getLogger().manager.loggerDict:
        if name.startswith("code_ally"):
            logging.getLogger(name).setLevel(target_level)

    # Set main logger
    logger.setLevel(target_level)

    # Log mode if applicable
    if mode_msg:
        logger.debug(mode_msg) if debug else logger.info(mode_msg)
```

### Logging Levels

#### Normal Mode (default)
- **Level:** `logging.WARNING`
- **Output:** Clean, user-facing messages only
- **Use Case:** Regular usage

#### Verbose Mode (`--verbose`)
- **Level:** `logging.INFO`
- **Output:** Startup information, operation details
- **Use Case:** Understanding what's happening
- **Example Messages:**
  - "Loaded session: {name} with {count} messages"
  - "Model '{model}' is available"
  - "Sending request to LLM with {messages} messages, {tokens} tokens, {functions} functions"
  - "Received tool calls ({tool_names}) from LLM"

#### Debug Mode (`--debug`)
- **Level:** `logging.DEBUG`
- **Output:** Full internal visibility
- **Use Case:** Troubleshooting, development
- **Example Messages:**
  - "Generated session name: {name}"
  - "Set current session: {name}"
  - "Saved session: {name} with {count} messages"
  - "Using UI manager from service registry"
  - "Created NonInteractiveUIManager"
  - "Diff display manager configured successfully"

### Logger Hierarchy

```
code_ally (root package logger)
├── code_ally.agent
│   ├── code_ally.agent.token_manager
│   ├── code_ally.agent.tool_manager
│   ├── code_ally.agent.command_handler
│   └── ...
├── code_ally.tools
│   ├── code_ally.tools.bash
│   ├── code_ally.tools.read
│   └── ...
├── code_ally.ui
├── code_ally.session_manager
└── ...
```

**Key Points:**
- All `code_ally.*` loggers configured together
- Third-party loggers unaffected
- Consistent level across all components

### Rich Handler

**Setup:**
```python
logging.basicConfig(
    level=logging.WARNING,
    format="%(message)s",
    datefmt="[%X]",
    handlers=[RichHandler(rich_tracebacks=True)],
)
```

**Features:**
- Formatted output with colors
- Rich tracebacks for exceptions
- Timestamps in clean format
- Handles ANSI color codes properly

**Shutdown Handling:**
```python
finally:
    # Disable logging during shutdown
    logging.disable(logging.CRITICAL)
```

**Reason:** Prevents Rich handler errors when event loop closes

---

## Message Flow & Architecture

### Message Structure

**User Message:**
```python
{
    "role": "user",
    "content": "Help me debug this code"
}
```

**Assistant Message (with tool calls):**
```python
{
    "role": "assistant",
    "content": "I'll analyze the code for you.",
    "tool_calls": [
        {
            "id": "call_abc123",
            "type": "function",
            "function": {
                "name": "read",
                "arguments": "{\"file_path\": \"/path/to/file.py\"}"
            }
        }
    ]
}
```

**Tool Result Message:**
```python
{
    "role": "tool",
    "tool_call_id": "call_abc123",
    "name": "read",
    "content": "def example():\n    pass"
}
```

**System Message:**
```python
{
    "role": "system",
    "content": "You are Code Ally, a local LLM-powered pair programming assistant..."
}
```

### Message Flow Diagram

```
User Input
    ↓
[Conversation Manager]
    ↓
Command Routing
    ├─ /command → Command Handler → Updated Messages
    ├─ !bash → Bash Tool → Updated Messages
    └─ Regular → Continue
    ↓
Message Append
    ↓
Token Management
    ↓
Session Auto-Save
    ↓
System Prompt Refresh
    ↓
[Model Client]
    ↓
LLM Request (with functions)
    ↓
Response Processing
    ├─ Text Response → Display → End
    └─ Tool Calls → Tool Orchestrator
                        ↓
                    [Tool Manager]
                        ↓
                    Permission Check
                        ↓
                    Tool Execution
                        ↓
                    Result Append
                        ↓
                    Token Management
                        ↓
                    Session Auto-Save
                        ↓
                    Recursive LLM Call
```

### Component Interaction

```
Agent (Main Coordinator)
├── ConversationManager
│   └── Manages conversation loop
├── ResponseProcessor
│   └── Handles LLM responses
├── ToolOrchestrator
│   └── Orchestrates tool execution
├── SessionManager
│   └── Auto-saves after each message
├── CommandHandler
│   └── Processes slash commands
├── ToolManager
│   └── Executes tools
├── TokenManager
│   └── Tracks context usage
├── PermissionManager
│   └── Checks permissions
└── UIManager
    └── Handles display and input
```

### Key Architectural Patterns

#### 1. Service Registry Pattern
- Central registry for all components
- Dependency injection
- Enables tool access to shared services
- Example: `service_registry.get("session_manager")`

#### 2. Component Delegation
- Agent delegates to specialized managers
- Clear separation of concerns
- Example: `agent.session_manager.auto_save_session()`

#### 3. Message List as State
- Messages list is the source of truth
- All components reference same list
- Updates trigger token count refresh
- Auto-save after every modification

#### 4. Async/Await Throughout
- All I/O operations are async
- User input is async (proper interrupt handling)
- LLM requests are async (streaming support)
- Tool execution can be async

#### 5. Graceful Error Handling
- Try-except at every integration point
- Errors logged but don't crash app
- User feedback for all errors
- Rollback support for critical operations

---

## Summary

This document provides a complete specification of:

1. **Command Handler System:** All 16 slash commands with detailed implementation
2. **Session Management:** File format, lifecycle, storage, todos, titles
3. **CLI Arguments:** All flags, groups, defaults, configuration flow
4. **Application Lifecycle:** Startup sequence, conversation loop, shutdown
5. **Logging System:** Three levels, configuration, Rich handler integration
6. **Message Flow:** Structure, flow diagram, component interaction

**Key Files for TypeScript Port:**
- `/Users/bhm128/CodeAlly/code_ally/agent/command_handler.py` (2628 lines)
- `/Users/bhm128/CodeAlly/code_ally/session_manager.py` (449 lines)
- `/Users/bhm128/CodeAlly/code_ally/agent/session_manager.py` (85 lines)
- `/Users/bhm128/CodeAlly/code_ally/main.py` (1054 lines)
- `/Users/bhm128/CodeAlly/code_ally/agent/conversation_manager.py` (529 lines)
- `/Users/bhm128/CodeAlly/code_ally/session_selector.py` (168 lines)

**Total Lines Documented:** ~5000 lines of core command/session/lifecycle logic
