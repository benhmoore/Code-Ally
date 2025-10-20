# CodeAlly Additional Features and Utility Documentation

**Comprehensive documentation of additional features, utilities, and infrastructure not covered by core component reviews**

---

## Table of Contents

1. [Testing Infrastructure](#testing-infrastructure)
2. [Utility Modules](#utility-modules)
3. [Agent System](#agent-system)
4. [Session Management](#session-management)
5. [File Checking System](#file-checking-system)
6. [Trust and Security](#trust-and-security)
7. [Completion System](#completion-system)
8. [Undo System](#undo-system)
9. [File Activity Tracking](#file-activity-tracking)
10. [Interactive Selectors](#interactive-selectors)
11. [Error Handling](#error-handling)
12. [Data Formats](#data-formats)

---

## 1. Testing Infrastructure

### Test Organization

**Location**: `/Users/bhm128/CodeAlly/tests/`

**Structure**:
```
tests/
├── conftest.py              # Pytest configuration and fixtures
├── agent/                   # Agent system tests
├── agents/                  # Agent creation tests
├── checkers/                # File checker tests
├── integration/             # Integration tests
├── llm_client/              # LLM client tests
├── prompts/                 # Prompt generation tests
├── tools/                   # Tool-specific tests
├── undo/                    # Undo system tests
└── ui/                      # UI component tests
```

### Core Fixtures (`tests/conftest.py`)

```python
@pytest.fixture
def temp_directory():
    """Create a temporary directory for testing."""
    temp_dir = tempfile.mkdtemp()
    yield temp_dir
    shutil.rmtree(temp_dir)

@pytest.fixture
def sample_directory_structure(temp_directory):
    """
    Create a sample directory structure for testing.

    Structure:
    - root/
      - dir1/
        - file1.txt
        - file2.py
        - subdir1/
          - file3.md
      - dir2/
        - file4.json
      - .git/
        - config
      - .gitignore
      - file5.py
      - file6.pyc
    """
```

### Integration Tests

**File Activity Tests** (`tests/integration/test_file_activity.py`):
- Tests file existence hints with fuzzy matching
- Tests recently modified file tracking
- Tests activity tracking across multiple tools
- Tests deduplication and recency ordering

**File Checking Tests** (`tests/integration/test_file_checking.py`):
- Tests syntax validation integration
- Tests checker registry
- Tests error reporting

**Parallel Agents Tests** (`tests/integration/test_parallel_agents.py`):
- Tests concurrent agent execution
- Tests agent coordination
- Tests result aggregation

### Test Coverage

**Key Test Areas**:
1. **Tool Operations**: Write, edit, read, line_edit, bash, glob, grep
2. **Agent System**: Creation, storage, execution, parallel execution
3. **File Checking**: Python, JSON, YAML, Shell, TypeScript, PHP
4. **Undo System**: Patch creation, application, reversal
5. **Session Management**: Persistence, loading, title generation
6. **Trust System**: Permission prompts, batch operations, security checks

---

## 2. Utility Modules

### Path Management (`code_ally/paths.py`)

**Central path configuration for all application data**:

```python
# Base directory for all Code Ally data
ALLY_HOME = Path.home() / ".ally"

# Subdirectories
SESSIONS_DIR = ALLY_HOME / "sessions"
AGENTS_DIR = ALLY_HOME / "agents"
PATCHES_DIR = ALLY_HOME / "patches"
CACHE_DIR = ALLY_HOME / "cache"
COMPLETION_CACHE_DIR = CACHE_DIR / "completion"

# Files
CONFIG_FILE = ALLY_HOME / "config.json"
COMMAND_HISTORY_FILE = ALLY_HOME / "command_history"
```

**Directory Structure**:
```
~/.ally/
├── config.json              # Configuration
├── command_history          # Command history
├── sessions/                # Conversation sessions
├── agents/                  # Custom agents
├── patches/                 # Undo patches
└── cache/
    └── completion/          # Path completion cache
```

**Functions**:
- `ensure_directories()`: Creates all required directories if they don't exist

### Version Management (`code_ally/_version.py`)

```python
__version__ = "0.6.0"
```

Simple version tracking for the application.

### Path Resolution (`code_ally/utils.py`)

**Deprecated Wrapper**:
```python
def resolve_path_with_focus(file_path: str) -> str:
    """Resolve a file path using focus-aware resolution when available.

    DEPRECATED: Use code_ally.services.path_resolver.resolve_path() instead.
    This function is maintained for backward compatibility.
    """
    return _resolve_path(file_path)
```

**Note**: Modern code should use `code_ally.services.path_resolver.resolve_path()` directly.

### Thinking Model Support (`code_ally/thinking.py`)

**Purpose**: Parses and handles responses from models that output thinking tags (e.g., DeepSeek, QwQ).

**Data Structures**:
```python
@dataclass
class ThinkingResponse:
    """Parsed response from a thinking model."""
    thinking: str | None
    content: str
```

**Components**:

1. **ThinkingModelDetector**: Detects thinking-capable models
   ```python
   THINKING_PATTERNS = [
       re.compile(r"<think>\s*(.*?)\s*</think>\s*(.*)", re.DOTALL | re.IGNORECASE),
       re.compile(r"<thinking>\s*(.*?)\s*</thinking>\s*(.*)", re.DOTALL | re.IGNORECASE),
   ]

   def has_thinking_content(cls, content: str) -> bool:
       """Check if content contains thinking tags."""
   ```

2. **ThinkingResponseParser**: Parses thinking content from responses
   ```python
   def parse_response(cls, content: str) -> ThinkingResponse:
       """Parse thinking content from model response."""
   ```

3. **ThinkingModelManager**: Manages thinking model capabilities
   ```python
   def has_thinking_content(self, content: str) -> bool
   def parse_response(self, content: str) -> ThinkingResponse
   ```

**Usage Pattern**:
```python
manager = ThinkingModelManager()

# Check for thinking content
if manager.has_thinking_content(response_text):
    parsed = manager.parse_response(response_text)
    # parsed.thinking contains internal reasoning
    # parsed.content contains the actual response
```

---

## 3. Agent System

### Overview

**Purpose**: Create and manage specialized agents for different tasks and domains.

**Storage**: Agents are stored as Markdown files in `~/.ally/agents/`

**Key Components**:
1. `AgentStorage`: Persistence layer
2. `AgentManager`: Lifecycle management
3. `AgentGenerator`: LLM-powered agent creation
4. `AgentWizard`: Interactive creation interface

### Agent File Format

**Structure**:
```markdown
---
name: "security-reviewer"
description: "Reviews code for security vulnerabilities and best practices"
created_at: "2025-01-20T10:30:00Z"
updated_at: "2025-01-20T10:30:00Z"
model: "qwen2.5-coder:32b"  # Optional: specific model
tools: ["read", "grep", "glob"]  # Optional: allowed tools
temperature: 0.3  # Optional: custom temperature
---

# System Prompt

You are a senior security engineer specialized in code review...
```

### Agent Storage (`code_ally/agents/storage.py`)

**Class**: `AgentStorage`

**Methods**:
```python
def save_agent(
    self,
    name: str,
    description: str,
    system_prompt: str,
    model: str | None = None,
    tools: list[str] | None = None,
    temperature: float | None = None
) -> bool:
    """Save an agent to storage."""

def load_agent(self, agent_name: str) -> dict[str, str] | None:
    """Load an agent from storage."""

def list_agents(self) -> list[AgentInfo]:
    """List all available agents."""

def delete_agent(self, agent_name: str) -> bool:
    """Delete an agent from storage."""

def update_agent(
    self,
    name: str,
    description: str | None = None,
    system_prompt: str | None = None
) -> bool:
    """Update an existing agent."""
```

**Data Structure**:
```python
class AgentInfo(NamedTuple):
    """Information about an agent for display purposes."""
    name: str
    description: str
    created_at: str
    system_prompt_preview: str  # First 100 chars
    model: str | None
```

### Agent Manager (`code_ally/agents/manager.py`)

**Class**: `AgentManager`

**Key Features**:
- Ensures default "general" agent exists
- Coordinates agent creation and deletion
- Prevents deletion of default agent
- Formats agent information for system prompts

**Methods**:
```python
async def generate_agent_content(self, description: str) -> dict[str, Any]:
    """Generate agent content without saving to storage."""

async def create_agent(self, description: str) -> dict[str, Any]:
    """Create a new agent from a description."""

def create_agent_with_config(
    self,
    name: str,
    description: str,
    system_prompt: str,
    model: str | None = None,
    tools: list[str] | None = None,
    temperature: float | None = None
) -> bool:
    """Create an agent with explicit configuration."""

def get_agents_for_system_prompt(self) -> str:
    """Get agent information formatted for inclusion in system prompt."""
```

**Default Agent**:
```python
def _get_default_agent_prompt(self) -> str:
    """Get the system prompt for the default general-purpose agent."""
    return """You are a general-purpose AI assistant specialized in software development tasks. You excel at:

**Core Capabilities:**
- Complex multi-step analysis and implementation
- Codebase exploration and understanding
- Problem-solving across multiple domains
- Thorough research and investigation

**Working Style:**
- Use multiple tools systematically (aim for 5+ tools minimum per task)
- Be thorough and methodical in your analysis
- Provide detailed explanations of findings and approaches
- Always complete tasks fully rather than stopping prematurely

**Tool Usage:**
- Extensively use search tools (grep, glob) to understand codebases
- Read multiple files to build comprehensive understanding
- Execute tests and verify solutions when applicable
- Make necessary file changes and implementations

**Agent Awareness:**
- When a task would benefit from specialized expertise, recommend using a more specific agent
- For example: "This task involves API security analysis - consider using the 'security-auditor' agent for specialized expertise"
- Always complete the current task first, then make recommendations

**Communication:**
- Summarize your findings and approach clearly
- Explain what was accomplished and any important discoveries
- Provide actionable next steps or recommendations

Continue working until you have thoroughly addressed the task through comprehensive analysis and implementation."""
```

### Agent Generator (`code_ally/agents/generator.py`)

**Class**: `AgentGenerator`

**LLM-Powered Generation**:
```python
async def generate_agent(self, user_description: str) -> dict[str, str] | None:
    """Generate an agent from a user description.

    Returns:
        Dict with 'name', 'description', and 'system_prompt' keys
    """
```

**Generation Prompt Template**:
```
Create a specialized agent based on this user description:

"{user_description}"

Generate exactly 3 components:

1. **Agent Name**: A short, descriptive name (hyphenated, lowercase, like "code-reviewer" or "api-tester")

2. **Usage Description**: 1-2 sentences describing when this agent should be used (what tasks/domains it specializes in)

3. **System Prompt**: A comprehensive system prompt that gives the agent the right personality, expertise, and approach for its specialized domain. This should be detailed and specific to the agent's purpose.

Format your response as:

## Name
[agent-name]

## Description
[when to use this agent]

## System Prompt
[detailed system prompt for the agent]
```

**Response Parsing**:
```python
def _parse_generated_agent(self, content: str) -> dict[str, str] | None:
    """Parse the generated agent content into structured data."""
    # Extracts sections by ## headers
    # Validates required fields
    # Sanitizes agent name for filesystem
```

### Agent Wizard (`code_ally/agents/wizard.py`)

**Class**: `AgentWizard`

**Interactive Creation Workflow**:

1. **System Prompt Strategy**:
   - Option 1: With Ally (LLM generates prompt from description)
   - Option 2: Manual (user writes prompt)

2. **Model Configuration**:
   - Use global model setting (default)
   - Select specific model for this agent

3. **Temperature Configuration**:
   - Use default temperature
   - Set custom temperature (0.0-2.0)

4. **Tool Access Configuration**:
   - All tools: Agent can use all available tools
   - Restricted: Choose specific tools
   - Read-only: Only file reading and analysis tools

5. **Review and Create**:
   - Shows configuration summary table
   - Confirms creation
   - Saves agent to storage

**Commands**:
```bash
/agent create [description]  # Create new agent
/agent ls                    # List all agents
/agent show <name>           # Show agent details
/agent edit <name>           # Edit agent description
/agent delete <name>         # Delete agent
```

**Example Usage**:
```python
wizard = AgentWizard(console, agent_manager, agent_instance)
await wizard.run("create Review code for security vulnerabilities")
```

---

## 4. Session Management

### Session Manager (`code_ally/session_manager.py`)

**Class**: `SessionManager`

**Purpose**: Manages conversation sessions with file-based persistence.

**Session File Structure**:
```json
{
  "name": "my-project",
  "title": "Debug authentication flow",  # Auto-generated or null
  "created_at": "2025-06-07T10:38:55.143436",
  "updated_at": "2025-06-07T10:39:19.977816",
  "messages": [
    {
      "role": "user",
      "content": "What is in the current directory?"
    },
    {
      "role": "assistant",
      "content": "...",
      "tool_calls": [...]
    }
  ],
  "todos": []  # Session-specific todos
}
```

**Key Methods**:
```python
def generate_session_name(self) -> str:
    """Generate a unique session name."""
    # Format: session_20250607_103855_a1b2c3d4
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    short_uuid = str(uuid.uuid4())[:8]
    return f"session_{timestamp}_{short_uuid}"

def create_session(self, session_name: str | None = None) -> str:
    """Create a new session."""

def load_session(self, session_name: str) -> dict[str, Any] | None:
    """Load an existing session."""

def save_session(self, session_name: str, messages: list[dict[str, Any]]) -> bool:
    """Save messages to a session."""

def get_todos(self, session_name: str | None = None) -> list[dict[str, Any]]:
    """Get todos from current or specified session."""

def set_todos(
    self,
    todos: list[dict[str, Any]],
    session_name: str | None = None,
) -> bool:
    """Set todos for current or specified session."""
```

**Session Info**:
```python
class SessionInfo(NamedTuple):
    """Information about a session for display purposes."""
    session_id: str
    display_name: str  # Either title or first_message_snippet
    last_modified: str
    message_count: int
```

**Automatic Cleanup**:
```python
def _cleanup_old_sessions(self, max_sessions: int = 10) -> None:
    """Clean up old sessions, keeping only the most recent ones."""
```

### Session Title Generator (`code_ally/session_title_generator.py`)

**Class**: `SessionTitleGenerator`

**Purpose**: Asynchronously generates descriptive titles for chat sessions based on the first user message.

**Background Generation**:
```python
def generate_title_background(
    self,
    session_name: str,
    first_user_message: str,
    sessions_dir: Path,
) -> None:
    """Start background title generation for a session.

    This method is non-blocking and starts title generation in the background.
    """
    # Creates async task
    # Adds to background task set
    # Removes task on completion
```

**LLM Prompt**:
```python
messages = [
    {
        "role": "system",
        "content": (
            "Generate a concise, descriptive title (2-5 words) for a chat session "
            "based on the user's first message. The title should capture the main "
            "topic or intent. Respond with only the title, no quotes or extra text."
        )
    },
    {
        "role": "user",
        "content": f"First message: {first_user_message}"
    }
]
```

**Title Processing**:
```python
# Remove quotes if present
title = title.strip('"\'`')
# Limit length
title = title[:50] if len(title) > 50 else title
```

**Integration**:
- Automatically triggered on first user message
- Runs in background without blocking conversation
- Updates session file when complete
- Falls back to message snippet if generation fails

### Session Selector (`code_ally/session_selector.py`)

**Class**: `SessionSelector`

**Purpose**: Interactive session selection with arrow key navigation.

**Features**:
- Arrow key navigation (↑/↓)
- Enter to select
- q/Esc to cancel
- Shows session title or first message preview
- Displays last modified time and message count

**Key Methods**:
```python
def select_session(self, sessions: list[SessionInfo]) -> str | None:
    """Interactive session selection with arrow key navigation."""

def _create_sessions_table(
    self, sessions: list[SessionInfo], selected_index: int,
) -> Table:
    """Create a table showing available sessions."""

def _get_key(self) -> str:
    """Get a single key press from the user."""
```

**Display Format**:
```
┌─ Available Sessions ─────────────────────────┐
│   │ Title               │ Last Modified  │ Messages │
├───┼────────────────────┼────────────────┼──────────┤
│ → │ Debug auth flow    │ 2025-06-07 10:39│ 12      │
│   │ Refactor API       │ 2025-06-06 15:22│ 8       │
│   │ Fix CSS layout     │ 2025-06-05 09:15│ 5       │
└───┴────────────────────┴────────────────┴──────────┘

Use ↑/↓ to navigate, Enter to select, q/Esc to cancel
```

---

## 5. File Checking System

### Base Classes (`code_ally/checkers/base.py`)

**Data Structures**:
```python
@dataclass
class CheckIssue:
    """A single syntax/parse issue found in a file."""
    line: Optional[int]
    column: Optional[int]
    message: str
    severity: str  # "error" | "warning"
    code: Optional[str] = None

@dataclass
class CheckResult:
    """Result of running a file checker."""
    checker: str
    passed: bool
    errors: list[CheckIssue]
    warnings: list[CheckIssue]
    check_time_ms: float
```

**Abstract Base**:
```python
class FileChecker(ABC):
    """Base class for language-specific file checkers."""

    @abstractmethod
    def can_check(self, file_path: str) -> bool:
        """Returns True if this checker supports the file type."""

    @abstractmethod
    def check(self, file_path: str, content: str) -> CheckResult:
        """Run checks and return results."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Checker name for display."""
```

### Checker Registry (`code_ally/checkers/registry.py`)

**Class**: `CheckerRegistry`

**Purpose**: Routes files to appropriate checkers based on file extension.

**Methods**:
```python
def register(self, checker: FileChecker) -> None:
    """Register a new file checker."""

def get_checker(self, file_path: str) -> Optional[FileChecker]:
    """Get the appropriate checker for a file."""

def check_file(self, file_path: str, content: str) -> Optional[CheckResult]:
    """Check a file using the appropriate checker."""
```

**Default Checkers**:
```python
def _initialize_default_checkers(registry: CheckerRegistry) -> None:
    """Initialize the default set of checkers."""
    from code_ally.checkers.python_checker import PythonChecker
    from code_ally.checkers.typescript_checker import TypeScriptChecker
    from code_ally.checkers.php_checker import PHPChecker
    from code_ally.checkers.json_checker import JSONChecker
    from code_ally.checkers.javascript_checker import JavaScriptChecker
    from code_ally.checkers.yaml_checker import YAMLChecker
    from code_ally.checkers.shell_checker import ShellChecker
    from code_ally.checkers.powershell_checker import PowerShellChecker

    # Register built-in checkers (fast ones first for priority)
    registry.register(PythonChecker())
    registry.register(JSONChecker())
    registry.register(YAMLChecker())
    registry.register(ShellChecker())
    registry.register(PowerShellChecker())
    registry.register(JavaScriptChecker())
    registry.register(TypeScriptChecker())
    registry.register(PHPChecker())
```

**Global Registry**:
```python
def get_default_registry() -> CheckerRegistry:
    """Get or create the default checker registry.

    Lazy initialization ensures checkers are only loaded when needed.
    """
```

### Checker Implementations

**Available Checkers**:
1. **PythonChecker**: Uses Python AST for syntax validation
2. **JSONChecker**: Uses `json.loads()` for validation
3. **YAMLChecker**: Uses `yaml.safe_load()` for validation
4. **ShellChecker**: Basic shell script validation
5. **PowerShellChecker**: PowerShell script validation
6. **JavaScriptChecker**: JavaScript syntax checking
7. **TypeScriptChecker**: TypeScript syntax checking
8. **PHPChecker**: PHP syntax checking

**Example Implementation** (Python):
```python
class PythonChecker(FileChecker):
    @property
    def name(self) -> str:
        return "python"

    def can_check(self, file_path: str) -> bool:
        return file_path.endswith('.py')

    def check(self, file_path: str, content: str) -> CheckResult:
        start_time = time.time()
        errors = []
        warnings = []

        try:
            compile(content, file_path, 'exec')
        except SyntaxError as e:
            errors.append(CheckIssue(
                line=e.lineno,
                column=e.offset,
                message=e.msg,
                severity="error"
            ))

        check_time_ms = (time.time() - start_time) * 1000

        return CheckResult(
            checker=self.name,
            passed=len(errors) == 0,
            errors=errors,
            warnings=warnings,
            check_time_ms=check_time_ms
        )
```

---

## 6. Trust and Security

### Trust Manager (`code_ally/trust.py`)

**Purpose**: Security layer for permission management and command validation.

**Key Features**:
1. Command allowlist/denylist checking
2. User permission management
3. Path-based trust scoping
4. Directory access restriction
5. Sensitivity tier classification

### Security Levels

**Sensitivity Tiers**:
```python
def get_command_sensitivity_tier(command: str) -> str:
    """Determine the sensitivity tier of a command.

    Returns:
        "EXTREMELY_SENSITIVE", "SENSITIVE", or "NORMAL"
    """
```

**Extremely Sensitive Commands**:
- System destruction: `rm -rf /`, `find / -delete`
- Dangerous disk operations: `dd if=/dev/zero`, `mkfs`
- Remote code execution: `curl | bash`, `wget | sh`
- Privilege escalation: `sudo su`, `sudo -i`
- System configuration: `passwd`, `usermod`, `visudo`

**Sensitive Commands**:
- File operations outside CWD
- Commands with sudo/su
- Network operations
- Single file deletion
- Chmod/chown operations

### Permission Management

**Class**: `TrustManager`

**Permission Scopes**:
```python
class PermissionScope(Enum):
    """Permission scope levels for trust management."""
    GLOBAL = auto()      # Trust for all paths and instances
    SESSION = auto()     # Trust for the current session only
    DIRECTORY = auto()   # Trust for a specific directory
    FILE = auto()        # Trust for a specific file only
    ONCE = auto()        # Trust for this one call only
```

**Data Structure**:
```python
@dataclass
class ToolPermission:
    """Represents a permission for a specific tool."""
    tool_name: str
    scope: PermissionScope
    path: str | None = None
    operation_id: str | None = None
```

**Methods**:
```python
def is_trusted(self, tool_name: str, path: CommandPath | None = None) -> bool:
    """Check if a tool is trusted for the given path."""

def trust_tool(self, tool_name: str, path: str | None = None) -> None:
    """Mark a tool as trusted for the given path."""

def prompt_for_permission(
    self,
    tool_name: str,
    path: CommandPath | None = None,
) -> bool:
    """Prompt the user for permission to use a tool."""

def prompt_for_batch_operations(
    self,
    tool_calls: list[dict],
) -> bool:
    """Prompt for permission to perform multiple tool operations in batch."""
```

### Permission UI

**Interactive Menu**:
```
┌─ 🔐 PERMISSION REQUIRED ────────────────────────┐
│                                                  │
│ You are about to execute the following command: │
│                                                  │
│ ┌────────────────────────────────────────────┐  │
│ │ rm -rf /tmp/build                          │  │
│ └────────────────────────────────────────────┘  │
│                                                  │
└──────────────────────────────────────────────────┘

Use arrow keys to navigate, Enter to select:

> Allow
  Deny
  Always Allow
```

**Permission Options**:
- **Allow**: Grant one-time permission
- **Deny**: Reject the operation
- **Always Allow**: Grant permanent permission (not shown for extremely sensitive commands)

**Keyboard Navigation**:
- ↑/↓: Navigate options
- Enter: Select option
- Ctrl+C: Cancel operation

### Path Traversal Protection

**Functions**:
```python
def is_path_within_cwd(path: str) -> bool:
    """Check if a path is within the current working directory."""

def has_path_traversal_patterns(input_str: str) -> bool:
    """Check if a string contains path traversal patterns."""

def has_dangerous_path_patterns(command: str) -> bool:
    """Check if a command contains extremely dangerous path patterns."""
```

**Dangerous Patterns**:
- `..` (parent directory)
- `/etc/`, `/var/`, `/usr/`
- `~/` (home directory)
- `$HOME`, `${HOME}`
- `$(pwd)`, `` `pwd` ``
- Absolute paths outside CWD

### Command Filtering

**Blocked Commands** (hard blocks):
- Currently empty - all dangerous commands prompt user

**Sensitive Patterns**:
```python
SENSITIVE_PATTERNS = [
    r"ls\s+(-[alFhrt]+\s+)?(\.\.|\/|\~)[\/]?",  # List files outside CWD
    r"cat\s+(\.\.|\/|\~)[\/]?",  # Cat files outside CWD
    r"grep\s+.+\s+(\.\.|\/|\~)[\/]?",  # Grep outside CWD
    r"^rm\s+[^\s\-\*]+$",  # Single file rm
]
```

**Extremely Sensitive Patterns**:
```python
EXTREMELY_SENSITIVE_PATTERNS = [
    r"^rm\s+(-[rf]+|--recursive|--force).*",  # rm with recursive/force
    r"^rm\s+.*\*",  # rm with wildcards
    r"dd\s+if=\/dev\/zero\s+of=",  # Disk wiping
    r"curl\s+.+\s*\|\s*(bash|sh|zsh)",  # Remote code execution
    r"sudo\s+(su|bash|sh|zsh)",  # Privilege escalation
]
```

### Exceptions

**Custom Exceptions**:
```python
class PermissionDeniedError(Exception):
    """Raised when a user denies permission for a tool."""

class DirectoryTraversalError(Exception):
    """Raised when an operation attempts to access paths outside of allowed directory."""
```

---

## 7. Completion System

### Composite Completer (`code_ally/completion/composite_completer.py`)

**Class**: `CompositeCompleter`

**Purpose**: Routes completion requests to appropriate completers based on input prefix.

**Routing Logic**:
```python
def get_completions(self, document: Document, complete_event) -> Iterable[Completion]:
    """Get completions by routing to appropriate completer."""
    text = document.text

    # Route to appropriate completer based on prefix
    if text.startswith("@"):
        # Agent completion
        yield from self.agent_completer.get_completions(document, complete_event)
    elif text.startswith("/"):
        if text.startswith("/focus "):
            # Directory-only completions for focus command
            yield from self._get_focus_directory_completions(document, complete_event)
        else:
            # Regular command completion
            yield from self.command_completer.get_completions(document, complete_event)
    else:
        # Default to path completion
        yield from self.path_completer.get_completions(document, complete_event)
```

**Sub-Completers**:
1. **PathCompleter**: File path completion
2. **AgentCompleter**: Agent name completion (`@agent-name`)
3. **CommandCompleter**: Slash command completion (`/command`)

### Path Indexer (`code_ally/completion/path_indexer.py`)

**Class**: `PathIndexer`

**Purpose**: Indexes file paths for fast tab completion.

**Configuration**:
```python
self.max_depth = 8  # Maximum directory depth to index
self.ignore_patterns = {
    '.git', '.svn', '.hg', '.bzr',  # Version control
    '__pycache__', '.pytest_cache', 'node_modules',  # Build artifacts
    '.tox', 'venv', '.venv', 'env', '.env',  # Virtual environments
}
self.ignore_extensions = {
    '.pyc', '.pyo', '.pyd', '.so', '.dylib', '.dll',  # Binaries
    '.log', '.tmp', '.temp', '.bak', '.swp',  # Temporary files
}
```

**Methods**:
```python
def index_directory(self, directory: Path, max_depth: int = None) -> int:
    """Index all files in a directory."""

def add_path(self, path: str) -> None:
    """Add a path to the index."""

def find_completions(self, partial_path: str) -> List[str]:
    """Find path completions for a partial path with case-insensitive matching."""

def rebuild_index(self, working_dir: Path | None = None) -> int:
    """Rebuild the entire index from scratch."""

def save_cache(self) -> bool:
    """Save the index to cache file."""

def load_cache(self) -> bool:
    """Load the index from cache file."""

def is_cache_stale(self, max_age_seconds: int = 300) -> bool:
    """Check if the cache is stale."""
```

**Completion Ranking**:
```python
def sort_key(path):
    # Priority 0: Exact case-sensitive basename match
    # Priority 1: Case-sensitive prefix match
    # Priority 2: Case-sensitive suffix match
    # Priority 3: Case-sensitive substring match
    # Priority 4: Case-insensitive basename match
    # Priority 5: Case-insensitive prefix match
    # Priority 6: Case-insensitive suffix match
    # Priority 7: Case-insensitive substring match
```

**Cache Structure**:
```json
{
  "file_paths": ["path1", "path2"],
  "basename_to_paths": {
    "file.py": ["dir1/file.py", "dir2/file.py"]
  },
  "last_update_time": 1234567890,
  "indexed_directories": ["/path/to/dir"]
}
```

### Agent Completer (`code_ally/completion/agent_completer.py`)

**Purpose**: Provides completions for agent names when user types `@`.

**Features**:
- Lists all available agents
- Caches agent list for performance
- Invalidates cache when agents are created/deleted

### Command Completer (`code_ally/completion/command_completer.py`)

**Purpose**: Provides completions for slash commands.

**Supported Commands**:
- `/help`: Show help information
- `/config`: Show configuration
- `/compact`: Compact conversation
- `/reset`: Reset conversation
- `/focus`: Set focus directory
- `/agent`: Manage agents
- `/undo`: Undo operations
- And more...

---

## 8. Undo System

### Patch Manager (`code_ally/undo/patch_manager.py`)

**Class**: `PatchManager`

**Purpose**: Manages patch-based undo functionality for file operations.

**Storage**: Patches stored in `~/.ally/patches/`

**Patch File Format**:
```diff
# Code Ally Patch File
# Operation: write
# File: /path/to/file.py
# Timestamp: 2025-01-20T10:30:00Z
#
# To apply this patch in reverse: patch -R -p1 < this_file
#

--- a/file.py
+++ b/file.py
@@ -1,3 +1,4 @@
 def hello():
-    print("Hello")
+    print("Hello, World!")
+    return True
```

**Index File** (`patch_index.json`):
```json
{
  "next_patch_number": 5,
  "patches": [
    {
      "patch_number": 1,
      "timestamp": "2025-01-20T10:30:00Z",
      "operation_type": "write",
      "file_path": "/absolute/path/to/file.py",
      "patch_file": "patch_001.diff"
    }
  ]
}
```

**Methods**:
```python
def capture_operation(
    self,
    operation_type: str,  # 'write' | 'edit' | 'delete' | 'patch'
    file_path: str,
    original_content: str,
    new_content: Optional[str] = None,
) -> Optional[int]:
    """Capture a file operation and create a patch file + index entry."""

def undo_operations(self, count: int = 1) -> Tuple[bool, List[str], List[str]]:
    """Undo the last N operations.

    Returns:
        (success, successfully_reverted_files, failed_operations)
    """

def preview_undo_operations(self, count: int = 1) -> Optional[List[Dict[str, Any]]]:
    """Preview what would be undone without actually applying changes."""

def get_patch_history(self, limit: Optional[int] = None) -> List[Dict[str, Any]]:
    """Get patch history in reverse chronological order."""

def clear_patch_history(self) -> Tuple[bool, str]:
    """Clear all patches and reset the index."""
```

**Diff Creation**:
```python
def create_unified_diff(
    self, original_content: str, new_content: str, file_path: str
) -> str:
    """Create a unified diff between original and new content.

    Uses git-style headers with a/ and b/ prefixes and 3 lines of context.
    """
```

**Patch Application**:
```python
def _apply_patch_with_library(
    self, diff_content: str, file_path: str, reverse: bool = False
) -> bool:
    """Apply a unified diff using patch-ng with an atomic write."""
    # Uses patch_ng library for reliable patching
    # Creates temporary working directory
    # Applies patch in isolation
    # Atomically replaces target file on success
    # Restores backup on failure
```

**Thread Safety**: Uses `threading.Lock()` for thread-safe operations.

**Session Management**: Clears previous session patches on initialization to start fresh.

---

## 9. File Activity Tracking

### File Activity Tracker (`code_ally/services/file_activity_tracker.py`)

**Class**: `FileActivityTracker`

**Purpose**: Tracks recent file read/write operations to provide context to models.

**Data Structure**:
```python
self._recent_files: deque[str] = deque(maxlen=max_recent_files)
```

**Methods**:
```python
def record_file_access(self, file_path: str, operation: str) -> None:
    """Record a file access operation.

    Args:
        file_path: Path to the file that was accessed
        operation: Type of operation ('read', 'write', 'edit', 'line_edit')
    """
    # Normalizes path
    # Removes if already present (moves to front)
    # Adds to front of queue (most recent first)

def get_recent_files(self, limit: Optional[int] = None) -> list[str]:
    """Get list of recently accessed files."""

def clear(self) -> None:
    """Clear all tracked files."""
```

**Global Singleton**:
```python
def get_file_activity_tracker() -> FileActivityTracker:
    """Get or create the global file activity tracker."""
```

**Integration with Tools**:
- All file tools (read, write, edit, line_edit) record activity
- Recent files included in tool responses
- Helps models understand working context
- Limited to 5 most recent files in responses

**Deduplication**:
- Modifying same file moves it to front
- Prevents duplicate entries
- Maintains recency order

**Path Format**:
- Uses relative paths when shorter than absolute
- Normalizes all paths for consistency
- Stores absolute paths internally

---

## 10. Interactive Selectors

### Model Selector (`code_ally/model_selector.py`)

**Class**: `ModelSelector`

**Purpose**: Interactive model selection with arrow key navigation.

**Features**:
- Lists all Ollama models with metadata
- Shows model size, family, parameters, modified date
- Highlights current model
- Arrow key navigation
- Uses Rich's alternate screen buffer

**Display**:
```
┌─ 🤖 Select Model ───────────────────────────────────┐
│   │ Model Name          │ Size   │ Family  │ Params │
├───┼────────────────────┼────────┼─────────┼────────┤
│ ▶ │ qwen2.5-coder:32b  │ 19.0GB │ qwen2.5 │ 32B    │
│   │ ● llama3.2:latest  │ 2.0GB  │ llama   │ 3B     │
│   │ codellama:13b      │ 7.4GB  │ llama   │ 13B    │
└───┴────────────────────┴────────┴─────────┴────────┘

Current: ● llama3.2:latest
Selected: ▶ qwen2.5-coder:32b

Navigation: ↑/↓ move • Enter select • q/Esc cancel
```

**Methods**:
```python
def select_model(self, endpoint: str, current_model: str | None = None) -> str | None:
    """Interactive model selection with arrow key navigation."""

def _get_models_from_ollama(self, endpoint: str) -> list[ModelInfo]:
    """Get models from Ollama API and format them."""

def _format_size(self, size_bytes: int) -> str:
    """Format file size in human-readable format."""
```

**Data Structure**:
```python
class ModelInfo(NamedTuple):
    """Information about a model for display purposes."""
    name: str
    size: str
    family: str
    parameters: str
    modified: str
```

### Prompt History Selector (`code_ally/prompt_history_selector.py`)

**Class**: `PromptHistorySelector`

**Purpose**: Interactive prompt history selector for conversation editing.

**Features**:
- Displays all user prompts in conversation
- Shows prompt preview and full content
- Allows selection for editing
- Truncates conversation to selected point

**Display**:
```
┌─ Select Conversation Point ──────────────────────────┐
│   │ Prompt Preview                                    │
├───┼──────────────────────────────────────────────────┤
│   │ What is in the current directory?                 │
│ ▶ │ Add type hints to the helper functions           │
│   │ Run the tests and fix any failures               │
└───┴──────────────────────────────────────────────────┘

Selected prompt 2 of 3:
Full prompt:
  Add type hints to the helper functions
  in utils.py and validate.py

The selected prompt will be loaded into the input buffer for editing.
Everything after it will be removed.

Navigation: ↑/↓ move • Enter load for editing • q/Esc cancel
```

**Methods**:
```python
def select_prompt(self, messages: list[dict]) -> tuple[int, str] | None:
    """Interactive prompt selection with arrow key navigation.

    Returns:
        Tuple of (message_index, prompt_content) to reset to and edit
    """

def _extract_prompts_from_messages(self, messages: list[dict]) -> list[PromptHistoryEntry]:
    """Extract user prompts from conversation messages."""

def _create_prompt_preview(self, content: str, max_length: int = 80) -> str:
    """Create a truncated preview of prompt content."""
```

**Data Structure**:
```python
class PromptHistoryEntry(NamedTuple):
    """Information about a prompt history entry for display purposes."""
    index: int  # Message index in conversation
    content: str  # The user prompt content
    timestamp: str  # When the prompt was made
    preview: str  # Truncated preview for display
```

### Shared Keyboard Handling

**Common Pattern** across all selectors:
```python
def _get_key(self) -> str:
    """Get a single key press from the user."""
    # Uses termios and tty for raw input
    # Handles escape sequences for arrow keys
    # Returns: "up", "down", "enter", "quit", "ctrl_c"
```

**Terminal Control**:
- Uses `termios` for raw terminal input
- Handles arrow keys via escape sequences
- Hides cursor during navigation
- Restores terminal state on exit
- Uses alternate screen buffer (preserves conversation history)

---

## 11. Error Handling

### Error Handler (`code_ally/agent/error_handler.py`)

**Purpose**: Provides error handling and formatting utilities for agents.

**Functions**:

```python
def format_error_message(
    error_msg: str,
    tool_name: str,
    arguments: dict[str, Any],
    task_id: str | None = None,
    task_desc: str | None = None,
) -> dict[str, Any]:
    """Format an error message with context details.

    Returns:
        {
            "error_note": str,  # Full context for model
            "display_error_note": str,  # Concise version for user
            "possible_fix": str | None,  # Suggested fix if available
        }
    """
```

**Error Context**:
- Full context for model: `"The tool 'bash' failed with arguments command=ls. The error was: ..."`
- Concise for user: `"Tool 'bash' failed: ..."`
- Task context when available: `"The task 'validate-code' (Validate Python syntax) failed..."`

**Suggested Fixes**:
```python
# Determines possible fixes based on error type
if "file not found" in error_msg.lower():
    possible_fix = "Check that the file path is correct and the file exists."
elif "permission denied" in error_msg.lower():
    possible_fix = "Check file permissions or try a different approach."
elif "syntax error" in error_msg.lower():
    possible_fix = "Review the syntax and fix any errors."
elif "command not found" in error_msg.lower():
    possible_fix = "Verify the command exists and is spelled correctly."
elif "timeout" in error_msg.lower():
    possible_fix = "The operation took too long. Consider optimizing or breaking it down."
```

**Display Function**:
```python
def display_error(
    ui_manager: Any,
    error_msg: str,
    tool_name: str,
    arguments: dict[str, Any],
    task_id: str | None = None,
    task_desc: str | None = None,
) -> None:
    """Display formatted error messages to the user."""
    # Uses Rich formatting
    # Shows error note in yellow
    # Shows possible fix in blue if available
```

### Custom Exceptions

**Permission Exceptions** (from `code_ally/trust.py`):
```python
class PermissionDeniedError(Exception):
    """Raised when a user denies permission for a tool.

    This special exception allows the agent to immediately stop processing
    and return to the main conversation loop.
    """

class DirectoryTraversalError(Exception):
    """Raised when an operation attempts to access paths outside of allowed directory."""
```

**Usage Pattern**:
```python
try:
    result = tool.execute(**arguments)
except PermissionDeniedError:
    # User denied permission - stop processing and return control
    return {"success": False, "error": "Permission denied"}
except DirectoryTraversalError as e:
    # Path traversal attempt - security error
    return {"success": False, "error": str(e)}
```

---

## 12. Data Formats

### Message Format

**User Message**:
```json
{
  "role": "user",
  "content": "What files are in the current directory?"
}
```

**Assistant Message** (without tool calls):
```json
{
  "role": "assistant",
  "content": "Based on the file listing, there are 15 Python files in the current directory..."
}
```

**Assistant Message** (with tool calls):
```json
{
  "role": "assistant",
  "content": "I'll check the current directory.",
  "tool_calls": [
    {
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "bash",
        "arguments": "{\"command\": \"ls -la\"}"
      }
    }
  ]
}
```

**Tool Result Message**:
```json
{
  "role": "tool",
  "tool_call_id": "call_abc123",
  "content": "total 48\ndrwxr-xr-x  12 user  staff   384 Jan 20 10:30 .\n..."
}
```

### Tool Call Format

**Function Call Structure**:
```json
{
  "id": "call_abc123",
  "type": "function",
  "function": {
    "name": "read",
    "arguments": "{\"file_paths\": [\"config.py\"]}"
  }
}
```

**Batch Tool Calls**:
```json
{
  "tool_calls": [
    {
      "id": "call_001",
      "type": "function",
      "function": {
        "name": "read",
        "arguments": "{\"file_paths\": [\"file1.py\"]}"
      }
    },
    {
      "id": "call_002",
      "type": "function",
      "function": {
        "name": "read",
        "arguments": "{\"file_paths\": [\"file2.py\"]}"
      }
    }
  ]
}
```

### Tool Response Format

**Success Response**:
```json
{
  "success": true,
  "content": "File content here...",
  "recently_modified": [
    "file1.py",
    "file2.py"
  ]
}
```

**Error Response**:
```json
{
  "success": false,
  "error": "File not found: config.py",
  "suggestion": "Check the file path and verify the file exists. Did you mean: config.json?"
}
```

**File Check Response**:
```json
{
  "success": true,
  "content": "...",
  "check_result": {
    "checker": "python",
    "passed": false,
    "errors": [
      {
        "line": 10,
        "column": 5,
        "message": "invalid syntax",
        "severity": "error"
      }
    ],
    "warnings": [],
    "check_time_ms": 12.5
  }
}
```

### Configuration Format

**User Config** (`~/.ally/config.json`):
```json
{
  "model": "qwen2.5-coder:32b",
  "endpoint": "http://localhost:11434",
  "temperature": 0.1,
  "system_prompt": "Custom system prompt...",
  "max_tokens": 8192,
  "compact_mode": false,
  "auto_confirm": false,
  "focus_directory": "/path/to/project"
}
```

### Agent Format

**Agent Metadata** (in frontmatter):
```yaml
name: "security-reviewer"
description: "Reviews code for security vulnerabilities and best practices"
created_at: "2025-01-20T10:30:00Z"
updated_at: "2025-01-20T10:30:00Z"
model: "qwen2.5-coder:32b"
tools: ["read", "grep", "glob"]
temperature: 0.3
```

### Session Format

**Session File**:
```json
{
  "name": "my-session",
  "title": "Debug authentication",
  "created_at": "2025-01-20T10:30:00.000Z",
  "updated_at": "2025-01-20T10:35:00.000Z",
  "messages": [
    {
      "role": "user",
      "content": "..."
    }
  ],
  "todos": [
    {
      "content": "Fix login bug",
      "status": "completed",
      "activeForm": "Fixing login bug"
    }
  ]
}
```

### Patch Format

**Patch Index**:
```json
{
  "next_patch_number": 5,
  "patches": [
    {
      "patch_number": 1,
      "timestamp": "2025-01-20T10:30:00Z",
      "operation_type": "write",
      "file_path": "/absolute/path/to/file.py",
      "patch_file": "patch_001.diff"
    }
  ]
}
```

**Unified Diff**:
```diff
# Code Ally Patch File
# Operation: edit
# File: /path/to/file.py
# Timestamp: 2025-01-20T10:30:00Z
#
# To apply this patch in reverse: patch -R -p1 < this_file
#

--- a/file.py
+++ b/file.py
@@ -1,5 +1,6 @@
 def hello():
-    print("Hello")
+    print("Hello, World!")
+    return True
```

---

## Summary

### Key Features Not Covered Elsewhere

1. **Agent System**: Complete agent creation, storage, and management system
2. **Session Management**: Persistent conversations with auto-title generation
3. **File Checking**: Multi-language syntax validation
4. **Trust System**: Comprehensive security and permission management
5. **Completion**: Intelligent tab completion for paths, agents, and commands
6. **Undo System**: Patch-based file operation reversal
7. **File Activity**: Context-aware file tracking
8. **Interactive Selectors**: Arrow-key navigation for models, sessions, and prompts
9. **Error Handling**: Structured error formatting with suggestions
10. **Data Formats**: Well-defined JSON/YAML formats for all persistent data

### File Structure Summary

```
~/.ally/
├── config.json              # User configuration
├── command_history          # Shell command history
├── sessions/                # Conversation sessions
│   └── session_*.json
├── agents/                  # Custom agents
│   └── agent-name.md
├── patches/                 # Undo patches
│   ├── patch_index.json
│   └── patch_*.diff
└── cache/
    └── completion/          # Path completion cache
        └── path_index.json
```

### Testing Infrastructure Summary

- **40+ test files** across multiple categories
- **Fixtures** for temp directories and sample structures
- **Integration tests** for cross-component functionality
- **Mock system** for UI and external dependencies
- **Coverage** of all major features and edge cases

---

## TypeScript Port Considerations

### Critical Components for Port

1. **Agent System**: Full implementation required
2. **Session Management**: Essential for conversation persistence
3. **Trust System**: Security is critical
4. **Undo System**: Important for user safety
5. **File Checking**: Language-specific implementations needed
6. **Completion**: Can be simplified initially

### Potential Simplifications

1. **Thinking Model Support**: Can be optional initially
2. **Advanced Completion**: Start with basic path completion
3. **Interactive Selectors**: Can use simpler prompts initially
4. **Background Title Generation**: Can be synchronous initially

### External Dependencies to Replace

1. **patch_ng**: Need pure TypeScript patch library
2. **termios/tty**: Need cross-platform terminal control
3. **Rich**: Need alternative for styled terminal output
4. **prompt_toolkit**: Need alternative for input handling
5. **yaml**: Standard YAML library for TypeScript

### Data Format Compatibility

All JSON/YAML formats should be preserved exactly to maintain compatibility:
- Session files
- Agent files
- Patch index
- Configuration files
- Completion cache

This allows users to switch between Python and TypeScript implementations seamlessly.
