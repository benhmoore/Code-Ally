/**
 * ModelCapabilitiesIndex - Manages persistent index of model capabilities
 *
 * This service handles caching of model capabilities (tool support, image support)
 * to avoid redundant capability checks. The cache is stored at ~/.ally/model-capabilities.json
 * and is invalidated when the endpoint changes.
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { ALLY_HOME } from '../config/paths.js';
import { logger } from './Logger.js';

export interface ModelCapability {
  supportsTools: boolean;
  supportsImages: boolean;
  testedAt: string; // ISO timestamp
  endpoint: string; // The endpoint used when testing (to invalidate if endpoint changes)
}

export interface ModelCapabilitiesData {
  version: 1;
  models: Record<string, ModelCapability>;
}

/**
 * ModelCapabilitiesIndex class
 * Singleton service for managing model capability cache
 */
export class ModelCapabilitiesIndex {
  private static instance: ModelCapabilitiesIndex | null = null;
  private data: ModelCapabilitiesData | null = null;
  private readonly filePath: string;

  private constructor() {
    this.filePath = join(ALLY_HOME, 'model-capabilities.json');
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): ModelCapabilitiesIndex {
    if (!ModelCapabilitiesIndex.instance) {
      ModelCapabilitiesIndex.instance = new ModelCapabilitiesIndex();
    }
    return ModelCapabilitiesIndex.instance;
  }

  /**
   * Load capabilities index from disk
   * Creates empty structure if file doesn't exist
   */
  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      const loaded = JSON.parse(content);

      // Validate structure
      if (loaded && typeof loaded === 'object' && loaded.version === 1 && typeof loaded.models === 'object') {
        this.data = loaded as ModelCapabilitiesData;
        logger.debug(`[ModelCapabilities] Loaded ${Object.keys(this.data.models).length} model capabilities from cache`);
      } else {
        logger.warn('[ModelCapabilities] Invalid cache structure, creating fresh');
        this.data = {
          version: 1,
          models: {},
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist yet - start fresh
        logger.debug('[ModelCapabilities] Cache file not found, creating fresh');
        this.data = {
          version: 1,
          models: {},
        };
      } else {
        logger.error('[ModelCapabilities] Failed to load cache:', error);
        this.data = {
          version: 1,
          models: {},
        };
      }
    }
  }

  /**
   * Save capabilities index to disk using atomic write
   * Uses temp file + rename pattern for atomicity
   */
  async save(): Promise<void> {
    if (!this.data) {
      logger.warn('[ModelCapabilities] No data to save, skipping');
      return;
    }

    // Ensure directory exists
    const dir = dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });

    // Atomic write: write to temp file first, then rename
    const tempPath = `${this.filePath}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(this.data, null, 2), 'utf-8');
      await fs.rename(tempPath, this.filePath);
      logger.debug('[ModelCapabilities] Cache saved successfully');
    } catch (error) {
      // Clean up temp file if rename failed
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      logger.error('[ModelCapabilities] Failed to save cache:', error);
      throw error;
    }
  }

  /**
   * Get cached capabilities for a model
   * Returns null if not cached OR if endpoint doesn't match (endpoint change invalidates cache)
   *
   * @param modelName - Name of the model
   * @param endpoint - The endpoint being used
   * @returns ModelCapability or null if not cached or endpoint mismatch
   */
  getCapabilities(modelName: string, endpoint: string): ModelCapability | null {
    // Ensure data is loaded
    if (!this.data) {
      logger.warn('[ModelCapabilities] Data not loaded, call load() first');
      return null;
    }

    const cached = this.data.models[modelName];

    if (!cached) {
      logger.debug(`[ModelCapabilities] No cache entry for model: ${modelName}`);
      return null;
    }

    // Validate endpoint matches (endpoint change invalidates cache)
    if (cached.endpoint !== endpoint) {
      logger.debug(`[ModelCapabilities] Endpoint mismatch for ${modelName} (cached: ${cached.endpoint}, current: ${endpoint}), invalidating`);
      return null;
    }

    logger.debug(`[ModelCapabilities] Cache hit for ${modelName} (tested at ${cached.testedAt})`);
    return cached;
  }

  /**
   * Set capabilities for a model and persist to disk
   *
   * @param modelName - Name of the model
   * @param endpoint - The endpoint being used
   * @param capabilities - Capabilities to cache (without testedAt and endpoint)
   */
  async setCapabilities(
    modelName: string,
    endpoint: string,
    capabilities: Omit<ModelCapability, 'testedAt' | 'endpoint'>
  ): Promise<void> {
    // Ensure data is loaded
    if (!this.data) {
      logger.warn('[ModelCapabilities] Data not loaded, initializing fresh');
      this.data = {
        version: 1,
        models: {},
      };
    }

    // Create full capability entry with timestamp and endpoint
    const fullCapability: ModelCapability = {
      ...capabilities,
      testedAt: new Date().toISOString(),
      endpoint,
    };

    this.data.models[modelName] = fullCapability;

    logger.debug(`[ModelCapabilities] Cached capabilities for ${modelName}: tools=${capabilities.supportsTools}, images=${capabilities.supportsImages}`);

    // Persist to disk
    await this.save();
  }

  /**
   * Invalidate cached capabilities for a specific model
   *
   * @param modelName - Name of the model to invalidate
   */
  async invalidate(modelName: string): Promise<void> {
    if (!this.data) {
      return;
    }

    if (this.data.models[modelName]) {
      delete this.data.models[modelName];
      logger.debug(`[ModelCapabilities] Invalidated cache for ${modelName}`);
      await this.save();
    }
  }

  /**
   * Clear entire cache
   */
  async invalidateAll(): Promise<void> {
    this.data = {
      version: 1,
      models: {},
    };

    logger.debug('[ModelCapabilities] Cleared all cached capabilities');
    await this.save();
  }
}
