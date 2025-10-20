# TrustManager Implementation Summary

## Overview

The TrustManager is a TypeScript implementation of the permission and security system from the Python CodeAlly project. It handles user confirmations for potentially destructive tool operations with a focus on security and usability.

## Trust Scopes

The system supports four trust scopes:

### 1. **ONCE** (Single Operation)
- Default when user selects "Allow"
- Permission granted for one operation only
- Implemented via pre-approved operations set

### 2. **SESSION** (Current Session)
- Granted when user selects "Always Allow"
- Trust persists for the current process
- Cleared on application exit
- Represented internally by `'*'` in trusted tools

### 3. **PATH** (File/Directory Specific)
- Trust granted for specific file or directory
- Can be extended to parent directory trust
- Currently implements exact path matching

### 4. **GLOBAL** (All Contexts)
- Same as SESSION in current implementation
- Represented by `'*'` wildcard
- Cleared on exit (no persistence across sessions)

## Permission Flow

```typescript
checkPermission(toolName, args, path)
  ↓
  1. Auto-confirm enabled? → Return true
  2. Tool already trusted? → Return true
  3. Operation pre-approved? → Return true
  4. Else → Prompt user
     ↓
     Determine sensitivity tier:
     - NORMAL: Full menu (Allow, Deny, Always Allow)
     - SENSITIVE: Full menu (Allow, Deny, Always Allow)
     - EXTREMELY_SENSITIVE: Limited menu (Allow, Deny)
     ↓
     User selects:
     - Allow → Mark as pre-approved, return true
     - Always Allow → Add to trusted tools, return true
     - Deny → Throw PermissionDeniedError
```

## Sensitive Command Lists

### Extremely Sensitive Commands (114 entries)

**Characteristics:**
- Disable "Always Allow" option
- Require explicit user confirmation every time
- Include system destruction, privilege escalation, remote code execution

**Examples:**
- `rm -rf /` - System destruction
- `sudo su` - Privilege escalation
- `curl | bash` - Remote code execution
- `dd if=/dev/zero` - Disk wiping
- Fork bombs, shutdown commands, etc.

### Extremely Sensitive Patterns (18 regex patterns)

**Characteristics:**
- Detect dangerous patterns even if command text varies
- Multi-file deletions, wildcards, pipe to shell, etc.

**Examples:**
- `rm.*\*` - Deletion with wildcards
- `curl.*\|.*bash` - Piping to shell
- `sudo (su|bash|sh)` - Privilege escalation
- `/.*\*` - Absolute paths with wildcards

### Sensitive Patterns (9 regex patterns)

**Characteristics:**
- Allow "Always Allow" option
- Single-file operations or outside-CWD access

**Examples:**
- `ls /` - List files outside CWD
- `cat ../` - Access parent directory
- `rm single_file.txt` - Single file deletion

### Sensitive Command Prefixes (32 prefixes)

**Characteristics:**
- Quick prefix matching for common sensitive commands
- Allow "Always Allow" option

**Examples:**
- `sudo ` - Privileged execution
- `rm -r` - Recursive deletion
- `ssh ` - Remote access
- `wget ` - Network download

## Key Methods

### `checkPermission(toolName, args, path): Promise<boolean>`

Main entry point for permission checks. Returns true if allowed, throws `PermissionDeniedError` if denied.

**Flow:**
1. Check auto-confirm mode
2. Check if tool is trusted
3. Prompt user if needed

### `promptForPermission(toolName, args, path): Promise<boolean>`

Shows interactive keyboard-navigated menu to user.

**Features:**
- Rich terminal UI with box drawing
- Arrow key navigation (↑/↓)
- Enter to select
- Ctrl+C to cancel
- Context-aware message display

### `promptForBatchOperations(toolCalls): Promise<boolean>`

Handles batch permission requests for multiple tools.

**Features:**
- Shows all operations in batch
- Single prompt for all operations
- Pre-approves all tools if granted
- Returns false instead of throwing (graceful failure)

