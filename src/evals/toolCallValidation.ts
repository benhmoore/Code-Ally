/** Dry-run the same schema and semantic validators used by tool execution. */
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { createBuiltInTools } from '../tools/createBuiltInTools.js';
import { ToolValidator, type ValidationResult } from '../tools/ToolValidator.js';
import type { Config, ToolCall } from '../types/index.js';

export function validateRuntimeToolCall(call: ToolCall, config: Readonly<Config> = DEFAULT_CONFIG): ValidationResult {
  const tool = createBuiltInTools(new ActivityStream(), config).find(candidate => candidate.name === call.function.name);
  if (!tool) return { valid: false, error: `No built-in validator for ${call.function.name}` };
  return new ToolValidator().validateArguments(tool, tool.getFunctionDefinition(), call.function.arguments);
}
