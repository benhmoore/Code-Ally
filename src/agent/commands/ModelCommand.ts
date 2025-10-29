/**
 * ModelCommand - Change AI model
 *
 * Handles model selection for both ally and service models.
 * - No args: Shows interactive model selector UI
 * - "service <name>": Sets service model
 * - "<name>": Sets ally model
 */

import { Command } from './Command.js';
import type { Message } from '../../types/index.js';
import { ActivityEventType } from '../../types/index.js';
import type { ServiceRegistry } from '../../services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { ConfigManager } from '../../services/ConfigManager.js';
import { formatError } from '../../utils/errorUtils.js';
import { BYTE_CONVERSIONS, FORMATTING } from '../../config/constants.js';

export class ModelCommand extends Command {
  readonly name = '/model';
  readonly description = 'Change AI model';

  // Use yellow output for direct model changes
  protected readonly useYellowOutput = true;

  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const configManager = serviceRegistry.get<ConfigManager>('config_manager');

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
      try {
        const configKey = modelType === 'service' ? 'service_model' : 'model';
        await configManager.setValue(configKey, modelName);

        // Update the active ModelClient to use the new model immediately
        const clientKey = modelType === 'service' ? 'service_model_client' : 'model_client';
        const modelClient = serviceRegistry.get<any>(clientKey);
        if (modelClient && typeof modelClient.setModelName === 'function') {
          modelClient.setModelName(modelName);
        }

        const typeName = modelType === 'service' ? 'Service model' : 'Model';
        return this.createResponse(`${typeName} changed to: ${modelName}`);
      } catch (error) {
        return this.createError(`Error changing model: ${formatError(error)}`);
      }
    }

    // No model name - show interactive selector
    try {
      const configKey = modelType === 'service' ? 'service_model' : 'model';
      const currentModel = configManager.getValue(configKey);
      const config = configManager.getConfig();
      const endpoint = config.endpoint || 'http://localhost:11434';

      // Fetch available models from Ollama
      const response = await fetch(`${endpoint}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return this.createError(
          `Failed to fetch models from Ollama (HTTP ${response.status}). Try /model <name> to set directly.`
        );
      }

      const data = (await response.json()) as { models?: Array<{ name: string; size?: number; modified_at?: string }> };
      const models = (data.models || []).map(m => ({
        name: m.name,
        size: m.size ? this.formatSize(m.size) : undefined,
        modified: m.modified_at,
      }));

      if (models.length === 0) {
        return this.createResponse('No models available in Ollama. Install models with: ollama pull <model>');
      }

      // Emit interactive selection request
      const activityStream = serviceRegistry.get('activity_stream');
      if (activityStream && typeof (activityStream as any).emit === 'function') {
        const requestId = `model_select_${Date.now()}`;
        const typeName = modelType === 'service' ? 'service model' : 'ally model';

        (activityStream as any).emit({
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
