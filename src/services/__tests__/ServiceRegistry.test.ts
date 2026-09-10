/**
 * ServiceRegistry unit tests
 *
 * Tests dependency injection, lifecycle management, and scoped registries
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ServiceRegistry,
  ServiceDescriptor,
  ScopedServiceRegistryProxy,
} from '../ServiceRegistry.js';
import { ServiceLifecycle, IService } from '@shared/index.js';

// Test service classes
class SimpleService {
  value = 'simple';
}

class ServiceWithDependency {
  constructor(public dependency: SimpleService) {}
}

class ServiceImplementingIService implements IService {
  initialized = false;
  cleaned = false;

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async cleanup(): Promise<void> {
    this.cleaned = true;
  }
}

describe('ServiceRegistry', () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    // Create a fresh registry for each test
    ServiceRegistry['_instance'] = undefined;
    registry = ServiceRegistry.getInstance();
    // Clear any existing services
    registry['_services'].clear();
    registry['_descriptors'].clear();
  });

  describe('singleton pattern', () => {
    it('should return the same instance', () => {
      const instance1 = ServiceRegistry.getInstance();
      const instance2 = ServiceRegistry.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('registerInstance', () => {
    it('should register a direct instance', () => {
      const service = new SimpleService();
      registry.registerInstance('simple', service);

      const retrieved = registry.get('simple');
      expect(retrieved).toBe(service);
    });

    it('should support method chaining', () => {
      const service1 = new SimpleService();
      const service2 = new SimpleService();

      const result = registry
        .registerInstance('service1', service1)
        .registerInstance('service2', service2);

      expect(result).toBe(registry);
      expect(registry.hasService('service1')).toBe(true);
      expect(registry.hasService('service2')).toBe(true);
    });
  });

  describe('registerSingleton', () => {
    it('should register a singleton service', () => {
      registry.registerSingleton('simple', SimpleService);

      const instance1 = registry.get('simple');
      const instance2 = registry.get('simple');

      expect(instance1).toBeInstanceOf(SimpleService);
      expect(instance1).toBe(instance2); // Same instance
    });

    it('should support custom factory', () => {
      registry.registerSingleton(
        'simple',
        SimpleService,
        () => {
          const service = new SimpleService();
          service.value = 'custom';
          return service;
        }
      );

      const instance = registry.get('simple');
      expect(instance?.value).toBe('custom');
    });

    it('should resolve dependencies', () => {
      registry.registerSingleton('simple', SimpleService);
      registry.registerSingleton('dependent', ServiceWithDependency, undefined, {
        dependency: 'simple',
      });

      const dependent = registry.get('dependent');
      expect(dependent).toBeInstanceOf(ServiceWithDependency);
      expect(dependent?.dependency).toBeInstanceOf(SimpleService);
    });

    it('should call initialize on IService implementations', async () => {
      registry.registerSingleton('service', ServiceImplementingIService);

      // Wait a bit for async initialize to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      const service = registry.get('service');
      expect(service?.initialized).toBe(true);
    });
  });

  describe('registerTransient', () => {
    it('should create new instance each time', () => {
      registry.registerTransient('simple', SimpleService);

      const instance1 = registry.get('simple');
      const instance2 = registry.get('simple');

      expect(instance1).toBeInstanceOf(SimpleService);
      expect(instance2).toBeInstanceOf(SimpleService);
      expect(instance1).not.toBe(instance2); // Different instances
    });
  });

  describe('get', () => {
    it('should return null for non-existent services', () => {
      const service = registry.get('nonexistent');
      expect(service).toBe(null);
    });

    it('should return direct instances first', () => {
      const directInstance = new SimpleService();
      directInstance.value = 'direct';

      registry.registerInstance('simple', directInstance);
      registry.registerSingleton('simple', SimpleService); // This should be ignored

      const retrieved = registry.get('simple');
      expect(retrieved?.value).toBe('direct');
    });
  });

  describe('getRequired', () => {
    it('should return service if exists', () => {
      const service = new SimpleService();
      registry.registerInstance('simple', service);

      const retrieved = registry.getRequired('simple');
      expect(retrieved).toBe(service);
    });

    it('should throw if service not found', () => {
      expect(() => registry.getRequired('nonexistent')).toThrow();
    });
  });

  describe('hasService', () => {
    it('should return true for existing services', () => {
      registry.registerInstance('simple', new SimpleService());
      expect(registry.hasService('simple')).toBe(true);
    });

    it('should return true for registered descriptors', () => {
      registry.registerSingleton('simple', SimpleService);
      expect(registry.hasService('simple')).toBe(true);
    });

    it('should return false for non-existent services', () => {
      expect(registry.hasService('nonexistent')).toBe(false);
    });
  });

  describe('shutdown', () => {
    it('waits for initialization before cleaning an owner, including direct aliases', async () => {
      let finish!: () => void;
      const service = new ServiceImplementingIService();
      vi.spyOn(service, 'initialize').mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
      const cleanup = vi.spyOn(service, 'cleanup');
      registry.registerSingleton('initializing', ServiceImplementingIService, () => service);
      registry.get('initializing');
      registry.registerInstance('alias', service);
      const pending = registry.shutdown();
      await Promise.resolve();
      expect(cleanup).not.toHaveBeenCalled();
      finish();
      await pending;
      expect(cleanup).toHaveBeenCalledOnce();
    });

    it('cleans partial resources even if initialization failed and surfaces the failure', async () => {
      const service = new ServiceImplementingIService();
      vi.spyOn(service, 'initialize').mockRejectedValue(new Error('initialization failed'));
      const cleanup = vi.spyOn(service, 'cleanup');
      registry.registerSingleton('initializing', ServiceImplementingIService, () => service);
      registry.get('initializing');
      await expect(registry.shutdown()).rejects.toThrow('Service registry cleanup failed');
      expect(cleanup).toHaveBeenCalledOnce();
    });

    it('should call cleanup on IService implementations', async () => {
      const service = new ServiceImplementingIService();
      registry.registerInstance('service', service);

      await registry.shutdown();

      expect(service.cleaned).toBe(true);
    });

    it('should clear all services', async () => {
      registry.registerInstance('service1', new SimpleService());
      registry.registerSingleton('service2', SimpleService);

      await registry.shutdown();

      expect(registry.hasService('service1')).toBe(false);
      expect(registry.hasService('service2')).toBe(false);
    });

    it('retains failed cleanup and rejects rather than reporting success', async () => {
      const brokenService = {
        async initialize() {},
        async cleanup() {
          throw new Error('Cleanup failed');
        },
      };

      registry.registerInstance('broken', brokenService);
      const cleanup = vi.spyOn(brokenService, 'cleanup');
      const pending = registry.shutdown();
      await expect(pending).rejects.toThrow('Service registry cleanup failed');
      expect(registry.hasService('broken')).toBe(true);
      expect(registry.shutdown()).toBe(pending);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(() => registry.registerInstance('another', {})).toThrow('cleanup failed');
    });

    it('cleans aliased resource owners once and shares concurrent shutdown', async () => {
      const service = new ServiceImplementingIService();
      const cleanup = vi.spyOn(service, 'cleanup');
      registry.registerInstance('first', service);
      registry.registerInstance('second', service);
      const pending = registry.shutdown();
      expect(registry.shutdown()).toBe(pending);
      await pending;
      expect(cleanup).toHaveBeenCalledOnce();
    });

    it('does not forget slow cleanup or admit new resources during its drain', async () => {
      vi.useFakeTimers();
      let finish!: () => void;
      registry.registerCleanup('slow', () => new Promise<void>(resolve => { finish = resolve; }));
      registry.registerSingleton('uncreated', SimpleService);
      let settled = false;
      const pending = registry.shutdown().then(() => { settled = true; });
      try {
        await vi.advanceTimersByTimeAsync(6000);
        expect(settled).toBe(false);
        expect(() => registry.registerCleanup('late', async () => {})).toThrow('shutting down');
        expect(() => registry.get('uncreated')).toThrow('during shutdown');
        finish();
        await pending;
        expect(vi.getTimerCount()).toBe(0);
      } finally { finish?.(); vi.useRealTimers(); }
    });
  });

  describe('ServiceDescriptor', () => {
    it('should create instance with no dependencies', () => {
      const descriptor = new ServiceDescriptor(SimpleService);
      const instance = descriptor.createInstance(registry);

      expect(instance).toBeInstanceOf(SimpleService);
    });

    it('should cache singleton instances', () => {
      const descriptor = new ServiceDescriptor(
        SimpleService,
        undefined,
        ServiceLifecycle.SINGLETON
      );

      const instance1 = descriptor.createInstance(registry);
      const instance2 = descriptor.createInstance(registry);

      expect(instance1).toBe(instance2);
    });

    it('should not cache transient instances', () => {
      const descriptor = new ServiceDescriptor(
        SimpleService,
        undefined,
        ServiceLifecycle.TRANSIENT
      );

      const instance1 = descriptor.createInstance(registry);
      const instance2 = descriptor.createInstance(registry);

      expect(instance1).not.toBe(instance2);
    });

    it('should throw on missing dependency', () => {
      registry.registerSingleton('dependent', ServiceWithDependency, undefined, {
        dependency: 'nonexistent',
      });

      expect(() => registry.get('dependent')).toThrow();
    });
  });

  describe('ScopedServiceRegistryProxy', () => {
    let baseRegistry: ServiceRegistry;
    let scopedRegistry: ScopedServiceRegistryProxy;

    beforeEach(() => {
      baseRegistry = ServiceRegistry.getInstance();
      baseRegistry['_services'].clear();
      baseRegistry['_descriptors'].clear();
      scopedRegistry = new ScopedServiceRegistryProxy(baseRegistry);
    });

    it('should register local overrides', () => {
      const service = new SimpleService();
      scopedRegistry.registerInstance('simple', service);

      expect(scopedRegistry.get('simple')).toBe(service);
    });

    it('should fall back to base registry', () => {
      const baseService = new SimpleService();
      baseRegistry.registerInstance('base', baseService);

      expect(scopedRegistry.get('base')).toBe(baseService);
    });

    it('should prioritize local overrides', () => {
      const baseService = new SimpleService();
      const scopedService = new SimpleService();
      scopedService.value = 'scoped';

      baseRegistry.registerInstance('simple', baseService);
      scopedRegistry.registerInstance('simple', scopedService);

      expect(scopedRegistry.get('simple')).toBe(scopedService);
      expect(baseRegistry.get('simple')).toBe(baseService);
    });

    it('should support getRequired', () => {
      const service = new SimpleService();
      scopedRegistry.registerInstance('simple', service);

      expect(scopedRegistry.getRequired('simple')).toBe(service);
    });

    it('should throw on required service not found', () => {
      expect(() => scopedRegistry.getRequired('nonexistent')).toThrow();
    });

    it('should check both local and base in hasService', () => {
      baseRegistry.registerInstance('base', new SimpleService());
      scopedRegistry.registerInstance('scoped', new SimpleService());

      expect(scopedRegistry.hasService('base')).toBe(true);
      expect(scopedRegistry.hasService('scoped')).toBe(true);
      expect(scopedRegistry.hasService('nonexistent')).toBe(false);
    });

    it('should clear local overrides', () => {
      const scopedService = new SimpleService();
      scopedRegistry.registerInstance('scoped', scopedService);

      expect(scopedRegistry.hasService('scoped')).toBe(true);

      scopedRegistry.clear();

      expect(scopedRegistry.hasService('scoped')).toBe(false);
    });

    it('should not affect base registry on clear', () => {
      const baseService = new SimpleService();
      const scopedService = new SimpleService();

      baseRegistry.registerInstance('base', baseService);
      scopedRegistry.registerInstance('scoped', scopedService);

      scopedRegistry.clear();

      expect(scopedRegistry.hasService('base')).toBe(true);
      expect(scopedRegistry.hasService('scoped')).toBe(false);
    });
  });
});
