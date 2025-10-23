/**
 * Registry for managing file checkers
 *
 * Maintains a collection of file checkers and routes files to the
 * appropriate checker based on file extension.
 */

import { FileChecker, CheckResult } from './types.js';

export class CheckerRegistry {
  private checkers: FileChecker[] = [];

  /**
   * Register a file checker
   *
   * @param checker - FileChecker implementation to register
   */
  register(checker: FileChecker): void {
    this.checkers.push(checker);
  }

  /**
   * Get the appropriate checker for a file
   *
   * @param filePath - Path to file
   * @returns FileChecker if available, null otherwise
   */
  getChecker(filePath: string): FileChecker | null {
    for (const checker of this.checkers) {
      if (checker.canCheck(filePath)) {
        return checker;
      }
    }
    return null;
  }

  /**
   * Check a file using the appropriate checker
   *
   * @param filePath - Path to file to check
   * @param content - File content
   * @returns CheckResult if checker available, null otherwise
   */
  async checkFile(filePath: string, content: string): Promise<CheckResult | null> {
    const checker = this.getChecker(filePath);
    if (!checker) {
      return null;
    }

    try {
      return await checker.check(filePath, content);
    } catch (error) {
      console.warn(`[CheckerRegistry] Checker ${checker.name} failed for ${filePath}:`, error);
      return null;
    }
  }
}

/**
 * Global registry instance
 */
let defaultRegistry: CheckerRegistry | null = null;
let initializationPromise: Promise<void> | null = null;

/**
 * Get or create the default checker registry
 *
 * Lazy initialization ensures checkers are only loaded when needed.
 *
 * @returns Global CheckerRegistry instance
 */
export function getDefaultRegistry(): CheckerRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new CheckerRegistry();
    initializationPromise = initializeDefaultCheckers(defaultRegistry);
  }
  return defaultRegistry;
}

/**
 * Ensure registry is fully initialized
 *
 * @returns Promise that resolves when registry is ready
 */
export async function ensureRegistryInitialized(): Promise<void> {
  getDefaultRegistry(); // Trigger initialization if needed
  if (initializationPromise) {
    await initializationPromise;
  }
}

/**
 * Initialize the default set of checkers
 *
 * @param registry - CheckerRegistry to populate
 */
async function initializeDefaultCheckers(registry: CheckerRegistry): Promise<void> {
  // Import and register checkers
  // Fast checkers first for priority
  const [
    { JSONChecker },
    { YAMLChecker },
    { JavaScriptChecker },
    { TypeScriptChecker },
  ] = await Promise.all([
    import('./JSONChecker.js'),
    import('./YAMLChecker.js'),
    import('./JavaScriptChecker.js'),
    import('./TypeScriptChecker.js'),
  ]);

  registry.register(new JSONChecker());
  registry.register(new YAMLChecker());
  registry.register(new JavaScriptChecker());
  registry.register(new TypeScriptChecker());
}

/**
 * Reset the registry (useful for testing)
 */
export function resetRegistry(): void {
  defaultRegistry = null;
}
