# Code Ally UI Foundation

This directory contains the foundation for Code Ally's Ink/React-based terminal UI. The foundation provides the core architecture for building interactive terminal interfaces with proper state management and event handling.

## Architecture Overview

The UI system is built on three layers:

1. **Contexts** - Global state management via React Context
2. **Hooks** - Reusable logic for common UI patterns
3. **Components** - Visual elements that compose the interface

### Foundation Components (Completed)

#### Contexts (`/contexts`)

- **ActivityContext.tsx** - Provides ActivityStream to components
  - Enables event-driven architecture
  - Allows components to subscribe to tool calls, agent activity, errors
  - Supports scoped streams for nested agents

- **AppContext.tsx** - Global application state
  - Message history management
  - Configuration state
  - Context usage tracking
  - Active tool call tracking
  - Actions for state updates

#### Hooks (`/hooks`)

- **useActivityStream.ts** - Access ActivityStream from context
  - Re-export of context hook with cleaner name

- **useActivityEvent.ts** - Subscribe to specific event types
  - Automatic cleanup on unmount
  - Dependency tracking
  - Type-safe event subscriptions

- **useToolState.ts** - Track individual tool call state
  - Status tracking (pending → executing → success/error)
  - Output accumulation
  - Error handling
  - Duration calculation

- **useAnimation.ts** - Animation timing and state
  - Elapsed time tracking
  - Start/stop/reset controls
  - Frame-based animations (requestAnimationFrame)
  - Configurable update intervals

#### Root Component (`/App.tsx`)

- **App** - Main application entry point
  - Sets up all context providers
  - Manages global state
  - Subscribes to activity events
  - Coordinates UI rendering

- **AppWithMessages** - App with pre-populated messages
  - Useful for testing and development

## Usage

### Basic Setup

```tsx
import { render } from 'ink';
import { App } from './ui/App.js';
import { ActivityStream } from './services/ActivityStream.js';

// Get configuration
const config = await configManager.getConfig();

// Create activity stream
const activityStream = new ActivityStream();

// Render the app
const { unmount } = render(
  <App config={config} activityStream={activityStream} />
);
```

### Using Hooks in Components

```tsx
import { useActivityEvent } from '../hooks/useActivityEvent.js';
import { useToolState } from '../hooks/useToolState.js';
import { useAnimation } from '../hooks/useAnimation.js';
import { ActivityEventType } from '../../types/index.js';

const MyComponent: React.FC<{ toolCallId: string }> = ({ toolCallId }) => {
  // Track tool state
  const toolState = useToolState(toolCallId);

  // Track elapsed time
  const animation = useAnimation({ autoStart: true });

  // Subscribe to specific events
  useActivityEvent(ActivityEventType.TOOL_CALL_START, (event) => {
    console.log('Tool started:', event.data.toolName);
  });

  return (
    <Box>
      <Text>Status: {toolState.status}</Text>
      <Text>Elapsed: {animation.elapsedSeconds}s</Text>
    </Box>
  );
};
```

### Using App Context

```tsx
import { useAppContext } from '../contexts/AppContext.js';

const MyComponent: React.FC = () => {
  const { state, actions } = useAppContext();

  // Access state
  console.log('Messages:', state.messages.length);
  console.log('Context usage:', state.contextUsage);

  // Update state
  const handleAddMessage = () => {
    actions.addMessage({
      role: 'user',
      content: 'Hello!',
    });
  };

  return (
    <Box>
      <Text>Messages: {state.messages.length}</Text>
      <Text>Active tools: {state.activeToolCallsCount}</Text>
    </Box>
  );
};
```

## Event Flow

The foundation implements an event-driven architecture:

1. **Tool Execution**
   ```
   ToolManager.execute()
   → ActivityStream.emit(TOOL_CALL_START)
   → Components subscribed via useActivityEvent update
   → useToolState hook updates status
   → UI re-renders automatically
   ```

