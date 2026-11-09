/** Observe actual Ollama transport traffic, including independently-created child clients. */
import { createHash } from 'node:crypto';
import { applyBehaviorVariant, type BehaviorVariant } from './behaviorPolicies.js';
import type { Message } from '../types/index.js';

export interface BehaviorTransportRequest {
  sequence: number;
  owner: 'main' | 'delegate' | 'compaction' | 'unknown';
  payload: Record<string, unknown>;
  sha256: string;
  variantApplied: boolean;
  elapsedMs?: number;
  httpStatus?: number;
  response?: {
    content: string;
    tool_calls: unknown[];
    thinking: string;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  };
  error?: string;
  responseTruncated?: boolean;
}
export interface BehaviorTransportOptions {
  endpoint: string;
  variant: BehaviorVariant;
  seed?: number;
  maxRequests?: number;
  maxResponseBytes?: number;
}
function owner(payload: Record<string, unknown>): BehaviorTransportRequest['owner'] {
  if (payload.format && typeof payload.format === 'object') return 'compaction';
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const system = messages.find((message: { role?: string }) => message?.role === 'system') as
    { content?: unknown } | undefined;
  if (typeof system?.content !== 'string') return 'unknown';
  return system.content.startsWith('You are Ally') ? 'main' : 'delegate';
}
async function observe(response: Response, request: BehaviorTransportRequest, limit: number): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const remaining = limit - size;
      if (item.value.byteLength > remaining) {
        chunks.push(item.value.subarray(0, remaining));
        request.responseTruncated = true;
        // Cancelling a tee branch can await the original branch; never await it here.
        void reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(item.value);
      size += item.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const raw = new TextDecoder().decode(bytes);
  const records: Record<string, unknown>[] = [];
  try {
    records.push(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        if (!request.responseTruncated) request.error = 'Malformed provider response';
      }
    }
  }
  let content = '';
  let thinking = '';
  const toolCalls: unknown[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  for (const record of records) {
    const message = record.message as { content?: unknown; thinking?: unknown; tool_calls?: unknown } | undefined;
    if (typeof message?.content === 'string') content += message.content;
    if (typeof message?.thinking === 'string') thinking += message.thinking;
    if (Array.isArray(message?.tool_calls)) toolCalls.push(...message.tool_calls);
    if (typeof record.prompt_eval_count === 'number') promptTokens = record.prompt_eval_count;
    if (typeof record.eval_count === 'number') completionTokens = record.eval_count;
    if (record.error) request.error = String(record.error);
  }
  request.response = {
    content,
    thinking,
    tool_calls: toolCalls,
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
  };
}
export function installBehaviorTransport(options: BehaviorTransportOptions): {
  requests: BehaviorTransportRequest[];
  drain: () => Promise<void>;
  restore: () => void;
} {
  if (options.seed !== undefined && (!Number.isSafeInteger(options.seed) || options.seed < 0)) {
    throw new Error('Behavior seed must be a nonnegative safe integer');
  }
  const original = globalThis.fetch;
  const target = new URL(`${options.endpoint.replace(/\/$/, '')}/api/chat`).href;
  const requests: BehaviorTransportRequest[] = [];
  const pending = new Set<Promise<void>>();
  let attempted = 0;
  const intercepted: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).href !== target) return original(input, init);
    if (attempted++ >= (options.maxRequests ?? 40))
      throw new Error('Behavior evaluation exceeded model request ceiling');
    const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    if (typeof body !== 'string') throw new Error('Behavior transport requires a JSON chat body');
    const payload = JSON.parse(body) as Record<string, unknown>;
    let variantApplied = false;
    if (Array.isArray(payload.messages)) {
      const originalMessages = JSON.stringify(payload.messages);
      payload.messages = applyBehaviorVariant(payload.messages as Message[], options.variant);
      variantApplied = originalMessages !== JSON.stringify(payload.messages);
    }
    if (options.seed !== undefined) {
      payload.options = { ...(payload.options as Record<string, unknown> | undefined), seed: options.seed };
    }
    const serialized = JSON.stringify(payload);
    const request: BehaviorTransportRequest = {
      sequence: requests.length + 1,
      owner: owner(payload),
      variantApplied,
      payload,
      sha256: createHash('sha256').update(serialized).digest('hex'),
    };
    requests.push(request);
    const started = Date.now();
    try {
      const response = await original(input, { ...init, body: serialized });
      request.httpStatus = response.status;
      const observation = observe(response.clone(), request, options.maxResponseBytes ?? 2 * 1024 * 1024)
        .catch(error => {
          request.error = String(error);
        })
        .finally(() => {
          request.elapsedMs = Date.now() - started;
          pending.delete(observation);
        });
      pending.add(observation);
      return response;
    } catch (error) {
      request.error = String(error);
      request.elapsedMs = Date.now() - started;
      throw error;
    }
  };
  globalThis.fetch = intercepted;
  return {
    requests,
    drain: async () => {
      while (pending.size) await Promise.all([...pending]);
    },
    restore: () => {
      if (globalThis.fetch === intercepted) globalThis.fetch = original;
    },
  };
}
