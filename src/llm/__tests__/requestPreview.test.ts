import { describe, expect, it } from 'vitest';
import type { FunctionDefinition, Message } from '../../types/index.js';
import { ModelClient, type LLMResponse, type SendOptions } from '../ModelClient.js';
import { OllamaClient } from '../OllamaClient.js';
import { OpenAICompatClient } from '../OpenAICompatClient.js';
import { OpenAIResponsesClient } from '../OpenAIResponsesClient.js';

const tools: FunctionDefinition[] = [{
  type: 'function',
  function: {
    name: 'read',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  },
}];

const messages: Message[] = [
  { role: 'system', content: 'Stable instructions' },
  { role: 'user', content: 'Inspect it' },
  {
    role: 'system',
    content: '<system-reminder>Current context</system-reminder>',
    metadata: { ephemeral: true },
  },
];

const requestOptions = (): SendOptions => ({
  functions: tools,
  stream: true,
  dynamicMaxTokens: 4096,
  signal: new AbortController().signal,
});

class BareModelClient extends ModelClient {
  get modelName(): string { return 'bare'; }
  get endpoint(): string { return 'http://bare'; }
  async send(): Promise<LLMResponse> { return { role: 'assistant', content: '' }; }
}

describe('model request previews', () => {
  it('uses the production Ollama serializer without sending', async () => {
    const client = new OllamaClient({
      endpoint: 'http://localhost:11434',
      modelName: 'qwen3.8:27b-mlx',
      contextSize: 131072,
      maxTokens: 16384,
      reasoningEffort: 'low',
    });
    const preview = client.previewRequest(messages, requestOptions());

    expect(preview.provider).toBe('ollama');
    expect(preview.url).toBe('http://localhost:11434/api/chat');
    expect(preview.payload).toMatchObject({
      model: 'qwen3.8:27b-mlx',
      stream: true,
      think: 'low',
      tool_choice: 'auto',
      options: { num_ctx: 131072, num_predict: 4096 },
    });
    expect((preview.payload.messages as Message[]).map(message => message.role))
      .toEqual(['system', 'user', 'user']);
    expect(preview.payload.tools).toEqual(tools);
    expect((preview.payload.options as Record<string, unknown>).temperature).toBeUndefined();

    client.setEndpoint('http://localhost:11435');
    client.setModelName('updated');
    client.setTemperature(0);
    client.setContextSize(65536);
    client.setMaxTokens(8192);
    client.setReasoningEffort('high');
    const updated = client.previewRequest(messages, requestOptions());
    expect(client.endpoint).toBe('http://localhost:11435');
    expect(client.modelName).toBe('updated');
    expect(updated.url).toBe('http://localhost:11435/api/chat');
    expect(updated.payload).toMatchObject({
      model: 'updated',
      options: { num_ctx: 65536, num_predict: 4096, temperature: 0 },
    });
    await client.close();
  });

  it('uses the production chat-completions serializer without sending', async () => {
    const client = new OpenAICompatClient({
      endpoint: 'http://localhost:8000',
      modelName: 'initial',
      contextSize: 32768,
      maxTokens: 2048,
      reasoningEffort: 'low',
    });
    client.setEndpoint('http://localhost:9000/v1');
    client.setModelName('updated');
    client.setTemperature(0);
    client.setContextSize(65536);
    client.setMaxTokens(8192);
    client.setReasoningEffort('high');

    const preview = client.previewRequest(messages, requestOptions());

    expect(client.endpoint).toBe('http://localhost:9000/v1');
    expect(client.modelName).toBe('updated');
    expect(preview.provider).toBe('openai-compat');
    expect(preview.url).toBe('http://localhost:9000/v1/chat/completions');
    expect(preview.payload).toMatchObject({
      model: 'updated',
      stream: true,
      max_tokens: 4096,
      temperature: 0,
      tools,
    });
    await client.close();
  });

  it('uses the production Responses serializer without sending', async () => {
    const client = new OpenAIResponsesClient({
      endpoint: 'https://api.openai.com/v1',
      modelName: 'initial',
      contextSize: 32768,
      maxTokens: 2048,
      apiKey: 'test-key',
      reasoningEffort: 'low',
    });
    client.setEndpoint('https://example.test/v1');
    client.setModelName('updated');
    client.setTemperature(0);
    client.setContextSize(65536);
    client.setMaxTokens(8192);
    client.setReasoningEffort('high');

    const preview = client.previewRequest(messages, requestOptions());

    expect(client.providerId).toBe('openai-responses');
    expect(client.capabilities).toEqual({
      nativeCompaction: true,
      exactInputTokens: true,
      opaqueReasoningReplay: true,
    });
    expect(client.endpoint).toBe('https://example.test/v1');
    expect(client.modelName).toBe('updated');
    expect(preview.provider).toBe('openai-responses');
    expect(preview.url).toBe('https://example.test/v1/responses');
    expect(preview.payload).toMatchObject({ model: 'updated', stream: true, max_output_tokens: 4096 });
    expect(preview.payload.tools).toEqual([{
      type: 'function',
      name: 'read',
      description: 'Read a file',
      parameters: tools[0]!.function.parameters,
    }]);
    await client.close();
  });

  it('keeps optional request diagnostics inert for providers without a preview', async () => {
    const client = new BareModelClient();
    const options = requestOptions();

    expect(client.providerId).toBe('chat');
    expect(client.capabilities).toEqual({
      nativeCompaction: false,
      exactInputTokens: false,
      opaqueReasoningReplay: false,
    });
    expect(client.previewRequest(messages, options)).toBeNull();
    await expect(client.countInput(messages, options)).resolves.toBeNull();
    await expect(client.compactProviderState(messages, options)).resolves.toBeNull();
  });
});
