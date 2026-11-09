/** Selective permission decisions. Model output never expands the deterministic action envelope. */
import { MAX_PERMISSION_REVIEW_BYTES } from '../security/PermissionReviewLimits.js';
import {
  createPermissionReadinessProbes,
  createPermissionReviewRequest,
  effectivePermissionVerdict,
  PERMISSION_CHOICES as CHOICES,
} from '../security/PermissionReviewRequest.js';
import type { Config } from '../types/index.js';
import type { PermissionMode } from '../security/PermissionMode.js';
import { classifyAutoAction } from '../security/AutoActionPolicy.js';
import { authorizeAutoReadCommand } from '../security/ReadCommandPlan.js';
import { authorizeAutoGrepRead } from '../security/GrepReadBoundary.js';

import type { PermissionDecision } from '../security/PermissionDecision.js';
export type { PermissionDecision } from '../security/PermissionDecision.js';
export interface PermissionSnapshot {
  requestedMode: PermissionMode;
  effectiveMode: PermissionMode;
  fallbackReason?: string;
  reviewerModel?: string;
  reviewing: boolean;
}
export interface PermissionEvaluation {
  toolMetadata?: import('../security/ToolPermissionMetadata.js').ToolPermissionMetadata;
  toolName: string;
  args: Record<string, unknown>;
  workspaceRoot: string;
  /** Original human instructions, never tool output or an agent's justification. */
  task?: string;
  signal?: AbortSignal;
}
interface Connection {
  endpoint: string;
  key?: string;
  model: string | null;
  shadow: boolean;
}
const REASONS = {
  allow: 'Reviewer found this bounded workspace action consistent with your request.',
  ask: 'The reviewer could not establish clear authorization for this action.',
  deny: 'The reviewer found this action inconsistent with your request.',
};

/** Preserve status so proposal validation failures do not disable a healthy reviewer. */
export class ReviewerHTTPError extends Error {
  constructor(readonly status: number) {
    super(`Reviewer returned HTTP ${status}`);
    this.name = 'ReviewerHTTPError';
  }
}

export class PermissionPolicyService {
  private snapshot: PermissionSnapshot = {
    requestedMode: 'auto',
    effectiveMode: 'manual',
    fallbackReason: 'Checking reviewer availability',
    reviewing: false,
  };
  private readonly listeners = new Set<() => void>();
  private controller = new AbortController();
  private connection?: Connection;
  private generation = 0;
  private activeReviews = 0;
  private readonly requests = new Set<Promise<unknown>>();
  private closed = false;
  private refreshPromise?: Promise<void>;
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  getSnapshot = (): PermissionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(patch: Partial<PermissionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  configure(config: Config): void {
    const endpoint = (config.reviewer_endpoint ?? config.endpoint).replace(/\/+$/, '');
    const connection: Connection = {
      endpoint,
      key:
        config.reviewer_api_key ??
        (endpoint === config.endpoint.replace(/\/+$/, '') ? (config.api_key ?? undefined) : undefined),
      model: config.reviewer_model,
      shadow: config.reviewer_shadow,
    };
    if (
      JSON.stringify(connection) === JSON.stringify(this.connection) &&
      config.permission_mode === this.snapshot.requestedMode
    ) {
      if (
        config.permission_mode === 'auto' &&
        this.snapshot.effectiveMode === 'manual' &&
        !connection.shadow &&
        !this.closed
      )
        void this.refresh();
      return;
    }
    this.controller.abort();
    this.controller = new AbortController();
    this.generation++;
    this.activeReviews = 0;
    this.refreshPromise = undefined;
    this.connection = connection;
    this.publish({
      requestedMode: config.permission_mode,
      effectiveMode: config.permission_mode === 'auto' ? 'manual' : config.permission_mode,
      fallbackReason: config.permission_mode === 'auto' ? 'Checking reviewer availability' : undefined,
      reviewerModel: undefined,
      reviewing: false,
    });
    if (config.permission_mode === 'auto' && !this.closed) void this.refresh();
  }

  refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const generation = this.generation;
    const promise = this.probe(generation).finally(() => {
      if (generation === this.generation) this.refreshPromise = undefined;
    });
    this.refreshPromise = promise;
    return promise;
  }

