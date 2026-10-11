import { prepareVerification, settleVerification, type ObjectiveArchitecture, type PreparedVerification } from './ObjectiveArchitecture.js';

/** An execution's journal capability is bound to its admitting run until release. */
export class RunExecution {
  private releasePromise?: Promise<void>;
  private readonly verifications = new Map<string, PreparedVerification[]>();

  constructor(
    readonly runId: string,
    private readonly record: (type: string, data: Record<string, unknown>) => Promise<void>,
    private readonly relinquish: () => Promise<void>,
    private readonly architecture: () => ObjectiveArchitecture | undefined = () => undefined,
    private readonly workspaceRoot = process.cwd(),
  ) {}

  private write(type: string, data: Record<string, unknown>): Promise<void> {
    if (this.releasePromise) return Promise.reject(new Error('Run execution has been released'));
    return this.record(type, data);
  }

  async toolPrepared(callId: string, tool: string, effect: string, args: Record<string, unknown>): Promise<void> {
    let serializedArgs = '[unserializable arguments]';
    try { serializedArgs = JSON.stringify(args).slice(0, 8000); } catch { /* retain diagnostic */ }
    this.verifications.set(callId, await prepareVerification(this.workspaceRoot, this.architecture(), tool, args));
    await this.write('tool_prepared', { callId, tool, effect, serializedArgs });
  }

  async toolStarted(callId: string, tool: string, effect: string): Promise<void> {
    await this.write('tool_running', { callId, tool, effect });
  }

  async toolFinished(callId: string, tool: string, effect: string, outcome: 'succeeded' | 'failed' | 'unknown', error?: string): Promise<void> {
    const prepared = this.verifications.get(callId) ?? [];
    this.verifications.delete(callId);
    const verification = await settleVerification(this.workspaceRoot, prepared, callId, outcome === 'succeeded');
    const ambiguous = outcome === 'unknown' && effect === 'non_idempotent';
    await this.write(ambiguous ? 'tool_unknown' : outcome === 'succeeded' ? 'tool_succeeded' : 'tool_failed', {
      callId, tool, effect, ...(verification.length ? { verification } : {}), ...(error ? { error: error.slice(0, 2000) } : {}),
    });
  }

  release(): Promise<void> {
    this.releasePromise ??= Promise.resolve().then(this.relinquish);
    return this.releasePromise;
  }
}
