# CodeAlly LLM Integration - Executive Summary

**Generated**: 2025-10-20
**Full Documentation**: `LLM_INTEGRATION_DOCUMENTATION.md`

---

## Quick Reference

### Architecture

```
ModelClient (Abstract)
    ├── send() - Main LLM request method
    ├── model_name - Current model identifier
    └── endpoint - API endpoint URL

OllamaClient (Implementation)
    ├── Connection pooling via aiohttp.ClientSession
    ├── Event-based cancellation via InterruptCoordinator
    ├── Streaming + non-streaming modes
    ├── Tool call validation & retry
    └── Automatic legacy format conversion
```

### Core Message Flow

```
User Input
    ↓
[ConversationManager] - Manages conversation loop
    ↓
model_client.send(messages, functions, stream=True)
    ↓
[OllamaClient._prepare_payload()] - Build request
    ↓
[OllamaClient._execute_request_with_retry()] - HTTP POST
    ↓
[Streaming] → _process_streaming_response() → Aggregate chunks
[Non-streaming] → Parse JSON → Validate tool calls
    ↓
[Tool Call Validation] - Repair & retry if needed
    ↓
Return LLMResponse
    ↓
[ResponseProcessor] - Extract tool calls
    ↓
[ToolOrchestrator] - Execute tools
    ↓
Follow-up request with tool results
```

---

## Critical Features for TypeScript Implementation

### 1. Message Format (4 Role Types)

```typescript
type MessageRole = "system" | "user" | "assistant" | "tool";

interface Message {
    role: MessageRole;
    content: string;
    tool_calls?: ToolCall[];      // Assistant messages
    tool_call_id?: string;        // Tool result messages
    name?: string;                // Tool result messages
    thinking?: string;            // Native reasoning (GPT-OSS)
}
```

### 2. Tool Call Structure

```typescript
interface ToolCall {
    id: string;                   // "auto-id-1729449876"
    type: "function";
    function: {
        name: string;             // Tool name from registry
        arguments: Record<string, any>;
    };
}
```

### 3. Dual Format Support

**Modern** (preferred):
```json
{
    "role": "assistant",
    "tool_calls": [
        {"id": "...", "type": "function", "function": {...}}
    ]
}
```

**Legacy** (auto-converted):
```json
{
    "role": "assistant",
    "function_call": {
        "name": "bash",
        "arguments": {"command": "ls"}
    }
}
```

### 4. Streaming Protocol

**Ollama Format**: Newline-delimited JSON chunks

```json
{"message": {"role": "assistant", "content": "Hello"}}
{"message": {"role": "assistant", "content": " world"}}
{"message": {"role": "assistant", "content": ""}, "done": true}
```

**Aggregation Requirements**:
- Accumulate `content` chunks (concatenate)
- Accumulate `thinking` chunks (concatenate)
- Replace `tool_calls` (not accumulate)
- Stop streaming UI when tool calls detected
- Check cancellation frequently

### 5. Tool Call Validation & Repair

**Validation Pipeline**:
1. Convert legacy `function_call` to `tool_calls`
2. Validate each tool call structure
3. Repair common issues:
   - Missing/invalid ID → Generate `repaired-{timestamp}-{index}`
   - Missing type → Set to `"function"`
   - Flat structure → Nest under `function` key
   - JSON string args → Parse to object
   - Missing args → Set to `{}`
4. Retry with instructional feedback if validation fails

**Retry Configuration**:
- `tool_call_max_retries`: Default 2
- `tool_call_retry_enabled`: Default true
- `tool_call_verbose_errors`: Default false

**Retry Flow**:
```
LLM Response (invalid tool calls)
    ↓
Create error message with format examples
    ↓
Append to conversation:
    [Assistant: Invalid tool calls]
    [User: "Fix these errors: ..."]
    ↓
Retry LLM request (up to max_retries)
    ↓
Validate retry result
    ↓
Success → Return
Failure → Continue retrying or return failure response
```

### 6. Cancellation System

**Components**:
- `InterruptCoordinator`: Global signal handler
- `threading.Event`: Thread-safe cancellation
- `asyncio.Event`: Async-safe cancellation
- State machine for context-aware interrupts