### `isTrusted(toolName, path): boolean`

Checks if tool is already trusted without prompting.

**Check Order:**
1. Pre-approved operations (highest priority)
2. Global trust (`'*'` in trusted paths)
3. Path-specific trust (exact match)
4. Parent directory trust (TODO: future enhancement)

### `trustTool(toolName, scope, path): void`

Marks a tool as trusted for the specified scope.

**Scopes:**
- `GLOBAL/SESSION`: Add `'*'` to trusted paths
- `PATH`: Add specific path to trusted paths
- `ONCE`: Don't add to trusted tools (use pre-approval instead)

### `isSensitiveCommand(command): boolean`

Quick check for bash command sensitivity.

**Returns:** True if command requires confirmation.

### `reset(): void`

Clears all session trust and pre-approved operations.

**Use Cases:**
- Session end
- Testing/debugging
- Security reset

## Permission UI Design

### Single Tool Prompt

```
┌────────────────────────────────────────────┐
│  🔐 PERMISSION REQUIRED                    │
│                                             │
│  You are about to execute:                 │
│                                             │
│  rm important_file.txt                     │
│                                             │
└────────────────────────────────────────────┘

Use arrow keys to navigate, Enter to select:

> Allow
  Deny
  Always Allow
```

### Batch Operations Prompt

```
🔐 Batch Permission Required

The following operations will be executed:
  1. write
  2. edit
  3. bash

Use arrow keys to navigate, Enter to select:

> Allow
  Deny
  Always Allow
```

### Extremely Sensitive Command

```
┌────────────────────────────────────────────┐
│  🔐 PERMISSION REQUIRED                    │
│                                             │
│  You are about to execute:                 │
│                                             │
│  rm -rf /tmp/*                             │
│                                             │
└────────────────────────────────────────────┘

Use arrow keys to navigate, Enter to select:

> Allow
  Deny
```

**Note:** No "Always Allow" option for extremely sensitive commands.

## Integration Points

### With ToolManager

```typescript
// In ToolManager.executeImpl():
if (tool.requiresConfirmation) {
  await trustManager.checkPermission(toolName, args, path);
}
```

### With Bash Tool

```typescript
// In BashTool.executeImpl():
const tier = trustManager.getCommandSensitivity('bash', { command });
if (tier !== SensitivityTier.NORMAL) {
  await trustManager.checkPermission('bash', { command }, { command });
}
```

### With BaseTool

```typescript
// BaseTool defines:
abstract readonly requiresConfirmation: boolean;

// Tools set this based on their destructive nature:
// - ReadTool: requiresConfirmation = false
// - WriteTool: requiresConfirmation = true
// - BashTool: requiresConfirmation = true (context-dependent)
```

## Security Considerations

### Session-Based Trust Only

- **No Persistence:** Trust is never saved to disk
- **Cleared on Exit:** All trust cleared when process ends
- **No Global Configuration:** No ~/.config trust files

**Rationale:** Prevents long-term security holes from "Always Allow" selections.

### Sensitivity Tiers

- **NORMAL:** No restrictions, full menu
- **SENSITIVE:** Require confirmation, allow "Always Allow"
- **EXTREMELY_SENSITIVE:** Require confirmation every time, no "Always Allow"

**Rationale:** Prevents accidental system damage from cached permissions.

### Auto-Confirm Mode

- **Dangerous:** Bypasses all permission checks
- **Use Cases:** Scripting, automated testing, CI/CD
- **Warning:** Should never be used in interactive mode

### Outside-CWD Detection

- **Context Flag:** `outside_cwd: true` in permission path
- **Effect:** Escalates to EXTREMELY_SENSITIVE tier
- **Rationale:** Prevents accidental file access outside project directory

## Testing Scenarios

### Basic Permission Flow

```typescript
const tm = new TrustManager(false);

// Should prompt user
await tm.checkPermission('write', { file_path: 'test.txt' });

// Should trust after "Always Allow"
tm.trustTool('write', TrustScope.GLOBAL);
await tm.checkPermission('write', { file_path: 'other.txt' }); // No prompt
```

