# CodeAlly Service & Configuration Infrastructure

**Document Version**: 1.0
**Date**: 2025-10-20
**Purpose**: Complete reference for TypeScript port of CodeAlly's service registry and configuration system

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Service Registry System](#service-registry-system)
3. [Configuration System](#configuration-system)
4. [Path Resolution Service](#path-resolution-service)
5. [Service Implementations](#service-implementations)
6. [Service Initialization Flow](#service-initialization-flow)
7. [Extension Points](#extension-points)

---

## Architecture Overview

CodeAlly uses a dependency injection pattern with a centralized service registry to manage all application services. The architecture follows CLEAN principles with clear separation of concerns.

### Key Principles

- **Singleton Service Registry**: Global registry instance accessed via `ServiceRegistry.get_instance()`
- **Service Lifecycles**: Three lifecycle types - Singleton, Transient, Scoped
- **Lazy Loading**: Services created on-demand when first requested
- **Dependency Injection**: Automatic resolution of service dependencies
- **Type Safety**: Generic type support for type-safe service retrieval

### Service Hierarchy

```
ServiceRegistry (Global Singleton)
├── Core Services (registered in main.py)
│   ├── config_manager (ConfigManager)
│   ├── llm_client (OllamaClient)
│   └── session_manager (SessionManager)
│
├── Agent Services (registered in Agent.__init__)
│   ├── ui_manager (UIManager / NonInteractiveUIManager / DelegationUIManager)
│   ├── trust_manager (TrustManager)
│   ├── permission_manager (PermissionManager)
│   ├── token_manager (TokenManager)
│   ├── tool_result_manager (ToolResultManager)
│   ├── tool_manager (ToolManager)
│   ├── usage_pattern_analyzer (UsagePatternAnalyzer)
│   ├── command_handler (CommandHandler)
│   └── agent (Agent - self-registration)
│
└── Utility Services (registered on-demand)
    ├── path_resolver (PathResolverService)
    ├── focus_manager (FocusManager)
    └── patch_manager (PatchManager)
```

---

## Service Registry System

### File Location
`/Users/bhm128/CodeAlly/code_ally/service_registry.py`

### Core Components

#### 1. ServiceLifecycle Enum

```python
class ServiceLifecycle(Enum):
    SINGLETON = "singleton"  # Single instance, cached after first creation
    TRANSIENT = "transient"  # New instance every time
    SCOPED = "scoped"        # Isolated scope (used for sub-agents)
```

**Usage Guidelines**:
- **SINGLETON**: Default for most services (UI managers, config, token manager)
- **TRANSIENT**: Services that need fresh state (currently unused in codebase)
- **SCOPED**: Used only in sub-agent contexts via `ScopedServiceRegistryProxy`

#### 2. IService Interface

```python
class IService(ABC):
    @abstractmethod
    def initialize(self) -> None:
        """Initialize the service. Called once after creation."""
        pass

    @abstractmethod
    def cleanup(self) -> None:
        """Cleanup the service. Called when service is disposed."""
        pass
```

**Implementation Notes**:
- Services implementing `IService` have their `initialize()` called automatically after construction
- `cleanup()` called during registry shutdown
- Optional - services don't need to implement this interface

**Current Implementations**:
- `ConfigManager`: Implements `IService` (initialize/cleanup are no-ops)
- `UsagePatternAnalyzer`: Implements `IService` with actual initialization logic

#### 3. ServiceDescriptor Class

Generic class describing how services are created and managed.

```python
class ServiceDescriptor(Generic[T]):
    def __init__(
        self,
        service_type: type[T],
        factory: Callable[[], T] | None = None,
        lifecycle: ServiceLifecycle = ServiceLifecycle.SINGLETON,
        dependencies: dict[str, str] | None = None,
    ) -> None
```

**Properties**:
- `service_type`: The class type of the service
- `factory`: Optional factory function (defaults to `service_type()`)
- `lifecycle`: How the service lifecycle is managed
- `dependencies`: Dict mapping constructor param names to service names
- `_instance`: Cached instance for singleton lifecycle

**Key Methods**:

```python
def create_instance(self, registry: "ServiceRegistry") -> T:
    """Create service instance with dependency injection."""
```

**Dependency Resolution Flow**:
1. Check if singleton already exists - return cached instance
2. Resolve dependencies by looking up service names in registry
3. Call factory with resolved dependencies
4. If service implements `IService`, call `initialize()`
5. Cache instance if lifecycle is SINGLETON
6. Return instance

#### 4. ServiceRegistry Class

Main registry managing all services.

```python
class ServiceRegistry:
    _instance: Optional["ServiceRegistry"] = None  # Singleton pattern

    def __init__(self) -> None:
        self._services: dict[str, Any] = {}         # Direct instances
        self._descriptors: dict[str, ServiceDescriptor] = {}  # Descriptors
        self._scoped_services: dict[str, Any] = {}  # Scoped instances
        self._initialized = False
```

**Singleton Access**:

```python
@classmethod
def get_instance(cls) -> "ServiceRegistry":
    """Get the singleton instance."""
    if cls._instance is None:
        cls._instance = cls()
    return cls._instance
```

**Registration Methods**:

```python
def register_singleton(
    self,
    name: str,
    service_type: type[T],
    factory: Callable[[], T] | None = None,
    dependencies: dict[str, str] | None = None,
) -> "ServiceRegistry":
    """Register a singleton service (single instance, cached)."""
```

```python
def register_transient(
    self,
    name: str,
    service_type: type[T],
    factory: Callable[[], T] | None = None,
    dependencies: dict[str, str] | None = None,
) -> "ServiceRegistry":
    """Register a transient service (new instance each time)."""
```

```python
def register_instance(self, name: str, instance: Any) -> "ServiceRegistry":
    """Register an existing instance as a singleton."""
```

**Retrieval Methods**:

```python
def get(self, name: str, service_type: type[T] | None = None) -> T | None:
    """Get service by name with optional type checking."""
```

```python
def get_required(self, name: str, service_type: type[T] | None = None) -> T:
    """Get required service, raises ValueError if not found."""
```

```python
def has_service(self, name: str) -> bool:
    """Check if service exists in registry."""
```

**Lookup Priority**:
1. Check `_services` dict for directly registered instances
2. Check `_descriptors` dict for descriptor-based services
3. Return `None` if not found

**Lifecycle Management**:

```python
def shutdown(self) -> None:
    """Shutdown all services and cleanup resources."""
    # Calls cleanup() on all IService implementations
    # Clears _services and _descriptors
```

#### 5. ScopedServiceRegistryProxy Class

Lightweight proxy providing scoped view over global registry. Used for sub-agent isolation.

```python
class ScopedServiceRegistryProxy:
    def __init__(self, base: ServiceRegistry) -> None:
        self._base = base
        self._overrides: dict[str, Any] = {}
```

**Purpose**:
- Isolate sub-agent services from main agent
- Local overrides don't affect global singleton
- Reads fall back to base registry when no local override

**Key Characteristics**:
- Only supports `register_instance()` (no descriptors)
- `get()` checks overrides first, then delegates to base
- `has_service()` checks both overrides and base
- `clear()` removes all local overrides

**Usage Example** (from agent tool):
```python
# Create scoped registry for sub-agent
scoped_registry = ScopedServiceRegistryProxy(main_registry)
scoped_registry.register_instance("ui_manager", delegation_ui)
scoped_registry.register_instance("trust_manager", configured_trust)

# Sub-agent uses scoped registry
sub_agent = Agent(
    model_client=model_client,
    tools=tools,
    service_registry=scoped_registry,
    ...
)
```

---

## Configuration System

### File Locations
- Configuration module: `/Users/bhm128/CodeAlly/code_ally/config.py`
- Path definitions: `/Users/bhm128/CodeAlly/code_ally/paths.py`

### Path Structure

```
~/.ally/                        # ALLY_HOME
├── config.json                 # CONFIG_FILE - main configuration
├── command_history             # COMMAND_HISTORY_FILE - shell history
├── sessions/                   # SESSIONS_DIR - conversation sessions
├── agents/                     # AGENTS_DIR - custom agent definitions
├── patches/                    # PATCHES_DIR - undo system patches
└── cache/                      # CACHE_DIR - cached data
    └── completion/             # COMPLETION_CACHE_DIR - path completion
```

**Path Constants** (from `paths.py`):
```python
ALLY_HOME = Path.home() / ".ally"
SESSIONS_DIR = ALLY_HOME / "sessions"
AGENTS_DIR = ALLY_HOME / "agents"
PATCHES_DIR = ALLY_HOME / "patches"
CACHE_DIR = ALLY_HOME / "cache"
COMPLETION_CACHE_DIR = CACHE_DIR / "completion"
CONFIG_FILE = ALLY_HOME / "config.json"
COMMAND_HISTORY_FILE = ALLY_HOME / "command_history"
```

### Configuration Schema

#### DEFAULT_CONFIG Dictionary

Complete configuration with types and default values:

```python
DEFAULT_CONFIG = {
    # ==========================================
    # LLM MODEL SETTINGS
    # ==========================================
    "model": None,                    # str | None - Auto-selected from available models
    "endpoint": "http://localhost:11434",  # str - Ollama API endpoint
    "context_size": 16384,            # int - Context window size in tokens
    "temperature": 0.3,               # float - Generation temperature (0.0-1.0)
    "max_tokens": 7000,               # int - Max tokens to generate per response

    # ==========================================
    # EXECUTION SETTINGS
    # ==========================================
    "bash_timeout": 30,               # int - Bash command timeout in seconds
    "auto_confirm": False,            # bool - Skip permission prompts (dangerous)
    "check_context_msg": True,        # bool - Encourage LLM context checks
    "parallel_tools": True,           # bool - Enable parallel tool execution

    # ==========================================
    # UI PREFERENCES
    # ==========================================
    "theme": "default",               # str - UI theme name
    "compact_threshold": 95,          # int - Context % threshold for auto-compact
    "show_token_usage": True,         # bool - Display token usage in UI
    "show_context_in_prompt": False,  # bool - Show context % in input prompt

    # ==========================================
    # TOOL RESULT PREVIEW SETTINGS
    # ==========================================
    "tool_result_preview_lines": 3,   # int - Lines to show in tool result preview
    "tool_result_preview_enabled": True,  # bool - Enable tool result previews

    # ==========================================
    # TOOL CALL VALIDATION & RETRY
    # ==========================================
    "tool_call_retry_enabled": True,  # bool - Retry failed tool calls
    "tool_call_max_retries": 2,       # int - Max retry attempts
    "tool_call_repair_attempts": True, # bool - Attempt to repair invalid calls
    "tool_call_verbose_errors": False, # bool - Show detailed error messages

    # ==========================================
    # DIRECTORY TREE GENERATION
    # ==========================================
    "dir_tree_max_depth": 3,          # int - Max depth for directory trees
    "dir_tree_max_files": 20,         # int - Max files to show in trees
    "dir_tree_enable": False,         # bool - Enable directory tree generation

    # ==========================================
    # DIFF DISPLAY SETTINGS
    # ==========================================
    "diff_display_enabled": True,     # bool - Show file change previews
    "diff_display_max_file_size": 102400,  # int - Max file size for diffs (bytes)
    "diff_display_context_lines": 3,  # int - Context lines around changes
    "diff_display_theme": "auto",     # str - Theme: auto, dark, light, minimal
    "diff_display_color_removed": "on rgb(50,20,20)",   # str - Removed line color
    "diff_display_color_added": "on rgb(20,50,20)",     # str - Added line color
    "diff_display_color_modified": "on rgb(50,50,20)",  # str - Modified line color

    # ==========================================
    # AGENT BEHAVIOR CONSTANTS
    # ==========================================
    "agent_manual_id_prefix": "manual-id",     # str - Prefix for manual IDs
    "agent_auto_id_prefix": "auto-id",         # str - Prefix for auto IDs
    "agent_truncation_suffix_template": "... ({} more lines)",  # str - Truncation format
    "agent_command_exit_status_pattern": "Command exited with status",  # str
    "agent_exit_code_no_output_msg": "Command exited with code {} (no output)",  # str

    # ==========================================
    # TOOL RESULT TRUNCATION (CONTEXT-AWARE)
    # ==========================================
    "tool_result_max_tokens_normal": 1000,     # int - 0-70% context usage
    "tool_result_max_tokens_moderate": 750,    # int - 70-85% context usage
    "tool_result_max_tokens_aggressive": 500,  # int - 85-95% context usage
    "tool_result_max_tokens_critical": 200,    # int - 95%+ context usage

    # ==========================================
    # SETUP TRACKING
    # ==========================================
    "setup_completed": False,         # bool - Whether initial setup ran
}
```

#### CONFIG_TYPES Dictionary

Type validation for configuration keys:

```python
CONFIG_TYPES = {
    "model": str,
    "endpoint": str,
    "context_size": int,
    "temperature": float,
    "max_tokens": int,
    "bash_timeout": int,
    "auto_confirm": bool,
    "check_context_msg": bool,
    "parallel_tools": bool,
    "dump_dir": str,                  # Optional, not in defaults
    "auto_dump": bool,                # Optional, not in defaults
    "theme": str,
    "compact_threshold": int,
    "show_token_usage": bool,
    "tool_call_retry_enabled": bool,
    "tool_call_max_retries": int,
    "tool_call_repair_attempts": bool,
    "tool_call_verbose_errors": bool,
    "setup_completed": bool,
    "dir_tree_max_depth": int,
    "dir_tree_max_files": int,
    "dir_tree_enable": bool,
    "diff_display_enabled": bool,
    "diff_display_max_file_size": int,
    "diff_display_context_lines": int,
    "diff_display_theme": str,
    "diff_display_color_removed": str,
    "diff_display_color_added": str,
    "diff_display_color_modified": str,
    "agent_manual_id_prefix": str,
    "agent_auto_id_prefix": str,
    "agent_truncation_suffix_template": str,
    "agent_command_exit_status_pattern": str,
    "agent_exit_code_no_output_msg": str,
    "tool_result_max_tokens_normal": int,
    "tool_result_max_tokens_moderate": int,
    "tool_result_max_tokens_aggressive": int,
    "tool_result_max_tokens_critical": int,
}
```

### ConfigManager Class

Service-managed configuration following dependency injection pattern.

```python
class ConfigManager(IService):
    def __init__(self) -> None:
        self._config = load_config()

    async def initialize(self) -> None:
        """No-op: Config loaded in __init__"""
        pass

    async def cleanup(self) -> None:
        """No cleanup needed"""
        pass
```

**Key Methods**:

```python
def get_config(self) -> dict[str, Any]:
    """Get the complete configuration dictionary."""
```

```python
def get_value(
    self,
    key: str,
    default: str | int | float | bool | None = None,
) -> str | int | float | bool | None:
    """Get specific configuration value with type safety."""
```

```python
def set_value(self, key: str, value: str | int | float | bool) -> None:
    """Set configuration value with validation and persistence."""
```

```python
def reset(self) -> dict[str, bool | str]:
    """Reset configuration to default values."""
```

### Configuration Loading

**Priority Layers**:
1. **CLI Arguments** (highest priority) - parsed in `main.py:parse_args()`
2. **Config File** - `~/.ally/config.json`
3. **Defaults** - `DEFAULT_CONFIG` dictionary

**Load Flow** (`load_config()` function):
1. Start with `DEFAULT_CONFIG.copy()`
2. Check if config file exists
3. Load JSON from file
4. Validate each key against `CONFIG_TYPES`
5. Attempt type conversion with special handling for booleans
6. Merge validated values into config dict
7. Return complete config

**Type Conversion**:
- String to bool: `"true"`, `"yes"`, `"y"`, `"1"` → `True`
- Automatic conversion using `expected_type(value)`
- Invalid types logged as warnings, use defaults

**Save Flow** (`save_config()` function):
1. Ensure `~/.ally/` directory exists
2. Write config as pretty-printed JSON (2-space indent)
3. Log success/failure

**Runtime Modification**:
```python
config_manager = ConfigManager()
config_manager.set_value("temperature", 0.7)  # Validates, saves, logs
```

### Configuration Categories

#### Model Settings
Control LLM behavior and connection.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `model` | str\|None | `None` | Model name (auto-selected if None) |
| `endpoint` | str | `"http://localhost:11434"` | Ollama API URL |
| `context_size` | int | `16384` | Context window in tokens |
| `temperature` | float | `0.3` | Generation randomness (0.0-1.0) |
| `max_tokens` | int | `7000` | Max tokens per response |

#### Tool Result Limits (Context-Aware)
Progressive truncation based on context usage.

| Key | Type | Default | Context Range | Purpose |
|-----|------|---------|---------------|---------|
| `tool_result_max_tokens_normal` | int | `1000` | 0-70% | Normal operation limit |
| `tool_result_max_tokens_moderate` | int | `750` | 70-85% | Moderate pressure limit |
| `tool_result_max_tokens_aggressive` | int | `500` | 85-95% | High pressure limit |
| `tool_result_max_tokens_critical` | int | `200` | 95%+ | Critical pressure limit |

**Impact**: Tool results automatically truncated more aggressively as context fills up.

#### Context Thresholds

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `compact_threshold` | int | `95` | Percentage threshold for auto-compact |
| `check_context_msg` | bool | `True` | Show context check reminders |
| `show_token_usage` | bool | `True` | Display token usage stats |
| `show_context_in_prompt` | bool | `False` | Show % in input prompt |

#### UI Preferences

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `theme` | str | `"default"` | UI color theme |
| `tool_result_preview_lines` | int | `3` | Lines in tool previews |
| `tool_result_preview_enabled` | bool | `True` | Enable previews |

#### Diff Display Settings

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `diff_display_enabled` | bool | `True` | Show file change previews |
| `diff_display_max_file_size` | int | `102400` | Max file size for diffs (bytes) |
| `diff_display_context_lines` | int | `3` | Lines of context |
| `diff_display_theme` | str | `"auto"` | auto, dark, light, minimal |
| `diff_display_color_removed` | str | `"on rgb(50,20,20)"` | Removed line background |
| `diff_display_color_added` | str | `"on rgb(20,50,20)"` | Added line background |
| `diff_display_color_modified` | str | `"on rgb(50,50,20)"` | Modified line background |

#### Session Settings

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `setup_completed` | bool | `False` | Track first-run setup |

#### Agent Behavior Constants

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `agent_manual_id_prefix` | str | `"manual-id"` | Prefix for manual tool call IDs |
| `agent_auto_id_prefix` | str | `"auto-id"` | Prefix for auto tool call IDs |
| `agent_truncation_suffix_template` | str | `"... ({} more lines)"` | Format for truncation messages |
| `agent_command_exit_status_pattern` | str | `"Command exited with status"` | Exit status message pattern |
| `agent_exit_code_no_output_msg` | str | `"Command exited with code {} (no output)"` | No output message format |

---

## Path Resolution Service

### File Location
`/Users/bhm128/CodeAlly/code_ally/services/path_resolver.py`

### PathResolverService Class

Centralized service for focus-aware path resolution.

```python
class PathResolverService:
    def __init__(self) -> None:
        self._focus_manager: Optional['FocusManager'] = None
```

**Lazy Focus Manager Access**:
```python
@property
def focus_manager(self) -> Optional['FocusManager']:
    """Get focus manager instance lazily from service registry."""
    if self._focus_manager is None:
        try:
            service_registry = ServiceRegistry.get_instance()
            if service_registry.has_service('focus_manager'):
                self._focus_manager = service_registry.get('focus_manager')
        except Exception as e:
            logger.debug(f"Could not access focus manager: {e}")
    return self._focus_manager
```

**Path Resolution**:
```python
def resolve_path(self, file_path: str) -> str:
    """Resolve path using focus-aware resolution when available."""
    if not file_path:
        return ""

    try:
        focus_manager = self.focus_manager
        if focus_manager is not None:
            return focus_manager.resolve_path_in_focus(file_path)
        else:
            # Standard resolution
            expanded_path = os.path.expanduser(file_path)
            return os.path.abspath(expanded_path)
    except Exception as e:
        logger.warning(f"Path resolution failed: {e}")
        # Fallback
        expanded_path = os.path.expanduser(file_path)
        return os.path.abspath(expanded_path)
```

**Batch Resolution**:
```python
def resolve_paths(self, file_paths: list[str]) -> list[str]:
    """Resolve multiple file paths efficiently."""
    return [self.resolve_path(path) for path in file_paths]
```

**Global Access**:
```python
def get_path_resolver() -> PathResolverService:
    """Get or create global path resolver service."""
    service_registry = ServiceRegistry.get_instance()
    path_resolver = service_registry.get('path_resolver')

    if path_resolver is None:
        path_resolver = PathResolverService()
        service_registry.register_instance('path_resolver', path_resolver)

    return path_resolver
```

**Convenience Function**:
```python
def resolve_path(file_path: str) -> str:
    """Convenience wrapper for path resolution."""
    return get_path_resolver().resolve_path(file_path)
```

### Focus Manager Integration

The path resolver integrates with an optional `FocusManager` service:

**Focus Concepts**:
- **Focus Directory**: Restricts operations to a specific directory subtree
- **Focus-Aware Resolution**: Validates paths are within focus constraints
- **Fallback Behavior**: Standard absolute path resolution if no focus set

**Resolution Flow**:
1. Check if path is empty → return empty string
2. Get focus manager from service registry (lazy)
3. If focus manager exists → use `resolve_path_in_focus()`
4. Else → expand `~` and convert to absolute path
5. On error → fallback to simple expansion + absolute conversion

---

## Service Implementations

### Core Services

#### 1. ConfigManager

**Location**: `code_ally/config.py`
**Lifecycle**: Singleton
**Registered**: In `main.py:setup_services_and_agent()`

```python
config_manager = ConfigManager()
service_registry.register_instance("config_manager", config_manager)
```

**Purpose**: Centralized configuration management
**Dependencies**: None
**IService**: Yes (no-op initialize/cleanup)

#### 2. SessionManager

**Location**: `code_ally/session_manager.py`
**Lifecycle**: Singleton
**Registered**: In `main.py:setup_session()`

```python
session_manager = SessionManager(model_client=model_client)
service_registry.register_instance("session_manager", session_manager)
```

**Purpose**: Conversation session persistence
**Dependencies**: Optional `model_client` for title generation
**IService**: No

**Key Responsibilities**:
- Load/save conversation sessions
- Generate unique session names
- Track current active session
- Provide session listing/search

#### 3. LLM Client

**Location**: `code_ally/llm_client/ollama_client.py`
**Lifecycle**: Singleton
**Registered**: In `main.py:setup_services_and_agent()`

```python
model_client = OllamaClient(...)
service_registry.register_instance("llm_client", model_client)
```

**Purpose**: LLM API communication
**Dependencies**: None
**IService**: No

### Agent Services

All registered in `Agent._initialize_components()` at `/Users/bhm128/CodeAlly/code_ally/agent/agent.py:90-179`

#### 4. UIManager

**Location**: `code_ally/ui/ui_manager.py`
**Lifecycle**: Singleton
**Variants**:
- `UIManager` - Interactive mode (default)
- `NonInteractiveUIManager` - Single message mode (`--once`)
- `DelegationUIManager` - Sub-agent context (scoped registry)

**Purpose**: Terminal output, user input, animations
**Dependencies**: None
**IService**: No

**Selection Logic** (from `Agent._initialize_components`):
```python
if self.service_registry.has_service("ui_manager"):
    # Delegation context - use existing UI from registry
    ui_manager = self.service_registry.get("ui_manager")
elif self.non_interactive:
    # Single message mode
    ui_manager = NonInteractiveUIManager()
else:
    # Interactive mode
    ui_manager = UIManager()

ui_manager.set_verbose(verbose)
self.service_registry.register_instance("ui_manager", ui_manager)
```

#### 5. TrustManager

**Location**: `code_ally/trust.py`
**Lifecycle**: Singleton
**Purpose**: Permission management for sensitive operations
**Dependencies**: None
**IService**: No

**Key Responsibilities**:
- Track trusted tools per path
- Prompt user for permissions
- Auto-confirm mode for scripting
- Command sensitivity analysis
- Batch operation permissions

**Trust Scopes**:
- Global (`*`) - trust tool everywhere
- Path-specific - trust for specific file/directory
- Session - trust for current session
- Once - trust for single operation

#### 6. PermissionManager

**Location**: `code_ally/agent/permission_manager.py`
**Lifecycle**: Singleton
**Purpose**: Coordinate permission requests
**Dependencies**: `trust_manager`
**IService**: No

#### 7. TokenManager

**Location**: `code_ally/agent/token_manager.py`
**Lifecycle**: Singleton
**Purpose**: Token counting and context management
**Dependencies**: None
**IService**: No

**Key Responsibilities**:
- Estimate token counts for messages
- Track total context usage
- Detect when context is near limits
- File content deduplication

**Token Estimation**:
- Uses simple `len(text) / 3.5` heuristic
- Configurable via `context_size` parameter

#### 8. ToolResultManager

**Location**: `code_ally/agent/tool_result_manager.py`
**Lifecycle**: Singleton
**Purpose**: Progressive tool result truncation
**Dependencies**: `token_manager`, `config_manager`
**IService**: No

**Context-Aware Limits**:
```python
context_usage = token_manager.get_context_usage_percentage()

if context_usage < 70:
    max_tokens = config.get("tool_result_max_tokens_normal", 1000)
elif context_usage < 85:
    max_tokens = config.get("tool_result_max_tokens_moderate", 750)
elif context_usage < 95:
    max_tokens = config.get("tool_result_max_tokens_aggressive", 500)
else:
    max_tokens = config.get("tool_result_max_tokens_critical", 200)
```

#### 9. ToolManager

**Location**: `code_ally/agent/tool_manager.py`
**Lifecycle**: Singleton
**Purpose**: Tool registration, execution, function definitions
**Dependencies**: `trust_manager`
**IService**: No

**Key Responsibilities**:
- Maintain tool registry
- Generate function definitions for LLM
- Execute tool calls with permission checks
- Validate tool call arguments

#### 10. UsagePatternAnalyzer

**Location**: `code_ally/agent/usage_pattern_analyzer.py`
**Lifecycle**: Singleton
**Purpose**: Detect redundant tool calls and usage patterns
**Dependencies**: None
**IService**: Yes

**Initialization**:
```python
def initialize(self) -> None:
    """Initialize pattern tracking structures."""
    self._tool_call_history = []
    self._file_access_counts = defaultdict(int)
```

#### 11. CommandHandler

**Location**: `code_ally/agent/command_handler.py`
**Lifecycle**: Singleton
**Purpose**: Process slash commands (`/help`, `/config`, etc.)
**Dependencies**: `ui_manager`, `token_manager`, `trust_manager`
**IService**: No

#### 12. Agent (Self-Registration)

**Location**: `code_ally/agent/agent.py`
**Lifecycle**: Singleton (per agent instance)
**Purpose**: Access to agent from tools
**Registration**:
```python
self.service_registry.register_instance("agent", self)
```

### Utility Services

#### 13. PathResolverService

**Location**: `code_ally/services/path_resolver.py`
**Lifecycle**: Singleton
**Registered**: On-demand via `get_path_resolver()`
**Purpose**: Focus-aware path resolution
**Dependencies**: Optional `focus_manager`
**IService**: No

#### 14. FocusManager

**Location**: `code_ally/tools/focus_manager.py`
**Lifecycle**: Singleton
**Registered**: On-demand via `ServiceAccessMixin.get_focus_manager()`
**Purpose**: Restrict operations to directory subtree
**Dependencies**: None
**IService**: No

#### 15. PatchManager

**Location**: `code_ally/undo/patch_manager.py`
**Lifecycle**: Singleton
**Registered**: On-demand in `command_handler.py`
**Purpose**: Undo system for file operations
**Dependencies**: None
**IService**: No

#### 16. FileActivityTracker

**Location**: `code_ally/services/file_activity_tracker.py`
**Lifecycle**: Module-level singleton (not in registry)
**Purpose**: Track recently accessed files
**Dependencies**: None
**IService**: No

**Note**: Uses module-level `_tracker` variable, not service registry:
```python
_tracker: Optional[FileActivityTracker] = None

def get_file_activity_tracker() -> FileActivityTracker:
    global _tracker
    if _tracker is None:
        _tracker = FileActivityTracker()
    return _tracker
```

---

## Service Initialization Flow

### Application Startup Sequence

```
main() [main.py:701]
├── parse_args() → Load config, parse CLI
├── handle_config_commands() → Process config flags
├── handle_setup_check() → First-run wizard
├── handle_resume_command() → Session selection
├── setup_ollama_validation() → Check model availability
├── create_model_client() → Initialize OllamaClient
│
└── setup_services_and_agent() [main.py:649]
    ├── 1. Get service registry singleton
    ├── 2. Register config_manager
    ├── 3. Register llm_client
    ├── 4. Generate system prompt
    │
    └── 5. Create Agent [agent.py:32]
        └── Agent._initialize_components() [agent.py:90]
            ├── Check for existing ui_manager (delegation)
            ├── Create UIManager variant
            ├── Register ui_manager
            ├── Create ThinkingModelManager
            ├── Re-register config_manager (already exists)
            ├── Create TrustManager
            ├── Register trust_manager
            ├── Create PermissionManager(trust_manager)
            ├── Register permission_manager
            ├── Create TokenManager(context_size)
            ├── Register token_manager
            ├── Create ToolResultManager(token_manager, config)
            ├── Register tool_result_manager
            ├── Create ToolManager(tools, trust_manager)
            ├── Register tool_manager
            ├── Setup DiffDisplayManager
            ├── Create UsagePatternAnalyzer
            ├── Call usage_pattern_analyzer.initialize()
            ├── Register usage_pattern_analyzer
            ├── Create CommandHandler(ui, token, trust)
            ├── Register command_handler
            └── Register agent (self)

setup_session() [main.py:830]
├── Create SessionManager(model_client)
└── Register session_manager
```

### Service Dependencies Graph

```
config_manager (no dependencies)
    ↓
llm_client (no dependencies)
    ↓
Agent
    ├── ui_manager (no dependencies)
    ├── trust_manager (no dependencies)
    ├── permission_manager → trust_manager
    ├── token_manager (no dependencies)
    ├── tool_result_manager → token_manager, config_manager
    ├── tool_manager → trust_manager
    ├── usage_pattern_analyzer (no dependencies, calls initialize())
    ├── command_handler → ui_manager, token_manager, trust_manager
    └── agent (self-reference)

session_manager → model_client (optional)
path_resolver → focus_manager (optional, lazy)
```

### Delegation Context Service Isolation

When creating sub-agents via the agent tool:

```python
# Create scoped registry
scoped_registry = ScopedServiceRegistryProxy(base_registry)

# Override services for sub-agent
scoped_registry.register_instance("ui_manager", DelegationUIManager(original_ui))
scoped_registry.register_instance("trust_manager", configured_trust)

# Sub-agent uses scoped registry
sub_agent = Agent(
    model_client=model_client,
    tools=filtered_tools,
    service_registry=scoped_registry,  # Isolated scope
    is_specialized_agent=True,
    non_interactive=True,
)
```

**Isolation Benefits**:
- Sub-agent UI doesn't interfere with main agent
- Trust configuration inherited but isolated
- Main agent services unchanged
- Prevents state leaks between agents

---

## Extension Points

### Adding New Services

#### 1. Create Service Class

```python
class MyNewService:
    def __init__(self, dependency_service=None):
        self.dependency = dependency_service
        # Initialize state
```

#### 2. Optional: Implement IService

```python
from code_ally.service_registry import IService

class MyNewService(IService):
    def initialize(self) -> None:
        """Called automatically after creation."""
        pass

    def cleanup(self) -> None:
        """Called during shutdown."""
        pass
```

#### 3. Register Service

**Option A: Direct Instance Registration**
```python
service = MyNewService()
service_registry.register_instance("my_service", service)
```

**Option B: Descriptor-Based Registration**
```python
# With dependencies
service_registry.register_singleton(
    "my_service",
    MyNewService,
    dependencies={
        "dependency_service": "other_service_name"
    }
)

# With factory
service_registry.register_singleton(
    "my_service",
    MyNewService,
    factory=lambda: MyNewService(custom_arg="value")
)
```

**Option C: Transient (New Instance Each Time)**
```python
service_registry.register_transient(
    "my_service",
    MyNewService
)
```

#### 4. Access Service

```python
# Optional return
my_service = service_registry.get("my_service")
if my_service:
    my_service.do_something()

# Required (raises ValueError if not found)
my_service = service_registry.get_required("my_service")
my_service.do_something()

# Type-safe access
from typing import cast
my_service = cast(MyNewService, service_registry.get("my_service"))
```

### Adding Configuration Options

#### 1. Update DEFAULT_CONFIG

```python
DEFAULT_CONFIG = {
    # ... existing config ...
    "my_new_setting": "default_value",  # Add here
}
```

#### 2. Update CONFIG_TYPES

```python
CONFIG_TYPES = {
    # ... existing types ...
    "my_new_setting": str,  # Add type validation
}
```

#### 3. Access Configuration

```python
config_manager = service_registry.get("config_manager")
value = config_manager.get_value("my_new_setting", "fallback")
```

#### 4. Update Configuration

```python
config_manager.set_value("my_new_setting", "new_value")
# Automatically validates type and saves to disk
```

### ServiceAccessMixin Pattern

For consistent service access across tools and components:

```python
from code_ally.services.registry_mixin import ServiceAccessMixin

class MyTool(ServiceAccessMixin):
    def execute(self, args):
        # Standardized service access
        config = self.get_service("config_manager")
        path_resolver = self.get_path_resolver()  # Helper method

        # Required service (raises if not found)
        agent = self.get_required_service("agent")
```

**Mixin Methods**:
- `get_service(name, type, create_if_missing, factory)` - Get optional service
- `get_required_service(name, type)` - Get required service (raises)
- `get_focus_manager()` - Get/create focus manager
- `get_patch_manager()` - Get/create patch manager
- `get_path_resolver()` - Get/create path resolver

### Custom Service Factories

For complex initialization:

```python
def create_my_service():
    # Complex setup logic
    dependency = service_registry.get("dependency")
    config = service_registry.get("config_manager")

    service = MyService(
        dependency=dependency,
        setting=config.get_value("my_setting")
    )

    # Additional setup
    service.load_data()

    return service

service_registry.register_singleton(
    "my_service",
    MyService,
    factory=create_my_service
)
```

---

## TypeScript Port Considerations

### Key Differences to Address

1. **Python Modules → TypeScript Modules**
   - Python: `from code_ally.service_registry import ServiceRegistry`
   - TypeScript: `import { ServiceRegistry } from './serviceRegistry'`

2. **Singleton Pattern**
   - Python: Class-level `_instance` with `get_instance()`
   - TypeScript: Module-level instance or singleton decorator

3. **Type Safety**
   - Python: `TypeVar` and `Generic[T]`
   - TypeScript: Native generics `class ServiceRegistry<T>`

4. **Optional Types**
   - Python: `str | None`
   - TypeScript: `string | null` or `string | undefined`

5. **Abstract Classes**
   - Python: `ABC` and `@abstractmethod`
   - TypeScript: `abstract class` and `abstract method()`

6. **Dictionary Types**
   - Python: `dict[str, Any]`
   - TypeScript: `Map<string, any>` or `Record<string, any>`

7. **Async/Await**
   - Python: `async def` / `await`
   - TypeScript: `async function` / `await` (similar)

8. **Path Handling**
   - Python: `pathlib.Path`, `os.path`
   - TypeScript: `path` module from Node.js

9. **JSON Configuration**
   - Python: `json.load()` / `json.dump()`
   - TypeScript: `JSON.parse()` / `JSON.stringify()`

### Recommended TypeScript Structure

```typescript
// serviceRegistry.ts
export enum ServiceLifecycle {
    SINGLETON = 'singleton',
    TRANSIENT = 'transient',
    SCOPED = 'scoped'
}

export interface IService {
    initialize(): Promise<void>;
    cleanup(): Promise<void>;
}

export class ServiceDescriptor<T> {
    constructor(
        public serviceType: new (...args: any[]) => T,
        public factory?: () => T,
        public lifecycle: ServiceLifecycle = ServiceLifecycle.SINGLETON,
        public dependencies?: Record<string, string>
    ) {}

    private _instance?: T;

    createInstance(registry: ServiceRegistry): T {
        // Implementation
    }
}

export class ServiceRegistry {
    private static _instance?: ServiceRegistry;
    private _services = new Map<string, any>();
    private _descriptors = new Map<string, ServiceDescriptor<any>>();

    static getInstance(): ServiceRegistry {
        if (!this._instance) {
            this._instance = new ServiceRegistry();
        }
        return this._instance;
    }

    registerSingleton<T>(
        name: string,
        serviceType: new () => T,
        factory?: () => T,
        dependencies?: Record<string, string>
    ): this {
        // Implementation
    }

    get<T>(name: string, serviceType?: new () => T): T | null {
        // Implementation
    }
}
```

### Configuration System in TypeScript

```typescript
// config.ts
export interface Config {
    model: string | null;
    endpoint: string;
    context_size: number;
    temperature: number;
    // ... all other config keys with proper types
}

export const DEFAULT_CONFIG: Config = {
    model: null,
    endpoint: 'http://localhost:11434',
    context_size: 16384,
    temperature: 0.3,
    // ... rest
};

export class ConfigManager implements IService {
    private _config: Config;

    constructor() {
        this._config = this.loadConfig();
    }

    async initialize(): Promise<void> {
        // No-op
    }

    async cleanup(): Promise<void> {
        // No-op
    }

    getConfig(): Config {
        return this._config;
    }

    getValue<K extends keyof Config>(key: K): Config[K] {
        return this._config[key];
    }

    setValue<K extends keyof Config>(key: K, value: Config[K]): void {
        this._config[key] = value;
        this.saveConfig();
    }
}
```

---

## Summary

This document provides complete specifications for:

1. **Service Registry System**
   - `ServiceLifecycle` enum with three lifecycle types
   - `IService` interface for lifecycle management
   - `ServiceDescriptor` for service metadata
   - `ServiceRegistry` singleton with dependency injection
   - `ScopedServiceRegistryProxy` for isolation

2. **Configuration System**
   - Complete configuration schema (66+ keys)
   - Type validation and conversion
   - Layered configuration (CLI → file → defaults)
   - Runtime modification with persistence
   - Path structure in `~/.ally/`

3. **Path Resolution**
   - Focus-aware path resolution
   - Lazy focus manager integration
   - Fallback to standard resolution
   - Batch path processing

4. **Service Implementations**
   - 16 documented services with purposes and dependencies
   - Clear initialization order
   - Delegation context isolation

5. **Extension Points**
   - Adding new services
   - Adding configuration options
   - ServiceAccessMixin pattern
   - Custom factory functions

Use this as the authoritative reference for porting CodeAlly's infrastructure to TypeScript.

---

**End of Document**
