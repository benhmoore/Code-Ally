/**
 * PathSecurity Test Suite
 *
 * Tests for path traversal detection and command sensitivity classification
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cwd } from 'process';
import path from 'path';
import {
  isPathWithinCwd,
  hasPathTraversalPatterns,
  DirectoryTraversalError,
  PermissionDeniedError,
} from '../PathSecurity.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';

describe('PathSecurity', () => {
  let workingDir: string;
  let registry: ServiceRegistry;

  beforeEach(() => {
    workingDir = path.resolve(cwd());
    registry = ServiceRegistry.getInstance();
  });

  afterEach(() => {
    // Clean up any registered services
    if (registry.hasService('additional_dirs_manager')) {
      registry['_services'].delete('additional_dirs_manager');
      registry['_descriptors'].delete('additional_dirs_manager');
    }
  });

  describe('isPathWithinCwd', () => {
    it('should allow paths within the current working directory', () => {
      expect(isPathWithinCwd('./src')).toBe(true);
      expect(isPathWithinCwd('src/agent')).toBe(true);
      expect(isPathWithinCwd(path.join(workingDir, 'src'))).toBe(true);
    });

    it('should reject paths outside the current working directory', () => {
      expect(isPathWithinCwd('/etc/passwd')).toBe(false);
      expect(isPathWithinCwd('/tmp')).toBe(false);
      expect(isPathWithinCwd('~/Desktop')).toBe(false);
    });

    it('should reject parent directory traversal', () => {
      expect(isPathWithinCwd('../outside')).toBe(false);
      expect(isPathWithinCwd('../../etc')).toBe(false);
    });

    it('should allow paths within additional directories added via /add-dir', () => {
      // Create a mock AdditionalDirectoriesManager
      const mockAdditionalDirsManager = {
        isPathInAdditionalDirectory: (absPath: string) => {
          const additionalDir = '/Users/test/external-project';
          return absPath === additionalDir || absPath.startsWith(additionalDir + path.sep);
        },
      };

      // Register the mock
      registry.registerInstance('additional_dirs_manager', mockAdditionalDirsManager);

      // Path within the additional directory should be allowed
      expect(isPathWithinCwd('/Users/test/external-project')).toBe(true);
      expect(isPathWithinCwd('/Users/test/external-project/src/file.ts')).toBe(true);

      // Path outside both CWD and additional directories should still be rejected
      expect(isPathWithinCwd('/Users/test/other-project')).toBe(false);
      expect(isPathWithinCwd('/etc/passwd')).toBe(false);
    });

    it('should work correctly when no additional directories are registered', () => {
      // Without AdditionalDirectoriesManager registered, external paths should be rejected
      expect(isPathWithinCwd('/Users/test/external-project')).toBe(false);

      // But CWD paths should still work
      expect(isPathWithinCwd('./src')).toBe(true);
    });
  });

  describe('hasPathTraversalPatterns', () => {
    it('should detect parent directory traversal patterns', () => {
      expect(hasPathTraversalPatterns('..')).toBe(true);
      expect(hasPathTraversalPatterns('../etc')).toBe(true);
      expect(hasPathTraversalPatterns('../../etc/passwd')).toBe(true);
      expect(hasPathTraversalPatterns('foo/../bar')).toBe(true);
    });

    it('should detect home directory patterns', () => {
      expect(hasPathTraversalPatterns('~/')).toBe(true);
      expect(hasPathTraversalPatterns('~/Desktop')).toBe(true);
      expect(hasPathTraversalPatterns('$HOME')).toBe(true);
      expect(hasPathTraversalPatterns('${HOME}')).toBe(true);
    });

    it('should detect dangerous system paths', () => {
      expect(hasPathTraversalPatterns('/etc/passwd')).toBe(true);
      expect(hasPathTraversalPatterns('/var/log')).toBe(true);
      expect(hasPathTraversalPatterns('/usr/bin')).toBe(true);
      expect(hasPathTraversalPatterns('/tmp/file')).toBe(true);
      expect(hasPathTraversalPatterns('/root/')).toBe(true);
    });

    it('should detect command substitution patterns', () => {
      expect(hasPathTraversalPatterns('$(pwd)')).toBe(true);
      expect(hasPathTraversalPatterns('`pwd`')).toBe(true);
      expect(hasPathTraversalPatterns('${PWD}')).toBe(true);
    });

    it('should allow safe relative paths within CWD', () => {
      expect(hasPathTraversalPatterns('./src')).toBe(false);
      expect(hasPathTraversalPatterns('src/agent')).toBe(false);
      expect(hasPathTraversalPatterns('file.txt')).toBe(false);
    });

    it('should allow absolute paths within CWD', () => {
      const cwdSubpath = path.join(workingDir, 'src');
      expect(hasPathTraversalPatterns(cwdSubpath)).toBe(false);
    });

    it('should handle glob patterns correctly', () => {
      // Glob within CWD is safe
      const cwdGlob = path.join(workingDir, 'src/**/*.ts');
      expect(hasPathTraversalPatterns(cwdGlob)).toBe(false);

      // Glob outside CWD is dangerous
      expect(hasPathTraversalPatterns('/etc/**')).toBe(true);
      expect(hasPathTraversalPatterns('~/*')).toBe(true);
    });
  });

  describe('Error classes', () => {
    it('should create DirectoryTraversalError correctly', () => {
      const error = new DirectoryTraversalError('Test error');
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DirectoryTraversalError);
      expect(error.name).toBe('DirectoryTraversalError');
      expect(error.message).toBe('Test error');
    });

    it('should create PermissionDeniedError correctly', () => {
      const error = new PermissionDeniedError('Access denied');
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(PermissionDeniedError);
      expect(error.name).toBe('PermissionDeniedError');
      expect(error.message).toBe('Access denied');
    });
  });
});
