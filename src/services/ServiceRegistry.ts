/**
 * ServiceRegistry - Dependency injection container
 *
 * Manages all application services with lifecycle management and dependency resolution.
 * Ported from Python implementation with TypeScript improvements.
 */

import { ServiceLifecycle, IService } from '../types/index.js';

export class ServiceDescriptor<T> {
  private _instance?: T;

  constructor(
    public readonly serviceType: new (...args: any[]) => T,
    public readonly factory?: () => T,
    public readonly lifecycle: ServiceLifecycle = ServiceLifecycle.SINGLETON,
    public readonly dependencies?: Record<string, string>
  ) {}

  /**
   * Create an instance of the service with dependency injection
   */
  createInstance(registry: ServiceRegistry): T {
    // Return cached instance if singleton
    if (this.lifecycle === ServiceLifecycle.SINGLETON && this._instance) {
      return this._instance;
    }

    // Resolve dependencies
    const resolvedDeps: any[] = [];
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
    if (this.isIService(instance)) {
      instance.initialize().catch(error => {
        console.error(`Error initializing service ${this.serviceType.name}:`, error);
      });
    }

    // Cache if singleton
    if (this.lifecycle === ServiceLifecycle.SINGLETON) {
      this._instance = instance;
    }

    return instance;
  }

  private isIService(obj: any): obj is IService {
    return (
      typeof obj === 'object' &&
      obj !== null &&
      typeof obj.initialize === 'function' &&
      typeof obj.cleanup === 'function'
    );
  }
}

export class ServiceRegistry {
  private static _instance?: ServiceRegistry;

  private _services: Map<string, any>;
  private _descriptors: Map<string, ServiceDescriptor<any>>;

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
  registerSingleton<T>(
    name: string,
    serviceType: new (...args: any[]) => T,
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
  registerTransient<T>(
    name: string,
    serviceType: new (...args: any[]) => T,
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
   */
  get<T>(name: string, _serviceType?: new (...args: any[]) => T): T | null {
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
   * Get a required service (throws if not found)
   */
  getRequired<T>(name: string, _serviceType?: new (...args: any[]) => T): T {
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
            console.error(`Error cleaning up service ${name}:`, error);
          })
        );
      }
    }

    for (const [name, descriptor] of this._descriptors.entries()) {
      if (descriptor['_instance'] && this.isIService(descriptor['_instance'])) {
        cleanupPromises.push(
          descriptor['_instance'].cleanup().catch(error => {
            console.error(`Error cleaning up service ${name}:`, error);
          })
        );
      }
    }

    await Promise.all(cleanupPromises);

    // Clear all registrations
    this._services.clear();
    this._descriptors.clear();
  }

  private isIService(obj: any): obj is IService {
    return (
      typeof obj === 'object' &&
      obj !== null &&
      typeof obj.initialize === 'function' &&
      typeof obj.cleanup === 'function'
    );
  }
}

/**
 * Scoped service registry proxy for isolated contexts (e.g., sub-agents)
 *
 * Provides a scoped view over the global registry with local overrides.
 * Reads fall back to the base registry when no local override exists.
 */
export class ScopedServiceRegistryProxy {
  private _overrides: Map<string, any>;

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
  get<T>(name: string, _serviceType?: new (...args: any[]) => T): T | null {
    if (this._overrides.has(name)) {
      return this._overrides.get(name) as T;
    }
    return this._base.get<T>(name);
  }

  /**
   * Get a required service
   */
  getRequired<T>(name: string, _serviceType?: new (...args: any[]) => T): T {
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
