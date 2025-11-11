/**
 * ServiceRegistry - Dependency injection container
 *
 * Manages all application services with lifecycle management and dependency resolution.
 * Ported from Python implementation with TypeScript improvements.
 */

import { ServiceLifecycle, IService } from '../types/index.js';
import type { PluginActivationManager } from '../plugins/PluginActivationManager.js';
import { logger } from './Logger.js';

export class ServiceDescriptor<T = unknown> {
  private _instance?: T;
  private _initPromise?: Promise<void>;
  private _initializing: boolean = false;

  constructor(
    public readonly serviceType: new (...args: unknown[]) => T,
    public readonly factory?: () => T,
    public readonly lifecycle: ServiceLifecycle = ServiceLifecycle.SINGLETON,
    public readonly dependencies?: Record<string, string>
  ) {}

  /**
   * Create an instance of the service with dependency injection
   *
   * For services implementing IService, initialization is started but not awaited
   * to maintain backward compatibility. Callers who need to ensure initialization
   * is complete should call ensureInitialized() after getting the instance.
   */
  createInstance(registry: ServiceRegistry): T {
    // Return cached instance if singleton
    if (this.lifecycle === ServiceLifecycle.SINGLETON && this._instance) {
      return this._instance;
    }

    // Resolve dependencies
    const resolvedDeps: unknown[] = [];
    if (this.dependencies) {
      for (const [_paramName, serviceName] of Object.entries(this.dependencies)) {
        const dependency = registry.get(serviceName);
        if (!dependency) {
          throw new Error(
            `Cannot resolve dependency '${serviceName}' for service '${this.serviceType.name}'`
          );
        }
        resolvedDeps.push(dependency);
      }
    }

    // Create instance using factory or constructor
    const instance = this.factory
      ? this.factory()
      : new this.serviceType(...resolvedDeps);

    // Call initialize if service implements IService
    // Track initialization promise to prevent race conditions
    if (this.isIService(instance)) {
      if (!this._initializing && !this._initPromise) {
        this._initializing = true;
        this._initPromise = instance.initialize()
          .catch(error => {
            logger.error(`Error initializing service ${this.serviceType.name}:`, error);
          })
          .finally(() => {
            this._initializing = false;
          });
      }
    }

    // Cache if singleton
    if (this.lifecycle === ServiceLifecycle.SINGLETON) {
      this._instance = instance;
    }

    return instance;
  }

  /**
   * Ensure initialization is complete for this service instance
   * This should be called by consumers who need to ensure the service is ready
   */
  async ensureInitialized(): Promise<void> {
    if (this._initPromise) {
      await this._initPromise;
    }
  }

  private isIService(obj: unknown): obj is IService {
    return (
      typeof obj === 'object' &&
      obj !== null &&
      typeof (obj as IService).initialize === 'function' &&
      typeof (obj as IService).cleanup === 'function'
    );
  }
}

export class ServiceRegistry {
  private static _instance?: ServiceRegistry;

  private _services: Map<string, unknown>;
  private _descriptors: Map<string, ServiceDescriptor<unknown>>;

  private constructor() {
    this._services = new Map();
    this._descriptors = new Map();
  }

  /**
   * Get the singleton instance of the service registry
   */
  static getInstance(): ServiceRegistry {
    if (!ServiceRegistry._instance) {
      ServiceRegistry._instance = new ServiceRegistry();
    }
    return ServiceRegistry._instance;
  }

  /**
   * Register a singleton service (single instance, cached after creation)
   */
  registerSingleton<T = unknown>(
    name: string,
    serviceType: new (...args: unknown[]) => T,
    factory?: () => T,
    dependencies?: Record<string, string>
  ): this {
    const descriptor = new ServiceDescriptor(
      serviceType,
      factory,
      ServiceLifecycle.SINGLETON,
      dependencies
    );
    this._descriptors.set(name, descriptor);
    return this;
  }

  /**
   * Register a transient service (new instance each time)
   */
  registerTransient<T = unknown>(
    name: string,
    serviceType: new (...args: unknown[]) => T,
    factory?: () => T,
    dependencies?: Record<string, string>
  ): this {
    const descriptor = new ServiceDescriptor(
      serviceType,
      factory,
      ServiceLifecycle.TRANSIENT,
      dependencies
    );
    this._descriptors.set(name, descriptor);
    return this;
  }

  /**
   * Register an existing instance as a singleton
   */
  registerInstance<T>(name: string, instance: T): this {
    this._services.set(name, instance);
    return this;
  }

