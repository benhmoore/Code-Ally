import { describe, it, expect, beforeEach } from 'vitest';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry, ScopedServiceRegistryProxy } from '@services/ServiceRegistry.js';
import type { ParameterSchema, ToolExecutionContext, ToolResult } from '@shared/index.js';
import { StructuredOutputTool, STRUCTURED_OUTPUT_TOOL } from '../StructuredOutputTool.js';

const SCHEMA: ParameterSchema = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['fingerprint', 'outcome', 'summary'],
        properties: {
          fingerprint: { type: 'string' },
          outcome: { enum: ['fixed', 'dismissed', 'escalated', 'skipped', 'resolved'] },
          repo: { type: 'string' },
          summary: { type: 'string' },
        },
      },
    },
  },
};

const VALID = {
  results: [{ fingerprint: 'abc123', outcome: 'escalated', summary: 'Needs the DBA.' }],
};

describe('StructuredOutputTool', () => {
  let tool: StructuredOutputTool;
  let recorded: unknown[];
  let context: ToolExecutionContext;

  /** Run the tool against a scoped registry so no global state is touched. */
  function run(args: Record<string, unknown>, withSink = true): Promise<ToolResult> {
    return tool.execute(args, undefined, undefined, false, false, withSink ? context : {});
  }

  beforeEach(() => {
    recorded = [];
    tool = new StructuredOutputTool(new ActivityStream(), SCHEMA);
    const scope = new ScopedServiceRegistryProxy(ServiceRegistry.getInstance());
    scope.registerInstance('structured_output_sink', {
      set: value => { recorded.push(value); },
    });
    context = { registryScope: scope };
  });

  it('presents the caller schema as its own parameters', () => {
    const { function: definition } = tool.getFunctionDefinition();

    expect(definition.name).toBe(STRUCTURED_OUTPUT_TOOL);
    expect(definition.parameters).toEqual({
      type: 'object',
      properties: SCHEMA.properties,
      required: ['results'],
    });
  });

  it('needs no confirmation and reports no effect', () => {
    expect(tool.requiresConfirmation(VALID)).toBe(false);
    expect(tool.effectFor(VALID)).toBe('read_only');
  });

  it('stores a payload that matches the schema', async () => {
    const result = await run(VALID);

    expect(result.success).toBe(true);
    expect(recorded).toEqual([VALID]);
  });

  it('rejects a value outside an enum and names its path', async () => {
    const result = await run({
      results: [{ fingerprint: 'abc123', outcome: 'maybe', summary: 'Unclear.' }],
    });

    expect(result.success).toBe(false);
    expect(result.error_type).toBe('validation_error');
    expect(result.error).toContain('$.results[0].outcome');
    expect(recorded).toEqual([]);
  });

  it('rejects a missing nested property and names its path', async () => {
    const result = await run({
      results: [{ fingerprint: 'abc123', outcome: 'fixed' }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('$.results[0].summary');
    expect(recorded).toEqual([]);
  });

  it('reports a missing sink rather than dropping the payload', async () => {
    const result = await run(VALID, false);

    expect(result.success).toBe(false);
    expect(result.error_type).toBe('system_error');
  });
});
