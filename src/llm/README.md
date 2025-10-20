# LLM Integration Layer

Complete TypeScript implementation of Code Ally's LLM client system, ported from Python with enhanced type safety and modern async/await patterns.

## Overview

This module provides an abstraction layer for communicating with Large Language Models (LLMs), specifically designed for function calling / tool use. The implementation supports:

- **Multiple backends**: Abstract `ModelClient` interface allows plugging in different providers
- **Streaming responses**: Real-time token delivery for responsive UI
- **Function calling**: Full support for tool use with validation and repair
- **Error handling**: Automatic retry with exponential backoff
- **Cancellation**: Request interruption via AbortController
- **Message history**: Context management with token estimation

## Architecture

```
llm/
├── ModelClient.ts          # Abstract base class
├── OllamaClient.ts         # Ollama implementation
├── MessageHistory.ts       # Conversation state management
├── FunctionCalling.ts      # Tool schema utilities
├── index.ts                # Public exports
└── __tests__/              # Comprehensive test suite
    ├── ModelClient.test.ts
    ├── OllamaClient.test.ts
    ├── MessageHistory.test.ts
    └── FunctionCalling.test.ts
```

## Quick Start

### Basic Usage

```typescript
import { OllamaClient, MessageHistory } from './llm/index.js';

// Initialize client
const client = new OllamaClient({
  endpoint: 'http://localhost:11434',
  modelName: 'qwen2.5-coder:32b',
  temperature: 0.3,
  contextSize: 16384,
  maxTokens: 5000,
});

// Initialize message history
const history = new MessageHistory({
  maxMessages: 1000,
  maxTokens: 16000,
});

// Add system message
history.updateSystemMessage('You are a helpful AI assistant.');

// Add user message
history.addMessage({
  role: 'user',
  content: 'Hello! Can you help me?',
});

// Send to LLM
const response = await client.send(history.getMessages(), {
  stream: false,
});

// Add response to history
history.addMessage(response);

console.log(response.content);
```

### With Function Calling

```typescript
import { OllamaClient, convertToolSchemaToFunctionDefinition } from './llm/index.js';

const client = new OllamaClient({
  endpoint: 'http://localhost:11434',
  modelName: 'qwen2.5-coder:32b',
  temperature: 0.3,
  contextSize: 16384,
  maxTokens: 5000,
});

// Define tool schemas
const toolSchema = {
  name: 'bash',
  description: 'Execute bash commands',
  parameters: {
    command: {
      type: 'string',
      description: 'The bash command to execute',
      required: true,
    },
  },
};

// Convert to function definition
const functions = [convertToolSchemaToFunctionDefinition(toolSchema)];

// Send with functions
const response = await client.send(
  [{ role: 'user', content: 'List files in the current directory' }],
  { functions, stream: false }
);

// Check for tool calls
if (response.tool_calls && response.tool_calls.length > 0) {
  const toolCall = response.tool_calls[0];
  console.log('Tool:', toolCall.function.name);
  console.log('Arguments:', toolCall.function.arguments);
}
```

### Streaming Responses

```typescript
const response = await client.send(messages, { stream: true });

// The response is aggregated, but streaming happens internally
// UI components can subscribe to streaming events via ActivityStream
console.log(response.content); // Full aggregated content
console.log(response._content_was_streamed); // true
```

### Cancellation

```typescript
// Start a request
const promise = client.send(messages, { stream: true });

// Cancel it
setTimeout(() => {
  client.cancel();
}, 1000);

const response = await promise;
console.log(response.interrupted); // true
console.log(response.content); // "[Request cancelled by user]"
```

## API Reference

### ModelClient (Abstract)

Base class for all LLM client implementations.

```typescript
abstract class ModelClient {
  abstract send(messages: Message[], options?: SendOptions): Promise<LLMResponse>;
  abstract get modelName(): string;
  abstract get endpoint(): string;
  abstract cancel?(): void;
  abstract close?(): Promise<void>;
}
```

