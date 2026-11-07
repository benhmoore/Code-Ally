/**
 * Requirements are per turn for the root agent. A stream-json session sends
 * many messages down one agent, and turn two has to earn its own payload
 * rather than inherit the successful call turn one made.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolSearchTool } from '@tools/ToolSearchTool.js';
import { BaseTool } from '@tools/BaseTool.js';
import type { FunctionDefinition, ToolResult } from '@shared/index.js';
import type { SendOptions } from '@llm/ModelClient.js';
import { Agent } from '../Agent.js';
import { ToolManager } from '@tools/ToolManager.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { StructuredOutputTool, STRUCTURED_OUTPUT_TOOL } from '@tools/StructuredOutputTool.js';
import type { Config, Message } from '@shared/index.js';
import type { LLMResponse, ModelClient } from '@llm/ModelClient.js';

const config = {
  model: 'test-model',
  endpoint: 'http://localhost:11434',
  context_size: 8192,
  temperature: 0.7,
  max_tokens: 2048,
  bash_timeout: 120000,
  auto_confirm: true,
  parallel_tools: false,
  theme: 'default',
  stream_responses: false,
  setup_completed: true,
} as unknown as Config;

const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
} as any;

function toolCallResponse(answer: string, id: string): LLMResponse {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [
      { id, type: 'function', function: { name: STRUCTURED_OUTPUT_TOOL, arguments: { answer } } },
    ],
  } as unknown as LLMResponse;
}

function textResponse(content: string): LLMResponse {
  return { role: 'assistant', content, tool_calls: [] } as unknown as LLMResponse;
}

describe('root agent requirements across turns', () => {
  let recorded: unknown[];
  let agent: Agent;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    recorded = [];
    ServiceRegistry.getInstance().registerInstance('structured_output_sink', {
      set: (value: unknown) => recorded.push(value),
    });
    const activityStream = new ActivityStream();
    send = vi.fn(async (_messages: Message[]) => textResponse('done'));
    agent = new Agent(
      { send, close: vi.fn(), cancel: vi.fn(), setModelName: vi.fn() } as unknown as ModelClient,
      new ToolManager([new StructuredOutputTool(activityStream, schema)]),
      activityStream,
      {
        config,
        isSpecializedAgent: false,
        requirements: {
          required_tools_all: [STRUCTURED_OUTPUT_TOOL],
          reminder_message: `Record your final answer with the ${STRUCTURED_OUTPUT_TOOL} tool before ending your turn.`,
        },
      },
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it('keeps legacy and all/one-of requirement schemas exposed with normalized names', async () => {
    class RequirementTool extends BaseTool {
      readonly capabilities = [] as const;
      readonly description = 'Record a required action.';
      readonly name: string;
      constructor(stream: ActivityStream, name: string) { super(stream); this.name = name; }
      getFunctionDefinition(): FunctionDefinition {
        return { type: 'function', function: { name: this.name, description: this.description, parameters: { type: 'object', properties: {} } } };
      }
      protected async executeImpl(): Promise<ToolResult> { return { success: true }; }
    }
    const stream = new ActivityStream();
    const names = ['legacy-tool', 'web-fetch', 'ls'];
    let exposed: string[] = [];
    const clientSend = vi.fn(async (_messages: Message[], options: SendOptions) => {
      exposed = options.functions?.map(definition => definition.function.name) ?? [];
      if (clientSend.mock.calls.length === 1) {
        return { role: 'assistant', content: '', tool_calls: names.map((name, index) => ({ id: `required-${index}`, type: 'function', function: { name, arguments: {} } })) } as LLMResponse;
      }
      return textResponse('done');
    });
    const requiredAgent = new Agent(
      { send: clientSend, close: vi.fn(), cancel: vi.fn(), setModelName: vi.fn() } as unknown as ModelClient,
      new ToolManager([...names.map(name => new RequirementTool(stream, name)), new ToolSearchTool(stream)]),
      stream,
      { config, requiredToolCalls: ['legacy-tool'], requirements: { required_tools_all: ['WebFetch'], required_tools_one_of: ['LS'] } },
    );
    await requiredAgent.sendMessage('complete the required actions');
    expect(exposed).toEqual(expect.arrayContaining(names));
    await requiredAgent.cleanup();
  });

  it('forces the required call again on the second turn', async () => {
    send
      .mockResolvedValueOnce(toolCallResponse('first', 'call-1'))
      .mockResolvedValueOnce(textResponse('first turn done'))
      // Turn two opens with text only: without a per-turn reset the tracker
      // still holds turn one's call and lets this stand as the answer.
      .mockResolvedValueOnce(textResponse('second turn done'))
      .mockResolvedValueOnce(toolCallResponse('second', 'call-2'))
      .mockResolvedValueOnce(textResponse('second turn really done'));

    await agent.sendMessage('first');
    expect(recorded).toEqual([{ answer: 'first' }]);

    await agent.sendMessage('second');
    expect(recorded).toEqual([{ answer: 'first' }, { answer: 'second' }]);
    expect(send).toHaveBeenCalledTimes(5);
  });
  it('stops unmet requirements at the no-progress boundary instead of recursively requesting forever', async () => {
    send.mockResolvedValue(textResponse('still done'));
    const response = await agent.sendMessage('produce the structured result');
    expect(response).toContain('no new successful tool evidence');
    expect(send).toHaveBeenCalledTimes(12);
    expect(recorded).toEqual([]);
    expect(agent.getTurnSnapshot().terminationReason).toBe('no_progress');
    await agent.cleanup();
  });

});