  private request(path: string, body: unknown | undefined, signal?: AbortSignal, timeout = 5000): Promise<unknown> {
    const request = this.requestOwned(path, body, signal, timeout);
    this.requests.add(request);
    void request.finally(() => this.requests.delete(request)).catch(() => {});
    return request;
  }

  private async requestOwned(
    path: string,
    body: unknown | undefined,
    signal?: AbortSignal,
    timeout = 5000
  ): Promise<unknown> {
    const connection = this.connection!;
    const response = await this.fetcher(`${connection.endpoint}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        ...(connection.key ? { Authorization: `Bearer ${connection.key}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw new ReviewerHTTPError(response.status);
    // Bound the response before parsing; a broken service cannot fill the harness heap.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Reviewer returned an empty response');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.byteLength;
        if (length > 262144) throw new Error('Reviewer response exceeds its size limit');
        chunks.push(result.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  private async probe(generation: number): Promise<void> {
    if (!this.connection || this.closed || this.snapshot.requestedMode !== 'auto') return;
    try {
      let model = this.connection.model;
      if (!model) {
        const listed = (await this.request('/api/tags', undefined)) as {
          models?: Array<{
            name?: string;
            capabilities?: string[];
            remote_model?: string;
            remote_host?: string;
          }>;
        };
        const candidates = Array.isArray(listed.models)
          ? listed.models.filter(
              item =>
                typeof item.name === 'string' &&
                Array.isArray(item.capabilities) &&
                item.capabilities.includes('decision') &&
                !item.remote_model &&
                !item.remote_host
            )
          : [];
        model = candidates.sort((a, b) => a.name!.localeCompare(b.name!))[0]?.name ?? null;
      }
      if (generation !== this.generation || this.closed) return;
      if (!model) throw new Error('No local decision model found. Configure reviewer_model and reviewer_endpoint.');
      for (const probe of createPermissionReadinessProbes(model)) {
        const response = await this.request('/v1/systemone', probe.body, undefined, 15000);
        if (generation !== this.generation || this.closed) return;
        const verdict = effectivePermissionVerdict(this.parseAnswer(response));
        if (probe.kind === 'positive' && verdict !== 'allow')
          throw new Error('Reviewer cannot confidently approve a clearly authorized action. Using Manual approvals.');
        if (probe.kind === 'negative' && verdict === 'allow')
          throw new Error('Reviewer approved an action forbidden by the human request. Using Manual approvals.');
      }
      if (generation !== this.generation || this.closed) return;
      this.publish({
        reviewerModel: model,
        effectiveMode: this.connection.shadow ? 'manual' : 'auto',
        fallbackReason: this.connection.shadow ? 'Shadow review: recommendations do not grant permission' : undefined,
      });
    } catch (error) {
      if (generation !== this.generation || this.closed) return;
      this.publish({
        effectiveMode: 'manual',
        reviewerModel: undefined,
        fallbackReason: error instanceof Error ? error.message : 'Reviewer unavailable',
      });
    }
  }

  private parseAnswer(value: unknown): {
    verdict: 'allow' | 'ask' | 'deny';
    probability: number;
  } {
    const answer = (
      value as {
        answers?: {
          permission?: {
            type?: unknown;
            choice?: unknown;
            probabilities?: Record<string, unknown>;
          };
        };
      }
    )?.answers?.permission;
    if (!answer || answer.type !== 'choice' || !['allow', 'ask', 'deny'].includes(String(answer.choice)))
      throw new Error('Reviewer returned an invalid decision');
    const probabilities = answer.probabilities;
    if (
      !probabilities ||
      Object.keys(probabilities).length !== 3 ||
      Object.values(probabilities).some(p => typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) ||
      Object.keys(CHOICES).some(key => typeof probabilities[key] !== 'number')
    )
      throw new Error('Reviewer returned invalid probabilities');
    const sum = Object.values(probabilities).reduce<number>((total, p) => total + Number(p), 0);
    if (Math.abs(sum - 1) > 0.02) throw new Error('Reviewer returned inconsistent probabilities');
    const verdict = answer.choice as 'allow' | 'ask' | 'deny';
    const probability = Number(probabilities[verdict]);
    if (Object.values(probabilities).some(p => Number(p) > probability))
      throw new Error('Reviewer choice disagrees with its probabilities');
    return { verdict, probability };
  }

  async evaluate(input: PermissionEvaluation): Promise<PermissionDecision> {
    const generation = this.generation;
    const finish = (
      verdict: PermissionDecision['verdict'],
      reason: string,
      source: PermissionDecision['source'] = 'policy'
    ): PermissionDecision => {
      const result = {
        toolName: input.toolName,
        verdict,
        reason,
        source,
        timestamp: Date.now(),
        ...(source === 'reviewer' || source === 'shadow' ? { reviewerModel: this.snapshot.reviewerModel } : {}),
      };
      return result;
    };
    const stale = () => generation !== this.generation || this.closed || input.signal?.aborted;
    if (stale()) return finish('ask', 'Permission review was cancelled.');
    const shadow = this.snapshot.requestedMode === 'auto' && this.connection?.shadow && !!this.snapshot.reviewerModel;
    // Local proofs do not depend on reviewer availability. Manual and shadow
    // modes still grant nothing here; review-required effects retain fallback.
    const localAuto = this.snapshot.requestedMode === 'auto' && !this.connection?.shadow;
    const reviewerUnavailable = this.snapshot.effectiveMode !== 'auto' && !shadow;
    if (reviewerUnavailable && !localAuto)
      return finish('ask', this.snapshot.fallbackReason ?? 'Manual approval is selected.');
    const policy = await classifyAutoAction(input);
    if (stale()) return finish('ask', 'Permission settings changed during review.');
    if (reviewerUnavailable && policy.kind !== 'allow')
      return finish('ask', this.snapshot.fallbackReason ?? 'Manual approval is selected.');
    if (policy.kind !== 'review') {
      if (!shadow && policy.kind === 'allow') {
        if (policy.readCommand) authorizeAutoReadCommand(input.args, policy.readCommand);
        if (policy.grepRead) authorizeAutoGrepRead(input.args, policy.grepRead);
      }
      return finish(
        shadow && policy.kind === 'allow' ? 'ask' : policy.kind,
        policy.reason,
        shadow ? 'shadow' : 'policy'
      );
    }
    const reviewedArguments = JSON.stringify(input.args);
    if (!input.task?.trim()) return finish('ask', 'The full authorization context is unavailable.');
    const body = createPermissionReviewRequest(
      this.snapshot.reviewerModel,
      input.task,
      input.toolName,
      input.args,
      policy.reason
    );
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_PERMISSION_REVIEW_BYTES)
      return finish(
        'ask',
        'This action and its authorization context exceed the 64 KiB automatic review limit. Review it before allowing.'
      );
    this.activeReviews++;
    this.publish({ reviewing: true });
    try {
      const response = await this.request('/v1/systemone', body, input.signal);
      if (stale()) return finish('ask', 'Permission settings changed during review.');
      const answer = this.parseAnswer(response);
      // This is an abstention threshold, not a calibrated probability of safety.
      if (answer.verdict === 'allow') {
        const currentPolicy = await classifyAutoAction(input);
        if (
          stale() ||
          JSON.stringify(input.args) !== reviewedArguments ||
          currentPolicy.kind !== 'review' ||
          JSON.stringify(currentPolicy.review) !== JSON.stringify(policy.review)
        )
          return finish('ask', 'The reviewed action or target changed before approval.');
      }
      const verdict = effectivePermissionVerdict(answer);
      return finish(
        shadow ? 'ask' : verdict,
        shadow ? `Shadow recommendation: ${verdict}. ${REASONS[verdict]}` : REASONS[verdict],
        shadow ? 'shadow' : 'reviewer'
      );
    } catch (error) {
      const proposalRejected = error instanceof ReviewerHTTPError && [400, 413, 422].includes(error.status);
      if (!stale() && !proposalRejected)
        this.publish({
          effectiveMode: 'manual',
          reviewerModel: undefined,
          fallbackReason: 'Reviewer unavailable. Check the connection or retry Auto mode.',
        });
      return finish(
        'ask',
        input.signal?.aborted
          ? 'Permission review was cancelled.'
          : `Automatic review failed: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    } finally {
      if (generation === this.generation) {
        this.activeReviews--;
        this.publish({ reviewing: this.activeReviews > 0 });
      }
    }
  }

  async cleanup(): Promise<void> {
    this.closed = true;
    this.generation++;
    this.controller.abort();
    this.listeners.clear();
    await Promise.allSettled([...this.requests, ...(this.refreshPromise ? [this.refreshPromise] : [])]);
  }
}
