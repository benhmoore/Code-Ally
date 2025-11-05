# Code Ally Service Layer

This directory contains the complete service layer infrastructure for Code Ally's TypeScript/Ink port. The implementation follows the architecture outlined in the documentation and provides dependency injection, configuration management, and path resolution services.

## Architecture Overview

The service layer uses a dependency injection pattern with centralized service registry to manage all application services. Key principles:

- **Singleton Service Registry**: Global registry accessed via `ServiceRegistry.getInstance()`
- **Service Lifecycles**: Three types - Singleton, Transient, Scoped
- **Lazy Loading**: Services created on-demand when first requested
- **Dependency Injection**: Automatic resolution of service dependencies
- **Type Safety**: Full TypeScript type safety with generics

## Core Components

### ServiceRegistry

Main dependency injection container managing all services.

```typescript
import { ServiceRegistry } from './services';

const registry = ServiceRegistry.getInstance();

// Register a singleton service
registry.registerSingleton('my_service', MyService);

// Register with dependencies
registry.registerSingleton(
  'dependent_service',
  DependentService,
  undefined,
  { dependency: 'my_service' }
);

// Register direct instance
const instance = new MyService();
registry.registerInstance('my_service', instance);

// Retrieve service
const service = registry.get<MyService>('my_service');

// Retrieve required service (throws if not found)
const required = registry.getRequired<MyService>('my_service');
```

**Features:**
- Singleton and transient lifecycles
- Automatic dependency resolution
- IService lifecycle management (initialize/cleanup)
- Scoped registries for isolated contexts

### ConfigManager

Configuration management with loading, saving, validation, and runtime modification.

```typescript
import { ConfigManager } from './services';

const config = new ConfigManager();
await config.initialize();

// Get configuration values
const temperature = config.getValue('temperature');
const model = config.getValue('model');

// Set configuration values (validates and saves)
await config.setValue('temperature', 0.7);

// Set multiple values at once
await config.setValues({
  temperature: 0.8,
  model: 'qwen2.5-coder:32b',
});

// Reset to defaults
const changes = await config.reset();

// Import/export configuration
const json = config.exportConfig();
await config.importConfig(json);
```

**Features:**
- Automatic type validation and coercion
- Persistent storage to `~/.ally/config.json`
- Default configuration values
- Runtime modification with instant saves
- Import/export functionality

### PathResolver

Centralized path resolution with optional focus awareness.

```typescript
import { resolvePath, resolvePaths, getPathResolver } from './services';

// Resolve single path
const absolute = resolvePath('~/project/file.txt');

// Resolve multiple paths
const paths = resolvePaths(['~/file1.txt', './file2.txt']);

// Advanced usage with focus manager
const resolver = getPathResolver();
const isInFocus = resolver.isInFocus('/path/to/check');
const focusDir = resolver.getFocusDirectory();
```

**Features:**
- Tilde expansion (`~` → home directory)
- Relative to absolute path conversion
- Optional focus-aware resolution (integrates with FocusManager)
- Batch path resolution
- Graceful fallback on errors

### ActivityStream

Event-driven system for tool calls, agents, and thoughts.

```typescript
import { ActivityStream, ActivityEventType } from './services';

const stream = new ActivityStream();

// Subscribe to events
const unsubscribe = stream.subscribe(
  ActivityEventType.TOOL_CALL_START,
  (event) => {
    console.log('Tool call started:', event.data);
  }
);

// Emit events
stream.emit({
  id: 'unique-id',
  type: ActivityEventType.TOOL_CALL_START,
  timestamp: Date.now(),
  data: { toolName: 'bash', arguments: { command: 'ls' } },
});

// Create scoped stream for nested agents
const scoped = stream.createScoped('parent-id');
```

**Features:**
- Event subscription/emission
- Wildcard listeners (subscribe to all events)
- Scoped streams for nested contexts
- Type-safe event types
- Automatic parent ID tracking

## Configuration System

### Default Configuration

Located in `/src/config/defaults.ts`:

```typescript
import { DEFAULT_CONFIG, CONFIG_TYPES, validateConfigValue } from '../config';

// Access default values
console.log(DEFAULT_CONFIG.temperature); // 0.3

// Validate configuration value
const result = validateConfigValue('temperature', 0.7);
if (result.valid) {
  console.log('Valid:', result.coercedValue);
}
```

### Path Constants

Located in `/src/config/paths.ts`:

```typescript
import {
  ALLY_HOME,
  CONFIG_FILE,
  AGENTS_DIR,
  ensureDirectories,
} from '../config';

// Use path constants
console.log('Config file:', CONFIG_FILE); // ~/.ally/config.json
console.log('Agents:', AGENTS_DIR); // ~/.ally/agents

// Ensure all directories exist
await ensureDirectories();
```

## Service Lifecycle

### IService Interface

Services can implement `IService` for lifecycle management:

