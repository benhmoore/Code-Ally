# Tool Argument Validation Examples

This document provides examples of the enhanced argument validation system implemented in `ToolValidator.ts`.

## Overview

The validation system catches invalid arguments BEFORE tool execution, providing clear error messages and suggestions for fixing them. This improves the user experience by failing fast and guiding the LLM toward correct usage.

## Validation Rules by Tool

### ReadTool

**Rules:**
- `limit` must be >= 0 (0 means all lines)
- `offset` must be >= 0 (1-based line numbers)

**Example Error Messages:**

```json
// Invalid: negative limit
{
  "success": false,
  "error": "limit must be a non-negative number",
  "error_type": "validation_error",
  "suggestion": "Example: limit=100 (or 0 for all lines)"
}
```

### BashTool

**Rules:**
- `timeout` must be > 0 and <= 600 seconds
- `command` cannot be empty
- `command` cannot exceed 10000 characters

**Example Error Messages:**

```json
// Invalid: timeout too large
{
  "success": false,
  "error": "timeout cannot exceed 600 seconds (10 minutes)",
  "error_type": "validation_error",
  "suggestion": "Maximum timeout is 600 seconds"
}

// Invalid: empty command
{
  "success": false,
  "error": "command cannot be empty",
  "error_type": "validation_error",
  "suggestion": "Example: command=\"ls -la\""
}
```

### GrepTool

**Rules:**
- `pattern` must be a valid regex
- Context line parameters (`-A`, `-B`, `-C`) must be >= 0 and <= 20

**Example Error Messages:**

```json
// Invalid: malformed regex
{
  "success": false,
  "error": "Invalid regex pattern: Unterminated character class",
  "error_type": "validation_error",
  "suggestion": "Use simpler patterns or escape special characters like . * + ? [ ] ( ) { } | \\"
}

// Invalid: too many context lines
{
  "success": false,
  "error": "-C cannot exceed 20 (max context lines)",
  "error_type": "validation_error",
  "suggestion": "Maximum context is 20 lines"
}
```

### WriteTool / EditTool / LineEditTool

**Rules:**
- `file_path` must be within the current working directory (security check)

**Example Error Messages:**

```json
// Invalid: path outside CWD
{
  "success": false,
  "error": "Path is outside the current working directory",
  "error_type": "security_error",
  "suggestion": "File paths must be within the current working directory. Use relative paths like \"src/file.ts\""
}
```

### LineEditTool (Additional Rules)

**Rules:**
- `line_number` must be >= 1 (1-indexed)
- `line_number` must be <= 1000000 (sanity check)
- `num_lines` must be >= 1 for delete operations

**Example Error Messages:**

```json
// Invalid: line_number < 1
{
  "success": false,
  "error": "line_number must be >= 1 (line numbers are 1-indexed)",
  "error_type": "validation_error",
  "suggestion": "Line numbers are 1-indexed. Example: line_number=10"
}

// Invalid: unreasonably large line number
{
  "success": false,
  "error": "line_number is unreasonably large (max 1000000)",
  "error_type": "validation_error",
  "suggestion": "Check that line_number is correct"
}
```

### AgentTool

**Rules:**
- `task_prompt` cannot be empty (after trimming)
- `task_prompt` cannot exceed 50000 characters

**Example Error Messages:**

```json
// Invalid: empty task prompt
{
  "success": false,
  "error": "task_prompt cannot be empty",
  "error_type": "validation_error",
  "suggestion": "Provide a clear task description for the agent"
}

// Invalid: task prompt too long
{
  "success": false,
  "error": "task_prompt is too long (max 50000 characters)",
  "error_type": "validation_error",
  "suggestion": "Break down into smaller tasks or provide a more concise prompt"
}
```

## Integration Point

Validation is automatically called in `ToolManager.executeTool()` before tool execution:

```typescript
// Line 266 in ToolManager.ts
const validation = this.validator.validateArguments(tool, functionDef, args);
if (!validation.valid) {
  return {
    success: false,
    error: validation.error!,
    error_type: validation.error_type,
    suggestion: validation.suggestion,
  };
}
```

## Benefits

1. **Fail Fast**: Catches errors before expensive operations (file I/O, subprocess spawning)
2. **Clear Errors**: Provides specific error messages with examples
3. **Security**: Validates paths are within CWD before filesystem operations
4. **Better UX**: Guides the LLM toward correct usage patterns
5. **Type Safety**: Combines TypeScript type checking with runtime value validation

## Adding New Validation Rules

To add validation for a new tool:

1. Add an entry to the `VALIDATION_RULES` Map in `ToolValidator.ts`:
   ```typescript
   ['new_tool', ToolValidator.validateNewToolArgs]
   ```

2. Implement the validation method:
   ```typescript
   private static validateNewToolArgs(args: Record<string, any>): ValidationResult {
     // Check specific constraints
     if (args.some_param < 0) {
       return {
         valid: false,
         error: 'some_param must be positive',
         error_type: 'validation_error',
         suggestion: 'Example: some_param=10',
       };
     }
     return { valid: true };
   }
   ```

3. Write tests in `ToolValidator.test.ts` to verify the validation works correctly.
