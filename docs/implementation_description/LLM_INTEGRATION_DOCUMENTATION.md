# CodeAlly LLM Integration Layer - Complete Documentation

**Purpose**: Complete technical documentation of CodeAlly's LLM integration layer for TypeScript reimplementation.

**Location**: `/Users/bhm128/CodeAlly/code_ally/llm_client/`

**Last Updated**: 2025-10-20

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [ModelClient Interface](#modelclient-interface)
3. [OllamaClient Implementation](#ollamaclient-implementation)
4. [Message Format Specification](#message-format-specification)
5. [Function Calling Protocol](#function-calling-protocol)
6. [Streaming Protocol](#streaming-protocol)
7. [Tool Call Validation & Retry](#tool-call-validation--retry)
8. [Interruption & Cancellation](#interruption--cancellation)
9. [Configuration & Initialization](#configuration--initialization)
10. [Error Handling](#error-handling)
11. [Integration Points](#integration-points)

---

## Architecture Overview

### Design Principles

1. **Abstract Interface Pattern**: `ModelClient` defines a provider-agnostic interface
2. **Async-First**: All LLM operations are asynchronous using `asyncio`
3. **Streaming by Default**: Supports both streaming and non-streaming modes
4. **Tool Call Normalization**: Handles both legacy (`function_call`) and modern (`tool_calls`) formats
5. **Graceful Degradation**: Automatic retry, validation, and error recovery
6. **Cancellation Support**: Event-based interruption using `InterruptCoordinator`

### Component Structure

```
code_ally/llm_client/
├── __init__.py              # Public exports
├── model_client.py          # Abstract base class
└── ollama_client.py         # Ollama implementation
```

### Dependencies

- `aiohttp`: Async HTTP client for API requests
- `asyncio`: Asynchronous programming framework
- `json`: Message serialization
- `re`: Tool response parsing
- `code_ally.config`: Configuration management
- `code_ally.agent.interrupt_coordinator`: Cancellation coordination

---

## ModelClient Interface

**File**: `/Users/bhm128/CodeAlly/code_ally/llm_client/model_client.py`

### Abstract Base Class

```python
from abc import ABC, abstractmethod
from typing import Any, Callable

class ModelClient(ABC):
    """Base class for LLM clients.

    This abstract class defines the interface that all model clients must implement.
    It provides a standard way to interact with different LLM backends.
    """
```

### Required Methods

#### `send()` - Primary LLM Request Method

```python
@abstractmethod
async def send(
    self,
    messages: list[dict[str, Any]],
    functions: list[dict[str, Any]] | None = None,
    tools: list[Callable] | None = None,
    stream: bool = False,
) -> dict[str, Any]:
    """Send a request to the LLM with messages and function definitions.

    Args:
        messages: List of message objects with role and content
        functions: List of function definitions in JSON schema format
        tools: List of Python functions to expose as tools
        stream: Whether to stream the response

    Returns:
        The LLM's response as a dictionary with at least 'role' and 'content' keys
    """
```

**Message Structure**:
- Each message is a dict with `role` and `content` keys
- Roles: `"system"`, `"user"`, `"assistant"`, `"tool"`
- Tool messages also include `tool_call_id`

**Function Definitions**:
- Either `functions` (pre-formatted JSON schemas) or `tools` (Python callables)
- Must follow OpenAI function calling schema format
- `OllamaClient` converts Python callables to schemas automatically

**Return Value**:
- Dict with `role` (always `"assistant"`)
- `content`: String response
- Optional `tool_calls`: List of tool invocations
- Optional `thinking`: Native reasoning trace (GPT-OSS style)
- Optional `_content_was_streamed`: Internal flag for UI coordination
- Optional `interrupted`: Cancellation marker

### Required Properties

#### `model_name` - Current Model Identifier

```python
@property
@abstractmethod
def model_name(self) -> str:
    """Get the name of the current model."""
```

#### `endpoint` - API Endpoint URL

```python
@property
@abstractmethod
def endpoint(self) -> str:
    """Get the API endpoint URL."""
```

---

## OllamaClient Implementation

**File**: `/Users/bhm128/CodeAlly/code_ally/llm_client/ollama_client.py`

### Class Definition

```python
class OllamaClient(ModelClient):
    """Async client for interacting with Ollama API with function calling support."""
```

### Initialization

```python
def __init__(
    self,
    endpoint: str = "http://localhost:11434",
    model_name: str | None = None,
    temperature: float = 0.3,
    context_size: int = 16384,
    max_tokens: int = 5000,
    keep_alive: int | None = None,
) -> None:
    """Initialize the Ollama client."""
```

**Parameters**:
- `endpoint`: Ollama server URL (default: `http://localhost:11434`)
- `model_name`: Model identifier (e.g., `"qwen2.5-coder:32b"`)
- `temperature`: Sampling temperature (0.0-1.0, default: 0.3)
- `context_size`: Context window size in tokens (default: 16384)
- `max_tokens`: Maximum tokens to generate (default: 5000)
- `keep_alive`: Model keep-alive duration in seconds (optional)

**Internal State**:
- `_session`: `aiohttp.ClientSession` for connection pooling
- `_current_request_task`: Active request task for cancellation
- `_current_streaming_task`: Active streaming task for cancellation
- `_interrupted`: Boolean interruption flag
- `_interrupt_coordinator`: Reference to global interrupt coordinator
- `api_url`: Computed as `f"{endpoint}/api/chat"`

### Context Manager Support

```python
async def __aenter__(self) -> 'OllamaClient':
    """Async context manager entry."""
    return self

async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
    """Async context manager exit."""
    await self.close()

async def close(self) -> None:
    """Close the aiohttp session."""
    if self._session:
        await self._session.close()
        self._session = None
```

### Core Request Flow

#### 1. `send()` - Main Entry Point

```python
async def send(
    self,
    messages: list[dict[str, Any]],
    functions: list[dict[str, Any]] | None = None,
    tools: list[Callable] | None = None,
    stream: bool = False,
    max_retries: int = 3,
) -> dict[str, Any]:
```

**Flow**:
1. **Agent Delegation Check**: Disables streaming for sub-agent contexts
2. **Payload Preparation**: Via `_prepare_payload()`
3. **Retry Loop**: Up to `max_retries + 1` attempts with exponential backoff
4. **Cancellation Wrapper**: Via `_execute_request_with_cancellation()`
5. **Tool Call Validation**: Via `_handle_tool_call_validation_retry()` (non-streaming only)
6. **Error Recovery**: Catches `ClientError`, `TimeoutError`, `CancelledError`

**Retry Strategy**:
- **Exponential backoff**: `wait_time = 2^attempt` for network errors
- **Linear backoff**: `wait_time = 1 + attempt` for JSON errors
- **No retry**: For unexpected errors or `CancelledError`

#### 2. `_prepare_payload()` - Request Construction

```python
def _prepare_payload(
    self,
    messages: list[dict[str, Any]],
    functions: list[dict[str, Any]] | None,
    tools: list[Callable] | None,
    stream: bool,
) -> dict[str, Any]:
```

**Returns**:
```python
{
    "model": self.model_name,
    "messages": messages,
    "stream": stream,
    "options": {
        "temperature": self.temperature,
        "num_ctx": self.context_size,
        "num_predict": self.max_tokens,
        "keep_alive": self.keep_alive  # Optional
    },
    "tools": [...],  # If functions or tools provided
}
```

**Tool Conversion**:
- If `functions` provided: Use directly
- If `tools` provided: Convert via `_convert_tools_to_schemas()`
- Always sets `"tool_choice": "auto"`

#### 3. `_execute_request_with_retry()` - HTTP Request

```python
async def _execute_request_with_retry(
    self,
    payload: dict[str, Any],
    stream: bool,
    attempt: int,
) -> dict[str, Any]:
```

**Flow**:
1. **Token Estimation**: Via `_estimate_request_tokens()`
2. **UI Status Update**: Set sending mode with estimated tokens
3. **Animation Start**: Token counter animation via `_animate_sending_tokens()`
4. **HTTP Request**: POST to `{endpoint}/api/chat` with adaptive timeout
5. **Response Processing**:
   - Non-streaming: Full JSON response with tool call validation
   - Streaming: Via `_process_streaming_response()`

**Timeout Calculation**:
```python
base_timeout = 240  # 4 minutes
timeout = aiohttp.ClientTimeout(total=base_timeout + (attempt * 60))
```

**Session Management**:
- Lazy-creates `aiohttp.ClientSession` on first request
- Reuses session for connection pooling
- Closes on `close()` or context exit

---

## Message Format Specification

### Message Roles

CodeAlly supports 4 message roles:

```typescript
type MessageRole = "system" | "user" | "assistant" | "tool";
```

### Message Structures

#### System Message

```python
{
    "role": "system",
    "content": "You are a helpful AI assistant..."
}
```

**Purpose**: Sets model behavior and context
**Placement**: Typically first message in conversation
**Content**: Prompt engineering, instructions, available tools

#### User Message

```python
{
    "role": "user",
    "content": "What is in this directory?"
}
```

**Purpose**: User input/queries
**Content**: Natural language requests

#### Assistant Message (Text Response)

```python
{
    "role": "assistant",
    "content": "I'll help you with that."
}
```

#### Assistant Message (Tool Calls)

```python
{
    "role": "assistant",
    "content": "",  # Often empty when making tool calls
    "tool_calls": [
        {
            "id": "auto-id-1729449876",
            "type": "function",
            "function": {
                "name": "bash",
                "arguments": {
                    "command": "ls -la",
                    "description": "List directory contents"
                }
            }
        }
    ]
}
```

**Tool Call Fields**:
- `id`: Unique identifier (format: `{prefix}-{timestamp}`)
- `type`: Always `"function"`
- `function.name`: Tool name matching registry
- `function.arguments`: Dict of tool parameters

**Multiple Tool Calls**:
```python
{
    "role": "assistant",
    "content": "",
    "tool_calls": [
        {"id": "call-1", "type": "function", "function": {...}},
        {"id": "call-2", "type": "function", "function": {...}},
        {"id": "call-3", "type": "function", "function": {...}}
    ]
}
```

#### Tool Result Message

```python
{
    "role": "tool",
    "tool_call_id": "auto-id-1729449876",
    "name": "bash",  # Tool name
    "content": "total 24\ndrwxr-xr-x  6 user  staff  192 Oct 14 09:38 .\n..."
}
```

**Required Fields**:
- `role`: Must be `"tool"`
- `tool_call_id`: Links to assistant's tool call
- `name`: Tool that produced result
- `content`: Tool output (string or JSON-serialized)

### Native Thinking Support

Assistant messages can include a `thinking` field for reasoning traces:

```python
{
    "role": "assistant",
    "content": "I'll analyze this file.",
    "thinking": "First I need to read the file to understand its structure..."
}
```

**Display Behavior**:
- Shown during streaming in real-time
- Collapsed/expandable in final output
- Combined with embedded `<thinking>` tags if both present

### Legacy Function Call Format

**Deprecated but supported for compatibility**:

```python
{
    "role": "assistant",
    "content": "",
    "function_call": {
        "name": "bash",
        "arguments": {"command": "ls"}
    }
}
```

**Conversion**: Automatically converted to `tool_calls` format via `_convert_function_call_to_tool_calls()`

---

## Function Calling Protocol

### Schema Generation from Python Functions

`OllamaClient` can automatically generate JSON schemas from Python callables:

```python
def _generate_schema_from_function(self, func: Callable) -> dict[str, Any]:
```

**Supports Two Input Types**:

1. **BaseTool instances**:
```python
# Checks for these attributes:
hasattr(func, "name")
hasattr(func, "description")
hasattr(func, "execute")
```

2. **Regular functions**:
```python
def my_tool(param1: str, param2: int = 0) -> str:
    """Tool description."""
    ...
```

**Schema Output Format**:

```python
{
    "type": "function",
    "function": {
        "name": "bash",
        "description": "Execute bash commands",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Command"
                },
                "description": {
                    "type": "string",
                    "description": "Description"
                }
            },
            "required": ["command"]
        }
    }
}
```

### Type Mapping

```python
def _determine_param_type(self, annotation: type) -> str:
```

**Python Type → JSON Schema Type**:
- `str` → `"string"`
- `int` → `"integer"`
- `float` → `"number"`
- `bool` → `"boolean"`
- `list` → `"array"`
- `Optional[T]` → Unwraps to inner type
- `Union[T, None]` → Unwraps to non-None type
- Unknown → `"string"` (default)

### Parameter Extraction

**From Function Signature**:
```python
import inspect
sig = inspect.signature(execute_method)
for param_name, param in sig.parameters.items():
    # Skip 'self' and 'kwargs'
    if param_name in ("self", "kwargs"):
        continue

    # Extract type annotation
    param_type = self._determine_param_type(
        param.annotation if param.annotation != inspect.Parameter.empty else str
    )

    # Add to properties
    parameters["properties"][param_name] = {
        "type": param_type,
        "description": param_name.replace("_", " ").title()
    }

    # Add to required if no default
    if param.default == inspect.Parameter.empty:
        parameters["required"].append(param_name)
```

### Tool Call Normalization

#### Legacy to Modern Format Conversion

```python
def _convert_function_call_to_tool_calls(self, message: dict[str, Any]) -> bool:
```

**Input** (Legacy):
```python
{
    "function_call": {
        "name": "bash",
        "arguments": '{"command": "ls"}'  # Can be string or dict
    }
}
```

**Output** (Modern):
```python
{
    "tool_calls": [
        {
            "id": f"function-{int(time.time())}",
            "type": "function",
            "function": {
                "name": "bash",
                "arguments": {"command": "ls"}  # Always dict
            }
        }
    ]
}
```

**Validation**:
- Checks `function_call` is dict
- Requires `name` field
- Parses JSON string arguments if needed
- Returns `False` on validation failure

---

## Tool Call Validation & Retry

### Validation Pipeline

```python
def _normalize_tool_calls_in_message(self, message: dict[str, Any]) -> dict[str, Any]:
```

**Returns Validation Result**:
```python
{
    "valid": True/False,
    "errors": ["Error 1", "Error 2"],  # If invalid
    "partial_repairs": [...]  # If some calls valid
}
```

**Process**:
1. **Legacy Conversion**: Convert `function_call` to `tool_calls`
2. **Validation**: Via `_validate_and_repair_tool_calls()`
3. **Repair Attempts**: Via `_repair_single_tool_call()`
4. **Result Aggregation**: Keeps valid calls, reports errors

### Single Tool Call Repair

```python
def _repair_single_tool_call(self, call: dict[str, Any], index: int) -> dict[str, Any]:
```

**Repairs**:

1. **Missing/Invalid ID**:
```python
if "id" not in repaired_call or not repaired_call["id"]:
    repaired_call["id"] = f"repaired-{int(time.time())}-{index}"
```

2. **Missing Type**:
```python
if "type" not in repaired_call:
    repaired_call["type"] = "function"
```

3. **Flat to Nested Structure**:
```python
# Before:
{"name": "bash", "arguments": {...}}

# After:
{"function": {"name": "bash", "arguments": {...}}}
```

4. **JSON String Arguments**:
```python
if isinstance(args, str):
    try:
        function["arguments"] = json.loads(args)
    except json.JSONDecodeError:
        # Report error
```

5. **Missing Arguments**:
```python
if "arguments" not in function:
    function["arguments"] = {}
```

### Retry Loop

```python
async def _handle_tool_call_validation_retry(
    self,
    result: dict[str, Any],
    original_messages: list[dict[str, Any]],
    functions: list[dict[str, Any]] | None,
    tools: list[Callable] | None,
) -> dict[str, Any] | None:
```

**Configuration**:
```python
max_retries = self.config.get("tool_call_max_retries", 2)
verbose_errors = self.config.get("tool_call_verbose_errors", False)
```

**Retry Flow**:
1. **Check Validation**: Skip if already valid
2. **Create Error Message**: Via `_create_tool_call_error_message()`
3. **Build Retry Conversation**:
```python
retry_messages = original_messages + [
    {
        "role": "assistant",
        "content": result.get("content", ""),
        "tool_calls": result.get("tool_calls", [])  # Include original
    },
    {
        "role": "user",
        "content": error_message  # Instructional feedback
    }
]
```
4. **Execute Retry**: Call LLM with corrective feedback
5. **Validate Result**: Check if retry succeeded
6. **Iterate or Fail**: Continue up to `max_retries`

**Error Message Format**:

```python
"""I encountered errors with your tool calls. Please fix these issues:

1. Tool call 0: Missing function name
2. Tool call 1: Invalid JSON in arguments: ...

Please ensure your tool calls follow this exact format:
```json
{
  "id": "unique-id",
  "type": "function",
  "function": {
    "name": "tool_name",
    "arguments": {...}
  }
}
```

Try your tool calls again with the correct format."""
```

**Failure Response**:
```python
{
    "role": "assistant",
    "content": "I attempted to call tools but encountered validation errors after 2 retries. Errors: ...",
    "tool_call_validation_failed": True,
    "validation_errors": [...]
}
```

---

## Streaming Protocol

### Streaming Response Processing

```python
async def _process_streaming_response(
    self,
    response: aiohttp.ClientResponse
) -> dict[str, Any]:
```

### Chunk Format

Ollama streams newline-delimited JSON:

```json
{"message": {"role": "assistant", "content": "Let"}}
{"message": {"role": "assistant", "content": " me"}}
{"message": {"role": "assistant", "content": " help"}}
...
{"message": {"role": "assistant", "content": ""}, "done": true}
```

**With Tool Calls**:
```json
{"message": {"role": "assistant", "content": "", "tool_calls": [...]}}
{"message": {"role": "assistant", "content": ""}, "done": true}
```

**With Native Thinking** (GPT-OSS models):
```json
{"message": {"role": "assistant", "thinking": "I need to", "content": ""}}
{"message": {"role": "assistant", "thinking": " analyze", "content": ""}}
{"message": {"role": "assistant", "content": "Let me help"}}
```

### Aggregation Logic

```python
aggregated_content = ""
aggregated_thinking = ""
aggregated_message = {}
tool_calls_detected = False

async for line in response.content:
    chunk_data = json.loads(line_text)
    message = chunk_data.get("message", {})

    # Accumulate content
    content_chunk = message.get("content", "")
    if content_chunk:
        aggregated_content += content_chunk
        aggregated_message["content"] = aggregated_content

    # Accumulate thinking
    thinking_chunk = message.get("thinking", "")
    if thinking_chunk:
        aggregated_thinking += thinking_chunk
        aggregated_message["thinking"] = aggregated_thinking

    # Handle tool calls (replace, not accumulate)
    if "tool_calls" in message:
        aggregated_message["tool_calls"] = message["tool_calls"]
        tool_calls_detected = True

    # Check for completion
    if chunk_data.get("done", False):
        break
```

### Cancellation Checking

**Frequent Interruption Checks**:
```python
async for line in response.content:
    # Check at start of iteration
    current_task = asyncio.current_task()
    cancellation_event = await self._interrupt_coordinator.get_cancellation_event_async()

    if (current_task and current_task.cancelled()) or
       self._interrupted or
       cancellation_event.is_set():
        raise asyncio.CancelledError("Streaming interrupted by user")

    # Process chunk...

    # Check again during processing
    if self._interrupted or cancellation_event.is_set():
        raise asyncio.CancelledError("Streaming interrupted by user")
```

### UI Coordination

**Streaming Display**:
```python
if (content_chunk or thinking_chunk) and not tool_calls_detected:
    if not streaming_started:
        ui_manager.start_streaming_response()
        streaming_started = True
        content_was_streamed = True

    ui_manager.update_streaming_response(
        aggregated_content,
        thinking=aggregated_thinking if aggregated_thinking else None
    )
```

**Tool Call Suppression**:
```python
if "tool_calls" in message:
    tool_calls_detected = True
    if streaming_started:
        ui_manager.stop_streaming_response()
        streaming_started = False
```

### Cleanup on Completion

```python
if content_was_streamed:
    aggregated_message["_content_was_streamed"] = True
    aggregated_message["_should_replace_streaming"] = True
    ui_manager.stop_streaming_response()

return aggregated_message
```

### Interrupted Streaming

```python
except (asyncio.CancelledError, KeyboardInterrupt):
    ui_manager.stop_streaming_response()
    self._interrupted = False

    if aggregated_message:
        aggregated_message["interrupted"] = True
        aggregated_message["_content_was_streamed"] = content_was_streamed
        return aggregated_message
    else:
        return {
            "role": "assistant",
            "content": aggregated_content or "[Request interrupted by user]",
            "interrupted": True,
            "_content_was_streamed": content_was_streamed
        }
```

---

## Interruption & Cancellation

### Architecture

CodeAlly uses a sophisticated event-based interruption system coordinated by `InterruptCoordinator`:

**File**: `/Users/bhm128/CodeAlly/code_ally/agent/interrupt_coordinator.py`

### Components

1. **Signal Handler**: Minimal SIGINT handler (sets flags only)
2. **Thread-Safe Event**: `threading.Event` for synchronous code
3. **Async Event**: `asyncio.Event` for coroutines
4. **State Machine**: Tracks application state for context-aware interrupts

### Event-Based Cancellation

```python
async def _execute_request_with_cancellation(
    self,
    request_coro: Awaitable[dict[str, Any]]
) -> dict[str, Any]:
```

**Pattern**:
```python
cancellation_event = await self._interrupt_coordinator.get_cancellation_event_async()

# Create tasks
cancel_task = asyncio.create_task(cancellation_event.wait())
request_task = asyncio.create_task(request_coro)

# Store for external cancellation
self._current_request_task = request_task

try:
    # Race condition: first to complete wins
    done, pending = await asyncio.wait(
        {request_task, cancel_task},
        return_when=asyncio.FIRST_COMPLETED
    )

    # Cancel pending tasks
    for task in pending:
        if not task.done():
            task.cancel()
            await asyncio.wait_for(task, timeout=0.1)

    # Check if cancelled
    if cancel_task in done:
        self._interrupted = True
        raise asyncio.CancelledError("Request cancelled by user")

    # Return result
    return await request_task

except asyncio.CancelledError:
    self._interrupted = True
    raise
finally:
    self._current_request_task = None
```

### Interrupt States

```python
class ApplicationState(Enum):
    IDLE = "idle"
    USER_INPUT_ACTIVE = "user_input_active"
    MODEL_REQUEST_ACTIVE = "model_request_active"
    TOOL_EXECUTION_ACTIVE = "tool_execution_active"
```

### Interrupt Actions

```python
class InterruptAction(Enum):
    CANCEL_REQUEST = "cancel_request"      # During model/tool execution
    CLEAR_INPUT = "clear_input"            # During typing
    EXIT_APPLICATION = "exit_application"  # At idle/empty prompt
    NO_ACTION = "no_action"
```

### Cancellation Flow

**Signal Handler** (minimal):
```python
def _signal_handler(self, signum, frame):
    self._interrupt_pending = True
    self._last_interrupt_time = time.time()

    # Schedule deferred processing
    loop = asyncio.get_event_loop()
    if loop.is_running():
        loop.call_soon_threadsafe(self._process_interrupt_deferred)
```

**Deferred Processing** (full logic):
```python
def _process_interrupt_deferred(self):
    action = self._determine_action()
    self._execute_action(action)
```

**Action Execution**:
```python
def _cancel_model_request(self):
    # Set thread-safe event
    self._cancellation_event_thread.set()

    # Schedule async event in event loop
    if self._cancellation_event_async:
        loop.call_soon_threadsafe(self._cancellation_event_async.set)

    # Set flags
    self.agent.request_in_progress = False
    self.agent.model_client._interrupted = True

    # Cancel tasks
    self._cancel_all_model_client_tasks()

    # Stop UI
    self._stop_all_ui_animations()
```

### Task Cancellation

```python
def _cancel_all_model_client_tasks(self):
    # Cancel streaming task
    if hasattr(model_client, '_current_streaming_task'):
        task = model_client._current_streaming_task
        if task and not task.done():
            task.cancel()

    # Cancel request task
    if hasattr(model_client, '_current_request_task'):
        task = model_client._current_request_task
        if task and not task.done():
            task.cancel()
```

### Reset Between Requests

```python
def reset_interrupt_state(self):
    self._cancellation_event_thread.clear()
    if self._cancellation_event_async:
        self._cancellation_event_async.clear()

    self._processing_interrupt = False
    self._interrupt_pending = False
    self._rapid_interrupt_count = 0
    self._exit_requested = False

    if self.agent:
        self.agent.model_client._interrupted = False
```

---

## Configuration & Initialization

### Configuration Parameters

**From** `/Users/bhm128/CodeAlly/code_ally/config.py`:

```python
DEFAULT_CONFIG = {
    # LLM Client Settings
    "model": None,  # Auto-selected from available models
    "endpoint": "http://localhost:11434",
    "context_size": 16384,
    "temperature": 0.3,
    "max_tokens": 7000,

    # Tool Call Validation
    "tool_call_retry_enabled": True,
    "tool_call_max_retries": 2,
    "tool_call_repair_attempts": True,
    "tool_call_verbose_errors": False,
}
```

### Initialization Pattern

```python
from code_ally.llm_client import OllamaClient
from code_ally.config import ConfigManager

config_manager = ConfigManager()
config = config_manager.get_config()

client = OllamaClient(
    endpoint=config.get("endpoint", "http://localhost:11434"),
    model_name=config.get("model"),
    temperature=config.get("temperature", 0.3),
    context_size=config.get("context_size", 16384),
    max_tokens=config.get("max_tokens", 7000),
    keep_alive=config.get("keep_alive")  # Optional
)
```

### Service Registry Integration

CodeAlly uses dependency injection via `ServiceRegistry`:

```python
from code_ally.service_registry import ServiceRegistry

# Registration
registry = ServiceRegistry.get_instance()
registry.register("model_client", lambda: OllamaClient(...))

# Retrieval
model_client = registry.get("model_client")
```

### Context Manager Usage

```python
async with OllamaClient(
    endpoint="http://localhost:11434",
    model_name="qwen2.5-coder:32b"
) as client:
    response = await client.send(
        messages=[{"role": "user", "content": "Hello"}],
        stream=True
    )
```

---

## Error Handling

### Exception Types

1. **Network Errors**:
   - `aiohttp.ClientError`
   - `aiohttp.ServerTimeoutError`
   - `asyncio.TimeoutError`

2. **Parsing Errors**:
   - `json.JSONDecodeError`

3. **Cancellation**:
   - `asyncio.CancelledError`
   - `KeyboardInterrupt`

4. **Unexpected**:
   - `Exception` (catch-all)

### Error Response Format

```python
def _handle_request_error(self, e: Exception, attempts: int = 1) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": f"Error communicating with Ollama after {attempts} attempts: {error_msg}\n\nSuggested fixes:\n...",
        "error": True,
        "suggestions": [
            "Check that Ollama is running: `ollama serve`",
            "Verify Ollama is accessible at the configured endpoint",
            ...
        ]
    }
```

### Recovery Suggestions

**Connection Errors**:
```python
suggestions = [
    "Check that Ollama is running: `ollama serve`",
    "Verify Ollama is accessible at the configured endpoint",
    "Try increasing the timeout in configuration"
]
```

**Refused Connection**:
```python
suggestions = [
    "Start Ollama service: `ollama serve`",
    "Check if another process is using port 11434"
]
```

**404 Not Found**:
```python
suggestions = [
    "Check if the model is available: `ollama list`",
    "Pull the model if needed: `ollama pull <model-name>`"
]
```

**JSON Decode Errors**:
```python
suggestions = [
    "Try restarting Ollama: `ollama serve`",
    "Check if the model supports function calling",
    "Verify model compatibility with CodeAlly"
]
```

### Retry Strategy

**Network Errors** (exponential backoff):
```python
for attempt in range(max_retries + 1):
    try:
        result = await self._execute_request_with_retry(...)
        return result
    except (aiohttp.ClientError, asyncio.TimeoutError) as e:
        if attempt < max_retries:
            wait_time = 2**attempt  # Exponential
            await asyncio.sleep(wait_time)
            continue
        else:
            return self._handle_request_error(e, attempt + 1)
```

**JSON Errors** (linear backoff):
```python
except json.JSONDecodeError as e:
    if attempt < max_retries:
        wait_time = 1 + attempt  # Linear
        await asyncio.sleep(wait_time)
        continue
    else:
        return self._handle_json_error(e, attempt + 1)
```

**Cancellation** (no retry):
```python
except asyncio.CancelledError:
    return {
        "role": "assistant",
        "content": "[Request cancelled by user]",
        "cancelled": True
    }
```

### Token Estimation for Timeout

```python
def _estimate_request_tokens(self, payload: dict[str, Any]) -> int:
    total_chars = 0

    # Count message characters
    for message in payload.get("messages", []):
        content = message.get("content", "")
        if isinstance(content, str):
            total_chars += len(content)

    # Count tool definition characters
    for tool in payload.get("tools", []):
        total_chars += len(str(tool))

    # Estimate: ~4 chars per token
    return max(1, total_chars // 4)
```

### Adaptive Timeout

```python
base_timeout = 240  # 4 minutes
timeout = aiohttp.ClientTimeout(total=base_timeout + (attempt * 60))
```

First attempt: 240s (4 min)
Second attempt: 300s (5 min)
Third attempt: 360s (6 min)

---

## Integration Points

### Agent Integration

**File**: `/Users/bhm128/CodeAlly/code_ally/agent/conversation_manager.py`

```python
# Refresh system prompt
self.agent._refresh_system_prompt()

# Send request with streaming
response = await self.agent.model_client.send(
    self.agent.messages,
    functions=self.agent.tool_manager.get_function_definitions(),
    stream=True
)

# Check for interruption
was_interrupted = response.get("interrupted", False)
if was_interrupted:
    return

# Process response
await self.agent.response_processor.process_llm_response(response)
```

### Response Processing

**File**: `/Users/bhm128/CodeAlly/code_ally/agent/response_processor.py`

```python
def _extract_tool_calls(self, response: dict[str, Any]) -> list[dict[str, Any]]:
    if "tool_calls" in response:
        return response.get("tool_calls", [])
    elif "function_call" in response and response["function_call"]:
        # Convert legacy format
        return [
            {
                "id": f"manual-id-{int(time.time())}",
                "type": "function",
                "function": response["function_call"]
            }
        ]
    return []
```

### Tool Execution

**File**: `/Users/bhm128/CodeAlly/code_ally/agent/tool_orchestrator.py`

```python
async def execute_tool_calls(self, tool_calls: list[dict[str, Any]]) -> None:
    for tool_call in tool_calls:
        function = tool_call.get("function", {})
        tool_name = function.get("name")
        arguments = function.get("arguments", {})

        # Execute tool
        result = await self.tool_manager.execute_tool(
            tool_name,
            arguments,
            tool_call_id=tool_call.get("id")
        )

        # Add result to messages
        self.agent.messages.append({
            "role": "tool",
            "tool_call_id": tool_call.get("id"),
            "name": tool_name,
            "content": result
        })
```

### UI Coordination

**Thinking Animation**:
```python
# Start
animation_thread = ui_manager.start_thinking_animation(
    token_percentage,
    model_name=model_client.model_name
)

# Stop
ui_manager.stop_thinking_animation()
```

**Streaming Display**:
```python
# Set sending mode
ui_manager.set_sending_mode(estimated_tokens)

# Update sending animation
ui_manager.update_sending_tokens(current_tokens)

# Switch to receiving
ui_manager.set_receiving_mode()

# Stream content
ui_manager.start_streaming_response()
ui_manager.update_streaming_response(content, thinking=thinking)
ui_manager.stop_streaming_response()
```

### Session Management

**Auto-save after responses**:
```python
self.agent.messages.append(response)
self.agent.token_manager.update_token_count(self.agent.messages)
self.agent._auto_save_session()
```

---

## Implementation Notes for TypeScript

### Key Differences to Address

1. **Async/Await**: Direct translation to TypeScript async/await
2. **Type Annotations**: Use TypeScript interfaces for message formats
3. **HTTP Client**: Replace `aiohttp` with `axios` or `fetch`
4. **Events**: Replace `asyncio.Event` with Promise-based cancellation (AbortController)
5. **Signal Handling**: Use Node.js `process.on('SIGINT', ...)` or browser equivalents
6. **Threading**: Replace `threading.Event` with EventEmitter or similar

### Recommended TypeScript Interfaces

```typescript
interface Message {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
    thinking?: string;
}

interface ToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: Record<string, any>;
    };
}

interface LLMResponse {
    role: "assistant";
    content: string;
    tool_calls?: ToolCall[];
    thinking?: string;
    interrupted?: boolean;
    _content_was_streamed?: boolean;
    _should_replace_streaming?: boolean;
}

interface ModelClientConfig {
    endpoint: string;
    modelName: string;
    temperature: number;
    contextSize: number;
    maxTokens: number;
    keepAlive?: number;
}

abstract class ModelClient {
    abstract send(
        messages: Message[],
        options?: {
            functions?: FunctionDefinition[];
            tools?: any[];
            stream?: boolean;
        }
    ): Promise<LLMResponse>;

    abstract get modelName(): string;
    abstract get endpoint(): string;
}
```

### Streaming Implementation

Use Server-Sent Events (SSE) or async generators:

```typescript
async *streamResponse(response: Response): AsyncGenerator<any, void, undefined> {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    while (true) {
        const { done, value } = await reader!.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(line => line.trim());

        for (const line of lines) {
            try {
                yield JSON.parse(line);
            } catch (e) {
                // Skip malformed chunks
            }
        }
    }
}
```

### Cancellation with AbortController

```typescript
class OllamaClient extends ModelClient {
    private currentAbortController?: AbortController;

    async send(messages: Message[], options?: any): Promise<LLMResponse> {
        this.currentAbortController = new AbortController();

        try {
            const response = await fetch(this.apiUrl, {
                method: 'POST',
                body: JSON.stringify(payload),
                signal: this.currentAbortController.signal
            });

            // Process response...
        } catch (error) {
            if (error.name === 'AbortError') {
                return {
                    role: 'assistant',
                    content: '[Request cancelled by user]',
                    interrupted: true
                };
            }
            throw error;
        } finally {
            this.currentAbortController = undefined;
        }
    }

    cancel(): void {
        this.currentAbortController?.abort();
    }
}
```

---

## Summary

This documentation provides a complete specification of CodeAlly's LLM integration layer:

1. **ModelClient**: Abstract interface for provider-agnostic LLM access
2. **OllamaClient**: Full implementation with streaming, retry, validation, and cancellation
3. **Message Format**: 4 role types with tool call and thinking support
4. **Function Calling**: Automatic schema generation and dual format support
5. **Streaming**: Real-time token delivery with UI coordination
6. **Tool Call Validation**: Automatic repair and retry with instructional feedback
7. **Interruption**: Event-based cancellation with graceful degradation
8. **Error Handling**: Comprehensive recovery with user-facing suggestions

All code examples are from the actual implementation in `/Users/bhm128/CodeAlly/code_ally/llm_client/`.