  /**
   * Get a service by name with optional type checking
   *
   * Note: For services implementing IService, initialization starts but is not awaited
   * to maintain backward compatibility. If you need to ensure initialization is complete,
   * use getRequired() or manually call ensureServiceInitialized() after getting the instance.
   */
  get<T = unknown>(name: string, _serviceType?: new (...args: unknown[]) => T): T | null {
    // Check direct instances first
    if (this._services.has(name)) {
      return this._services.get(name) as T;
    }

    // Check descriptors
    if (this._descriptors.has(name)) {
      const descriptor = this._descriptors.get(name)!;
      const instance = descriptor.createInstance(this);
      return instance as T;
    }

    return null;
  }

  /**
   * Ensure a service is fully initialized
   * Call this after get() if you need to guarantee initialization is complete
   */
  async ensureServiceInitialized(name: string): Promise<void> {
    const descriptor = this._descriptors.get(name);
    if (descriptor) {
      await descriptor.ensureInitialized();
    }
  }

  /**
   * Get a required service (throws if not found)
   */
  getRequired<T = unknown>(name: string, _serviceType?: new (...args: unknown[]) => T): T {
    const service = this.get<T>(name);
    if (!service) {
      throw new Error(`Required service '${name}' not found in registry`);
    }
    return service;
  }

  /**
   * Check if a service exists in the registry
   */
  hasService(name: string): boolean {
    return this._services.has(name) || this._descriptors.has(name);
  }

  /**
   * Shutdown all services and cleanup resources
   */
  async shutdown(): Promise<void> {
    // Cleanup IService implementations
    const cleanupPromises: Promise<void>[] = [];

    for (const [name, instance] of this._services.entries()) {
      if (this.isIService(instance)) {
        cleanupPromises.push(
          instance.cleanup().catch(error => {
            logger.error(`Error cleaning up service ${name}:`, error);
          })
        );
      }
    }

    for (const [name, descriptor] of this._descriptors.entries()) {
      if (descriptor['_instance'] && this.isIService(descriptor['_instance'])) {
        cleanupPromises.push(
          descriptor['_instance'].cleanup().catch(error => {
            logger.error(`Error cleaning up service ${name}:`, error);
          })
        );
      }
    }

    await Promise.all(cleanupPromises);

    // Clear all registrations
    this._services.clear();
    this._descriptors.clear();
  }

  private isIService(obj: unknown): obj is IService {
    return (
      typeof obj === 'object' &&
      obj !== null &&
      typeof (obj as IService).initialize === 'function' &&
      typeof (obj as IService).cleanup === 'function'
    );
  }

  /**
   * Set the PluginActivationManager instance
   */
  setPluginActivationManager(manager: PluginActivationManager): void {
    this.registerInstance('plugin_activation_manager', manager);
  }

  /**
   * Get the PluginActivationManager instance
   * @throws Error if not registered
   */
  getPluginActivationManager(): PluginActivationManager {
    const manager = this.get('plugin_activation_manager');
    if (!manager) {
      throw new Error('PluginActivationManager not registered in ServiceRegistry');
    }
    return manager as PluginActivationManager;
  }
}

/**
 * Scoped service registry proxy for isolated contexts (e.g., sub-agents)
 *
 * Provides a scoped view over the global registry with local overrides.
 * Reads fall back to the base registry when no local override exists.
 */
export class ScopedServiceRegistryProxy {
  private _overrides: Map<string, unknown>;

  constructor(private _base: ServiceRegistry) {
    this._overrides = new Map();
  }

  /**
   * Register an instance in the scoped context
   */
  registerInstance<T>(name: string, instance: T): this {
    this._overrides.set(name, instance);
    return this;
  }

  /**
   * Get a service (checks overrides first, then base registry)
   */
  get<T = unknown>(name: string, _serviceType?: new (...args: unknown[]) => T): T | null {
    if (this._overrides.has(name)) {
      return this._overrides.get(name) as T;
    }
    return this._base.get<T>(name);
  }

  /**
   * Get a required service
   */
  getRequired<T = unknown>(name: string, _serviceType?: new (...args: unknown[]) => T): T {
    const service = this.get<T>(name);
    if (!service) {
      throw new Error(`Required service '${name}' not found in scoped registry`);
    }
    return service;
  }

  /**
   * Check if a service exists (checks both overrides and base)
   */
  hasService(name: string): boolean {
    return this._overrides.has(name) || this._base.hasService(name);
  }

  /**
   * Clear all local overrides
   */
  clear(): void {
    this._overrides.clear();
  }
}
