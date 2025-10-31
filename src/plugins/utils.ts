/**
 * Plugin utility functions
 *
 * Common helpers for plugin configuration, validation, and path resolution.
 */

import { homedir } from 'os';
import { resolve } from 'path';
import type { ConfigProperty } from './PluginLoader.js';

/**
 * Configuration validation and coercion utilities
 */
export class ConfigUtils {
  /**
   * Check if a value is empty (undefined, null, or empty string)
   */
  static isEmpty(value: any): boolean {
    return value === undefined || value === null || value === '';
  }

  /**
   * Coerce string values to proper types based on schema
   */
  static coerceType(value: any, targetType: string): any {
    if (this.isEmpty(value)) {
      return value;
    }

    switch (targetType) {
      case 'integer':
      case 'number':
        if (typeof value === 'string') {
          const num = Number(value);
          return isNaN(num) ? value : num;
        }
        return value;

      case 'boolean':
        if (typeof value === 'string') {
          return value === 'true';
        }
        return value;

      default:
        return value;
    }
  }

  /**
   * Validate that a value matches the expected type
   */
  static validateType(value: any, expectedType: string): boolean {
    if (this.isEmpty(value)) {
      return true;
    }

    const actualType = typeof value;

    switch (expectedType) {
      case 'integer':
      case 'number':
        return actualType === 'number' ||
          (actualType === 'string' && !isNaN(Number(value)) && value.trim() !== '');

      case 'boolean':
        return actualType === 'boolean' ||
          (actualType === 'string' && (value === 'true' || value === 'false'));

      case 'string':
        return actualType === 'string';

      default:
        return false;
    }
  }

  /**
   * Get all required field names from a config schema
   */
  static getRequiredFields(properties: Record<string, ConfigProperty>): string[] {
    return Object.entries(properties)
      .filter(([_, prop]) => prop.required)
      .map(([key, _]) => key);
  }
}

/**
 * Path resolution utilities
 */
export class PathUtils {
  /**
   * Resolve a path, expanding ~ to home directory
   */
  static resolvePath(inputPath: string): string {
    if (inputPath.startsWith('~')) {
      return resolve(inputPath.replace('~', homedir()));
    }
    return resolve(inputPath);
  }
}
