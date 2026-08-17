import OpenAI from 'openai';
import {
  ModelClient,
  type LLMResponse,
  type ModelClientCapabilities,
  type ModelClientConfig,
  type SendOptions,
} from './ModelClient.js';
import type { FunctionDefinition, Message, ToolCall } from '../types/index.js';
import { ActivityEventType } from '../types/index.js';
import type { ActivityStream } from '../services/ActivityStream.js';
import type { ProviderCheckpointState } from '../agent/compaction/types.js';
import { parseToolCallArguments } from './FunctionCalling.js';

interface PreparedInput {
  input: any[];
  baseItems: any[];
  persistentInput: any[];
  coveredMessageIds: string[];
  pendingAssistant?: { content: string; toolCallIds: string[] };
  instructions?: string;
}

function baseUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '');
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function assistantMatches(
  message: Message,
  pending: { content: string; toolCallIds: string[] },
): boolean {
  if (message.role !== 'assistant') return false;
  const ids = (message.tool_calls ?? []).map(call => call.id);
  return message.content === pending.content
    && ids.length === pending.toolCallIds.length
    && ids.every((id, index) => id === pending.toolCallIds[index]);
}

/** Official Responses API transport with locally persisted, store:false item replay. */
export class OpenAIResponsesClient extends ModelClient {
  private client: OpenAI;
  private _endpoint: string;
  private _modelName: string;
  private _temperature?: number;
  private _maxTokens: number;
  private _reasoningEffort?: string;
  private readonly apiKey?: string;
  private readonly activityStream?: ActivityStream;
  private contextWindow: number;

  constructor(config: ModelClientConfig) {
    super();
    this._endpoint = config.endpoint;
    this._modelName = config.modelName ?? '';
    this._temperature = config.temperature;
    this._maxTokens = config.maxTokens;
    this._reasoningEffort = config.reasoningEffort;
    this.contextWindow = config.contextSize;
    this.apiKey = config.apiKey;
    this.activityStream = config.activityStream;
    this.client = this.createClient();
  }

  override get providerId(): string {
    return 'openai-responses';
  }

  override get capabilities(): ModelClientCapabilities {
    return { nativeCompaction: true, exactInputTokens: true, opaqueReasoningReplay: true };
  }

  get modelName(): string { return this._modelName; }
  get endpoint(): string { return this._endpoint; }

  setModelName(modelName: string): void { this._modelName = modelName; }
  setEndpoint(endpoint: string): void {
    this._endpoint = endpoint;
    this.client = this.createClient();
  }
  setTemperature(temperature: number | undefined): void { this._temperature = temperature; }
  setMaxTokens(maxTokens: number): void { this._maxTokens = maxTokens; }
  setContextSize(contextWindow: number): void { this.contextWindow = contextWindow; }
  setReasoningEffort(effort: string | undefined): void { this._reasoningEffort = effort; }

  async close(): Promise<void> {
    // The SDK owns no persistent resources that require explicit teardown.
  }

  private createClient(): OpenAI {
    return new OpenAI({
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
      baseURL: baseUrl(this._endpoint),
    });
  }

  async send(messages: readonly Message[], options: SendOptions): Promise<LLMResponse> {
    const prepared = this.prepareInput(messages, options.providerState);
    const payload = this.payload(prepared, options);
    try {
      const response = options.stream
        ? await this.streamResponse(payload, options)
        : await this.client.responses.create(payload as any, { signal: options.signal });
      return this.toResult(response as any, prepared);
    } catch (error) {
      if (options.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return { role: 'assistant', content: '', interrupted: true };
      }
      throw error;
    }
  }

  override async countInput(messages: readonly Message[], options: SendOptions): Promise<number | null> {
    const prepared = this.prepareInput(messages, options.providerState);
    const payload = this.payload(prepared, { ...options, stream: false });
    const { stream: _stream, store: _store, context_management: _context, max_output_tokens: _max, ...countable } = payload as any;
    const response = await this.client.responses.inputTokens.count(countable, { signal: options.signal });
    return response.input_tokens;
  }