```typescript
import { IService } from '../types';

class MyService implements IService {
  async initialize(): Promise<void> {
    // Called once after service creation
    console.log('Service initializing...');
  }

  async cleanup(): Promise<void> {
    // Called during shutdown
    console.log('Service cleaning up...');
  }
}
```

### Scoped Registries

For isolated contexts (e.g., sub-agents):

```typescript
import { ScopedServiceRegistryProxy } from './services';

const baseRegistry = ServiceRegistry.getInstance();
const scoped = new ScopedServiceRegistryProxy(baseRegistry);

// Register local overrides
scoped.registerInstance('ui_manager', customUI);

// Falls back to base registry for non-overridden services
const config = scoped.get('config_manager'); // From base
const ui = scoped.get('ui_manager'); // From scoped override
```

## Testing

All services have comprehensive unit tests in `__tests__/`:

```bash
# Run all service tests
npm test src/services/__tests__/

# Run specific test file
npm test src/services/__tests__/ConfigManager.test.ts

# Watch mode
npm test src/services/__tests__/ -- --watch
```

**Test Coverage:**
- ConfigManager: 26 tests covering loading, saving, validation, import/export
- ServiceRegistry: 30 tests covering registration, retrieval, lifecycles, scoped proxies
- PathResolver: 20 tests covering resolution, focus awareness, edge cases

## File Structure

```
src/services/
├── ServiceRegistry.ts          # DI container and descriptors
├── ConfigManager.ts            # Configuration management
├── PathResolver.ts             # Path resolution service
├── ActivityStream.ts           # Event system
├── index.ts                    # Exports
├── README.md                   # This file
└── __tests__/
    ├── ServiceRegistry.test.ts
    ├── ConfigManager.test.ts
    └── PathResolver.test.ts

src/config/
├── defaults.ts                 # Default config and validation
├── paths.ts                    # Path constants
└── index.ts                    # Exports
```

## Usage Examples

### Basic Application Setup

```typescript
import { ServiceRegistry, ConfigManager } from './services';

async function setupServices() {
  const registry = ServiceRegistry.getInstance();

  // Register config manager
  const config = new ConfigManager();
  await config.initialize();
  registry.registerInstance('config_manager', config);

  // Register other services with dependencies
  registry.registerSingleton('llm_client', OllamaClient, () => {
    const config = registry.get<ConfigManager>('config_manager')!;
    return new OllamaClient({
      endpoint: config.getValue('endpoint'),
      temperature: config.getValue('temperature'),
    });
  });

  return registry;
}
```

### Service with Dependencies

```typescript
class TokenManager {
  constructor(
    private config: ConfigManager,
    private activityStream: ActivityStream
  ) {}

  getContextSize(): number {
    return this.config.getValue('context_size');
  }
}

// Register with dependency injection
registry.registerSingleton(
  'token_manager',
  TokenManager,
  undefined,
  {
    config: 'config_manager',
    activityStream: 'activity_stream',
  }
);
```

## Architectural Decisions

### 1. TypeScript Throughout

Using TypeScript with strict mode for maximum type safety. All services are fully typed with generic support.

### 2. Async/Await by Default

Service lifecycle methods (`initialize`, `cleanup`) are async to support future async operations without breaking changes.

### 3. Module-Level vs. Class Singletons

- `ServiceRegistry`: Class-level singleton via `getInstance()`
- `PathResolver`: Module-level singleton via `getPathResolver()`
- Both approaches are valid; we use whichever is more ergonomic

### 4. Immutable Configuration Returns

`getConfig()` returns a readonly copy to prevent accidental mutations. Use `setValue()` for modifications.

### 5. Graceful Degradation

Services like `PathResolver` gracefully fall back to standard behavior when optional dependencies (like `FocusManager`) aren't available.

## Migration from Python

Key differences from the Python implementation:

1. **ES Modules**: Using `import/export` instead of Python imports
2. **Async/Await**: All I/O operations are async (file reading, initialization)
3. **Map vs Dict**: Using `Map<string, T>` for service storage
4. **Type Safety**: Full TypeScript type checking vs. Python's gradual typing
5. **Path Handling**: Using Node.js `path` module instead of `pathlib`

## Future Enhancements

Potential improvements:

- [ ] Service registration via decorators
- [ ] Automatic service discovery
- [ ] Configuration schema validation with Zod
- [ ] Hot-reloading of configuration changes
- [ ] Service health checks
- [ ] Performance monitoring/metrics

## Contributing

When adding new services:

1. Implement the service class
2. Optionally implement `IService` for lifecycle management
3. Add comprehensive unit tests
4. Document public APIs with JSDoc comments
5. Update this README with usage examples

## Related Documentation

- [SERVICE_CONFIGURATION_INFRASTRUCTURE.md](/docs/implementation_description/SERVICE_CONFIGURATION_INFRASTRUCTURE.md)
- [INK_ARCHITECTURE_DESIGN.md](/docs/INK_ARCHITECTURE_DESIGN.md)
