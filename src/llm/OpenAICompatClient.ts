/**
 * OpenAICompatClient - ModelClient for OpenAI-compatible /v1/chat/completions
 * backends (vLLM, llama.cpp's llama-server, LM Studio, TGI, and most cloud
 * open-model hosts, plus Ollama's own /v1 surface).
 *
 * Shares the retry policy, circuit breaker, error classification, and auth-header
 * rule with OllamaClient via ./httpTransport and ./requestHeaders. Only the wire
 * format differs: this client speaks SSE (`data: {...}`) with OpenAI-shaped
 * messages and tool calls, where tool-call arguments are JSON *strings* (not
 * objects) in both directions.
 */

import {
  ModelClient,
  ModelClientConfig,
  SendOptions,
  LLMResponse,
  SamplingParams,
} from './ModelClient.js';
import { Message, FunctionDefinition, ActivityEventType } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { logger } from '../services/Logger.js';
import { API_TIMEOUTS, ID_GENERATION, RETRY_CONFIG } from '../config/constants.js';
import { resolveModelProfile } from './modelProfile.js';
import { buildRequestHeaders } from './requestHeaders.js';
import { CircuitBreaker, runWithRetries } from './httpTransport.js';

/** OpenAI chat-completions request payload (the subset we send). */
interface OpenAIPayload {
  model: string;
  messages: any[];
  stream: boolean;
  stream_options?: { include_usage: boolean };
  temperature: number;
  max_tokens: number;
  top_p?: number;
  stop?: string[];
  // Non-standard but widely accepted by vLLM / llama.cpp; only sent when set.
  top_k?: number;
  min_p?: number;
  repetition_penalty?: number;
  reasoning_effort?: string;
  tools?: FunctionDefinition[];
  tool_choice?: string;
}

/** Map an OpenAI `usage` object to our internal usage shape. */
function openAIUsage(u: any): LLMResponse['usage'] | undefined {
  if (!u) return undefined;
  const promptTokens = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined;
  const completionTokens = typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined;
  if (promptTokens === undefined && completionTokens === undefined) return undefined;
  return { promptTokens, completionTokens };
}

export class OpenAICompatClient extends ModelClient {
  private _endpoint: string;
  private _modelName: string;
  private _temperature: number;
  private _maxTokens: number;
  private _reasoningEffort?: string;
  private readonly sampling?: SamplingParams;
  private readonly requestHeaders: Record<string, string>;
  private apiUrl: string;
  private readonly activityStream?: ActivityStream;

  private activeRequests: Map<string, AbortController> = new Map();
  private readonly breaker = new CircuitBreaker();

  constructor(config: ModelClientConfig) {
    super();
    this._endpoint = config.endpoint;
    this._modelName = config.modelName || '';
    this._temperature = config.temperature;
    this._maxTokens = config.maxTokens;
    this._reasoningEffort = config.reasoningEffort;
    this.sampling = config.sampling;
    this.requestHeaders = buildRequestHeaders({ apiKey: config.apiKey, headers: config.headers });
    this.activityStream = config.activityStream;
    this.apiUrl = this.buildApiUrl(this._endpoint);
  }

  get modelName(): string {
    return this._modelName;
  }

  get endpoint(): string {
    return this._endpoint;
  }

  /** Append /v1/chat/completions, tolerating endpoints already ending in /v1. */
  private buildApiUrl(endpoint: string): string {
    const base = endpoint.replace(/\/+$/, '');
    return /\/v1$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  }

  setEndpoint(newEndpoint: string): void {
    logger.debug(`[OPENAI_COMPAT] Changing endpoint from ${this._endpoint} to ${newEndpoint}`);
    this._endpoint = newEndpoint;
    this.apiUrl = this.buildApiUrl(newEndpoint);
    this.breaker.reset();
  }

  setModelName(newModelName: string): void {
    logger.debug(`[OPENAI_COMPAT] Changing model from ${this._modelName} to ${newModelName}`);
    this._modelName = newModelName;
  }

  setTemperature(newTemperature: number): void {
    this._temperature = newTemperature;
  }