**TypeScript Equivalent**:
```typescript
class OllamaClient {
    private abortController?: AbortController;

    async send(...): Promise<LLMResponse> {
        this.abortController = new AbortController();

        try {
            const response = await fetch(url, {
                signal: this.abortController.signal
            });
            // ...
        } catch (error) {
            if (error.name === 'AbortError') {
                return {
                    role: 'assistant',
                    content: '[Request cancelled by user]',
                    interrupted: true
                };
            }
            throw error;
        }
    }

    cancel(): void {
        this.abortController?.abort();
    }
}
```

### 7. Error Handling & Retry

**Network Errors** (exponential backoff):
- Attempt 1: Wait 1s (2^0)
- Attempt 2: Wait 2s (2^1)
- Attempt 3: Wait 4s (2^2)

**JSON Errors** (linear backoff):
- Attempt 1: Wait 1s
- Attempt 2: Wait 2s
- Attempt 3: Wait 3s

**No Retry**:
- `CancelledError`
- Unexpected errors

**Error Response Format**:
```typescript
interface ErrorResponse {
    role: "assistant";
    content: string;              // User-friendly message
    error: true;
    suggestions: string[];        // Recovery actions
}
```

---

## Configuration Parameters

```typescript
interface OllamaClientConfig {
    // Connection
    endpoint: string;              // Default: "http://localhost:11434"
    model_name: string;            // e.g., "qwen2.5-coder:32b"

    // Generation
    temperature: number;           // Default: 0.3
    context_size: number;          // Default: 16384
    max_tokens: number;            // Default: 7000
    keep_alive?: number;           // Optional (seconds)

    // Retry & Validation
    tool_call_retry_enabled: boolean;       // Default: true
    tool_call_max_retries: number;          // Default: 2
    tool_call_repair_attempts: boolean;     // Default: true
    tool_call_verbose_errors: boolean;      // Default: false
}
```

---

## Payload Format

**Request to Ollama**:
```json
{
    "model": "qwen2.5-coder:32b",
    "messages": [
        {"role": "system", "content": "..."},
        {"role": "user", "content": "..."}
    ],
    "stream": true,
    "options": {
        "temperature": 0.3,
        "num_ctx": 16384,
        "num_predict": 7000,
        "keep_alive": 300
    },
    "tools": [
        {
            "type": "function",
            "function": {
                "name": "bash",
                "description": "Execute bash commands",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {"type": "string", "description": "Command"},
                        "description": {"type": "string", "description": "Description"}
                    },
                    "required": ["command"]
                }
            }
        }
    ]
}
```

**Response from Ollama** (non-streaming):
```json
{
    "message": {
        "role": "assistant",
        "content": "I'll help with that.",
        "tool_calls": [
            {
                "id": "auto-id-123456",
                "type": "function",
                "function": {
                    "name": "bash",
                    "arguments": {"command": "ls -la", "description": "List files"}
                }
            }
        ]
    },
    "done": true
}
```

---

## Function Schema Generation

**From Python Function**:
```python
def bash(command: str, description: str = "") -> str:
    """Execute bash commands"""
    ...
```

**To JSON Schema**:
```json
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

**Type Mapping**:
- `str` → `"string"`
- `int` → `"integer"`
- `float` → `"number"`
- `bool` → `"boolean"`
- `list` → `"array"`
- `Optional[T]` → Unwrap to inner type
- Unknown → `"string"` (fallback)

---

## UI Coordination Flags

**Internal Response Fields**:
```typescript
interface LLMResponse {
    // Standard fields
    role: "assistant";
    content: string;
    tool_calls?: ToolCall[];
    thinking?: string;

    // Control flags
    interrupted?: boolean;                  // User cancelled
    _content_was_streamed?: boolean;        // Content displayed during streaming
    _should_replace_streaming?: boolean;    // Replace streaming UI with final
    error?: boolean;                        // Error occurred
    cancelled?: boolean;                    // Request cancelled
    tool_call_validation_failed?: boolean;  // Validation failed after retries
}
```

**UI Coordination**:
- `_content_was_streamed`: Don't duplicate content display
- `_should_replace_streaming`: Replace streaming UI with formatted version
- `interrupted`/`cancelled`: Stop all UI, return to prompt
- Tool calls detected: Stop streaming immediately, switch to tool execution display

---

## Key Implementation Insights

### 1. Tool Call ID Generation

```python
# Auto-generated
f"auto-id-{int(time.time())}"

