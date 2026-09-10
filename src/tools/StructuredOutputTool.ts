/**
 * StructuredOutputTool - the caller's schema as a tool.
 *
 * Registered only when `--json-schema` is given, so an interactive run never
 * sees it. Its parameters are the caller-supplied schema verbatim, which makes
 * the final answer a tool call the model must get right rather than prose a
 * consumer has to parse. `RequirementValidator` keeps the turn open until the
 * call succeeds.
 */

import { BaseTool } from './BaseTool.js';
import { ToolCapability } from './ToolCapability.js';
import { ToolValidator } from './ToolValidator.js';
import type { ActivityStream } from '../services/ActivityStream.js';
import type {
  FunctionDefinition,
  ParameterSchema,
  ToolExecutionContext,
  ToolResult,
} from '../types/index.js';

/** The tool's Ally name, shared with the requirement list that demands it. */
export const STRUCTURED_OUTPUT_TOOL = 'structured-output';

/**
 * Where a validated payload goes.
 *
 * One method, so the tool reaches the headless session through the registry
 * without depending on the session type.
 */
export interface StructuredOutputSink {
  set(value: unknown): void;
}

export class StructuredOutputTool extends BaseTool {
  readonly name = STRUCTURED_OUTPUT_TOOL;
  readonly description =
    'Record the final answer as JSON matching the required schema. Call this once, before ending the turn.';
  readonly capabilities: readonly ToolCapability[] = [];
  readonly visibleInChat = false;
  readonly hideOutput = true;

  private readonly schema: ParameterSchema;
  private readonly validator = new ToolValidator();

  constructor(activityStream: ActivityStream, schema: ParameterSchema) {
    super(activityStream);
    this.schema = schema;
  }

  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: this.schema.properties ?? {},
          ...(this.schema.required ? { required: this.schema.required } : {}),
          ...(this.schema.additionalProperties === undefined
            ? {}
            : { additionalProperties: this.schema.additionalProperties }),
        },
      },
    };
  }

  protected async executeImpl(
    args: Record<string, unknown>,
    _toolCallId?: string,
    _isUserInitiated?: boolean,
    _isContextFile?: boolean,
    executionContext?: ToolExecutionContext,
  ): Promise<ToolResult> {
    this.captureParams(args);

    const checked = this.validator.validateValue(args, this.schema);
    if (!checked.valid) {
      return this.formatErrorResponse(
        `Output does not match the required schema: ${checked.error}`,
        'validation_error',
        'Correct the value at that path and call structured-output again.',
      );
    }

    const sink = this.getExecutionRegistry(executionContext).get('structured_output_sink');
    if (!sink) {
      return this.formatErrorResponse(
        'No structured output sink is registered for this run',
        'system_error',
      );
    }
    sink.set(args);

    return this.formatSuccessResponse({ content: 'Structured output recorded.' });
  }
}
