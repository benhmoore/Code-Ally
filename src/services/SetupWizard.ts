/**
 * SetupWizard - First-run setup wizard for Code Ally
 *
 * Guides users through initial configuration:
 * - Ollama endpoint validation
 * - Model selection
 * - Context size configuration
 * - Temperature setting
 * - Auto-confirm preference
 */

import { ConfigManager } from './ConfigManager.js';
import { logger } from './Logger.js';

export interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
}

export interface OllamaListResponse {
  models: OllamaModel[];
}

export interface SetupConfig {
  endpoint: string;
  model: string;
  context_size: number;
  temperature: number;
  auto_confirm: boolean;
}

export class SetupWizard {
  private configManager: ConfigManager;

  constructor(configManager: ConfigManager) {
    this.configManager = configManager;
  }

  /**
   * Check if setup has been completed
   */
  isSetupCompleted(): boolean {
    const config = this.configManager.getConfig();
    return config.setup_completed === true;
  }

  /**
   * Mark setup as completed
   */
  markSetupCompleted(): void {
    this.configManager.setValue('setup_completed', true);
    logger.info('[SetupWizard] Setup marked as completed');
  }

  /**
   * Validate Ollama endpoint connectivity
   * @param endpoint - The Ollama API endpoint URL
   * @returns Promise<boolean> - true if connection successful
   */
  async validateOllamaConnection(endpoint: string): Promise<boolean> {
    try {
      const url = `${endpoint}/api/tags`;
      logger.debug('[SetupWizard] Testing Ollama connection:', url);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout

      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        logger.warn('[SetupWizard] Ollama connection failed with status:', response.status);
        return false;
      }

      logger.debug('[SetupWizard] Ollama connection successful');
      return true;
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          logger.warn('[SetupWizard] Ollama connection timeout');
        } else {
          logger.warn('[SetupWizard] Ollama connection error:', error.message);
        }
      }
      return false;
    }
  }

  /**
   * Get available models from Ollama endpoint
   * @param endpoint - The Ollama API endpoint URL
   * @returns Promise<string[]> - Array of model names
   */
  async getAvailableModels(endpoint: string): Promise<string[]> {
    try {
      const url = `${endpoint}/api/tags`;
      logger.debug('[SetupWizard] Fetching available models from:', url);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        logger.warn('[SetupWizard] Failed to fetch models, status:', response.status);
        return [];
      }

      const data = (await response.json()) as OllamaListResponse;
      const models = data.models.map((m) => m.name);

      logger.debug('[SetupWizard] Found models:', models);
      return models;
    } catch (error) {
      if (error instanceof Error) {
        logger.warn('[SetupWizard] Error fetching models:', error.message);
      }
      return [];
    }
  }

  /**
   * Validate temperature value
   * @param temperature - Temperature value to validate
   * @returns boolean - true if valid
   */
  validateTemperature(temperature: number): boolean {
    return temperature >= 0.0 && temperature <= 2.0;
  }

  /**
   * Validate context size
   * @param contextSize - Context size to validate
   * @returns boolean - true if valid
   */
  validateContextSize(contextSize: number): boolean {
    const validSizes = [16384, 32768, 65536, 131072];
    return validSizes.includes(contextSize);
  }

  /**
   * Apply setup configuration
   * @param config - The setup configuration to apply
   */
  async applySetupConfig(config: SetupConfig): Promise<void> {
    logger.info('[SetupWizard] Applying setup configuration');

    this.configManager.setValue('endpoint', config.endpoint);
    this.configManager.setValue('model', config.model);
    this.configManager.setValue('context_size', config.context_size);
    this.configManager.setValue('temperature', config.temperature);
    this.configManager.setValue('auto_confirm', config.auto_confirm);

    this.markSetupCompleted();

    logger.info('[SetupWizard] Configuration applied successfully');
  }

  /**
   * Reset setup completion flag (for re-running setup)
   */
  resetSetup(): void {
    this.configManager.setValue('setup_completed', false);
    logger.info('[SetupWizard] Setup completion flag reset');
  }

  /**
   * Get default endpoint
   */
  getDefaultEndpoint(): string {
    return 'http://localhost:11434';
  }

  /**
   * Get default context size
   */
  getDefaultContextSize(): number {
    return 32768;
  }

  /**
   * Get default temperature
   */
  getDefaultTemperature(): number {
    return 0.3;
  }

  /**
   * Get context size options
   */
  getContextSizeOptions(): Array<{ value: number; label: string }> {
    return [
      { value: 16384, label: '16K (16,384 tokens)' },
      { value: 32768, label: '32K (32,768 tokens) [Recommended]' },
      { value: 65536, label: '64K (65,536 tokens)' },
      { value: 131072, label: '128K (131,072 tokens)' },
    ];
  }
}
