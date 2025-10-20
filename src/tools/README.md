# Tool System Architecture

The tool system provides an event-driven, extensible framework for implementing tools that the LLM can call during conversations.

## Architecture Overview

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
│  • Redundancy Detection                                  │
│  • File Operation Tracking                               │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│                   Individual Tools                       │
│  • BaseTool inheritance                                  │
│  • Event emission                                        │
│  • Execute implementation                                │
└─────────────────────────────────────────────────────────┘
```

## Core Components

### BaseTool

Abstract base class that all tools must extend. Provides:

- **Event Emission**: Automatically emits START, END, OUTPUT_CHUNK, and ERROR events
- **Error Handling**: Standardized error response formatting with context
- **Parameter Capture**: Captures parameters for enhanced error messages
- **Result Preview**: Customizable preview system for UI display

```typescript
export abstract class BaseTool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly requiresConfirmation: boolean;
  readonly suppressExecutionAnimation: boolean = false;

  protected abstract executeImpl(args: any): Promise<ToolResult>;
}
```

### ToolManager

Central registry and execution coordinator. Features:

- **Tool Registration**: Maintains map of tool name → tool instance
- **Function Definition Generation**: Creates LLM-compatible function schemas
- **Validation Pipeline**: Validates tool existence and arguments
- **Redundancy Detection**: Prevents duplicate calls in same conversation turn
- **File Tracking**: Tracks read/write operations for validation
- **State Management**: Clears turn-specific and session state

```typescript
export class ToolManager {
  constructor(tools: BaseTool[], activityStream: ActivityStream);

  getTool(name: string): BaseTool | undefined;
  getFunctionDefinitions(): FunctionDefinition[];
  executeTool(toolName: string, args: any): Promise<ToolResult>;
  clearCurrentTurn(): void;
  clearState(): void;
}
```

### ToolValidator

Validates tool arguments against function definitions:

- **Required Parameter Checking**: Ensures all required params are present
- **Type Validation**: Validates parameter types (string, number, boolean, array, object)
- **Helpful Error Messages**: Generates examples for missing parameters
- **Nested Validation**: Validates array items and object properties

```typescript
export class ToolValidator {
  validateArguments(
    tool: BaseTool,
    functionDef: FunctionDefinition,
    arguments: Record<string, any>
  ): ValidationResult;
}
```

## Event System

All tool operations emit events through the ActivityStream:

### Event Types

```typescript
enum ActivityEventType {
  TOOL_CALL_START = 'tool_call_start',   // Tool execution begins
  TOOL_CALL_END = 'tool_call_end',       // Tool execution completes
  TOOL_OUTPUT_CHUNK = 'tool_output_chunk', // Streaming output (bash, grep)
  ERROR = 'error',                        // Tool error occurred
}
```

### Event Flow

1. **TOOL_CALL_START**: Emitted when `execute()` is called
   - Includes: toolName, arguments
   - Used by UI to show "executing" state

2. **TOOL_OUTPUT_CHUNK**: Emitted during streaming operations
   - Includes: chunk of output text
   - Used by UI to show real-time output (bash command)

3. **TOOL_CALL_END**: Emitted when execution completes successfully
   - Includes: result, success flag
   - Used by UI to show "complete" state

4. **ERROR**: Emitted when execution fails
   - Includes: error message, toolName
   - Used by UI to show "error" state

### Subscribing to Events

```typescript
const activityStream = new ActivityStream();

// Subscribe to specific event type
const unsubscribe = activityStream.subscribe(
  ActivityEventType.TOOL_CALL_START,
  (event) => {
    console.log(`Tool ${event.data.toolName} started`);
  }
);

// Subscribe to all events
activityStream.subscribe('*', (event) => {
  console.log(`Event: ${event.type}`, event.data);
});

