import { ModelClient, type ModelClientConfig, type SendOptions } from './ModelClient.js';
import type { Message } from '../types/index.js';
import type { ModelProvider } from '../config/providers.js';

export type TransportFactory = (provider: ModelProvider, config: ModelClientConfig) => ModelClient;

/** Stable client reference shared by agents, compaction, and background services.
 * Connection changes replace the transport for subsequent requests. Requests
 * already running retain their transport until they finish.
 */
export class ConfigurableModelClient extends ModelClient {
  private client: ModelClient;
  private readonly retired = new Set<ModelClient>();
  private readonly active = new Map<ModelClient, number>();
  private readonly closingTransports = new WeakMap<ModelClient, Promise<void>>();
  private readonly pendingClosures = new Set<Promise<void>>();
  private readonly closeFailures: unknown[] = [];
  private closePromise?: Promise<void>;

  constructor(
    private provider: ModelProvider,
    private config: ModelClientConfig,
    private readonly factory: TransportFactory
  ) {
    super();
    this.client = factory(provider, config);
  }

  get providerId() {
    return this.client.providerId;
  }
  get capabilities() {
    return this.client.capabilities;
  }
  get modelName() {
    return this.client.modelName;
  }
  get endpoint() {
    return this.client.endpoint;
  }

  private replace(config: ModelClientConfig, provider = this.provider): void {
    if (this.closePromise) throw new Error('Model client is closed');
    const next = this.factory(provider, config);
    const previous = this.client;
    this.config = config;
    this.provider = provider;
    this.client = next;
    if (this.active.has(previous)) this.retired.add(previous);
    else this.closeTransport(previous);
  }

  private closeTransport(client: ModelClient): Promise<void> {
    const existing = this.closingTransports.get(client);
    if (existing) return existing;
    const operation = Promise.resolve().then(() => client.close?.());
    this.closingTransports.set(client, operation);
    this.pendingClosures.add(operation);
    void operation.then(() => this.pendingClosures.delete(operation), error => {
      this.pendingClosures.delete(operation);
      this.closeFailures.push(error);
    });
    return operation;
  }

  setProvider(provider: ModelProvider): void {
    if (provider !== this.provider) this.replace({ ...this.config, supportsImages: undefined }, provider);
  }

  setApiKey(apiKey: string | null | undefined): void {
    if ((apiKey ?? undefined) !== this.config.apiKey) this.replace({ ...this.config, apiKey: apiKey ?? undefined });
  }

  private update<K extends keyof ModelClientConfig>(key: K, value: ModelClientConfig[K]): void {
    if (Object.is(this.config[key], value)) return;
    this.replace({ ...this.config, [key]: value });
  }

  setModelName(value: string) {
    this.update('modelName', value);
  }
  setEndpoint(value: string) {
    this.update('endpoint', value);
  }
  setTemperature(value: number | undefined) {
    this.update('temperature', value);
  }
  setContextSize(value: number) {
    this.update('contextSize', value);
  }
  setMaxTokens(value: number) {
    this.update('maxTokens', value);
  }
  setReasoningEffort(value: string | undefined) {
    this.update('reasoningEffort', value);
  }
  setSampling(value: ModelClientConfig['sampling']) {
    this.update('sampling', value);
  }
  override setSupportsImages(value: boolean | undefined) {
    this.update('supportsImages', value);
  }

  private async withClient<T>(run: (client: ModelClient) => Promise<T>): Promise<T> {
    if (this.closePromise) throw new Error('Model client is closed');
    const client = this.client;
    this.active.set(client, (this.active.get(client) ?? 0) + 1);
    try {
      return await run(client);
    } finally {
      const remaining = this.active.get(client)! - 1;
      if (remaining) this.active.set(client, remaining);
      else {
        this.active.delete(client);
        if (this.retired.delete(client)) this.closeTransport(client);
      }
    }
  }

  send(messages: readonly Message[], options: SendOptions) {
    return this.withClient(client => client.send(messages, options));
  }
  override previewRequest(messages: readonly Message[], options: SendOptions) {
    return this.client.previewRequest(messages, options);
  }
  override countInput(messages: readonly Message[], options: SendOptions) {
    return this.withClient(client => client.countInput(messages, options));
  }
  override compactProviderState(messages: readonly Message[], options: SendOptions) {
    return this.withClient(client => client.compactProviderState(messages, options));
  }
  close(): Promise<void> {
    this.closePromise ??= Promise.resolve().then(async () => {
      for (const client of new Set([this.client, ...this.retired])) this.closeTransport(client);
      await Promise.allSettled(this.pendingClosures);
      this.retired.clear();
      if (this.closeFailures.length) throw new AggregateError(this.closeFailures, 'Model transport cleanup failed');
    });
    return this.closePromise;
  }
}
