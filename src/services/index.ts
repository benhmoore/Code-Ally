/**
 * Services module exports
 *
 * Centralized export point for all service layer components
 */

// Core services
export { ServiceRegistry, ServiceDescriptor, ScopedServiceRegistryProxy } from './ServiceRegistry.js';
export { ActivityStream, globalActivityStream } from './ActivityStream.js';
export { ConfigManager } from './ConfigManager.js';
export { PathResolver, getPathResolver, resolvePath, resolvePaths } from './PathResolver.js';

// Advanced services
export { TodoManager, TodoItem } from './TodoManager.js';
export { FocusManager, FocusResult } from './FocusManager.js';
export { AgentManager, AgentData, AgentInfo } from './AgentManager.js';
export { CommandHistory } from './CommandHistory.js';
export { CompletionProvider } from './CompletionProvider.js';

// Re-export types
export type { CommandHistoryEntry, CommandHistoryOptions } from './CommandHistory.js';
export type { Completion, CompletionType, CompletionContext } from './CompletionProvider.js';

// UI Polish services
export { SyntaxHighlighter } from './SyntaxHighlighter.js';