### OllamaClient

Ollama API implementation with function calling support.

```typescript
class OllamaClient extends ModelClient {
  constructor(config: ModelClientConfig);
  send(messages: Message[], options?: SendOptions): Promise<LLMResponse>;
  cancel(): void;
  get modelName(): string;
  get endpoint(): string;
}
```

**Configuration:**

```typescript
interface ModelClientConfig {
  endpoint: string; // API endpoint URL
  modelName: string | null; // Model identifier
  temperature: number; // Sampling temperature (0.0 - 1.0)
  contextSize: number; // Context window size in tokens
  maxTokens: number; // Maximum tokens to generate
  keepAlive?: number; // Keep-alive duration in seconds
}
```

**Send Options:**

```typescript
interface SendOptions {
  functions?: FunctionDefinition[]; // Function definitions for tool calling
  stream?: boolean; // Enable streaming responses
  maxRetries?: number; // Maximum retry attempts (default: 3)
}
```

**Response Format:**

```typescript
interface LLMResponse {
  role: 'assistant';
  content: string;
  tool_calls?: ToolCall[]; // Tool calls requested by the model
  thinking?: string; // Native reasoning trace
  interrupted?: boolean; // Request was cancelled
  error?: boolean; // An error occurred
  suggestions?: string[]; // Error recovery suggestions
  _content_was_streamed?: boolean; // Internal flag
  _should_replace_streaming?: boolean; // Internal flag
}
```

### MessageHistory

Manages conversation state with token estimation and context management.

```typescript
class MessageHistory {
  constructor(options?: MessageHistoryOptions);

  // Message management
  addMessage(message: Message): void;
  addMessages(messages: Message[]): void;
  getMessages(): Message[];
  getLastMessages(count: number): Message[];

  // System message
  updateSystemMessage(content: string): void;
  getSystemMessage(): Message | undefined;

  // Clearing
  clearConversation(): void; // Keep system message
  clearAll(): void; // Remove everything

  // Token estimation
  estimateTokenCount(): number;
  getContextUsagePercent(): number;
  isNearCapacity(threshold?: number): boolean;

  // Statistics
  get messageCount(): number;
  getStats(): MessageStats;
  getSummary(): string;

  // Serialization
  toJSON(): Message[];
  fromJSON(messages: Message[]): void;
}
```

### FunctionCalling Utilities

Helper functions for working with function calling / tool use.

```typescript
// Convert tool schema to OpenAI function definition
function convertToolSchemaToFunctionDefinition(schema: ToolSchema): FunctionDefinition;

// Parse tool call arguments (handles strings and objects)
function parseToolCallArguments(args: string | object): Record<string, any>;

// Validate function arguments against schema
function validateFunctionArguments(
  args: Record<string, any>,
  schema: FunctionDefinition['function']['parameters']
): { valid: boolean; errors: string[] };

// Extract tool call data
function extractToolCallData(toolCall: any): {
  name: string;
  arguments: Record<string, any>;
  id: string;
};

// Create tool result message
function createToolResultMessage(
  toolCallId: string,
  toolName: string,
  result: any
): Message;

// Validation helpers
function hasToolCalls(message: any): boolean;
function isValidToolCall(toolCall: any): boolean;
function sanitizeToolCallArguments(args: Record<string, any>): Record<string, any>;
```

## Features

### Automatic Retry

The client automatically retries failed requests with exponential backoff:

- **Network errors**: 2^attempt seconds (1s, 2s, 4s, ...)
- **JSON parse errors**: Linear backoff (1s, 2s, 3s, ...)
- **Other errors**: No retry

### Tool Call Validation

Tool calls are automatically validated and repaired:

1. **Missing ID**: Generate a unique ID
2. **Missing type**: Set to "function"
3. **Flat structure**: Convert to nested format
4. **String arguments**: Parse JSON
5. **Missing arguments**: Default to empty object

Invalid tool calls that can't be repaired trigger a retry with error feedback to the model.