### Batch Operations

```typescript
const tm = new TrustManager(false);

const calls = [
  { function: { name: 'write', arguments: {} } },
  { function: { name: 'edit', arguments: {} } },
];

// Should show batch prompt
await tm.promptForBatchOperations(calls);

// All operations pre-approved
await tm.checkPermission('write', {}); // No prompt
await tm.checkPermission('edit', {}); // No prompt
```

### Sensitivity Detection

```typescript
const tm = new TrustManager(false);

// Normal command
const tier1 = tm.getCommandSensitivity('bash', { command: 'ls -la' });
// → SensitivityTier.NORMAL

// Sensitive command
const tier2 = tm.getCommandSensitivity('bash', { command: 'rm file.txt' });
// → SensitivityTier.SENSITIVE

// Extremely sensitive command
const tier3 = tm.getCommandSensitivity('bash', { command: 'rm -rf *' });
// → SensitivityTier.EXTREMELY_SENSITIVE
```

## Future Enhancements

### Path Trust Hierarchy

Currently implements exact path matching. Could add:
- Parent directory trust (trust `/path/to/` grants trust to `/path/to/file.txt`)
- Subdirectory trust (trust `/path/to/` grants trust to `/path/to/sub/file.txt`)

### Persistent Trust Configuration

Could add optional trust persistence:
- Per-project `.trust.json` configuration
- Global `~/.code-ally/trust.json` configuration
- Explicit opt-in required (security consideration)

### Trust Expiration

Could add time-based trust expiration:
- Session trust expires after N minutes
- Path trust expires after file modification
- Configurable expiration policies

### Command Whitelisting

Could add safe command whitelisting:
- Pre-approved safe commands (e.g., `git status`)
- User-configurable whitelist
- Pattern-based safe commands

## Known Limitations

### TTY Requirement

The keyboard navigation menu requires a TTY. In non-TTY environments:
- Falls back to simple prompts
- Arrow keys don't work
- Enter still required

**Solution:** Use auto-confirm mode for CI/CD.

### Windows Compatibility

The terminal control sequences are POSIX-based:
- May not work correctly on Windows
- Readline behavior may differ

**Solution:** Test on Windows, add platform-specific handling if needed.

### Concurrent Permissions

Currently not designed for concurrent permission prompts:
- Sequential tool execution works fine
- Concurrent batch operations work fine
- Multiple simultaneous prompts may conflict

**Solution:** Queue permission prompts if needed (future enhancement).

## Questions and Considerations

### 1. Should we add path normalization?

Currently uses raw paths from tools. Should we:
- Normalize to absolute paths?
- Resolve symlinks?
- Handle case sensitivity?

**Recommendation:** Add path normalization for consistency.

### 2. Should we support regex-based trust patterns?

Allow users to trust based on patterns like:
- `*.txt` - All text files
- `/tmp/*` - All temp files

**Recommendation:** Add in future version with careful security review.

### 3. Should we add audit logging?

Track all permission decisions for security review:
- Log all prompts and user choices
- Log trusted tools and scopes
- Timestamped audit trail

**Recommendation:** Add as optional feature with privacy considerations.

### 4. Should we support non-interactive environments?

Add support for environment variables like:
- `ALLY_AUTO_CONFIRM=1` - Auto-confirm all
- `ALLY_TRUST_CONFIG=/path/to/trust.json` - Load trust config

**Recommendation:** Add for CI/CD use cases.

## References

- **Python Implementation:** `/Users/bhm128/CodeAlly/code_ally/trust.py`
- **Security Documentation:** `/Users/bhm128/code-ally/docs/implementation_description/SECURITY_TRUST_DOCUMENTATION.md`
- **Agent Documentation:** `/Users/bhm128/code-ally/docs/implementation_description/AGENT_SYSTEM_DOCUMENTATION.md`
