# Cancellation System Gaps - Analysis

## Problem Statement
Users report entering fully blocking states where:
- Cannot press Escape to exit permission prompts
- Cannot use keyboard to navigate
- UI becomes completely unresponsive

## Root Cause Analysis

### Gap 1: **No Escape Key Handler for Permission Prompts** ❌ CRITICAL
**Location**: `src/ui/components/InputPrompt.tsx:322-374`

**Issue**: When a permission prompt is active, the keyboard handler supports:
- Up/Down arrows → navigate options
- Enter → confirm selection
- Ctrl+C → deny permission

BUT the **Escape key is not handled**! The general Escape handler (lines 421-428) is unreachable because the permission prompt section returns early (line 373).

**Impact**: User cannot press Escape to dismiss permission prompts.

**Fix**: Add Escape handler in permission prompt section:
```typescript
// Escape - deny permission and close prompt
if (key.escape) {
  activityStream.emit({
    id: `response_${permissionRequest.requestId}_escape`,
    type: ActivityEventType.PERMISSION_RESPONSE,
    timestamp: Date.now(),
    data: {
      requestId: permissionRequest.requestId,
      choice: PermissionChoice.DENY,
    },
  });
  return;
}
```

---

### Gap 2: **ActivityStream Dependency Creates Deadlock** ❌ CRITICAL
**Location**: `src/ui/components/InputPrompt.tsx:323`

**Issue**: Permission handling checks:
```typescript
if (permissionRequest && onPermissionNavigate && activityStream) {
  // Handle permission navigation...
}
// Block all other input
return;
```

If `activityStream` is undefined when `permissionRequest` is active:
- Permission navigation is skipped
- BUT all other input is still blocked (line 372-373)
- User has NO WAY to interact with UI

**Impact**: Complete UI deadlock if activityStream is undefined.

**Fix**: Add fallback or make activityStream required:
```typescript
if (permissionRequest) {
  if (!activityStream || !onPermissionNavigate) {
    // CRITICAL ERROR - log and allow force quit
    console.error('[InputPrompt] Permission prompt active but activityStream/onPermissionNavigate missing!');
    if (key.ctrl && input === 'c') {
      exit(); // Force quit
    }
    return;
  }
  // ... rest of permission handling
}
```

---

### Gap 3: **No Timeout on Permission Wait** ❌ HIGH
**Location**: `src/agent/TrustManager.ts` showPermissionMenu()

**Issue**: Permission requests wait indefinitely:
```typescript
private async showPermissionMenu(...): Promise<PermissionChoice> {
  return new Promise((resolve, reject) => {
    this.pendingPermissions.set(requestId, { resolve, reject });
    this.activityStream!.emit({ /* permission request */ });
    // Waits forever for response...
  });
}
```

If PERMISSION_RESPONSE event never fires (event system failure, UI crash, etc.), this Promise hangs forever.

**Impact**: Permanent blocking - no timeout or fallback.

**Fix**: Add 30-second timeout:
```typescript
return new Promise((resolve, reject) => {
  const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  // Set timeout
  const timeout = setTimeout(() => {
    this.pendingPermissions.delete(requestId);
    reject(new PermissionDeniedError('Permission request timed out after 30 seconds'));
  }, 30000);

  this.pendingPermissions.set(requestId, {
    resolve: (choice) => {
      clearTimeout(timeout);
      resolve(choice);
    },
    reject: (error) => {
      clearTimeout(timeout);
      reject(error);
    }
  });

  this.activityStream!.emit({ /* ... */ });
});
```

---

### Gap 4: **Permission Response Can Fail Silently** ⚠️ MEDIUM
**Location**: `src/ui/components/InputPrompt.tsx:344-354`

**Issue**: Event emission has no error handling:
```typescript
activityStream.emit({
  id: `response_${permissionRequest.requestId}`,
  type: ActivityEventType.PERMISSION_RESPONSE,
  // ...
});
```

If `emit()` throws or fails:
- Permission prompt stays active
- TrustManager keeps waiting
- User is stuck

**Impact**: Blocking state if event emission fails.

**Fix**: Add try-catch and fallback:
```typescript
try {
  activityStream.emit({ /* ... */ });
} catch (error) {
  console.error('[InputPrompt] Failed to emit permission response:', error);
  // Clear local state as fallback
  setPermissionRequest(undefined);
}
```

---

### Gap 5: **Agent.isProcessing() Race Condition** ⚠️ LOW
**Location**: `src/ui/components/InputPrompt.tsx:449`

**Issue**: Ctrl+C handler:
```typescript
if (agent && agent.isProcessing()) {
  agent.interrupt();
  return;
}
```

Race condition scenario:
1. Agent finishes processing (`requestInProgress = false`)
2. Permission prompt is still waiting for user input
3. User presses Ctrl+C
4. Interrupt branch is skipped (not processing)
5. Permission handler executes instead

**Impact**: Minor - permission denial still works, but interrupt intent is unclear.

**Fix**: Check permission prompt state first:
```typescript
// Priority 1: Permission prompts (always handle Ctrl+C as deny)
if (permissionRequest && activityStream) {
  // ... deny permission
  return;
}

// Priority 2: Interrupt agent if processing
if (agent && agent.isProcessing()) {
  agent.interrupt();
  return;
}

// Priority 3-4: Clear buffer or quit
// ...
```

---

### Gap 6: **No Force-Quit Mechanism** ⚠️ MEDIUM
**Location**: `src/ui/components/InputPrompt.tsx` Ctrl+C handler

**Issue**: Current Ctrl+C flow:
1. If agent processing → interrupt
2. Else if buffer has content → clear
3. Else → quit

**Missing**: If permission prompt is active and event emission fails, user cannot force quit.

Python version has escalation: multiple Ctrl+C presses → force quit.

**Impact**: No escape if event system is broken.

**Fix**: Add Ctrl+C counter:
```typescript
const [ctrlCCount, setCtrlCCount] = useState(0);
const [ctrlCTimer, setCtrlCTimer] = useState<NodeJS.Timeout | null>(null);

// In Ctrl+C handler:
if (key.ctrl && input === 'c') {
  // Increment counter
  const newCount = ctrlCCount + 1;
  setCtrlCCount(newCount);

  // Reset counter after 1 second
  if (ctrlCTimer) clearTimeout(ctrlCTimer);
  setCtrlCTimer(setTimeout(() => setCtrlCCount(0), 1000));

  // Force quit on 3rd Ctrl+C within 1 second
  if (newCount >= 3) {
    console.log('[InputPrompt] Force quit - 3x Ctrl+C');
    exit();
    return;
  }

  // ... rest of Ctrl+C logic
}
```

---

## Priority Fixes

**Immediate (P0)**:
1. Add Escape handler for permission prompts
2. Add activityStream fallback/force-quit

**High Priority (P1)**:
3. Add timeout to permission wait (30s)
4. Add error handling around event emission

**Medium Priority (P2)**:
5. Add force-quit escalation (3x Ctrl+C)
6. Reorder Ctrl+C handler priorities

---

## Testing Strategy

1. **Permission prompt blocking**:
   - Open permission prompt
   - Disconnect event system
   - Try Escape, Ctrl+C, force quit

2. **ActivityStream undefined**:
   - Set activityStream to undefined
   - Trigger permission prompt
   - Verify force quit works

3. **Timeout**:
   - Open permission prompt
   - Don't respond for 30 seconds
   - Verify auto-denial

4. **Event emission failure**:
   - Mock ActivityStream.emit to throw
   - Trigger permission
   - Verify graceful handling
