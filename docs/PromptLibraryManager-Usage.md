# PromptLibraryManager Usage Guide

## Overview

The `PromptLibraryManager` is a service that manages a user's saved prompt library. Prompts are stored in `~/.ally/prompts/library.json` and can be organized with tags.

## Basic Usage

### Getting the Manager Instance

```typescript
import { ServiceRegistry } from './services/ServiceRegistry.js';

// Get the manager from the service registry
const registry = ServiceRegistry.getInstance();
const promptLibraryManager = registry.getPromptLibraryManager();
```

### Adding a Prompt

```typescript
// Add a simple prompt
const prompt = await promptLibraryManager.addPrompt(
  'Code Review Checklist',
  'Review the following code for:\n- Code style\n- Security issues\n- Performance\n- Best practices'
);

console.log('Created prompt:', prompt.id);

// Add a prompt with tags
const taggedPrompt = await promptLibraryManager.addPrompt(
  'TypeScript Refactoring',
  'Refactor this code to use modern TypeScript features...',
  ['typescript', 'refactoring', 'coding']
);
```

### Getting All Prompts

```typescript
// Get all prompts (sorted by creation time, newest first)
const allPrompts = await promptLibraryManager.getPrompts();

for (const prompt of allPrompts) {
  console.log(`${prompt.title} (${prompt.tags?.join(', ') || 'no tags'})`);
  console.log(`  Created: ${new Date(prompt.createdAt).toLocaleDateString()}`);
}
```

### Getting a Specific Prompt

```typescript
// Get by ID
const prompt = await promptLibraryManager.getPrompt('some-uuid-here');

if (prompt) {
  console.log('Title:', prompt.title);
  console.log('Content:', prompt.content);
  console.log('Tags:', prompt.tags);
}
```

### Searching Prompts

```typescript
// Search by title or tags (case-insensitive)
const results = await promptLibraryManager.searchPrompts('typescript');

console.log(`Found ${results.length} prompts matching "typescript"`);

// Get prompts by specific tag
const codingPrompts = await promptLibraryManager.getPromptsByTag('coding');
```

### Updating a Prompt

```typescript
// Update prompt title, content, or tags
const updated = await promptLibraryManager.updatePrompt(prompt.id, {
  title: 'Updated Title',
  tags: ['new', 'tags'],
});

// Partial updates work too
await promptLibraryManager.updatePrompt(prompt.id, {
  content: 'New content only',
});
```

### Deleting a Prompt

```typescript
// Delete by ID
try {
  await promptLibraryManager.deletePrompt(prompt.id);
  console.log('Prompt deleted successfully');
} catch (error) {
  console.error('Prompt not found:', error.message);
}
```

### Working with Tags

```typescript
// Get all unique tags in the library
const allTags = await promptLibraryManager.getAllTags();

console.log('Available tags:', allTags);

// Get all prompts with a specific tag
const reviewPrompts = await promptLibraryManager.getPromptsByTag('review');
```

## Data Structure

### PromptInfo Interface

```typescript
interface PromptInfo {
  id: string;              // Unique UUID
  title: string;           // User-provided title
  content: string;         // The actual prompt text
  createdAt: number;       // Timestamp (milliseconds since epoch)
  tags?: string[];         // Optional tags for organization
}
```

## Storage

- **Location**: `~/.ally/prompts/library.json`
- **Format**: JSON with 2-space indentation
- **Atomic Writes**: Uses temp file + rename to prevent corruption
- **Automatic Directory Creation**: The `prompts` directory is created on initialization

## Example: Complete Workflow

```typescript
import { ServiceRegistry } from './services/ServiceRegistry.js';

async function managePrompts() {
  const registry = ServiceRegistry.getInstance();
  const manager = registry.getPromptLibraryManager();

  // Add some prompts
  await manager.addPrompt(
    'Bug Fix Template',
    'Fix the following bug:\n\n1. Reproduce the issue\n2. Identify root cause\n3. Implement fix\n4. Add tests',
    ['debugging', 'template']
  );

  await manager.addPrompt(
    'Feature Implementation',
    'Implement the following feature:\n\n- Requirements\n- Design\n- Implementation\n- Testing',
    ['feature', 'template']
  );

  // Search for templates
  const templates = await manager.searchPrompts('template');
  console.log(`Found ${templates.length} templates`);

  // Get all tags
  const tags = await manager.getAllTags();
  console.log('Available tags:', tags);

  // Update a prompt
  if (templates[0]) {
    await manager.updatePrompt(templates[0].id, {
      tags: ['template', 'debugging', 'workflow'],
    });
  }

  // List all prompts
  const allPrompts = await manager.getPrompts();
  for (const prompt of allPrompts) {
    console.log(`\n${prompt.title}`);
    console.log(`Tags: ${prompt.tags?.join(', ') || 'none'}`);
    console.log(`Created: ${new Date(prompt.createdAt).toLocaleString()}`);
  }
}

managePrompts().catch(console.error);
```

## Important Notes

1. **Sequential Operations**: For best results, perform operations sequentially rather than concurrently. Each operation loads the entire library, modifies it, and saves it back.

2. **Error Handling**: Methods like `deletePrompt` and `updatePrompt` throw errors if the prompt is not found. Use try-catch blocks for proper error handling.

3. **Automatic Initialization**: The directory is created automatically when the manager is initialized. No manual setup required.

4. **ID Generation**: Prompt IDs are UUIDs generated automatically. Don't try to create custom IDs.

5. **Tag Normalization**: Tags are trimmed of whitespace and empty tags are filtered out automatically.

## Integration with Service Registry

The PromptLibraryManager is registered in the service registry during app initialization:

```typescript
// In src/cli.ts
const { PromptLibraryManager } = await import('./services/PromptLibraryManager.js');
const promptLibraryManager = new PromptLibraryManager();
await promptLibraryManager.initialize();
registry.setPromptLibraryManager(promptLibraryManager);
```

Access it anywhere in the application:

```typescript
const registry = ServiceRegistry.getInstance();
const manager = registry.getPromptLibraryManager();
```
