/**
 * SetupWizard - Interactive setup for first-time configuration
 *
 * Guides users through initial configuration with model detection,
 * preference selection, and validation.
 */

import inquirer from 'inquirer';
import { ConfigManager } from '../services/ConfigManager.js';

export interface SetupWizardOptions {
  endpoint?: string;
  skipModelCheck?: boolean;
}

/**
 * SetupWizard class
 *
 * Provides interactive configuration wizard for initial setup
 */
export class SetupWizard {
  private configManager: ConfigManager;
  private options: SetupWizardOptions;

  constructor(configManager: ConfigManager, options: SetupWizardOptions = {}) {
    this.configManager = configManager;
    this.options = options;
  }

  /**
   * Run the interactive setup wizard
   *
   * @returns Promise<boolean> - true if setup completed successfully
   */
  async run(): Promise<boolean> {
    console.log('\n=== Welcome to Code Ally Setup! ===\n');

    try {
      // Step 1: Ollama endpoint
      const endpoint = await this.promptEndpoint();

      // Step 2: Detect and select model
      const model = await this.promptModelSelection(endpoint);

      // Step 3: Model configuration
      const temperature = await this.promptTemperature();
      const contextSize = await this.promptContextSize();
      const maxTokens = await this.promptMaxTokens();

      // Step 4: Behavior preferences
      const bashTimeout = await this.promptBashTimeout();

      // Save configuration
      await this.configManager.setValues({
        endpoint,
        model,
        temperature,
        context_size: contextSize,
        max_tokens: maxTokens,
        bash_timeout: bashTimeout,
        setup_completed: true,
      });

      // Display completion summary
      console.log('\n' + '='.repeat(60));
      console.log('✓ Setup Complete!');
      console.log('='.repeat(60));
      console.log('\nConfiguration Summary:');
      console.log(`  Model:         ${model}`);
      console.log(`  Context Size:  ${contextSize.toLocaleString()} tokens`);
      console.log(`  Temperature:   ${temperature}`);
      console.log(`  Max Tokens:    ${maxTokens.toLocaleString()}`);
      console.log(`  Endpoint:      ${endpoint}`);
      console.log('\nNext Steps:');
      console.log('  1. Run "ally" to start a new conversation');
      console.log('  2. Use "ally --help" to see all available options');
      console.log('  3. Use "ally --init" to reconfigure settings anytime');
      console.log('\n' + '='.repeat(60) + '\n');

      return true;
    } catch (error) {
      if (error instanceof Error && error.message === 'User cancelled setup') {
        console.log('\n✗ Setup cancelled.\n');
        return false;
      }

      console.error('\n✗ Setup failed:', error);
      return false;
    }
  }

