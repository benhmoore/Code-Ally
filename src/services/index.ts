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
