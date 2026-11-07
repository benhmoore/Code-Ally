/**
 * ModelCommand - Change AI model
 *
 * Handles model selection for both ally and service models.
 * - No args: Shows interactive model selector UI
 * - "service <name>": Sets service model
 * - "<name>": Sets ally model
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import { ActivityEventType } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import { formatError } from '@utils/errorUtils.js';
import { BYTE_CONVERSIONS, FORMATTING } from '@config/constants.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';
import { listProviderModels } from '@llm/ProviderAdapter.js';
import { createModelConfigCoordinator } from '@services/createModelConfigCoordinator.js';

export class ModelCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/model',
    description: 'Switch LLM model',
    helpCategory: 'Core',
    subcommands: [
      { name: '<model>', description: 'Select the main coding model' },
      { name: 'service', description: 'Choose the background model', args: '[model]' },
    ],
    useYellowOutput: true,
  };

  static {
    CommandRegistry.register(ModelCommand.metadata);
  }

  readonly name = ModelCommand.metadata.name;
  readonly description = ModelCommand.metadata.description;
  protected readonly useYellowOutput = ModelCommand.metadata.useYellowOutput ?? false;

  async execute(args: string[], _messages: Message[], serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const configManager = serviceRegistry.get('config_manager');

    if (!configManager) {
      return this.createError('Configuration manager not available');
    }

    const argString = args.join(' ').trim();

    // Parse model type (ally/main/service) and model name
    let modelType: 'ally' | 'service' = 'ally'; // default to ally model
    let modelName = '';

    if (argString) {
      const parts = argString.split(/\s+/);
      const firstArg = parts[0]?.toLowerCase() || '';

      // Check if first arg is a type specifier
      if (firstArg === 'service') {
        modelType = 'service';
        modelName = parts.slice(1).join(' ').trim();
      } else if (firstArg === 'ally' || firstArg === 'main') {
        modelType = 'ally';
        modelName = parts.slice(1).join(' ').trim();
      } else {
        // No type specifier, treat entire arg as model name for ally model
        modelName = argString;
      }
    }

    // Direct model name provided - set it immediately
    if (modelName) {
      const outcome = await createModelConfigCoordinator(serviceRegistry).switchModel(modelName, modelType);
      if (outcome.configUpdate)
        serviceRegistry.get('activity_stream')?.emit({
          id: `config_updated_${Date.now()}`,
          type: ActivityEventType.CONFIG_UPDATED,
          timestamp: Date.now(),
          data: outcome.configUpdate,
        });
      const content = outcome.messages.join('\n');
      if (outcome.status === 'switched') return this.createResponse(content);
      if (outcome.status === 'superseded') return this.createResponse('A newer model selection replaced this request.');
      return this.createError(content || 'Model selection unavailable. Run /config setup.');
    }

    // No model name - show interactive selector
    try {
      const configKey = modelType === 'service' ? 'service_model' : 'model';
      const currentModel = configManager.getValue(configKey);
      const config = configManager.getConfig();
      const discovery = await listProviderModels(config);
      const directCommand = `/model${modelType === 'service' ? ' service' : ''} <name>`;
      if (discovery.error) {
        return this.createError(
          `Failed to fetch models from the configured provider (${discovery.error}). Check /config setup or use ${directCommand} to set the exact identifier.`
        );
      }

      if (!discovery.supported) {
        return this.createResponse(
          `This provider does not support model discovery. Use ${directCommand} to set the exact model identifier.`
        );
      }
      const models = [...discovery.models]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(m => ({
          name: m.name,
          size: m.size ? this.formatSize(m.size) : undefined,
          modified: m.modified,
        }));

      if (models.length === 0) {
        const providerName = config.provider ?? 'ollama';
        return this.createResponse(
          `No models were reported by ${providerName}. Use ${directCommand} to set one directly.`
        );
      }

      // Emit interactive selection request
      const activityStream = serviceRegistry.get('activity_stream');
      if (activityStream) {
        const requestId = `model_select_${Date.now()}`;
        const typeName = modelType === 'service' ? 'service model' : 'ally model';

        activityStream.emit({
          id: requestId,
          type: ActivityEventType.MODEL_SELECT_REQUEST,
          timestamp: Date.now(),
          data: {
            requestId,
            models,
            currentModel,
            modelType, // Pass model type so UI knows which config to update
            typeName, // Display name for UI
          },
        });

        return { handled: true }; // Selection handled via UI
      }

      // Fallback: show list
      const typeName = modelType === 'service' ? 'service model' : 'model';
      let output = `Current ${typeName}: ${currentModel || 'not set'}\n\nAvailable models:\n`;
      models.forEach(m => {
        output += `  - ${m.name}${m.size ? ` (${m.size})` : ''}\n`;
      });
      output += `\nUse /model ${modelType === 'service' ? 'service ' : ''}<name> to switch.`;

      return { handled: true, response: output };
    } catch (error) {
      return this.createError(`Error fetching models: ${formatError(error)}`);
    }
  }

  /**
   * Format bytes into human-readable size
   */
  private formatSize(bytes: number): string {
    if (bytes < BYTE_CONVERSIONS.BYTES_PER_KB) return `${bytes}B`;
    if (bytes < BYTE_CONVERSIONS.BYTES_PER_MB)
      return `${(bytes / BYTE_CONVERSIONS.BYTES_PER_KB).toFixed(FORMATTING.FILE_SIZE_DECIMAL_PLACES)}KB`;
    if (bytes < BYTE_CONVERSIONS.BYTES_PER_GB)
      return `${(bytes / BYTE_CONVERSIONS.BYTES_PER_MB).toFixed(FORMATTING.FILE_SIZE_DECIMAL_PLACES)}MB`;
    return `${(bytes / BYTE_CONVERSIONS.BYTES_PER_GB).toFixed(FORMATTING.FILE_SIZE_DECIMAL_PLACES)}GB`;
  }
}
