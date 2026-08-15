/**
 * SetupWizard - First-run setup wizard for Code Ally
 *
 * Guides users through initial configuration:
 * - Provider endpoint validation
 * - Model selection
 * - Context size configuration
 * - Temperature setting
 * - Auto-confirm preference
 */

import { ConfigManager } from './ConfigManager.js';
import { API_TIMEOUTS, CONTEXT_SIZES, VALID_CONTEXT_SIZES } from '../config/constants.js';
import { listProviderModels } from '../llm/ProviderAdapter.js';

export interface SetupConfig {
  provider: 'ollama' | 'openai-compat';
  endpoint: string;
  api_key: string | null;
  model: string;
  service_model: string | null;
  context_size: number;
  temperature: number;
  auto_confirm: boolean;
  enable_idle_messages: boolean;
  enable_session_title_generation: boolean;
  tool_call_activity_timeout: number;
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
   * Validate Ollama endpoint connectivity
   * @param endpoint - The Ollama API endpoint URL
   * @returns Promise<boolean> - true if connection successful
   */
  async validateConnection(
    endpoint: string,
    provider = this.configManager.getConfig().provider,
    apiKey = this.configManager.getConfig().api_key
  ): Promise<boolean> {
    const result = await listProviderModels(
      { provider, endpoint, api_key: apiKey },
      API_TIMEOUTS.OLLAMA_ENDPOINT_VALIDATION
    );
    return !result.error;
  }

  /**
   * Get available models from Ollama endpoint
   * @param endpoint - The Ollama API endpoint URL
   * @returns Promise<string[]> - Array of model names
   */
  async getAvailableModels(
    endpoint: string,
    provider = this.configManager.getConfig().provider,
    apiKey = this.configManager.getConfig().api_key
  ): Promise<string[]> {
    const result = await listProviderModels(
      { provider, endpoint, api_key: apiKey },
      API_TIMEOUTS.OLLAMA_ENDPOINT_VALIDATION
    );
    return result.models.map((model) => model.name);
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
    await this.configManager.setValues({
      ...config,
      setup_completed: true,
    });
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
      { value: CONTEXT_SIZES.XXLARGE, label: '256K (262,144 tokens)' },
    ];
  }
}
