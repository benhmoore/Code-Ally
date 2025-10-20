/**
 * PathResolver unit tests
 *
 * Tests path resolution with and without focus awareness
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'os';
import { resolve, join } from 'path';
import { PathResolver, getPathResolver } from '../PathResolver.js';
import { ServiceRegistry } from '../ServiceRegistry.js';

describe('PathResolver', () => {
  let pathResolver: PathResolver;

  beforeEach(() => {
    pathResolver = new PathResolver();
  });

  describe('standard resolution', () => {
    it('should resolve absolute paths unchanged', () => {
      const absolutePath = '/usr/local/bin/test';
      expect(pathResolver.resolvePath(absolutePath)).toBe(absolutePath);
    });

    it('should resolve relative paths to absolute', () => {
      const cwd = process.cwd();
      const relativePath = './test/file.txt';
      const expected = resolve(cwd, relativePath);
      expect(pathResolver.resolvePath(relativePath)).toBe(expected);
    });

    it('should expand tilde to home directory', () => {
      const home = homedir();
      expect(pathResolver.resolvePath('~')).toBe(home);
      expect(pathResolver.resolvePath('~/test')).toBe(join(home, 'test'));
      expect(pathResolver.resolvePath('~/test/file.txt')).toBe(
        join(home, 'test', 'file.txt')
      );
    });

    it('should handle empty paths', () => {
      expect(pathResolver.resolvePath('')).toBe('');
    });

    it('should handle current directory', () => {
      const cwd = process.cwd();
      expect(pathResolver.resolvePath('.')).toBe(cwd);
    });

    it('should handle parent directory', () => {
      const cwd = process.cwd();
      const parent = resolve(cwd, '..');
      expect(pathResolver.resolvePath('..')).toBe(parent);
    });

    it('should resolve multiple paths', () => {
      const paths = ['~/test', './file.txt', '/absolute/path'];
      const resolved = pathResolver.resolvePaths(paths);

      expect(resolved.length).toBe(3);
      expect(resolved[0]).toBe(join(homedir(), 'test'));
      expect(resolved[1]).toBe(resolve(process.cwd(), 'file.txt'));
      expect(resolved[2]).toBe('/absolute/path');
    });

    it('should handle empty array', () => {
      const resolved = pathResolver.resolvePaths([]);
      expect(resolved).toEqual([]);
    });
  });

  describe('focus awareness', () => {
    it('should return true for isInFocus when no focus manager', () => {
      expect(pathResolver.isInFocus('/any/path')).toBe(true);
      expect(pathResolver.isInFocus('~/test')).toBe(true);
    });

    it('should return null for getFocusDirectory when no focus manager', () => {
      expect(pathResolver.getFocusDirectory()).toBe(null);
    });

    it('should use focus manager when available', () => {
      // Create a mock focus manager
      const mockFocusManager = {
        resolvePathInFocus: (path: string) => `/focused${path}`,
        getFocusDirectory: () => '/focused',
        isPathInFocus: (path: string) => path.startsWith('/focused'),
      };

      // Register in service registry
      const registry = ServiceRegistry.getInstance();
      registry.registerInstance('focus_manager', mockFocusManager);

      // Reset path resolver to pick up the new focus manager
      pathResolver.resetFocusManager();

      // Test resolution with focus
      const result = pathResolver.resolvePath('/test');
      expect(result).toBe('/focused/test');

      // Test focus checks
      expect(pathResolver.getFocusDirectory()).toBe('/focused');

      // Test isInFocus - it resolves the path first, so we need to check resolved paths
      const resolvedFocused = pathResolver.resolvePath('/focused/file');
      const resolvedOutside = pathResolver.resolvePath('/outside/file');
      expect(pathResolver.isInFocus(resolvedFocused)).toBe(true);
      expect(pathResolver.isInFocus(resolvedOutside)).toBe(true); // Still true because focus manager accepts it

      // Cleanup
      registry['_services'].delete('focus_manager');
    });

    it('should fall back to standard resolution on focus manager error', () => {
      // Create a broken focus manager
      const brokenFocusManager = {
        resolvePathInFocus: () => {
          throw new Error('Focus error');
        },
        getFocusDirectory: () => '/focused',
        isPathInFocus: () => false,
      };

      const registry = ServiceRegistry.getInstance();
      registry.registerInstance('focus_manager', brokenFocusManager);
      pathResolver.resetFocusManager();

      // Should fall back to standard resolution
      const result = pathResolver.resolvePath('~/test');
      expect(result).toBe(join(homedir(), 'test'));

      // Cleanup
      registry['_services'].delete('focus_manager');
    });
  });

  describe('global instance', () => {
    it('should return singleton instance', () => {
      const resolver1 = getPathResolver();
      const resolver2 = getPathResolver();
      expect(resolver1).toBe(resolver2);
    });

    it('should register in service registry', () => {
      // Clear any previous instance
      const registry = ServiceRegistry.getInstance();
      const hadResolver = registry.hasService('path_resolver');

      if (!hadResolver) {
        getPathResolver();
        expect(registry.hasService('path_resolver')).toBe(true);
        // Clean up
        registry['_services'].delete('path_resolver');
      } else {
        // If already registered, that's fine - test the registration functionality
        expect(registry.hasService('path_resolver')).toBe(true);
      }
    });
  });

  describe('edge cases', () => {
    it('should handle paths with spaces', () => {
      const pathWithSpaces = './test folder/file.txt';
      const result = pathResolver.resolvePath(pathWithSpaces);
      expect(result).toContain('test folder');
    });

    it('should handle paths with special characters', () => {
      const specialPath = './test-file_v2.txt';
      const result = pathResolver.resolvePath(specialPath);
      expect(result).toContain('test-file_v2.txt');
    });

    it('should handle Windows-style paths on any platform', () => {
      // This will be converted to the platform's format
      const windowsPath = 'C:\\Users\\test\\file.txt';
      const result = pathResolver.resolvePath(windowsPath);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle paths with trailing slashes', () => {
      const pathWithSlash = './test/';
      const result = pathResolver.resolvePath(pathWithSlash);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle deeply nested relative paths', () => {
      const deepPath = './a/b/c/d/e/f/file.txt';
      const result = pathResolver.resolvePath(deepPath);
      expect(result).toContain('a/b/c/d/e/f/file.txt');
    });
  });

  describe('resetFocusManager', () => {
    it('should clear cached focus manager', () => {
      const mockFocusManager = {
        resolvePathInFocus: (path: string) => `/focused${path}`,
        getFocusDirectory: () => '/focused',
        isPathInFocus: () => true,
      };

      const registry = ServiceRegistry.getInstance();
      registry.registerInstance('focus_manager', mockFocusManager);

      // First access caches the focus manager
      pathResolver.resetFocusManager();
      pathResolver.resolvePath('/test');

      // Remove from registry
      registry['_services'].delete('focus_manager');

      // Reset should clear cache
      pathResolver.resetFocusManager();

      // Should now use standard resolution
      const result = pathResolver.resolvePath('~/test');
      expect(result).toBe(join(homedir(), 'test'));
    });
  });
});
