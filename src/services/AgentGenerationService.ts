/**
 * AgentGenerationService - LLM-powered agent configuration generation
 *
 * Uses the service model client to generate agent configurations from detailed descriptions.
 * Follows the SessionTitleGenerator pattern for background LLM tasks.
 */

import type { ModelClient } from '../llm/ModelClient.js';
import { validateAgentName } from '../utils/namingValidation.js';
import type { CancellableService } from '../types/CancellableService.js';

export interface AgentGenerationResult {
  name: string;
  description: string;
  systemPrompt: string;
}

export class AgentGenerationService implements CancellableService {
  private modelClient: ModelClient;
  private isGenerating = false;

  constructor(modelClient: ModelClient) {
    this.modelClient = modelClient;
  }

  /**
   * Generate agent configuration from detailed description
   */
  async generateAgent(detailedDescription: string): Promise<AgentGenerationResult> {
    this.isGenerating = true;

    try {
      // Build the generation prompt
      const prompt = this.buildGenerationPrompt(detailedDescription);

      // Call the model (non-streaming)
      const response = await this.modelClient.send(
        [{ role: 'user', content: prompt }],
        {
          stream: false,
          suppressThinking: true, // Don't show thinking for background agent generation
        }
      );

      const result = this.parseResponse(response.content);
      this.isGenerating = false;

      return result;
    } catch (error) {
      this.isGenerating = false;
      throw error;
    }
  }

  /**
   * Build the LLM prompt for agent generation
   */
  private buildGenerationPrompt(detailedDescription: string): string {
    return `You are helping a user create a custom AI agent. Based on their detailed description, generate the following:

1. **Agent Name**: A concise, URL-friendly name (lowercase, hyphens, numbers only). Keep it short and descriptive.
2. **Brief Description**: A one-sentence summary (max 100 chars) for listings.
3. **System Prompt**: A detailed system prompt that will guide this agent's behavior.

User's detailed description:
${detailedDescription}

IMPORTANT: Respond ONLY with valid JSON in this exact format:
{
  "name": "agent-name-here",
  "description": "Brief one-sentence description here",
  "systemPrompt": "Detailed system prompt here. Can be multiple paragraphs."
}

Do not include any text before or after the JSON. The name must be lowercase with hyphens only.`;
  }

  /**
   * Parse and validate the LLM response
   */
  private parseResponse(content: string): AgentGenerationResult {
    // Clean the response - remove markdown code blocks if present
    let cleaned = content.trim();

    // Remove markdown code blocks
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.substring(7);
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.substring(3);
    }

    if (cleaned.endsWith('```')) {
      cleaned = cleaned.substring(0, cleaned.length - 3);
    }

    cleaned = cleaned.trim();

    try {
      const parsed = JSON.parse(cleaned);

      // Validate required fields
      if (!parsed.name || !parsed.description || !parsed.systemPrompt) {
        throw new Error('Missing required fields in generated agent configuration');
      }

      // Validate name format using strict validation utility
      const nameValidation = validateAgentName(parsed.name);
      if (!nameValidation.valid) {
        throw new Error(nameValidation.error);
      }

      return {
        name: parsed.name,
        description: parsed.description,
        systemPrompt: parsed.systemPrompt,
      };
    } catch (error) {
      throw new Error(`Failed to parse agent generation response: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Cancel ongoing generation
   */
  cancel(): void {
    if (this.isGenerating) {
      if (typeof this.modelClient.cancel === 'function') {
        this.modelClient.cancel();
      }
      this.isGenerating = false;
    }
  }

}