### Error Messages

Helpful error messages with recovery suggestions:

```typescript
{
  role: 'assistant',
  content: 'Error communicating with Ollama after 3 attempts: ECONNREFUSED\n\nSuggested fixes:\n- Start Ollama service: `ollama serve`\n- Check if another process is using port 11434',
  error: true,
  suggestions: [
    'Start Ollama service: `ollama serve`',
    'Check if another process is using port 11434'
  ]
}
```

### Legacy Format Support

Automatically converts legacy `function_call` format to modern `tool_calls`:

```typescript
// Input (legacy)
{
  function_call: {
    name: 'bash',
    arguments: '{"command": "ls"}'
  }
}

// Output (modern)
{
  tool_calls: [{
    id: 'function-1729449876',
    type: 'function',
    function: {
      name: 'bash',
      arguments: { command: 'ls' }
    }
  }]
}
```

## Testing

Comprehensive test suite with 100+ test cases:

```bash
# Run all tests
npm test

# Run specific test file
npm test MessageHistory.test.ts

# Run with coverage
npm test -- --coverage

# Run in watch mode
npm test -- --watch
```

Test coverage includes:

- ✅ Message management and history
- ✅ Token estimation and context management
- ✅ Tool schema conversion
- ✅ Function argument validation
- ✅ Tool call parsing and validation
- ✅ Non-streaming requests
- ✅ Error handling and retry logic
- ✅ Cancellation
- ✅ Tool call validation and repair
- ✅ Legacy format conversion

## Implementation Notes

### Differences from Python Version

1. **Fetch API**: Uses native `fetch()` instead of `aiohttp`
2. **AbortController**: Uses `AbortController` for cancellation instead of `asyncio.Event`
3. **Streaming**: Aggregates streaming responses internally instead of yielding chunks
4. **Type Safety**: Full TypeScript type checking with strict mode
5. **No Session Management**: Session kept by `aiohttp.ClientSession` is not needed with fetch

### Streaming Implementation

The streaming implementation reads from `response.body.getReader()` and aggregates chunks:

```typescript
const reader = response.body.getReader();
const decoder = new TextDecoder();

let aggregatedContent = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const chunk = decoder.decode(value, { stream: true });
  const lines = chunk.split('\n').filter(line => line.trim());

  for (const line of lines) {
    const chunkData = JSON.parse(line);
    aggregatedContent += chunkData.message.content || '';

    // UI updates happen via ActivityStream events
  }
}
```

### Timeout Strategy

Adaptive timeout increases with each retry:

```typescript
const baseTimeout = 240000; // 4 minutes
const timeout = baseTimeout + attempt * 60000; // +1 minute per retry

// First attempt: 4 minutes
// Second attempt: 5 minutes
// Third attempt: 6 minutes
```

## Integration with Code Ally

### Service Registry

Register the client as a singleton:

```typescript
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { OllamaClient } from './llm/index.js';

const registry = ServiceRegistry.getInstance();

registry.registerSingleton(
  'model_client',
  OllamaClient,
  () =>
    new OllamaClient({
      endpoint: config.get('endpoint'),
      modelName: config.get('model'),
      temperature: config.get('temperature'),
      contextSize: config.get('context_size'),
      maxTokens: config.get('max_tokens'),
    })
);
```

### ActivityStream Events

Tool calls emit events via `ActivityStream`:

```typescript
// When receiving tool calls
for (const toolCall of response.tool_calls) {
  activityStream.emit({
    id: toolCall.id,
    type: ActivityEventType.TOOL_CALL_START,
    timestamp: Date.now(),
    data: {
      toolName: toolCall.function.name,
      arguments: toolCall.function.arguments,
    },
  });
}
```

## License

MIT License - See LICENSE file for details

## Contributing

Contributions are welcome! Please:

1. Add tests for new features
2. Follow TypeScript strict mode
3. Use ESM imports
4. Add JSDoc comments
5. Run `npm test` before submitting
