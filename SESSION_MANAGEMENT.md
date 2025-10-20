# Session Management System

Complete session persistence and management implementation for Code Ally (TypeScript/Ink port).

## Features

- **Session Persistence**: Full conversation history stored as JSON files
- **Auto-generated Session Names**: Timestamp + UUID format for uniqueness
- **Session Metadata**: Support for titles, tags, and model information
- **Auto-cleanup**: Keeps only N most recent sessions (configurable)
- **Title Generation**: Optional LLM-powered auto-title generation
- **CLI Integration**: Complete command-line support for session operations

## File Structure

```
src/
├── services/
│   ├── SessionManager.ts                  # Core session CRUD operations
│   ├── SessionTitleGenerator.ts           # Auto-title generation
│   └── __tests__/
│       ├── SessionManager.test.ts         # 33 tests (100% pass)
│       └── SessionTitleGenerator.test.ts  # 18 tests (100% pass)
├── types/index.ts                         # Session type definitions
└── cli.ts                                 # CLI integration
```

## API Reference

### SessionManager

```typescript
import { SessionManager } from './services/SessionManager.js';

const manager = new SessionManager({ maxSessions: 10 });
await manager.initialize();

// Create session
const sessionName = await manager.createSession('my-project');

// Load session
const session = await manager.loadSession('my-project');

// Save messages
await manager.saveSession('my-project', messages);

// List all sessions
const sessions = await manager.listSessions();

// Get display info
const info = await manager.getSessionsInfo();

// Delete session
await manager.deleteSession('my-project');

// Current session tracking
manager.setCurrentSession('my-project');
const current = manager.getCurrentSession();

// Metadata management
await manager.updateMetadata('my-project', {
  title: 'Custom Title',
  tags: ['feature', 'bugfix'],
  model: 'qwen2.5-coder:32b'
});
```

### SessionTitleGenerator

```typescript
import { SessionTitleGenerator } from './services/SessionTitleGenerator.js';

const generator = new SessionTitleGenerator(modelClient, {
  maxTokens: 50,
  temperature: 0.3
});

// Generate title from messages
const title = await generator.generateTitle(messages);

// Background generation (non-blocking)
generator.generateTitleBackground(
  sessionName,
  firstUserMessage,
  sessionsDir
);

// Cleanup
await generator.cleanup();
```

## CLI Usage

### Session Commands

```bash
# List all sessions
ally --list-sessions

# Delete a session
ally --delete-session my-project

# Create/resume named session
ally --session my-project

# Single message with session
ally --once "Help me debug this" --session my-project

# Single message with auto-generated session
ally --once "List files in directory"

# Disable session creation
ally --once "Quick question" --no-session

# Resume session interactively
ally --resume
ally --resume my-project
```

### Session Storage

Sessions are stored in `~/.ally/sessions/` as JSON files:

```json
{
  "id": "session_20250120T103045_abc123",
  "name": "my-project",
  "created_at": "2025-01-20T10:30:45.123Z",
  "updated_at": "2025-01-20T11:15:22.456Z",
  "messages": [
    {
      "role": "user",
      "content": "Help me debug this authentication issue"
    },
    {
      "role": "assistant",
      "content": "I'll help you debug that...",
      "tool_calls": [...]
    }
  ],
  "metadata": {
    "title": "Debugging authentication flow",
    "tags": ["auth", "debugging"],
    "model": "qwen2.5-coder:32b"
  }
}
```

## Type Definitions

```typescript
// Session with full metadata
interface Session {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  messages: Message[];
  metadata?: SessionMetadata;
}

// Session metadata
interface SessionMetadata {
  title?: string;
  tags?: string[];
  model?: string;
}

// Display information
interface SessionInfo {
  session_id: string;
  display_name: string;  // Title or first message snippet
  last_modified: string;
  message_count: number;
}
```

## Test Coverage

### SessionManager Tests (33 tests)

- ✓ Initialization and directory creation
- ✓ Session name generation (unique timestamps)
- ✓ Create session (auto-generated and custom names)
- ✓ Load session (existing and non-existent)
- ✓ Save session (new and existing)
- ✓ Session existence checks
- ✓ List sessions (empty, multiple, sorted)
- ✓ Delete sessions
- ✓ Current session tracking
- ✓ Get session messages
- ✓ Get session info for display
- ✓ Display name logic (title > first message > placeholder)
- ✓ Message truncation for display
- ✓ Metadata updates (merge and override)
- ✓ Auto-cleanup of old sessions
- ✓ Error handling (corrupted JSON, missing files)

### SessionTitleGenerator Tests (18 tests)

- ✓ Generate title from messages
- ✓ Default title for empty messages
- ✓ Quote cleanup
- ✓ Length truncation
- ✓ Error handling with fallback
- ✓ Fallback to first message
- ✓ Whitespace cleanup
- ✓ Background title generation
- ✓ Prevent duplicate generations
- ✓ Handle missing session files
- ✓ Skip existing titles
- ✓ Cleanup with timeout
- ✓ Configuration acceptance

## Integration Notes

### CLI Integration

The CLI (`src/cli.ts`) already includes:

1. `handleSessionCommands()` - Processes `--list-sessions` and `--delete-session`
2. `handleOnceMode()` - Single message mode with session support
3. Session manager initialization and registration in ServiceRegistry
4. Auto-generated session names when `--session` not specified

### ArgumentParser

All session flags are defined in `src/cli/ArgumentParser.ts`:

- `--session <name>` - Resume or create named session
- `--once <message>` - Single message mode
- `--list-sessions` - List all sessions
- `--delete-session <name>` - Delete a session
- `--no-session` - Disable session persistence
- `--resume [session]` - Resume session (interactive or named)

## Implementation Details

### Auto-cleanup Behavior

- Configured via `maxSessions` (default: 10)
- Cleanup runs after every session creation/save
- Keeps N most recently modified sessions
- Uses file system modification times for sorting

### Session Name Format

Auto-generated names: `session_YYYYMMDDTHHMMSS_<8-char-uuid>`

Example: `session_20250120T103045_abc123de`

### Title Generation

- Triggered on first user message
- Runs in background (non-blocking)
- Uses low temperature (0.3) for deterministic results
- Fallback to first 40 chars of message if LLM fails
- Won't overwrite existing titles

### Display Name Logic

1. Use `metadata.title` if present
2. Otherwise, use first 40 chars of first user message
3. If no messages, use "(no messages)"

### Error Handling

- Corrupted JSON files return `null` (graceful degradation)
- Missing files handled with appropriate error codes
- Background operations catch and log errors
- Test coverage includes error scenarios

## Future Enhancements

Potential additions (not yet implemented):

1. **Session Search**: Full-text search across messages
2. **Session Export**: Export to Markdown or other formats
3. **Session Merging**: Combine multiple sessions
4. **Session Tags**: Filter and organize by tags
5. **Session Analytics**: Stats on usage patterns
6. **Session Sharing**: Export/import for collaboration
7. **Session Encryption**: Secure sensitive conversations

## Testing

Run session tests:

```bash
# All session tests
npm test -- src/services/__tests__/Session --run

# SessionManager only
npm test -- src/services/__tests__/SessionManager.test.ts --run

# SessionTitleGenerator only
npm test -- src/services/__tests__/SessionTitleGenerator.test.ts --run
```

Results:
- **51 total tests**
- **100% pass rate**
- **~6 second execution time**

## Migration from Python

This implementation is fully compatible with the Python version's session format:

- Same JSON structure
- Same directory location (`~/.ally/sessions/`)
- Same naming conventions
- Same metadata fields

Sessions can be used interchangeably between Python and TypeScript versions.