  /**
   * Prompt for Ollama endpoint
   */
  private async promptEndpoint(): Promise<string> {
    const currentEndpoint = this.configManager.getValue('endpoint');

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'endpoint',
        message: 'Ollama API endpoint:',
        default: currentEndpoint || 'http://localhost:11434',
        validate: (input: string) => {
          if (!input.trim()) {
            return 'Endpoint cannot be empty';
          }
          try {
            new URL(input);
            return true;
          } catch {
            return 'Please enter a valid URL';
          }
        },
      },
    ]);

    return answers.endpoint;
  }

  /**
   * Detect available models and prompt for selection
   */
  private async promptModelSelection(endpoint: string): Promise<string> {
    if (this.options.skipModelCheck) {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'model',
          message: 'Model name:',
          validate: (input: string) => {
            if (!input.trim()) {
              return 'Model name cannot be empty';
            }
            return true;
          },
        },
      ]);
      return answers.model;
    }

    console.log('\nDetecting available models...');

    try {
      const models = await this.detectModels(endpoint);

      if (models.length === 0) {
        console.log(
          '\n⚠️  No models found. Please install a model with: ollama pull <model-name>\n'
        );

        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'model',
            message: 'Enter model name to use:',
            validate: (input: string) => {
              if (!input.trim()) {
                return 'Model name cannot be empty';
              }
              return true;
            },
          },
        ]);
        return answers.model;
      }

      console.log(`\nFound ${models.length} available model(s).\n`);

      const answers = await inquirer.prompt([
        {
          type: 'list',
          name: 'model',
          message: 'Select a model:',
          choices: models,
          pageSize: 10,
        },
      ]);

      return answers.model;
    } catch (error) {
      console.log(
        `\n⚠️  Could not connect to Ollama at ${endpoint}\n`
      );
      console.log('Please ensure:');
      console.log('  1. Ollama is installed');
      console.log('  2. Ollama server is running');
      console.log('  3. Endpoint URL is correct\n');

      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'model',
          message: 'Enter model name to use anyway:',
          validate: (input: string) => {
            if (!input.trim()) {
              return 'Model name cannot be empty';
            }
            return true;
          },
        },
      ]);
      return answers.model;
    }
  }

  /**
   * Detect available models from Ollama
   */
  private async detectModels(endpoint: string): Promise<string[]> {
    try {
      const response = await fetch(`${endpoint}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        models?: Array<{ name: string }>;
      };

      if (!data.models || !Array.isArray(data.models)) {
        return [];
      }

      return data.models.map((m: { name: string }) => m.name).filter(Boolean);
    } catch (error) {
      throw new Error('Failed to detect models');
    }
  }

  /**
   * Prompt for temperature setting
   */
  private async promptTemperature(): Promise<number> {
    const currentTemp = this.configManager.getValue('temperature');

    const answers = await inquirer.prompt<{ temperature: number }>([
      {
        type: 'input',
        name: 'temperature',
        message: 'Temperature (0.0-1.0, lower = more focused):',
        default: String(currentTemp || 0.3),
        validate: (input: string) => {
          const num = parseFloat(input);
          if (isNaN(num) || num < 0 || num > 1) {
            return 'Temperature must be between 0.0 and 1.0';
          }
          return true;
        },
        filter: (input: string) => parseFloat(input),
      },
    ]);

    return answers.temperature;
  }

  /**
   * Prompt for context size
   */
  private async promptContextSize(): Promise<number> {
    const currentSize = this.configManager.getValue('context_size');

    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'contextSize',
        message: 'Context window size:',
        choices: [
          { name: '8K tokens (8192)', value: 8192 },
          { name: '16K tokens (16384) - Recommended', value: 16384 },
          { name: '32K tokens (32768)', value: 32768 },
          { name: '64K tokens (65536)', value: 65536 },
          { name: '128K tokens (131072)', value: 131072 },
        ],
        default: currentSize || 16384,
      },
    ]);

    return answers.contextSize;
  }

  /**
   * Prompt for max tokens to generate
   */
  private async promptMaxTokens(): Promise<number> {
    const currentMax = this.configManager.getValue('max_tokens');

    const answers = await inquirer.prompt<{ maxTokens: number }>([
      {
        type: 'input',
        name: 'maxTokens',
        message: 'Maximum tokens to generate per response:',
        default: String(currentMax || 7000),
        validate: (input: string) => {
          const num = parseInt(input, 10);
          if (isNaN(num) || num < 100 || num > 100000) {
            return 'Max tokens must be between 100 and 100000';
          }
          return true;
        },
        filter: (input: string) => parseInt(input, 10),
      },
    ]);

    return answers.maxTokens;
  }

  /**
   * Prompt for bash timeout
   */
  private async promptBashTimeout(): Promise<number> {
    const currentTimeout = this.configManager.getValue('bash_timeout');

    const answers = await inquirer.prompt<{ bashTimeout: number }>([
      {
        type: 'input',
        name: 'bashTimeout',
        message: 'Bash command timeout (seconds):',
        default: String(currentTimeout || 30),
        validate: (input: string) => {
          const num = parseInt(input, 10);
          if (isNaN(num) || num < 1 || num > 600) {
            return 'Timeout must be between 1 and 600 seconds';
          }
          return true;
        },
        filter: (input: string) => parseInt(input, 10),
      },
    ]);

    return answers.bashTimeout;
  }

}
