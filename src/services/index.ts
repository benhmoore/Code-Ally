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
export { ReadStateManager, ReadRange, FileReadState, ValidationResult } from './ReadStateManager.js';
export { AgentManager, AgentData, AgentInfo } from './AgentManager.js';
export { AgentPoolService, AgentPoolConfig, AgentMetadata, PooledAgent } from './AgentPoolService.js';
export { DelegationContextManager, DelegationContext, DelegationState, ActiveDelegation } from './DelegationContextManager.js';
export { CommandHistory } from './CommandHistory.js';
export { CompletionProvider } from './CompletionProvider.js';
export { FuzzyFilePathMatcher } from './FuzzyFilePathMatcher.js';
export { PatchManager } from './PatchManager.js';
export { PatchValidator } from './PatchValidator.js';
export { PatchFileManager } from './PatchFileManager.js';
export { PatchIndexManager } from './PatchIndexManager.js';
export { PatchCleanupManager } from './PatchCleanupManager.js';
export { BashProcessManager, CircularBuffer } from './BashProcessManager.js';

// Re-export types
export type { CommandHistoryEntry, CommandHistoryOptions } from './CommandHistory.js';
export type { Completion, CompletionType, CompletionContext } from './CompletionProvider.js';
export type { FuzzyMatchResult, FuzzyMatchOptions, MatchType } from './FuzzyFilePathMatcher.js';
export type { PatchManagerConfig, PatchMetadata, UndoResult, UndoPreview, UndoFileEntry } from './PatchManager.js';
export type { DiffStats } from '../utils/diffUtils.js';
export type { PatchIndex } from './PatchValidator.js';
export type { ProcessInfo } from './BashProcessManager.js';

// UI Polish services
export { SyntaxHighlighter } from './SyntaxHighlighter.js';