// Unsubscribe when done
unsubscribe();
```

## Implemented Tools

### BashTool

Executes shell commands with streaming output and security validation.

**Features:**
- Real-time output streaming via TOOL_OUTPUT_CHUNK events
- Timeout support (default: 5s, max: 60s)
- Security validation (blocks dangerous commands)
- Working directory support
- Exit code tracking

**Function Definition:**
```typescript
{
  name: 'bash',
  parameters: {
    command: string,      // Required: Shell command
    description?: string, // Optional: Brief description (5-10 words)
    timeout?: number,     // Optional: Timeout in seconds
    working_dir?: string, // Optional: Working directory
  }
}
```

**Example Usage:**
```typescript
const result = await toolManager.executeTool('bash', {
  command: 'npm test',
  description: 'Run test suite',
  timeout: 30
});

// Result: { success: true, output: '...', error: '...', return_code: 0 }
```

### ReadTool

Reads one or more files with line numbering and token estimation.

**Features:**
- Multi-file support
- Line numbering (6-character width)
- Token estimation (prevents context overflow)
- Binary file detection
- Limit and offset support

**Function Definition:**
```typescript
{
  name: 'read',
  parameters: {
    file_paths: string[],  // Required: Array of file paths
    limit?: number,        // Optional: Max lines per file (0 = all)
    offset?: number,       // Optional: Start line (1-based)
  }
}
```

**Example Usage:**
```typescript
const result = await toolManager.executeTool('read', {
  file_paths: ['src/main.ts', 'package.json'],
  limit: 50  // First 50 lines of each file
});

// Result: { success: true, content: '=== path ===\n  1\t...', files_read: 2 }
```

## Creating a New Tool

### 1. Define Tool Class

```typescript
import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';

export class MyTool extends BaseTool {
  readonly name = 'my_tool';
  readonly description = 'What my tool does';
  readonly requiresConfirmation = false;  // true for destructive ops

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  // Optional: Provide custom function definition
  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            param1: {
              type: 'string',
              description: 'Description of param1',
            },
          },
          required: ['param1'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    // 1. Capture parameters for error context
    this.captureParams(args);

    // 2. Validate parameters
    if (!args.param1) {
      return this.formatErrorResponse(
        'param1 is required',
        'validation_error',
        'Example: my_tool(param1="value")'
      );
    }

    // 3. Execute tool logic
    try {
      const result = await this.performOperation(args.param1);

      // 4. Return success response
      return this.formatSuccessResponse({
        result: result,
      });
    } catch (error) {
      // 5. Return error response
      return this.formatErrorResponse(
        error instanceof Error ? error.message : String(error),
        'system_error'
      );
    }
  }

  private async performOperation(param: string): Promise<string> {
    // Tool-specific logic here
    return 'success';
  }

  // Optional: Custom result preview
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    return [`Result: ${result.result}`];
  }
}
```

### 2. Register with ToolManager

```typescript
import { MyTool } from './MyTool.js';

const activityStream = new ActivityStream();
const tools = [
  new BashTool(activityStream),
  new ReadTool(activityStream),
  new MyTool(activityStream),  // Add your tool
];

const toolManager = new ToolManager(tools, activityStream);
```

### 3. Test Your Tool

```typescript
import { describe, it, expect, beforeEach } from '@jest/globals';
import { MyTool } from './MyTool.js';
import { ActivityStream } from '../services/ActivityStream.js';

describe('MyTool', () => {
  let activityStream: ActivityStream;
  let tool: MyTool;

  beforeEach(() => {
    activityStream = new ActivityStream();
    tool = new MyTool(activityStream);
  });

  it('should execute with valid parameters', async () => {
    const result = await tool.execute({ param1: 'test' });
    expect(result.success).toBe(true);
  });

  it('should require param1', async () => {
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('param1 is required');
  });
});
```

## Tool Result Format

All tools must return a `ToolResult` with at least:

```typescript
interface ToolResult {
  success: boolean;      // Whether tool execution succeeded
  error: string;         // Error message (empty string if success)
  error_type?: string;   // Optional: 'validation_error', 'system_error', etc.
  suggestion?: string;   // Optional: Suggestion for fixing error
  [key: string]: any;    // Tool-specific fields
}
```

### Success Response

```typescript
return this.formatSuccessResponse({
  result: 'operation completed',
  data: processedData,
  count: 42,
});

