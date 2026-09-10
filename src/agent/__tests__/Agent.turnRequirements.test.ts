/**
 * Requirements are per turn for the root agent. A stream-json session sends
 * many messages down one agent, and turn two has to earn its own payload
 * rather than inherit the successful call turn one made.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
});
