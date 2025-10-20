# Model Change - Immediate Application Fix

## Problem
Model changes via `/model` command required app restart to take effect. The issue:
- ConfigManager was updated with new model name
- But the active Agent's ModelClient still used the old model
- Next LLM request would use stale model name

## Root Cause
`OllamaClient` had a `readonly _modelName` property set at construction. When config changed, the ModelClient instance wasn't updated.

## Solution

### 1. **Made ModelClient Support Runtime Model Changes**
**File**: `src/llm/ModelClient.ts`

Added optional `setModelName()` method to interface:
```typescript
abstract setModelName?(newModelName: string): void;
```

### 2. **Implemented setModelName in OllamaClient**
**File**: `src/llm/OllamaClient.ts`

- Changed `_modelName` from `readonly` to mutable
- Added `setModelName()` method:
```typescript
setModelName(newModelName: string): void {
  console.log(`[OLLAMA_CLIENT] Changing model from ${this._modelName} to ${newModelName}`);
  this._modelName = newModelName;
}
```

### 3. **Updated Direct Model Change**
**File**: `src/agent/CommandHandler.ts:316-320`

When user types `/model <name>`:
```typescript
// Update config
await this.configManager.setValue('model', modelName);

// Update active ModelClient immediately
const modelClient = this.serviceRegistry.get<any>('model_client');
if (modelClient && typeof modelClient.setModelName === 'function') {
  modelClient.setModelName(modelName);
}
```

### 4. **Updated Interactive Selector**
**File**: `src/ui/App.tsx:253-263`

When user selects model from interactive menu:
```typescript
// Update config
await configManager.setValue('model', modelName);

// Update active ModelClient to use new model
const modelClient = registry.get<any>('model_client');
if (modelClient && typeof modelClient.setModelName === 'function') {
  modelClient.setModelName(modelName);
}

// Update UI state
actions.setConfig({ ...state.config, model: modelName });
```

## Result

✅ Model changes apply **immediately**
✅ Next LLM request uses the new model
✅ No app restart required
✅ Works for both direct (`/model llama2`) and interactive (`/model`) modes

## Technical Details

**Flow**:
1. User changes model via `/model`
2. ConfigManager persists new model to disk
3. ModelClient.setModelName() updates in-memory model name
4. UI state updated to show new model
5. Next agent request uses new model

**Thread Safety**:
- Model change happens synchronously
- No race conditions with ongoing requests (they use old model)
- New requests pick up new model immediately