  // OpenAI-compatible servers own the context window (num_ctx is set at model
  // load, not per request), so there is nothing client-side to update. Present
  // as a no-op to satisfy callers that adjust context size at runtime.
  setContextSize(_newContextSize: number): void {
    /* no-op for /v1 backends */
  }

  setMaxTokens(newMaxTokens: number): void {
    this._maxTokens = newMaxTokens;
  }

  setReasoningEffort(newReasoningEffort: string | undefined): void {
    this._reasoningEffort = newReasoningEffort;
  }

  async close(): Promise<void> {
    for (const [, controller] of this.activeRequests.entries()) {
      controller.abort();
    }
    this.activeRequests.clear();
  }

  async send(messages: readonly Message[], options: SendOptions): Promise<LLMResponse> {
    const { functions, stream = false, temperature, parentId, suppressThinking = false, dynamicMaxTokens, signal } = options;
    const eventStream: ActivityStream | undefined = options.activityStream ?? this.activityStream;

    const requestId = `req-${Date.now()}-${Math.random().toString(ID_GENERATION.RANDOM_STRING_RADIX).substring(ID_GENERATION.RANDOM_STRING_SUBSTRING_START, ID_GENERATION.RANDOM_STRING_SUBSTRING_START + ID_GENERATION.RANDOM_STRING_LENGTH_LONG)}`;
    const payload = this.preparePayload(messages, functions, stream, temperature, dynamicMaxTokens);

    try {
      return await runWithRetries<LLMResponse>({
        breaker: this.breaker,
        onRetry: (label, delaySec, attemptNum) => {
          logger.debug(`[OPENAI_COMPAT] ${label} on request ${requestId}, retrying in ${delaySec}s (attempt ${attemptNum})...`);
          this.emitStatusMessage(`${label}, retrying in ${delaySec}s...`);
        },
        onInterrupted: () => ({ role: 'assistant', content: '', interrupted: true }),
        onError: (error: any) => this.handleRequestError(error),
        attempt: (attempt) => this.executeRequest(requestId, payload, stream, attempt, signal, parentId, suppressThinking, eventStream),
      });
    } finally {
      this.activeRequests.delete(requestId);
    }
  }

  /** Build the OpenAI-shaped request payload from internal messages/functions. */
  private preparePayload(
    messages: readonly Message[],
    functions?: FunctionDefinition[],
    stream: boolean = false,
    temperature?: number,
    dynamicMaxTokens?: number
  ): OpenAIPayload {
    const payload: OpenAIPayload = {
      model: this._modelName,
      messages: messages.map(m => this.toOpenAIMessage(m)),
      stream,
      temperature: temperature !== undefined ? temperature : this._temperature,
      max_tokens: dynamicMaxTokens ?? this._maxTokens,
    };

    // Ask the server to emit a final usage chunk for token calibration.
    if (stream) {
      payload.stream_options = { include_usage: true };
    }

    if (this.sampling) {
      const { top_p, top_k, min_p, repeat_penalty, stop } = this.sampling;
      if (top_p !== undefined) payload.top_p = top_p;
      if (top_k !== undefined) payload.top_k = top_k;
      if (min_p !== undefined) payload.min_p = min_p;
      if (repeat_penalty !== undefined) payload.repetition_penalty = repeat_penalty;
      if (stop !== undefined && stop.length > 0) payload.stop = stop;
    }

    // Only gpt-oss-style backends take reasoning_effort over the /v1 API; the
    // `think` boolean is Ollama-native and has no /v1 equivalent, so it is omitted.
    const profile = resolveModelProfile(this._modelName);
    if (profile.reasoningControl === 'reasoning_effort' && this._reasoningEffort) {
      payload.reasoning_effort = this._reasoningEffort;
    }

    if (functions && functions.length > 0) {
      payload.tools = functions;
      payload.tool_choice = 'auto';
    }

    return payload;
  }

