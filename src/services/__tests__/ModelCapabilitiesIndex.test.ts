/**
 * ModelCapabilitiesIndex Tests
 *
 * Strategic test coverage for the model capabilities caching system.
 * Tests focus on persistence, cache invalidation, and edge cases.
 *
 * Key scenarios covered:
 * - Singleton pattern
 * - Cache persistence (load/save)
 * - Capability retrieval and storage
 * - Endpoint-based cache invalidation
 * - Atomic file operations
 * - Error handling and recovery
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We need to mock the ALLY_HOME path before importing ModelCapabilitiesIndex
const testDir = join(tmpdir(), `model-capabilities-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);

vi.mock('../../config/paths.js', () => ({
  ALLY_HOME: testDir,
}));

// Import after mocking
const { ModelCapabilitiesIndex } = await import('../ModelCapabilitiesIndex.js');

describe('ModelCapabilitiesIndex', () => {
  beforeEach(async () => {
    // Create test directory
    await fs.mkdir(testDir, { recursive: true });
    // Reset singleton for each test
    (ModelCapabilitiesIndex as any).instance = null;
  });

  afterEach(async () => {
    // Cleanup
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    // Reset singleton
    (ModelCapabilitiesIndex as any).instance = null;
  });

  describe('Singleton Pattern', () => {
    it('should return same instance on multiple getInstance calls', () => {
      const instance1 = ModelCapabilitiesIndex.getInstance();
      const instance2 = ModelCapabilitiesIndex.getInstance();

      expect(instance1).toBe(instance2);
    });

    it('should create new instance after reset', () => {
      const instance1 = ModelCapabilitiesIndex.getInstance();
      (ModelCapabilitiesIndex as any).instance = null;
      const instance2 = ModelCapabilitiesIndex.getInstance();

      expect(instance1).not.toBe(instance2);
    });
  });

  describe('Loading', () => {
    it('should create empty data structure when file does not exist', async () => {
      const index = ModelCapabilitiesIndex.getInstance();
      await index.load();

      // Should have empty models
      const capability = index.getCapabilities('nonexistent-model', 'http://localhost:11434');
      expect(capability).toBeNull();
    });

    it('should load existing cache file', async () => {
      const cacheData = {
        version: 1,
        models: {
          'llama3.2': {
            supportsTools: true,
            supportsImages: false,
            testedAt: '2024-01-15T10:00:00.000Z',
            endpoint: 'http://localhost:11434',
          },
        },
      };

      await fs.writeFile(
        join(testDir, 'model-capabilities.json'),
        JSON.stringify(cacheData),
        'utf-8'
      );

      const index = ModelCapabilitiesIndex.getInstance();
      await index.load();

      const capability = index.getCapabilities('llama3.2', 'http://localhost:11434');
      expect(capability).toBeDefined();
      expect(capability!.supportsTools).toBe(true);
      expect(capability!.supportsImages).toBe(false);
    });

    it('should handle invalid cache structure', async () => {
      // Write invalid structure
      await fs.writeFile(
        join(testDir, 'model-capabilities.json'),
        JSON.stringify({ version: 2, invalid: true }),
        'utf-8'
      );

      const index = ModelCapabilitiesIndex.getInstance();
      await index.load();

      // Should create fresh structure
      const capability = index.getCapabilities('any-model', 'http://localhost:11434');
      expect(capability).toBeNull();
    });

    it('should handle corrupted JSON', async () => {
      await fs.writeFile(
        join(testDir, 'model-capabilities.json'),
        'not valid json {{{',
        'utf-8'
      );

      const index = ModelCapabilitiesIndex.getInstance();

      // Should not throw
      await index.load();

      // Should create fresh structure
      const capability = index.getCapabilities('any-model', 'http://localhost:11434');
      expect(capability).toBeNull();
    });
  });

  describe('Getting Capabilities', () => {
    it('should return null for uncached model', async () => {
      const index = ModelCapabilitiesIndex.getInstance();
      await index.load();

      const capability = index.getCapabilities('uncached-model', 'http://localhost:11434');
      expect(capability).toBeNull();
    });

    it('should return cached capabilities for matching endpoint', async () => {
      const index = ModelCapabilitiesIndex.getInstance();
      await index.load();

      await index.setCapabilities('test-model', 'http://localhost:11434', {
        supportsTools: true,
        supportsImages: true,
      });

      const capability = index.getCapabilities('test-model', 'http://localhost:11434');
      expect(capability).toBeDefined();
      expect(capability!.supportsTools).toBe(true);
      expect(capability!.supportsImages).toBe(true);
      expect(capability!.endpoint).toBe('http://localhost:11434');
      expect(capability!.testedAt).toBeDefined();
    });

    it('should return null when endpoint does not match (cache invalidation)', async () => {
      const index = ModelCapabilitiesIndex.getInstance();
      await index.load();

      // Cache with one endpoint
      await index.setCapabilities('test-model', 'http://localhost:11434', {
        supportsTools: true,
        supportsImages: false,
      });

      // Try to get with different endpoint
      const capability = index.getCapabilities('test-model', 'http://different:8080');
      expect(capability).toBeNull();
    });

    it('should warn and return null if data not loaded', () => {
      const index = ModelCapabilitiesIndex.getInstance();
      // Don't call load()

      const capability = index.getCapabilities('test-model', 'http://localhost:11434');
      expect(capability).toBeNull();
    });
  });

  describe('Setting Capabilities', () => {
    it('should store capabilities with timestamp and endpoint', async () => {
      const index = ModelCapabilitiesIndex.getInstance();
      await index.load();

      const beforeSet = new Date().toISOString();
      await index.setCapabilities('new-model', 'http://api.example.com', {
        supportsTools: false,
        supportsImages: true,
      });
      const afterSet = new Date().toISOString();

      const capability = index.getCapabilities('new-model', 'http://api.example.com');
      expect(capability).toBeDefined();
      expect(capability!.supportsTools).toBe(false);
      expect(capability!.supportsImages).toBe(true);
      expect(capability!.endpoint).toBe('http://api.example.com');
      // Timestamp should be between before and after
      expect(capability!.testedAt >= beforeSet).toBe(true);
      expect(capability!.testedAt <= afterSet).toBe(true);
    });

    it('should overwrite existing capabilities', async () => {
      const index = ModelCapabilitiesIndex.getInstance();
      await index.load();

      // Set initial
      await index.setCapabilities('model', 'http://localhost:11434', {
        supportsTools: false,
        supportsImages: false,
      });

      // Overwrite
      await index.setCapabilities('model', 'http://localhost:11434', {
        supportsTools: true,
        supportsImages: true,
      });

      const capability = index.getCapabilities('model', 'http://localhost:11434');
      expect(capability!.supportsTools).toBe(true);
      expect(capability!.supportsImages).toBe(true);
    });

    it('should persist to disk after setting', async () => {
      const index = ModelCapabilitiesIndex.getInstance();
      await index.load();

      await index.setCapabilities('persisted-model', 'http://localhost:11434', {
        supportsTools: true,
        supportsImages: false,
      });

      // Read file directly
      const content = await fs.readFile(
        join(testDir, 'model-capabilities.json'),
        'utf-8'
      );
      const data = JSON.parse(content);

      expect(data.version).toBe(1);
      expect(data.models['persisted-model']).toBeDefined();
      expect(data.models['persisted-model'].supportsTools).toBe(true);
    });

    it('should initialize data if not loaded when setting', async () => {
      const index = ModelCapabilitiesIndex.getInstance();
      // Don't call load()

      await index.setCapabilities('model', 'http://localhost:11434', {
        supportsTools: true,
        supportsImages: false,
      });

      // Should work and be retrievable
      const capability = index.getCapabilities('model', 'http://localhost:11434');
      expect(capability!.supportsTools).toBe(true);
    });
  });

  describe('Invalidation', () => {
    it('should invalidate specific model', async () => {
      const index = ModelCapabilitiesIndex.getInstance();
      await index.load();

      await index.setCapabilities('model1', 'http://localhost:11434', {
        supportsTools: true,
        supportsImages: false,
      });
      await index.setCapabilities('model2', 'http://localhost:11434', {
        supportsTools: false,
        supportsImages: true,
      });

      await index.invalidate('model1');

      expect(index.getCapabilities('model1', 'http://localhost:11434')).toBeNull();
      expect(index.getCapabilities('model2', 'http://localhost:11434')).toBeDefined();
    });

    it('should persist invalidation to disk', async () => {
      const index = ModelCapabilitiesIndex.getInstance();
      await index.load();

      await index.setCapabilities('to-invalidate', 'http://localhost:11434', {
        supportsTools: true,
        supportsImages: true,
      });

      await index.invalidate('to-invalidate');

      // Read file directly
      const content = await fs.readFile(
        join(testDir, 'model-capabilities.json'),
        'utf-8'
      );
      const data = JSON.parse(content);

      expect(data.models['to-invalidate']).toBeUndefined();
    });

    it('should handle invalidating non-existent model', async () => {
      const index = ModelCapabilitiesIndex.getInstance();
      await index.load();

      // Should not throw
      await index.invalidate('nonexistent-model');
    });

    it('should invalidate all models', async () => {
      const index = ModelCapabilitiesIndex.getInstance();
      await index.load();

      await index.setCapabilities('model1', 'http://localhost:11434', {
        supportsTools: true,
        supportsImages: false,
      });
      await index.setCapabilities('model2', 'http://localhost:11434', {
        supportsTools: false,
        supportsImages: true,
      });

      await index.invalidateAll();

      expect(index.getCapabilities('model1', 'http://localhost:11434')).toBeNull();
      expect(index.getCapabilities('model2', 'http://localhost:11434')).toBeNull();
    });
  });

  describe('File Operations', () => {
    it('should use atomic write (temp file + rename)', async () => {
      const index = ModelCapabilitiesIndex.getInstance();
      await index.load();

      await index.setCapabilities('model', 'http://localhost:11434', {
        supportsTools: true,
        supportsImages: false,
      });

      // Temp file should not exist after successful write
      const files = await fs.readdir(testDir);
      const tempFiles = files.filter(f => f.endsWith('.tmp'));
      expect(tempFiles.length).toBe(0);
    });

    it('should create directory if it does not exist', async () => {
      // Remove the test directory
      await fs.rm(testDir, { recursive: true, force: true });

      const index = ModelCapabilitiesIndex.getInstance();
      await index.load();

      await index.setCapabilities('model', 'http://localhost:11434', {
        supportsTools: true,
        supportsImages: false,
      });

      // Directory should exist now
      const stats = await fs.stat(testDir);
      expect(stats.isDirectory()).toBe(true);
    });

    it('should handle no data to save', async () => {
      const index = ModelCapabilitiesIndex.getInstance();
      // Don't load, so data is null

      // Call save directly (private method access for testing)
      await (index as any).save();

      // Should not create file
      const files = await fs.readdir(testDir).catch(() => []);
      expect(files.includes('model-capabilities.json')).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle model names with special characters', async () => {
      const index = ModelCapabilitiesIndex.getInstance();
      await index.load();

      const specialName = 'model/with:special.chars@v1';

      await index.setCapabilities(specialName, 'http://localhost:11434', {
        supportsTools: true,
        supportsImages: false,
      });

      const capability = index.getCapabilities(specialName, 'http://localhost:11434');
      expect(capability).toBeDefined();
      expect(capability!.supportsTools).toBe(true);
    });

    it('should handle very long model names', async () => {
      const index = ModelCapabilitiesIndex.getInstance();
      await index.load();

      const longName = 'a'.repeat(500);

      await index.setCapabilities(longName, 'http://localhost:11434', {
        supportsTools: false,
        supportsImages: true,
      });

      const capability = index.getCapabilities(longName, 'http://localhost:11434');
      expect(capability).toBeDefined();
    });

    it('should handle many models in cache', async () => {
      const index = ModelCapabilitiesIndex.getInstance();
      await index.load();

      // Add 100 models
      for (let i = 0; i < 100; i++) {
        await index.setCapabilities(`model-${i}`, 'http://localhost:11434', {
          supportsTools: i % 2 === 0,
          supportsImages: i % 3 === 0,
        });
      }

      // Verify some of them
      const cap50 = index.getCapabilities('model-50', 'http://localhost:11434');
      expect(cap50!.supportsTools).toBe(true); // 50 is even
      expect(cap50!.supportsImages).toBe(false); // 50 % 3 !== 0

      const cap99 = index.getCapabilities('model-99', 'http://localhost:11434');
      expect(cap99!.supportsTools).toBe(false); // 99 is odd
      expect(cap99!.supportsImages).toBe(true); // 99 % 3 === 0
    });

    it('should handle endpoints with various formats', async () => {
      const index = ModelCapabilitiesIndex.getInstance();
      await index.load();

      const endpoints = [
        'http://localhost:11434',
        'http://localhost:11434/',
        'https://api.openai.com/v1',
        'http://192.168.1.100:8080',
        'http://model-server.internal.cluster.local:11434',
      ];

      for (const endpoint of endpoints) {
        await index.setCapabilities('model', endpoint, {
          supportsTools: true,
          supportsImages: false,
        });

        const capability = index.getCapabilities('model', endpoint);
        expect(capability).toBeDefined();
        expect(capability!.endpoint).toBe(endpoint);
      }
    });
  });
});