  override async compactProviderState(
    messages: readonly Message[],
    options: SendOptions,
  ): Promise<ProviderCheckpointState | null> {
    const prepared = this.prepareInput(messages, options.providerState);
    const tools = this.tools(options.functions);
    const compacted = await this.client.responses.compact({
      model: this._modelName,
      input: prepared.input as any,
      ...(prepared.instructions ? { instructions: prepared.instructions } : {}),
      ...(tools.length ? { tools: tools as any } : {}),
    } as any, { signal: options.signal });

    return {
      kind: 'openai-responses',
      provider: 'openai-responses',
      model: this._modelName,
      // Standalone compact output is the canonical next window; never prune it.
      items: structuredClone((compacted as any).output ?? []),
      coveredMessageIds: prepared.coveredMessageIds,
      ...(prepared.pendingAssistant ? { pendingAssistant: prepared.pendingAssistant } : {}),
    };
  }

  private payload(prepared: PreparedInput, options: SendOptions): Record<string, unknown> {
    const tools = this.tools(options.functions);
    const reasoningModel = /^(?:o\d|gpt-5(?:\.|-|$))/i.test(this._modelName);
    const outputReserve = Math.min(this._maxTokens, Math.max(2048, Math.floor(this.contextWindow * 0.12)));
    const safetyReserve = Math.max(512, Math.floor(this.contextWindow * 0.05));
    const compactThreshold = Math.max(1, Math.min(
      Math.floor(this.contextWindow * 0.8),
      this.contextWindow - outputReserve - safetyReserve,
    ));
    return {
      model: this._modelName,
      input: prepared.input,
      store: false,
      stream: Boolean(options.stream),
      max_output_tokens: options.dynamicMaxTokens ?? this._maxTokens,
      context_management: [{ type: 'compaction', compact_threshold: compactThreshold }],
      ...(reasoningModel ? { include: ['reasoning.encrypted_content'] } : {}),
      ...(prepared.instructions ? { instructions: prepared.instructions } : {}),
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      ...(options.responseSchema ? {
        text: {
          format: {
            type: 'json_schema',
            name: options.responseSchema.name,
            strict: true,
            schema: options.responseSchema.schema,
          },
        },
      } : {}),
      ...(reasoningModel && this._reasoningEffort ? {
        reasoning: { effort: this._reasoningEffort, context: 'all_turns' },
      } : {}),
      // Reasoning models reject temperature. Conventional models receive it
      // only when explicitly configured, preserving the provider default.
      ...(reasoningModel || options.temperature === undefined && this._temperature === undefined
        ? {}
        : { temperature: options.temperature ?? this._temperature }),
    };
  }

  private tools(functions?: readonly FunctionDefinition[]): any[] {
    return (functions ?? []).map(tool => ({
      type: 'function',
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    }));
  }

  private prepareInput(
    messages: readonly Message[],
    providerState?: ProviderCheckpointState,
  ): PreparedInput {
    const state = providerState?.kind === 'openai-responses'
      ? providerState
      : { kind: 'openai-responses' as const, items: [], coveredMessageIds: [] };
    const covered = new Set(state.coveredMessageIds);
    let pending = state.pendingAssistant;
    const persistentInput: any[] = [];
    const ephemeralInput: any[] = [];
    const instructions: string[] = [];

    for (const message of messages) {
      if (message.role === 'system' && !message.metadata?.ephemeral) {
        if (message.content.trim()) instructions.push(message.content);
        continue;
      }
      if (message.id && covered.has(message.id)) continue;
      if (pending && assistantMatches(message, pending)) {
        if (message.id) covered.add(message.id);
        pending = undefined;
        continue;
      }
      const items = this.messageItems(message);
      if (message.metadata?.ephemeral) {
        ephemeralInput.push(...items);
      } else {
        persistentInput.push(...items);
        if (message.id) covered.add(message.id);
      }
    }

    return {
      input: [...state.items, ...persistentInput, ...ephemeralInput],
      baseItems: state.items,
      persistentInput,
      coveredMessageIds: [...covered],
      ...(pending ? { pendingAssistant: pending } : {}),
      ...(instructions.length ? { instructions: instructions.join('\n\n') } : {}),
    };
  }