  /**
   * Convert an internal message to OpenAI chat-completions shape. The key
   * differences from the native format: tool-call arguments are serialized to
   * JSON strings, native `thinking` is dropped (not a request field), and images
   * become a multimodal content array.
   */
  private toOpenAIMessage(m: Message): any {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content ?? '' };
    }

    if (m.role === 'assistant') {
      const out: any = { role: 'assistant', content: m.content || '' };
      if (m.tool_calls && m.tool_calls.length > 0) {
        out.tool_calls = m.tool_calls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: typeof tc.function.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments ?? {}),
          },
        }));
        // OpenAI allows null content alongside tool calls.
        if (!m.content) out.content = null;
      }
      return out;
    }

    // system / user
    if (m.role === 'user' && m.images && m.images.length > 0) {
      const parts: any[] = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      for (const img of m.images) {
        const url = img.startsWith('data:') ? img : `data:image/png;base64,${img}`;
        parts.push({ type: 'image_url', image_url: { url } });
      }
      return { role: 'user', content: parts };
    }

    return { role: m.role, content: m.content ?? '' };
  }

  private async executeRequest(
    requestId: string,
    payload: OpenAIPayload,
    stream: boolean,
    attempt: number,
    callerSignal: AbortSignal,
    parentId?: string,
    suppressThinking?: boolean,
    eventStream?: ActivityStream
  ): Promise<LLMResponse> {
    const abortController = new AbortController();
    this.activeRequests.set(requestId, abortController);

    if (callerSignal.aborted) abortController.abort();
    const onCallerAbort = () => abortController.abort();
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });

    const timeout = Math.min(
      API_TIMEOUTS.LLM_REQUEST_BASE + attempt * API_TIMEOUTS.LLM_REQUEST_RETRY_INCREMENT,
      RETRY_CONFIG.MAX_LLM_TIMEOUT
    );
    let responseTimedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        responseTimedOut = true;
        abortController.abort();
        reject(new Error('Request timeout'));
      }, timeout);
    });

    try {
      const fetchPromise = fetch(this.apiUrl, {
        method: 'POST',
        headers: this.requestHeaders,
        body: JSON.stringify(payload),
        signal: abortController.signal,
      });

      const response = await Promise.race([fetchPromise, timeoutPromise]);
      clearTimeout(timeoutHandle);

      if (!response.ok) {
        const errorText = await response.text();
        const error: any = new Error(`HTTP ${response.status}: ${errorText}`);
        error.httpStatus = response.status;
        throw error;
      }

      return stream
        ? await this.parseStreamingResponse(requestId, response, callerSignal, parentId, suppressThinking, eventStream)
        : this.parseNonStreamingResponse(await response.json(), requestId, parentId, suppressThinking, eventStream);
    } catch (error: any) {
      if (responseTimedOut && error?.name === 'AbortError') {
        throw new Error('Request timeout');
      }
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
      callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }

  /** Parse an SSE stream of chat-completion chunks into a single response. */
  private async parseStreamingResponse(
    requestId: string,
    response: Response,
    callerSignal: AbortSignal,
    parentId?: string,
    suppressThinking?: boolean,
    eventStream: ActivityStream | undefined = this.activityStream
  ): Promise<LLMResponse> {
    if (!response.body) throw new Error('Response body is null');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let thinking = '';
    let contentWasStreamed = false;
    let usage: LLMResponse['usage'] | undefined;
    // Tool calls arrive incrementally, keyed by their `index`; arguments are
    // concatenated as raw JSON-string fragments and parsed once at the end.
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();

    while (true) {
      if (callerSignal.aborted) {
        return { role: 'assistant', content, interrupted: true, _content_was_streamed: contentWasStreamed };
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;

        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          logger.debug('[OPENAI_COMPAT] Skipping unparseable SSE chunk:', data.substring(0, 200));
          continue;
        }

        // Usage may arrive on a trailing chunk with an empty choices array.
        if (chunk.usage) {
          usage = openAIUsage(chunk.usage);
        }

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          content += delta.content;
          contentWasStreamed = true;
          eventStream?.emit({
            id: `assistant-${requestId}-${Date.now()}`,
            type: ActivityEventType.ASSISTANT_CHUNK,
            timestamp: Date.now(),
            data: { chunk: delta.content },
          });
        }

        // vLLM and some servers surface native reasoning as reasoning_content.
        const reasoningChunk = delta.reasoning_content || delta.reasoning;
        if (reasoningChunk) {
          thinking += reasoningChunk;
          if (!suppressThinking) {
            eventStream?.emit({
              id: `thinking-${requestId}-${Date.now()}`,
              type: ActivityEventType.THOUGHT_CHUNK,
              timestamp: Date.now(),
              data: { chunk: reasoningChunk },
            });
          }
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const entry = toolAcc.get(idx) ?? { id: '', name: '', args: '' };
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;
            toolAcc.set(idx, entry);
          }
        }
      }
    }

    if (thinking && !suppressThinking) {
      eventStream?.emit({
        id: `thinking-complete-${requestId}`,
        type: ActivityEventType.THOUGHT_COMPLETE,
        timestamp: Date.now(),
        parentId,
        data: { thinking },
      });
    }

    const result: LLMResponse = { role: 'assistant', content };
    if (thinking) result.thinking = thinking;
    if (usage) result.usage = usage;
    const toolCalls = this.finalizeToolCalls([...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]));
    if (toolCalls.length > 0) result.tool_calls = toolCalls;
    if (contentWasStreamed) {
      result._content_was_streamed = true;
      result._should_replace_streaming = true;
    }
    return result;
  }

  private parseNonStreamingResponse(
    data: any,
    requestId: string,
    parentId?: string,
    suppressThinking?: boolean,
    eventStream: ActivityStream | undefined = this.activityStream
  ): LLMResponse {
    const message = data.choices?.[0]?.message || {};
    const result: LLMResponse = { role: 'assistant', content: message.content || '' };

    const reasoning = message.reasoning_content || message.reasoning;
    if (reasoning) {
      result.thinking = reasoning;
      if (eventStream && !suppressThinking) {
        eventStream.emit({
          id: `thinking-complete-${requestId}`,
          type: ActivityEventType.THOUGHT_COMPLETE,
          timestamp: Date.now(),
          parentId,
          data: { thinking: reasoning },
        });
      }
    }

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const toolCalls = this.finalizeToolCalls(
        message.tool_calls.map((tc: any) => ({
          id: tc.id || '',
          name: tc.function?.name || '',
          args: typeof tc.function?.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments ?? {}),
        }))
      );
      if (toolCalls.length > 0) result.tool_calls = toolCalls;
    }

    if (data.usage) {
      const usage = openAIUsage(data.usage);
      if (usage) result.usage = usage;
    }

    return result;
  }

  /**
   * Turn accumulated {id,name,args-string} tuples into internal tool calls:
   * parse the JSON-string arguments to an object and guarantee a unique id.
   * Calls with an unparseable/missing name are dropped.
   */
  private finalizeToolCalls(
    raw: Array<{ id: string; name: string; args: string }>
  ): NonNullable<LLMResponse['tool_calls']> {
    const calls: NonNullable<LLMResponse['tool_calls']> = [];
    raw.forEach((entry, index) => {
      if (!entry.name) return;
      let args: Record<string, any> = {};
      if (entry.args.trim()) {
        try {
          args = JSON.parse(entry.args);
        } catch {
          logger.warn(`[OPENAI_COMPAT] Dropping tool call '${entry.name}' with unparseable arguments`);
          return;
        }
      }
      const random = Math.random().toString(36).substring(2, 9);
      calls.push({
        id: entry.id || `call-${Date.now()}-${index}-${random}`,
        type: 'function',
        function: { name: entry.name, arguments: args },
      });
    });
    return calls;
  }

  private handleRequestError(error: any): LLMResponse {
    const errorMsg = error?.message || String(error);
    const suggestions = [
      'Verify the endpoint exposes an OpenAI-compatible /v1/chat/completions API',
      'Check the api_key / Authorization header if the endpoint requires auth',
      'Confirm the model name matches one served by the endpoint',
    ];
    return {
      role: 'assistant',
      content: `Error communicating with OpenAI-compatible endpoint: ${errorMsg}\n\nSuggested fixes:\n${suggestions.map(s => `- ${s}`).join('\n')}`,
      error: true,
      suggestions,
    };
  }

  private emitStatusMessage(message: string): void {
    this.activityStream?.emit({
      id: `status-${Date.now()}`,
      type: ActivityEventType.STATUS_MESSAGE,
      timestamp: Date.now(),
      data: { message },
    });
  }
}