// Returns:
{
  success: true,
  error: '',
  result: 'operation completed',
  data: processedData,
  count: 42,
}
```

### Error Response

```typescript
return this.formatErrorResponse(
  'File not found',
  'user_error',
  'Check the file path and try again'
);

// Returns:
{
  success: false,
  error: 'my_tool(param1="value"): File not found',
  error_type: 'user_error',
  suggestion: 'Check the file path and try again',
}
```

### Error Types

- **validation_error**: Invalid parameters or usage
- **user_error**: User-facing errors (file not found, etc.)
- **system_error**: Internal errors or exceptions
- **permission_error**: Access denied
- **security_error**: Security violation detected

## Streaming Output

For tools that produce output incrementally (like bash), emit chunks:

```typescript
protected async executeImpl(args: any): Promise<ToolResult> {
  const callId = generateId();

  // Emit output as it becomes available
  this.emitOutputChunk(callId, 'Processing...\n');
  await someAsyncOperation();
  this.emitOutputChunk(callId, 'Done!\n');

  return this.formatSuccessResponse({ ... });
}
```

UI components can subscribe to `TOOL_OUTPUT_CHUNK` events to display real-time output.

## Best Practices

### 1. Always Capture Parameters
```typescript
protected async executeImpl(args: any): Promise<ToolResult> {
  this.captureParams(args);  // First line of executeImpl
  // ...
}
```

### 2. Validate Early
```typescript
if (!args.required_param) {
  return this.formatErrorResponse('required_param is required', 'validation_error');
}
```

### 3. Use Specific Error Types
```typescript
// Good
return this.formatErrorResponse('File not found', 'user_error');

// Bad
return this.formatErrorResponse('Error', 'general');
```

### 4. Provide Helpful Suggestions
```typescript
return this.formatErrorResponse(
  'Invalid pattern syntax',
  'validation_error',
  'Use a valid regex pattern like "class.*Test"'
);
```

### 5. Emit Events for Long Operations
```typescript
// For operations > 1 second, emit progress chunks
this.emitOutputChunk(callId, 'Searching 1000 files...\n');
```

### 6. Override Result Preview
```typescript
getResultPreview(result: ToolResult, maxLines: number): string[] {
  // Provide concise, useful preview for UI
  return [`Found ${result.count} matches`];
}
```

## Testing Guidelines

### Unit Tests
- Test basic tool execution
- Test parameter validation
- Test error handling
- Test custom function definitions

### Integration Tests
- Test tool registration with ToolManager
- Test event emission
- Test result format

### Example Test Structure
```typescript
describe('MyTool', () => {
  describe('basic properties', () => {
    it('should have correct name', () => { ... });
    it('should have function definition', () => { ... });
  });

  describe('execute', () => {
    it('should execute with valid args', async () => { ... });
    it('should require parameters', async () => { ... });
    it('should handle errors', async () => { ... });
  });

  describe('getResultPreview', () => {
    it('should show preview', async () => { ... });
  });
});
```

## Future Enhancements

- **WriteTool**: Create or overwrite files
- **EditTool**: Make find-and-replace edits
- **GrepTool**: Search files for patterns
- **GlobTool**: Find files by glob pattern
- **AgentTool**: Delegate to sub-agents
- **Validation Schemas**: Zod integration for runtime validation
- **Permission System**: User confirmation for destructive operations
- **Undo System**: Patch management for file modifications

## References

- Python Implementation: `/Users/bhm128/code-ally/code_ally/tools/`
- Documentation: `/Users/bhm128/code-ally/docs/implementation_description/TOOL_SYSTEM_DOCUMENTATION.md`
- Architecture: `/Users/bhm128/code-ally/docs/INK_ARCHITECTURE_DESIGN.md`