  private messageItems(message: Message): any[] {
    if (message.role === 'tool') {
      return [{ type: 'function_call_output', call_id: message.tool_call_id, output: message.content ?? '' }];
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const items = message.tool_calls.map(call => this.functionCallItem(call));
      if (message.content.trim()) {
        items.unshift({ type: 'message', role: 'assistant', content: message.content });
      }
      return items;
    }
    if (message.role === 'user' && message.images?.length) {
      return [{
        type: 'message',
        role: 'user',
        content: [
          ...(message.content ? [{ type: 'input_text', text: message.content }] : []),
          ...message.images.map(image => ({
            type: 'input_image',
            image_url: image.startsWith('data:') ? image : `data:image/png;base64,${image}`,
          })),
        ],
      }];
    }
    return [{
      type: 'message',
      role: message.role === 'system' ? 'user' : message.role,
      content: message.content ?? '',
    }];
  }

  private functionCallItem(call: ToolCall): any {
    return {
      type: 'function_call',
      call_id: call.id,
      name: call.function.name,
      arguments: JSON.stringify(parseToolCallArguments(call.function.arguments as any)),
    };
  }

  private async streamResponse(payload: Record<string, unknown>, options: SendOptions): Promise<any> {
    const stream = this.client.responses.stream(payload as any, { signal: options.signal });
    const activity: ActivityStream | undefined = options.activityStream ?? this.activityStream;
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        activity?.emit({
          id: `openai-text-${Date.now()}`,
          type: ActivityEventType.ASSISTANT_CHUNK,
          timestamp: Date.now(),
          parentId: options.parentId,
          data: { chunk: event.delta },
        });
      } else if (event.type === 'response.reasoning_summary_text.delta' && !options.suppressThinking) {
        activity?.emit({
          id: `openai-reasoning-${Date.now()}`,
          type: ActivityEventType.THOUGHT_CHUNK,
          timestamp: Date.now(),
          parentId: options.parentId,
          data: { chunk: event.delta, thinking: true },
        });
      }
    }
    return { ...(await stream.finalResponse()), __streamed: true };
  }

  private toResult(response: any, prepared: PreparedInput): LLMResponse {
    const output = Array.isArray(response.output) ? response.output : [];
    const toolCalls = output
      .filter((item: any) => item?.type === 'function_call')
      .map((item: any) => ({
        id: item.call_id,
        type: 'function' as const,
        function: {
          name: item.name,
          arguments: parseToolCallArguments(item.arguments),
        },
      }));
    const reasoning = output
      .filter((item: any) => item?.type === 'reasoning')
      .flatMap((item: any) => item.summary ?? [])
      .map((part: any) => part.text ?? '')
      .filter(Boolean)
      .join('\n');
    // Persist the canonical replay stream without per-request ephemeral input.
    let items = [...prepared.baseItems, ...prepared.persistentInput, ...output];
    const lastCompaction = items.map((item: any) => item?.type).lastIndexOf('compaction');
    if (lastCompaction >= 0) items = items.slice(lastCompaction);

    const content = response.output_text ?? '';
    return {
      role: 'assistant',
      content,
      ...(response.__streamed ? {
        _content_was_streamed: true,
        _should_replace_streaming: true,
      } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(reasoning ? { thinking: reasoning } : {}),
      usage: {
        promptTokens: response.usage?.input_tokens,
        completionTokens: response.usage?.output_tokens,
      },
      providerState: {
        kind: 'openai-responses',
        provider: 'openai-responses',
        model: this._modelName,
        items: structuredClone(items),
        coveredMessageIds: prepared.coveredMessageIds,
        pendingAssistant: { content, toolCallIds: toolCalls.map((call: any) => call.id) },
      },
      nativeCompaction: lastCompaction >= 0,
    };
  }
}
