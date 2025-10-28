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
import { API_TIMEOUTS, CONTEXT_SIZES, VALID_CONTEXT_SIZES } from '../config/constants.js';

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
  service_model: string | null;
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
  async markSetupCompleted(): Promise<void> {
    await this.configManager.setValue('setup_completed', true);
  }

  /**
   * Validate Ollama endpoint connectivity
   * @param endpoint - The Ollama API endpoint URL
   * @returns Promise<boolean> - true if connection successful
   */
  async validateOllamaConnection(endpoint: string): Promise<boolean> {
    try {
      const url = `${endpoint}/api/tags`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), API_TIMEOUTS.OLLAMA_ENDPOINT_VALIDATION);

      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return false;
      }

      return true;
    } catch (error) {
      // Connection failures during setup are expected, no need to log
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

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), API_TIMEOUTS.OLLAMA_ENDPOINT_VALIDATION);

      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return [];
      }

      const data = (await response.json()) as OllamaListResponse;
      const models = data.models.map((m) => m.name);

      return models;
    } catch (error) {
      // Connection failures during setup are expected, no need to log
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
    return (VALID_CONTEXT_SIZES as readonly number[]).includes(contextSize);
  }

  /**
   * Apply setup configuration
   * @param config - The setup configuration to apply
   */
  async applySetupConfig(config: SetupConfig): Promise<void> {
    await this.configManager.setValue('endpoint', config.endpoint);
    await this.configManager.setValue('model', config.model);
    await this.configManager.setValue('service_model', config.service_model);
    await this.configManager.setValue('context_size', config.context_size);
    await this.configManager.setValue('temperature', config.temperature);
    await this.configManager.setValue('auto_confirm', config.auto_confirm);

    await this.markSetupCompleted();
  }

  /**
   * Reset setup completion flag (for re-running setup)
   */
  async resetSetup(): Promise<void> {
    await this.configManager.setValue('setup_completed', false);
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
    return CONTEXT_SIZES.MEDIUM;
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
      { value: CONTEXT_SIZES.SMALL, label: '16K (16,384 tokens)' },
      { value: CONTEXT_SIZES.MEDIUM, label: '32K (32,768 tokens) [Recommended]' },
      { value: CONTEXT_SIZES.LARGE, label: '64K (65,536 tokens)' },
      { value: CONTEXT_SIZES.XLARGE, label: '128K (131,072 tokens)' },
    ];
  }
}
