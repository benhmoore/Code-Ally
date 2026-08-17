import { createHash } from 'node:crypto';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { tokenCounter } from '../services/TokenCounter.js';
import { createBuiltInTools } from '../tools/createBuiltInTools.js';
import {
  getRuntimeToolExclusions,
  type RuntimeToolSelectionContext,
} from '../tools/runtimeToolSelection.js';
import { ToolManager } from '../tools/ToolManager.js';
import type { Config, FunctionDefinition } from '../types/index.js';

/** Tools hidden from an interactive root agent by the durable-run policy. */
const DURABLE_ROOT_EXCLUSIONS = [
  'complete-objective',
  'block-objective',
  'reconcile-effect',
] as const;

export const INTERACTIVE_ROOT_EXCLUSIONS = [
  ...DURABLE_ROOT_EXCLUSIONS,
  ...getRuntimeToolExclusions({ planModeActive: false }),
] as const;

/**
 * Produce the same built-in schemas an interactive root Ally receives.
 * Contextual MCP/plugin tools are intentionally a separate profile because
 * their availability is installation-dependent and must be captured explicitly.
 */
export function createRuntimeCoreToolDefinitions(
  config: Readonly<Config> = DEFAULT_CONFIG,
): FunctionDefinition[] {
  return createRuntimeCoreToolDefinitionsForContext({ planModeActive: false }, config);
}

export function createRuntimeCoreToolDefinitionsForContext(
  context: RuntimeToolSelectionContext,
  config: Readonly<Config> = DEFAULT_CONFIG,
): FunctionDefinition[] {
  const stream = new ActivityStream();
  const manager = new ToolManager(createBuiltInTools(stream, config));
  return manager.getFunctionDefinitions([
    ...DURABLE_ROOT_EXCLUSIONS,
    ...getRuntimeToolExclusions(context),
  ], 'ally');
}

export interface ToolProfileMetadata {
  sha256: string;
  count: number;
  characters: number;
  estimatedTokens: number;
  names: string[];
  definitions: FunctionDefinition[];
}

export function describeToolProfile(definitions: FunctionDefinition[]): ToolProfileMetadata {
  const serialized = JSON.stringify(definitions);
  return {
    sha256: createHash('sha256').update(serialized).digest('hex'),
    count: definitions.length,
    characters: serialized.length,
    estimatedTokens: tokenCounter.count(serialized),
    names: definitions.map(definition => definition.function.name),
    definitions,
  };
}

/** Normalize the two provider shapes used by Ollama/chat-completions and Responses. */
export function normalizeProviderToolDefinitions(values: unknown[]): FunctionDefinition[] {
  return values.map((value, index) => {
    const candidate = value as any;
    if (candidate?.type === 'function' && candidate.function?.name && candidate.function?.parameters) {
      return candidate as FunctionDefinition;
    }
    if (candidate?.type === 'function' && candidate.name && candidate.parameters) {
      return {
        type: 'function',
        function: {
          name: candidate.name,
          description: candidate.description ?? '',
          parameters: candidate.parameters,
        },
      } as FunctionDefinition;
    }
    throw new Error(`Unsupported provider tool definition at index ${index}`);
  });
}