2. **State Updates**
   ```
   User action
   → actions.addMessage() / actions.setContextUsage()
   → Context state updates
   → All components using useAppContext re-render
   ```

3. **Animation Updates**
   ```
   useAnimation({ autoStart: true })
   → setInterval updates elapsed time
   → Component re-renders with new time
   → Smooth 1-second intervals
   ```

## Integration with Existing Services

The foundation integrates seamlessly with existing Code Ally services:

- **ActivityStream** - Event system for tool/agent activity
- **ServiceRegistry** - Dependency injection container
- **ConfigManager** - Configuration management

Example integration:

```tsx
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { ConfigManager } from '../services/ConfigManager.js';
import { ActivityStream } from '../services/ActivityStream.js';

// Get services
const registry = ServiceRegistry.getInstance();
const configManager = registry.getRequired('config', ConfigManager);
const activityStream = registry.getRequired('activityStream', ActivityStream);

// Get config
const config = configManager.getConfig();

// Render with real services
render(<App config={config} activityStream={activityStream} />);
```

## Component Development Guidelines

When building new components on this foundation:

1. **Use Context Wisely**
   - Access ActivityStream via `useActivityStream()`
   - Access app state via `useAppContext()`
   - Don't prop-drill these values

2. **Subscribe to Events**
   - Use `useActivityEvent()` for activity subscriptions
   - Always provide dependency arrays
   - Cleanup is automatic

3. **Track Tool State**
   - Use `useToolState(toolCallId)` for individual tools
   - Don't manually track status/output/errors
   - Hook handles all updates automatically

4. **Animations**
   - Use `useAnimation()` for time tracking
   - Use `useFrameAnimation()` for smooth visual animations
   - Both handle cleanup automatically

5. **State Updates**
   - Use `actions` from `useAppContext()` to update state
   - Never mutate state directly
   - State updates trigger re-renders automatically

## Examples

See `/examples/BasicExample.tsx` for:
- Basic app setup
- Custom components using hooks
- Activity event simulation
- Tool state monitoring
- Event logging

## Next Steps

With this foundation in place, other agents can now build:

1. **Visual Components** (`/components`)
   - ConversationView (message display)
   - ToolGroupMessage (concurrent tool display)
   - ToolMessage (individual tool status)
   - InputPrompt (user input)
   - StatusLine (context/token info)
   - ThinkingIndicator (animations)

2. **Advanced Features**
   - Streaming response display
   - Nested agent visualization
   - Diff previews
   - History navigation
   - Todo list display

## Architecture Benefits

This foundation provides:

- ✅ **Type Safety** - Full TypeScript support
- ✅ **Event-Driven** - Decoupled components via ActivityStream
- ✅ **State Management** - Centralized via React Context
- ✅ **Reusable Logic** - Custom hooks for common patterns
- ✅ **Automatic Cleanup** - Hooks handle subscription cleanup
- ✅ **Performance** - Only affected components re-render
- ✅ **Testable** - Pure functions and isolated state
- ✅ **Extensible** - Easy to add new components/hooks

## Files Created

```
src/ui/
├── contexts/
│   ├── ActivityContext.tsx    ✅ Event stream provider
│   └── AppContext.tsx          ✅ Global state provider
├── hooks/
│   ├── useActivityStream.ts   ✅ Access event stream
│   ├── useActivityEvent.ts    ✅ Subscribe to events
│   ├── useToolState.ts        ✅ Track tool execution
│   └── useAnimation.ts        ✅ Animation timing
├── examples/
│   └── BasicExample.tsx       ✅ Usage examples
├── App.tsx                    ✅ Root component
├── index.ts                   ✅ Public API exports
└── README.md                  ✅ This file
```

## Questions or Issues

None at this time. The foundation is complete and ready for component development.

## References

- Architecture: `/docs/INK_ARCHITECTURE_DESIGN.md`
- UI System: `/docs/implementation_description/UI_SYSTEM_DOCUMENTATION.md`
- Types: `/src/types/index.ts`
- ActivityStream: `/src/services/ActivityStream.ts`