# Manual (from config)
f"{config.agent_manual_id_prefix}-{int(time.time())}"

# Repaired
f"repaired-{int(time.time())}-{index}"
```

### 2. Streaming Display Logic

```python
if (content_chunk or thinking_chunk) and not tool_calls_detected:
    if not streaming_started:
        ui.start_streaming_response()
        streaming_started = True

    ui.update_streaming_response(
        aggregated_content,
        thinking=aggregated_thinking
    )

# When tool calls detected
if "tool_calls" in message:
    tool_calls_detected = True
    if streaming_started:
        ui.stop_streaming_response()  # Prevent leakage
```

### 3. Cancellation Checking (Streaming)

```python
async for line in response.content:
    # Check at start
    if task.cancelled() or interrupted or event.is_set():
        raise asyncio.CancelledError()

    # Process chunk...

    # Check again
    if interrupted or event.is_set():
        raise asyncio.CancelledError()
```

### 4. Token Estimation (for timeouts)

```python
total_chars = sum(len(msg.get("content", "")) for msg in messages)
total_chars += sum(len(str(tool)) for tool in tools)
estimated_tokens = max(1, total_chars // 4)  # ~4 chars/token
```

### 5. Adaptive Timeout

```python
base_timeout = 240  # 4 minutes
timeout = base_timeout + (attempt * 60)  # Add 1 min per retry
```

---

## Critical Differences: Python vs TypeScript

| Feature | Python | TypeScript Equivalent |
|---------|--------|----------------------|
| HTTP Client | `aiohttp.ClientSession` | `fetch` or `axios` |
| Async Events | `asyncio.Event` | `Promise` + `AbortController` |
| Thread Events | `threading.Event` | `EventEmitter` |
| Signal Handling | `signal.signal(SIGINT, ...)` | `process.on('SIGINT', ...)` |
| Async Generators | `async for` | `for await (... of ...)` |
| Type Hints | `list[dict[str, Any]]` | `Message[]` |
| JSON Parsing | `json.loads()` | `JSON.parse()` |
| Context Managers | `async with` | Try/finally or custom |

---

## Testing Checklist

- [ ] Non-streaming request/response
- [ ] Streaming with content accumulation
- [ ] Streaming with thinking accumulation
- [ ] Tool calls in response
- [ ] Multiple tool calls (parallel)
- [ ] Legacy function_call conversion
- [ ] Tool call validation (malformed)
- [ ] Tool call repair (missing fields)
- [ ] Tool call retry with feedback
- [ ] Cancellation during request
- [ ] Cancellation during streaming
- [ ] Network error retry (exponential backoff)
- [ ] JSON error retry (linear backoff)
- [ ] Timeout handling (adaptive)
- [ ] Session management (close)
- [ ] UI coordination flags
- [ ] Error response format

---

## Reference Files

**Core Implementation**:
- `/Users/bhm128/CodeAlly/code_ally/llm_client/model_client.py` - Abstract interface
- `/Users/bhm128/CodeAlly/code_ally/llm_client/ollama_client.py` - Implementation (1174 lines)

**Integration Points**:
- `/Users/bhm128/CodeAlly/code_ally/agent/conversation_manager.py` - Request orchestration
- `/Users/bhm128/CodeAlly/code_ally/agent/response_processor.py` - Response handling
- `/Users/bhm128/CodeAlly/code_ally/agent/interrupt_coordinator.py` - Cancellation system

**Configuration**:
- `/Users/bhm128/CodeAlly/code_ally/config.py` - Default settings

---

## Next Steps for TypeScript Implementation

1. Define TypeScript interfaces for all message types
2. Implement `ModelClient` abstract class
3. Implement `OllamaClient` with:
   - Connection pooling
   - Streaming via async generators
   - Tool call validation & repair
   - Retry logic with backoff
   - Cancellation via AbortController
4. Create interrupt coordinator equivalent
5. Test all scenarios from checklist
6. Document TypeScript-specific patterns

**Full details in**: `LLM_INTEGRATION_DOCUMENTATION.md` (11,000+ lines)
